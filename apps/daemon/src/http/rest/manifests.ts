/**
 * 内置目录（`vendor/manifests/*.json`，ADR-001 C 类产物）的加载与校验。
 *
 * 这里读的是**仓库里 git 提交的真实 manifest**，不是 mock。加载时用
 * `@openmemo/shared` 的 zod schema 校验：manifest 里一个手打错的 sha256 或 sizeBytes
 * 会让用户在下载几 GB 之后才失败，在启动时就拒绝掉要便宜得多。
 */
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateBackendManifest,
  validateModelManifest,
  type BackendPack,
  type ModelEntry,
} from '@openmemo/shared';

/**
 * manifest 文档外壳。
 *
 * `packages/shared` 只导出了 zod schema、没有导出这个外层 interface，所以在这里补一个
 * **文件格式**类型（不是 API 响应形状，不违反"响应类型只从 shared 取"的约定）。
 */
interface ModelManifestDoc {
  schemaVersion: 1;
  catalogVersion: string;
  generatedAt: string;
  models: ModelEntry[];
}

interface BackendManifestDoc {
  schemaVersion: 1;
  catalogVersion: string;
  generatedAt: string;
  packs: BackendPack[];
}

/**
 * 清单目录读不了时的原因。**`null` 表示"目录真的读到了"**（哪怕里面零条）。
 *
 * ## 为什么必须有这个字段（T-153）
 *
 * 在此之前 `listManifestFiles()` 是 `catch { return []; }` —— 目录不存在、没权限、
 * 或那个路径根本是个文件，全部安静地变成"零条清单"。于是
 * `loadModelCatalog()` 返回 `{ catalogVersion: '0', models: [] }`，
 * **和"目录里本来就没有模型"在调用方眼里一模一样。**
 *
 * `[实测]` 用户双击打开之后看到 `packs 0`、组件页全空。他会去找"为什么没有包可装"，
 * 而正确的问题是"为什么清单没加载"。**这两个问题的答案不在同一个地方。**
 *
 * 仓库里早就有一句一字不差的判词（`pipeline/probeShipping.test.ts:101`）：
 *
 * > **「`backends.json` 解析出 0 个包 —— 空集不是"没问题"，是"什么都没检查"」**
 *
 * 同一条道理，在模型/后端目录这一侧从来没有被贯彻。
 *
 * 判据形状与本仓已经反复确立的那条相同：**`UNKNOWN` / 空 / 真零，三者必须分得开**
 * —— 和 `null` vs `[]`（解析器失败 vs 解析器说没有）、`UNDECIDED` vs 绿、
 * `N/A` vs `UNKNOWN` 是同一件事。
 *
 * ⚠️ 对**这个**目录而言，`ENOENT` 也算故障，不算"合法的空"：
 * `vendor/manifests` 是随产品出厂的东西，它不存在就是安装坏了。
 * （与 `<模型根>/manifests/<桶>/` 不同 —— 那里 ENOENT 表示"这类东西还没装过"，
 * 是合法的零。两者不能用同一条规则，所以这里写明。）
 */
export interface CatalogLoadError {
  /** 试图读的目录。 */
  dir: string;
  /** `ENOENT` / `EACCES` / `ENOTDIR` …；拿不到就是 `'UNKNOWN'`。 */
  code: string;
  /** 原始错误信息，供日志与诊断页显示。 */
  message: string;
  /** 给人看的一句话。**不含可点的下一步** —— 见下面 `describeCatalogLoadError` 的注释。 */
  messageZh: string;
}

export interface ModelCatalog {
  catalogVersion: string;
  models: ModelEntry[];
  /** `null` = 清单目录确实读到了（models 为空就是真的零条）。 */
  loadError: CatalogLoadError | null;
}

export interface BackendCatalog {
  catalogVersion: string;
  packs: BackendPack[];
  /** `null` = 清单目录确实读到了（packs 为空就是真的零个）。 */
  loadError: CatalogLoadError | null;
}

/*
 * ⚠️ **不要再写死文件名清单**（ADR-014）。
 *
 * 曾经这里是 `['models-whisper.json','models-llm.json']`，于是磁盘上真实存在的
 * `models-asr-support.json`（VAD / Paraformer / 标点）与 `sqlite-ext.json`（中文分词器）
 * **从来没被加载过** —— 上游把东西加进目录了，下游看不见，
 * 表现成"网页上根本没有 VAD 这一项"，排查时会怀疑上游没做，其实是这一行挡的。
 *
 * 改为**列目录**：manifest 目录下所有 `*.json` 都尝试加载，按内容判类型。
 * 这样上游加文件，下游自动看见，不需要两边同步改。
 */

/** 文件名 → 类型的判定不靠命名约定，靠内容里有没有 `models` / `packs` 数组。 */
type ManifestKind = 'model' | 'backend' | 'unknown';

function classifyManifest(raw: unknown): ManifestKind {
  if (!raw || typeof raw !== 'object') return 'unknown';
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o['models'])) return 'model';
  if (Array.isArray(o['packs'])) return 'backend';
  return 'unknown';
}

/**
 * 列出 manifest 目录里所有 `*.json`（排除 schema.json 这类非目录文件）。
 *
 * ★ T-153：返回 `{ files, error }` 而不是光秃秃一个数组。
 * 旧签名 `Promise<string[]>` 在结构上**没有能力**区分"读不了"与"零条"，
 * 于是调用方也不可能区分 —— 这不是调用方写得不小心，是返回类型不允许他小心。
 */
async function listManifestFiles(
  manifestDir: string,
): Promise<{ files: string[]; error: CatalogLoadError | null }> {
  let names: string[];
  try {
    names = await fs.readdir(manifestDir);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { files: [], error: describeCatalogLoadError(manifestDir, err) };
  }
  return {
    files: names
      .filter((n) => n.endsWith('.json') && n !== 'schema.json')
      .sort()
      .map((n) => path.join(manifestDir, n)),
    error: null,
  };
}

/**
 * 把 errno 翻成一句**给人看**的话。
 *
 * ## 为什么这里没有 remediation（"可点的下一步"）
 *
 * `apps/web/src/lib/remediation/routes.ts` 记着：**26 个调用点里 23 个是刻意不给按钮的**，
 * 理由写在那份表里 ——「给一个点了没用的按钮，比不给按钮更糟（它教会用户忽略按钮）」。
 * 这个场景正属于那 23 个：
 *
 * - 清单是**随产品出厂**的（`vendor/manifests/`，`build-bundle.mjs` 放进包里）。
 *   用户在应用内**没有任何动作**能把它装回来 —— 没有"重新下载目录"这个功能，
 *   也不该有：那等于让一个坏掉的安装自己去修自己。
 * - 唯一真实的下一步是"重装/重新解压应用"，那**不在应用里**。
 *
 * 所以给的是**一句能让人知道发生了什么的话**，而不是一个按钮：
 * 说清「不是没有包，是清单没读到」+ 读的是哪个路径 + 系统给的原因。
 * 有了这三样，用户自己或帮他排查的人才问得出对的问题。
 */
function describeCatalogLoadError(dir: string, err: NodeJS.ErrnoException): CatalogLoadError {
  const code = err.code ?? 'UNKNOWN';
  const why =
    code === 'ENOENT'
      ? '目录不存在'
      : code === 'EACCES' || code === 'EPERM'
        ? '没有读取权限'
        : code === 'ENOTDIR'
          ? '这个路径不是目录'
          : `读取失败（${code}）`;
  return {
    dir,
    code,
    message: err.message ?? String(err),
    /*
     * ⚠️ 第一句必须是**否定用户会做的那个推断**。
     * 用户看到的是"0 个可用"，他的默认解释是"确实没有东西可装"；
     * 不先把这句话推翻，后面写多少路径他都不会读。
     */
    messageZh:
      `不是"没有可用项"，是**内置目录没能读取** —— ${why}。\n` +
      `找的是：${dir}\n` +
      `系统原因：${code} ${err.message ?? ''}\n` +
      `这份目录随应用出厂，应用内没有办法重新下载它；` +
      `多半是安装包解压不全或被安全软件拦了，重装/重新解压一次即可。`,
  };
}

/**
 * 定位 `vendor/manifests`。
 *
 * ## 兜底从三条收敛成两条（2026-08-08），因为第三条是缺陷的一部分
 *
 * 原来是：环境变量 > 模块相对 > **`process.cwd()`**。
 * `[实测]` 用户双击打开之后 `packs = 0, groups = 0` —— 组件页整个是空的，
 * 于是 ffmpeg / whisper / yt-dlp 一个都装不了，导入和转写全废。三条**全落空**：
 *   ① 环境变量 —— 没人设；
 *   ② 模块相对 —— **包里当时没有 `vendor/`**（现已随包出厂，见 build-bundle.mjs）；
 *   ③ cwd —— **启动器 `cd` 进了 `app/daemon`**。
 *
 * **而 CI 一直是绿的**：旧的直接启动方式 cwd = 仓库检出目录，那里正好有
 * `vendor/manifests` —— 第三条**碰巧**落上，把前两条的失败遮了几个月。
 *
 * 所以第三条被删掉，不是因为它"没用"，是因为**它让前两条的失败不可见**：
 * 一条碰巧成立的兜底，等价于一个关掉的告警。
 *
 * 剩下的两条里，第 ② 条**在两种布局里算出来的都是对的**（都是上溯 5 层）：
 *   仓库   `apps/daemon/{src,dist}/http/rest` → 仓库根 → `vendor/manifests` ✔
 *   包内   `app/daemon/dist/http/rest`        → 包根   → `vendor/manifests` ✔
 * 一条规则同时覆盖"双击 / 终端跑启动器 / 从别的目录调启动器 / CI 直接起 daemon"
 * 四种启动方式 —— 它们的差别只在 cwd，而这一条**不看 cwd**。
 *
 * ## 找不到时**必须出声**
 *
 * 旧实现返回一个不存在的路径，`listManifestFiles()` 会 catch 掉 readdir 的错
 * 并返回 `[]` —— 于是"目录空的"和"根本没找到目录"在下游**长得一模一样**。
 * 用户看到的是一个空列表，没有任何一处说过发生了什么。
 * 现在找不到就打一行醒目的日志（含找过哪些位置），让它可诊断。
 *
 * 必须同步，因为 server.ts 的接线点没有 await 的余地。
 */
export function resolveManifestDir(): string {
  const fromEnv = process.env['OPENMEMO_MANIFEST_DIR'];
  if (fromEnv) return fromEnv;

  const here = path.dirname(fileURLToPath(import.meta.url));
  // {仓库根|包根}/…/{src,dist}/http/rest 上溯 5 层；两种布局层级相同
  const moduleRelative = path.resolve(here, '..', '..', '..', '..', '..', 'vendor', 'manifests');
  if (existsSync(moduleRelative)) return moduleRelative;

  console.warn(
    `[daemon] ⚠️ 找不到组件目录 vendor/manifests —— 组件页与模型页会是空的，` +
      `装不了 ffmpeg / whisper / 模型。\n` +
      `   找过：OPENMEMO_MANIFEST_DIR（未设）、${moduleRelative}（不存在）。\n` +
      `   预编译包里它应当随包出厂；开发树里它应当在仓库根的 vendor/manifests。`,
  );
  return moduleRelative;
}

async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function loadModelCatalog(manifestDir: string): Promise<ModelCatalog> {
  const models: ModelEntry[] = [];
  const seen = new Set<string>();
  let catalogVersion = '0';

  const listing = await listManifestFiles(manifestDir);
  // 读不了就**直接把原因带出去**，不要再往下走成一个"零条目录"。
  if (listing.error) return { catalogVersion, models, loadError: listing.error };

  for (const file of listing.files) {
    const raw = await readJsonFile(file);
    if (classifyManifest(raw) !== 'model') continue; // 后端目录/其它文件跳过
    const checked = validateModelManifest(raw);
    if (!checked.ok) {
      throw new Error(`模型 manifest 校验失败 ${file}: ${checked.errors.slice(0, 5).join('; ')}`);
    }
    // zod 已按 shared 的 ModelEntrySchema 校验通过，schema 与 ModelEntry 同源，可以断言。
    const doc = raw as ModelManifestDoc;
    for (const m of doc.models) {
      // 多个文件里出现同一个 id 时以先读到的为准，避免目录里出现重复项
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      models.push(m);
    }
    catalogVersion = doc.catalogVersion;
  }

  return { catalogVersion, models, loadError: null };
}

export async function loadBackendCatalog(manifestDir: string): Promise<BackendCatalog> {
  const packs: BackendPack[] = [];
  const seen = new Set<string>();
  let catalogVersion = '0';

  const listing = await listManifestFiles(manifestDir);
  if (listing.error) return { catalogVersion, packs, loadError: listing.error };

  for (const file of listing.files) {
    const raw = await readJsonFile(file);
    if (classifyManifest(raw) !== 'backend') continue;
    const checked = validateBackendManifest(raw);
    if (!checked.ok) {
      throw new Error(`后端 manifest 校验失败 ${file}: ${checked.errors.slice(0, 5).join('; ')}`);
    }
    const doc = raw as BackendManifestDoc;
    for (const p of doc.packs) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      packs.push(p);
    }
    catalogVersion = doc.catalogVersion;
  }

  return { catalogVersion, packs, loadError: null };
}

/**
 * 随预编译包出厂的 **CPU 基线运行时**目录（`<包根>/runtime/probe`）。
 *
 * ## 为什么这里也要有一条"模块相对"的解析
 *
 * 启动脚本会设 `OPENMEMO_BUNDLED_WHISPER_DIR`，但那**只修双击那一条路**。
 * `[CI 实测 2026-08-08 run 31263973429]` 我自己那条冷启动腿是**直接起 daemon** 的
 * （cwd = 检出目录、不经启动器），于是包里明明带了 whisper-cli，
 * `pipeline.missing` 里**照样有 `whisper-cli`** —— 与 manifests 那条是同一个病：
 * **能不能用，不该取决于你从哪儿启动。**
 *
 * 所以按与 `resolveManifestDir()` 完全相同的方式上溯 5 层：
 *   包内   `app/daemon/dist/http/rest` → 包根 → `runtime/probe` ✔
 *   仓库   `apps/daemon/dist/http/rest` → 仓库根 → `runtime/probe`（不存在 → 返回 null，
 *          开发树本来就该走已安装的后端包，不该有包内兜底）
 *
 * 返回 `null` 表示"这不是一个自带 CPU 运行时的布局"，调用方据此不设那个环境变量。
 */
export function resolveBundledWhisperDir(): string | null {
  const fromEnv = process.env['OPENMEMO_BUNDLED_WHISPER_DIR'];
  if (fromEnv) return fromEnv;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const guess = path.resolve(here, '..', '..', '..', '..', '..', 'runtime', 'probe');
  return existsSync(guess) ? guess : null;
}
