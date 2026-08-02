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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ArtifactStore, findInstalledByRole } from '@openmemo/downloader';

/** `active.json` 的形状：role → 已激活的模型 id（未激活为 null）。 */
type ActiveMap = Partial<Record<string, string | null>>;

interface InstallRecordFile {
  role?: string;
  name?: string;
  /** 新契约：根锚点 + 相对路径。 */
  root?: string;
  relPath?: string;
  /** @deprecated 旧记录里的绝对路径，仅作兼容回退。 */
  path?: string;
}

interface InstallRecord {
  id?: string;
  role?: string;
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
 * 解析某个 role 当前该用哪个模型。
 *
 * 顺序：`active.json` 指定的 → 该 role 下任意一个已装且完好的。
 * 都没有则返回 undefined（调用方应把 job 转 `blocked` 并给出安装引导，而不是硬失败）。
 */
export async function resolveActiveModel(
  modelsDir: string,
  role: string,
): Promise<ResolvedModel | undefined> {
  const active = readJson<ActiveMap>(join(modelsDir, 'active.json'));
  const wantedId = active?.[role] ?? null;

  const installed = await listInstalled(modelsDir, role);

  if (wantedId) {
    const rec = installed.find((r) => r.id === wantedId);
    const p = rec ? weightsPathOf(modelsDir, rec) : undefined;
    if (rec && p) return { id: wantedId, role, path: p };
    // active.json 指着一个已经不在的模型（用户删了）→ 不报错，往下退到"任意已装"
  }

  for (const rec of installed) {
    const p = weightsPathOf(modelsDir, rec);
    if (rec.id && p) return { id: rec.id, role, path: p };
  }
  return undefined;
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
// SQLite 扩展（中文分词器 + 向量检索）的安装位置解析（ADR-014 ③）
// ---------------------------------------------------------------------------

interface InstalledBackendRecord {
  id?: string;
  engine?: string;
  installPath?: string | null;
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
      if (existsSync(join(unpacked, 'libsimple.so')) || existsSync(join(unpacked, 'libsimple.dylib'))) {
        return unpacked;
      }
      // 有些包会把内容直接摊在 by-name/backend 下
      if (existsSync(unpacked)) return unpacked;
    }
  }
  return fallbackDir;
}
