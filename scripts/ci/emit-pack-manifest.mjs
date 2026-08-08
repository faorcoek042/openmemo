#!/usr/bin/env node
/**
 * 把一个刚构建好的后端包变成一条 **`BackendPackSchema` 形状的 manifest fragment**。
 *
 * ## 为什么这是一个独立的、零依赖的 node 脚本，而不是 build-whisper.sh 里的 printf
 *
 * `platform` 的 T-141 §4 C2 记录了原来那段 `printf` 的产物：
 * **缺 8 个必填字段**（`displayName` / `displayNameZh` / `totalSizeBytes` /
 * `requiresDriver` / `license` / `providesFiles` / `priority` / `catalogVersion`），
 * **多 4 个未声明字段**（`engineCommit` / `buildHost` / `builtAt` / `archive`
 * —— `BackendPackSchema` 是 `.strict()`，多一个就直接拒），
 * `files[]` 缺 `ArtifactFileSchema` 的 `role` / `mirrors`，
 * **整个 fragment 里没有任何 URL**。
 *
 * 这不是"写漏了"，是**结构上不可能对**：schema 在 TypeScript 里，fragment 在 bash 的
 * printf 里，两者之间没有任何东西能把它们对起来。**唯一的检查时机在三个 job 之后**，
 * 而那个 job 从来没跑过。
 *
 * 所以：fragment 由 node 生成（字段名与 schema 一一对应），并且
 * `scripts/ci/selftest-ci-manifest.mjs` 会**拿真的 `validateBackendManifest`**
 * 校验本脚本的输出 —— 那条自检在 `pnpm test:ci-scripts` 里，本机就能跑。
 *
 * ## 零依赖是刻意的
 *
 * 三个构建 job（macos / linux / windows）**不跑 `pnpm install`** —— 为了一条 manifest
 * 去装整个 workspace 不划算。所以本脚本只用 node 内置模块。
 * **真正的 schema 校验放在 merge job**（`merge-backend-manifest.mjs`，那里有 workspace），
 * 校验不过就 exit 1，manifest 一个字都不写。
 *
 * ## availability = "pending-ci" 是正确答案，不是将就
 *
 * CI 刚构建出来的包**还没有任何下载地址**（产物在 actions artifact 里，不是公网 URL）。
 * `BackendManifestSchema` 的 `superRefine` 明确要求：`published` 必须有 mirror，
 * 而 `pending-ci` 允许 `mirrors: []`（`ArtifactFileSchema` 那里也写了这条例外）。
 * 前端 `BackendPackCard` 读到 `pending-ci` 会**禁用安装按钮**，
 * 而不是让用户点一个必然失败的下载。
 *
 * 用法：
 *   node scripts/ci/emit-pack-manifest.mjs \
 *     --pack-id whispercpp-vulkan-linux-x64 --engine whisper.cpp \
 *     --engine-version v1.9.1 --ggml-abi 0.15.1 --backend vulkan \
 *     --os linux --arch x64 --tier downloadable \
 *     --archive dist/packs/whispercpp-vulkan-linux-x64.tar.gz \
 *     --stage .build/whisper-linux-x64-vulkan/stage/whispercpp-vulkan-linux-x64 \
 *     --catalog-version 2026.08.05 \
 *     --out dist/packs/whispercpp-vulkan-linux-x64.json
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/* ------------------------------ 参数 ------------------------------ */

const REQUIRED = [
  'pack-id',
  'engine',
  'engine-version',
  'backend',
  'os',
  'arch',
  'tier',
  'archive',
  'stage',
  'catalog-version',
  'out',
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) die(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val == null || val.startsWith('--')) die(`--${key} needs a value`);
    out[key] = val;
    i += 1;
  }
  for (const k of REQUIRED) if (!out[k]) die(`missing required --${k}`);
  return out;
}

function die(msg) {
  console.error(`emit-pack-manifest: ${msg}`);
  process.exit(1);
}

/* --------------------------- 派生字段的表 --------------------------- */

/**
 * 优先级：沿用手写 manifest 里已经在用的那套数值，**不新发明一套**。
 * 两套并存的话，同一台机器上"推荐哪个"会随包的来源而变 —— 用户看不出原因。
 */
const PRIORITY = { cuda: 90, metal: 90, coreml: 90, vulkan: 80, rocm: 70, cpu: 10 };

/** 引擎 → 许可证。手写 manifest 里 whisper.cpp 用的就是这一条，保持逐字一致。 */
const ENGINE_LICENSE = {
  'whisper.cpp': {
    id: 'MIT',
    gated: false,
    url: 'https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE',
  },
};

const BACKEND_LABEL = {
  cpu: 'CPU',
  cuda: 'CUDA',
  vulkan: 'Vulkan',
  rocm: 'ROCm',
  metal: 'Metal',
  coreml: 'CoreML',
};

const OS_LABEL = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };

/* ------------------------------ 主体 ------------------------------ */

async function sha256File(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

/** 递归列出 stage 里的文件（相对路径），排序稳定。 */
async function listFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(join(dir, e.name), rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const archive = args['archive'];
  const archiveStat = await stat(archive).catch(() => die(`archive not found: ${archive}`));
  const archiveName = basename(archive);

  /*
   * `ArtifactFileSchema.name` 要求是**裸文件名**（不含 `/`、`\`、`..`）——
   * 上游 ComfyUI-Manager 是事后才补的这条路径穿越检查。basename() 之后再断言一次，
   * 因为 `--archive` 是外部输入。
   */
  if (/[/\\]/.test(archiveName) || archiveName.includes('..')) {
    die(`archive basename is not a bare name: ${archiveName}`);
  }

  const unpack = archiveName.endsWith('.zip')
    ? 'zip'
    : archiveName.endsWith('.tar.gz')
      ? 'tar.gz'
      : archiveName.endsWith('.tar.xz')
        ? 'tar.xz'
        : die(`cannot infer unpack format from ${archiveName}`);

  const staged = await listFiles(args['stage']).catch(() =>
    die(`stage not found: ${args['stage']}`),
  );
  if (staged.length === 0) {
    /*
     * 空 stage = 构建其实什么都没产出，而 tar 对空目录**照样成功**。
     * 这正是「失败被写成成功」的形状：包会是一个 45 字节的合法 tar.gz，
     * schema 也过得去（`providesFiles` 会是 []，但那时才 min(1) 报错，
     * 错误信息指向 schema 而不是指向"构建没产出东西"）。在这里就说清楚。
     */
    die(`stage dir is empty: ${args['stage']} —— 构建没有产出任何文件，包是空的`);
  }

  const backend = args['backend'];
  const os = args['os'];
  const license = ENGINE_LICENSE[args['engine']];
  if (!license) die(`no license mapping for engine ${args['engine']} —— 补进 ENGINE_LICENSE 再来`);

  const label = `${BACKEND_LABEL[backend] ?? backend} (${OS_LABEL[os] ?? os} ${args['arch']})`;

  const pack = {
    schemaVersion: 1,
    id: args['pack-id'],
    engine: args['engine'],
    engineVersion: args['engine-version'],
    // 手写 manifest 里没测出 ABI 的写 null；这里 build-whisper.sh 探不到时传 "unknown"，
    // 那种情况也一律折成 null —— "unknown" 这个字符串会被当成一个真的 ABI 值去比。
    ggmlAbi: args['ggml-abi'] && args['ggml-abi'] !== 'unknown' ? args['ggml-abi'] : null,
    backend,
    tier: args['tier'],
    os,
    arch: args['arch'],
    displayName: `${args['engine']} — ${label}`,
    displayNameZh: `${args['engine']} · ${BACKEND_LABEL[backend] ?? backend} 后端（${OS_LABEL[os] ?? os} ${args['arch']}）`,
    files: [
      {
        role: 'archive',
        name: archiveName,
        sizeBytes: archiveStat.size,
        sha256: await sha256File(archive),
        unpack,
        // ★ 刻意为空：CI 产物还在 actions artifact 里，没有公网地址。
        //   配合 availability:"pending-ci"，schema 的 superRefine 才放行。
        mirrors: [],
      },
    ],
    totalSizeBytes: archiveStat.size,
    ...(args['cuda-arch']
      ? { cudaArchitectures: args['cuda-arch'].split(';').filter(Boolean) }
      : {}),
    /*
     * ★ null = **我们没有测过驱动下限**，不是"没有要求"。
     *   手写 manifest 里那些 `vulkanApi:"1.2"` / `nvidiaDriver:"580"` 是 llama.cpp
     *   上游文档里的数字，whisper.cpp 的下限**不一定相同** —— 照抄过来就是编数字。
     *   这个字段只用于界面展示（`BackendPackCard.tsx:146`），不参与可安装性判定，
     *   所以 null 的代价是"少显示一行提示"，而编错的代价是"用户照着装了还是跑不起来"。
     *   真测出来了用 --requires-driver '{"vulkanApi":"1.2"}' 传进来。
     */
    requiresDriver: args['requires-driver'] ? JSON.parse(args['requires-driver']) : null,
    license,
    // 装完之后 `discoverTools()` 能在这个包里找到的东西。stage 是扁平的，
    // 但仍走 basename()，免得日后 stage 变成嵌套时这里悄悄产出带斜杠的名字。
    providesFiles: staged.map((f) => basename(f)),
    priority: PRIORITY[backend] ?? 10,
    // ★ 见文件头：CI 产物没有下载地址，必须如实说。
    availability: 'pending-ci',
    // R-02 拒绝编造 CUDA-vs-Vulkan 的数字，ADR-003 决策 3 依赖这份诚实。
    benchmark: null,
    catalogVersion: args['catalog-version'],
  };

  await writeFile(args['out'], `${JSON.stringify(pack, null, 2)}\n`);
  console.log(`emit-pack-manifest: wrote ${args['out']} (${staged.length} staged files)`);
}

await main();
