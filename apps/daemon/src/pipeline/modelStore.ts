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

/** `active.json` 的形状：role → 已激活的模型 id（未激活为 null）。 */
type ActiveMap = Partial<Record<string, string | null>>;

interface InstallRecordFile {
  role?: string;
  name?: string;
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

/** 列出某 role 下所有**校验通过**的安装记录。 */
export function listInstalled(modelsDir: string, role: string): InstallRecord[] {
  const dir = join(modelsDir, 'manifests', role);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: InstallRecord[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const rec = readJson<InstallRecord>(join(dir, n));
    // integrity 不是 'ok' 的记录一律不用 —— 宁可报"没装"，也不要拿一个校验失败的权重去推理
    if (rec && rec.integrity === 'ok') out.push(rec);
  }
  return out;
}

/** 从一条安装记录里取权重文件路径（优先 `role:'weights'`，否则取第一个存在的文件）。 */
function weightsPathOf(rec: InstallRecord): string | undefined {
  const files = rec.files ?? [];
  const weights = files.find((f) => f.role === 'weights' && f.path && existsSync(f.path));
  if (weights?.path) return weights.path;
  const any = files.find((f) => f.path && existsSync(f.path));
  return any?.path;
}

/**
 * 解析某个 role 当前该用哪个模型。
 *
 * 顺序：`active.json` 指定的 → 该 role 下任意一个已装且完好的。
 * 都没有则返回 undefined（调用方应把 job 转 `blocked` 并给出安装引导，而不是硬失败）。
 */
export function resolveActiveModel(modelsDir: string, role: string): ResolvedModel | undefined {
  const active = readJson<ActiveMap>(join(modelsDir, 'active.json'));
  const wantedId = active?.[role] ?? null;

  const installed = listInstalled(modelsDir, role);

  if (wantedId) {
    const rec = installed.find((r) => r.id === wantedId);
    const p = rec ? weightsPathOf(rec) : undefined;
    if (rec && p) return { id: wantedId, role, path: p };
    // active.json 指着一个已经不在的模型（用户删了）→ 不报错，往下退到"任意已装"
  }

  for (const rec of installed) {
    const p = weightsPathOf(rec);
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
  opts: { readonly ext: string; readonly includes?: string },
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
      if (!f.path) continue;
      const unpacked = f.path.replace(/\.(zip|tar\.gz|tgz)$/i, '');
      if (existsSync(join(unpacked, 'libsimple.so')) || existsSync(join(unpacked, 'libsimple.dylib'))) {
        return unpacked;
      }
      // 有些包会把内容直接摊在 by-name/backend 下
      if (existsSync(unpacked)) return unpacked;
    }
  }
  return fallbackDir;
}
