/**
 * 从**模型安装记录**里解析模型路径（ADR-014 ②）。
 *
 * ## 为什么不能写死文件名
 *
 * 之前这里是 `firstExisting(modelsDir/'ggml-base.en.bin', modelsDir/'ggml-base.bin')`。
 * 冷启动实测：用户从网页装好 `whisper-base-q5_1`（下载 59.7MB → 校验 → 硬链到
 * `by-name/asr/ggml-base-q5_1.bin`）—— **装成功了，daemon 仍然报"没有模型"**，
 * 因为文件名不在那两个硬编码里，而且根本不在 `modelsDir` 根目录下。
 *
 * 用户视角：我明明装好了，它说没装。这是最难自查的一类 bug。
 *
 * ## 正确做法：读安装记录
 *
 * ```
 * <modelsDir>/active.json                    { "asr": "asr/whisper-base-q5_1", ... }
 * <modelsDir>/manifests/<role>/<id>.json     { files: [{ role:'weights', path:'/abs/...' }] }
 * <modelsDir>/by-name/<kind>/<file>          硬链，manifest 里的 path 指向它
 * ```
 * `active.json` 说用哪个，安装记录说它在哪。**两者都不需要我们猜文件名。**
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { copyFile, link, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { ArtifactStore, findInstalledByRole } from '@openmemo/downloader';

/** `active.json` 的形状：role → 已激活的模型 id（未激活为 null）。 */
type ActiveMap = Partial<Record<string, string | null>>;

interface InstallRecordFile {
  role?: string;
  name?: string;
  /** 内容寻址摘要。**它是唯一不会被同名文件覆盖的锚点** —— 见 materializeModelDir。 */
  sha256?: string;
  /** 新契约：根锚点 + 相对路径。 */
  root?: string;
  relPath?: string;
  /** @deprecated 旧记录里的绝对路径，仅作兼容回退。 */
  path?: string;
}

interface InstallRecord {
  id?: string;
  role?: string;
  /**
   * 引擎按它决定 `modelConfig` 的形状（transducer / paraformer / …）。
   * 老记录里没有这个字段，契约明写「`undefined` = 不知道，**不要**当成空集过滤掉」。
   */
  family?: string;
  files?: InstallRecordFile[];
  integrity?: string;
}

export interface ResolvedModel {
  readonly id: string;
  readonly role: string;
  /** 权重文件的绝对路径。 */
  readonly path: string;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/**
 * 列出某 role 下所有**校验通过**的安装记录。
 *
 * **判据是记录自己的 `role` 字段，不是它所在的目录名。**
 *
 * 原来这里读 `manifests/<role>/`，用目录名当类型。当时 StoreKind 只有 3 个桶、
 * 而 ModelRole 有 7 个，VAD 没有自己的桶只能塞进 `manifests/asr/` ——
 * 于是 `listInstalled(dir,'asr')` 会把 **VAD 模型当成 ASR 模型交出去**，
 * whisper 拿着 VAD 网络去转写，而 `pipeline.missing` 一路是绿的。
 * **绿灯和错误来自同一个事实**：目录名既是"在哪"又被当成"是什么"。
 *
 * 现在委托给 `findInstalledByRole()`：它扫**全部 8 个桶**再按 `role` 过滤，
 * 放错目录的记录仍被正确分类，没有 `role` 的记录**直接跳过而不是猜** ——
 * 猜正是这个 bug 的成因，宁可显式报"没装"。
 */
export async function listInstalled(modelsDir: string, role: string): Promise<InstallRecord[]> {
  const store = new ArtifactStore(modelsDir);
  return (await findInstalledByRole(store, role, { requireIntegrityOk: true })) as InstallRecord[];
}

/**
 * 一条文件记录 → 绝对路径。
 *
 * **优先 `root`+`relPath`**（新契约），旧记录回退到废弃的绝对 `path`。
 * 兼容分支不能省：已经装过模型的用户，记录里只有绝对路径；
 * 而绝对路径正是搬目录/换盘符/换机器会失效的那个东西。
 */
function absOf(modelsDir: string, f: InstallRecordFile): string | undefined {
  if (f.relPath) {
    // 目前只有 models 根会出现在模型安装记录里；其它根出现时按 models 处理并不合适，
    // 但契约上 role 决定不了根，只能信记录本身。
    const p = join(modelsDir, f.relPath);
    if (existsSync(p)) return p;
  }
  if (f.path && existsSync(f.path)) return f.path;
  return undefined;
}

/** 从一条安装记录里取权重文件路径（优先 `role:'weights'`，否则取第一个存在的文件）。 */
function weightsPathOf(modelsDir: string, rec: InstallRecord): string | undefined {
  const files = rec.files ?? [];
  const weights = files.find((f) => f.role === 'weights' && absOf(modelsDir, f));
  if (weights) return absOf(modelsDir, weights);
  for (const f of files) {
    const p = absOf(modelsDir, f);
    if (p) return p;
  }
  return undefined;
}

/**
 * 调用方对候选模型的额外要求。
 *
 * ## 这个参数是 T-148 的根因修复，不是可选的锦上添花
 *
 * `role` 只说"它是干什么用的"，**不说"谁能加载它"**。目录里同一个 `role: 'vad'` 底下
 * 躺着两个**互相加载不了**的文件，而且两条清单条目自己就写着这件事：
 *
 * ```
 * vad/silero-vad-onnx  engines:["sherpa-onnx"]  "whisper.cpp CANNOT load this file"
 * vad/silero-vad-ggml  engines:["whisper.cpp"]  "The sherpa-onnx engine CANNOT load this file"
 * ```
 *
 * 而 `models.ts:488` 是 `if (activateOnSuccess || !state.active[role])` —— **先装的那个赢**。
 * 目录里 onnx 排在 ggml 前面，于是任何一次冷装 `required-core` 都会让
 * `active.json.vad = "vad/silero-vad-onnx"`，这里再把那个 ONNX 文件交给
 * whisper.cpp 的 VAD 二进制 → `bad magic` → `failed to initialize whisper context` →
 * **整单转写死掉**（`[CI 实测]` run 31039460495，Linux 与 Windows 一字不差）。
 *
 * 所以调用方**必须**能说出"我要能被我这个引擎加载的那一个"，而不是只说 role。
 */
export interface ModelAcceptance {
  /** 逐个候选问一次；返回 false 就继续找下一个。判据应当钉后果（能不能加载），而不是钉文件名。 */
  readonly accept: (path: string, rec: InstallRecord) => boolean | Promise<boolean>;
  /** 全部候选都被否掉时，把被否掉的路径交回给调用方，用于写出一条**说得出原因**的诊断。 */
  readonly onRejected?: (rejected: readonly ResolvedModel[]) => void;
}

/**
 * 解析某个 role 当前该用哪个模型。
 *
 * 顺序：`active.json` 指定的 → 该 role 下任意一个已装且完好的。
 * 都没有则返回 undefined（调用方应把 job 转 `blocked` 并给出安装引导，而不是硬失败）。
 *
 * `opts.accept` 见 {@link ModelAcceptance}：**`active.json` 指定的那个同样要过这一关**。
 * 只在兜底分支上过滤是不够的 —— 出事的那次恰恰就是 `active.json` 指着错的那一个。
 */
export async function resolveActiveModel(
  modelsDir: string,
  role: string,
  opts?: ModelAcceptance,
): Promise<ResolvedModel | undefined> {
  const active = readJson<ActiveMap>(join(modelsDir, 'active.json'));
  const wantedId = active?.[role] ?? null;

  const installed = await listInstalled(modelsDir, role);

  // active.json 指定的排最前，其余按原顺序跟在后面；去重靠 id。
  const ordered: InstallRecord[] = [];
  if (wantedId) {
    const first = installed.find((r) => r.id === wantedId);
    if (first) ordered.push(first);
  }
  for (const rec of installed) {
    if (rec.id !== undefined && rec.id === wantedId) continue;
    ordered.push(rec);
  }

  const rejected: ResolvedModel[] = [];
  for (const rec of ordered) {
    const p = weightsPathOf(modelsDir, rec);
    if (!rec.id || !p) continue;
    const resolved: ResolvedModel = { id: rec.id, role, path: p };
    if (opts && !(await opts.accept(p, rec))) {
      rejected.push(resolved);
      continue;
    }
    return resolved;
  }
  if (rejected.length > 0) opts?.onRejected?.(rejected);
  return undefined;
}

/**
 * 按**模型 id** 解析路径（用户在界面上显式选了某个模型时用）。
 *
 * 仍然按 `role` 过滤（走 findInstalledByRole），所以选不到别的 role 的权重 ——
 * 这正是"VAD 被当成 ASR"那个 bug 的防线，显式选择路径同样受它保护。
 */
export async function resolveModelById(
  modelsDir: string,
  role: string,
  id: string,
): Promise<ResolvedModel | undefined> {
  const installed = await listInstalled(modelsDir, role);
  const rec = installed.find((r) => r.id === id);
  if (!rec) return undefined;
  const p = weightsPathOf(modelsDir, rec);
  return p ? { id, role, path: p } : undefined;
}

/**
 * 兜底扫描：直接在 `by-name/<kind>/` 里找匹配的文件。
 *
 * 用于安装记录缺失但文件确实在的情况（例如用户手工拷了一个模型进去）。
 * **仍然不写死文件名** —— 用后缀 + 关键词匹配。
 */
export function scanByName(
  modelsDir: string,
  kind: string,
  opts: { readonly ext: string; readonly includes?: string; readonly excludes?: string },
): string | undefined {
  const dir = join(modelsDir, 'by-name', kind);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const hit = names
    .filter((n) => n.endsWith(opts.ext))
    .filter((n) => (opts.includes ? n.toLowerCase().includes(opts.includes) : true))
    // 排除项存在的理由：这个兜底是"没有安装记录时按文件名猜"，
    // 而猜错的代价是把 VAD 权重当 ASR 交出去（静默跑错模型）。
    .filter((n) => (opts.excludes ? !n.toLowerCase().includes(opts.excludes) : true))
    .sort();
  return hit[0] ? join(dir, hit[0]) : undefined;
}

// ---------------------------------------------------------------------------
// 多文件模型（sherpa transducer / Paraformer / 标点）的解析（T-160）
//
// whisper 的模型是**一个** ggml 文件，所以上面那套「role → 一个权重路径」够用。
// sherpa 系不是：一条流式模型是 encoder + decoder + joiner + tokens **四个文件**，
// Paraformer 是 model + tokens（+ am.mvn）。它们要的是"一组文件"，而且引擎按
// **扩展名**校验（实测：喂 `.bin` 会被拒 `Please pass *.onnx`），所以不能直接交 blob 路径。
// ---------------------------------------------------------------------------

/** 一条安装记录的最小视图 —— 只暴露解析用得到的部分。 */
export interface InstalledModelRecord {
  readonly id: string;
  /** 老记录可能没有；契约明写 `undefined` = 未知，不得当成"没有引擎能加载它"。 */
  readonly family: string | undefined;
  /** **记录里声明的**文件名（不是从磁盘 readdir 猜的）。 */
  readonly fileNames: readonly string[];
  /** @internal 交回给 materializeModelDir 用。 */
  readonly raw: unknown;
}

/** 列出某 role 下所有校验通过的安装记录（多文件模型用）。 */
export async function listInstalledModelRecords(
  modelsDir: string,
  role: string,
): Promise<InstalledModelRecord[]> {
  const recs = await listInstalled(modelsDir, role);
  const out: InstalledModelRecord[] = [];
  for (const rec of recs) {
    if (!rec.id) continue;
    out.push({
      id: rec.id,
      family: rec.family,
      fileNames: (rec.files ?? []).map((f) => f.name).filter((n): n is string => !!n),
      raw: rec,
    });
  }
  return out;
}

/** id → 文件系统安全的目录名（与 ArtifactStore.sanitizeId 同一口径）。 */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

/**
 * 一个模型独占目录的位置。**写入方与清理方共用这一份**。
 *
 * 卸载时要把它删掉（T-164 ⑥：留下的硬链让磁盘回收不了，也让"已删除"的模型
 * 继续被发现路径找到）。两处各写一遍 `join(modelsDir,'by-model',sanitize(id))`
 * 的下场是可预见的：`sanitizeId` 的规则一改，清理方就开始删不到东西 ——
 * 而"删不到"是静默的。
 */
export function byModelDir(modelsDir: string, id: string): string {
  return join(modelsDir, 'by-model', sanitizeId(id));
}

async function linkOrCopy(src: string, dest: string): Promise<void> {
  await rm(dest, { force: true });
  try {
    await link(src, dest);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // 跨文件系统 / 权限 / 不支持硬链 —— 退回复制（与 ArtifactStore.linkByName 同一处理）
    if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP') await copyFile(src, dest);
    else throw e;
  }
}

function sameInode(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.ino === sb.ino && sa.dev === sb.dev && sa.ino !== 0;
  } catch {
    return false;
  }
}

/**
 * 把一条安装记录摊成**这个模型独占的一个目录**：`<modelsDir>/by-model/<id>/<原文件名>`。
 *
 * ## 为什么必须这么做，而不是直接用 `by-name/<kind>/<name>`
 *
 * `by-name` 是**按文件名**的视图，而文件名在模型之间**会撞**。目录里现成的一对：
 *
 * ```
 * asr/sherpa-streaming-zh-14m  →  tokens.txt  48697 B  sha256 8b294db9…
 * asr/paraformer-zh-small      →  tokens.txt  75352 B  sha256 4b2d964e…
 * ```
 *
 * 两条都是 `role: asr`，于是都硬链到 `by-name/asr/tokens.txt`，而 `linkByName()`
 * 是 `rm(target)` 之后再 `link()` —— **后装的那个把先装的那个顶掉**，
 * 且两条安装记录的 `relPath` 仍然都指着这一个路径。后果不是"装不上"，
 * 是**装上了、跑起来了、吐出来的字是错的**：ADR-013 的中文默认引擎与 F3 流式引擎
 * 只要同时装，就一定有一个拿着别人的词表。这是"绿灯与错误来自同一个事实"那一族。
 *
 * ## 锚点用 blob，不用 by-name
 *
 * blob 是**内容寻址**的（文件名就是 sha256），从定义上不可能被同名文件覆盖。
 * 所以这里优先从 `blobs/sha256-…` 硬链过来；blob 不在（老库、手工塞进来的文件）
 * 才退回记录里的 `relPath`。硬链不额外占磁盘，跨卷失败时退回复制。
 *
 * ## 为什么不直接把 blob 路径交给引擎
 *
 * sherpa 按**扩展名**校验（实测报错原文 `Please pass *.onnx ... Given '.../ggml-base.en.bin'`），
 * 而 blob 文件名是 `sha256-<hex>`，没有扩展名。所以必须有一层带真实文件名的视图。
 *
 * @returns 目录绝对路径；一个文件都摊不出来时返回 undefined（**不返回半个目录**）。
 */
export async function materializeModelDir(
  modelsDir: string,
  rec: InstalledModelRecord,
): Promise<string | undefined> {
  const raw = rec.raw as InstallRecord;
  const files = raw.files ?? [];
  if (files.length === 0) return undefined;

  const dir = byModelDir(modelsDir, rec.id);
  const store = new ArtifactStore(modelsDir);
  let linked = 0;

  await mkdir(dir, { recursive: true });
  for (const f of files) {
    if (!f.name) continue;
    const blob = f.sha256 ? store.blobPath(f.sha256) : undefined;
    const src = blob && existsSync(blob) ? blob : absOf(modelsDir, f);
    if (!src) continue;
    const dest = join(dir, f.name);
    // 已经是同一个 inode 就什么都不用做（每次启动都会跑，必须幂等且便宜）
    if (!sameInode(src, dest)) await linkOrCopy(src, dest);
    linked += 1;
  }
  return linked > 0 ? dir : undefined;
}

// ---------------------------------------------------------------------------
// SQLite 扩展（中文分词器 + 向量检索）的安装位置解析（ADR-014 ③）
// ---------------------------------------------------------------------------

interface InstalledBackendRecord {
  id?: string;
  engine?: string;
  linkInto?: string | null;
  files?: InstallRecordFile[];
}

/**
 * 找到已安装的 SQLite 扩展目录。
 *
 * `sqlite-ext` 是**当作后端包装的**（`vendor/manifests/sqlite-ext.json` 里是 `packs`），
 * 下载器验完 sha256 后会把 `.tar.gz` 解到
 * `<modelsDir>/by-name/backend/<archive-name-without-ext>/`。
 *
 * 而 daemon 的扩展加载器原先只看 `<dataDir>/bin/ext` —— 两边对不上，
 * 于是"网页装好了中文分词器，搜索仍然是 trigram 降级"。
 * 这里改为**读安装记录**，与模型解析同一原则：不猜路径。
 *
 * @param fallbackDir 没有安装记录时的兜底（环境变量或 `<dataDir>/bin/ext`）
 */
export function resolveExtensionDir(modelsDir: string, fallbackDir: string): string {
  const dir = join(modelsDir, 'manifests', 'backend');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return fallbackDir;
  }

  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const rec = readJson<InstalledBackendRecord>(join(dir, n));
    if (rec?.engine !== 'sqlite-ext') continue;

    // 解包目录 = 归档文件所在目录下、去掉后缀的同名目录
    for (const f of rec.files ?? []) {
      const archive = f.relPath ? join(modelsDir, f.relPath) : f.path;
      if (!archive) continue;
      const unpacked = archive.replace(/\.(zip|tar\.gz|tgz)$/i, '');
      if (
        existsSync(join(unpacked, 'libsimple.so')) ||
        existsSync(join(unpacked, 'libsimple.dylib'))
      ) {
        return unpacked;
      }
      // 有些包会把内容直接摊在 by-name/backend 下
      if (existsSync(unpacked)) return unpacked;
    }
  }
  return fallbackDir;
}
