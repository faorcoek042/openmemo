/**
 * Tool resolution.
 *
 * Every native tool this package drives is spawned by its resolved absolute path —
 * never a bare command name. Two reasons:
 *   1. Never spawning a bare name defeats PATH injection (a hostile `ffmpeg` earlier in
 *      PATH would win if we ever did). This is D-01 §8.4 L2, "never through shell"
 *      (`D-01:1172`) — L2 bans shell invocation, not resolving via PATH. Those are
 *      different steps: resolution (may walk PATH — see `RESOLUTION_PLANS` below) always
 *      happens before spawn (never a bare name). ⚠️ An earlier version of this comment
 *      conflated the two into "D-01 §8.4 L2 forbids PATH lookups" — that claim was
 *      fabricated. See the 2026-08-09/08-10 correction below `discoverTools`.
 *   2. ADR-001 class C: these binaries are runtime downloads under our managed runtime
 *      directory, not system packages. Their location is ours to know.
 *
 * `discoverTools` is the **production** resolver. Each tool declares its own tier order
 * explicitly — see `RESOLUTION_PLANS` below — because "installed packs, then PATH, then
 * bundle" is not the right order for every tool. Callers may still pass paths explicitly,
 * and those always win.
 */

import { access, constants, cp, mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, relative } from 'node:path';

import { isGgmlModelFile, unpackDirName } from '@openmemo/downloader';
import { bundledRuntimeDir } from '@openmemo/runtime';
import { BACKENDS, type Backend } from '@openmemo/shared';

export interface ToolPaths {
  ffmpeg: string;
  ffprobe: string;
  /** whisper.cpp CLI, from the L1 core pack built by scripts/build-whisper.sh. */
  whisperCli: string | null;
  /** whisper.cpp VAD segmenter, also from the L1 core pack. */
  whisperVad: string | null;
  /**
   * Silero VAD weights **in ggml format** — the only thing whisper.cpp's VAD can load.
   *
   * NOT "any installed model whose role is vad": the catalog also ships
   * `silero_vad.onnx` for sherpa-onnx, and its own description says whisper.cpp cannot
   * load it. Whoever fills this field owes the reader that guarantee (T-148).
   */
  vadModel: string | null;
  /**
   * yt-dlp. Nullable BY DESIGN — TD-002 requires the product to work without it.
   * Nothing outside media/sources/ytdlp.ts may read this field.
   */
  ytDlp: string | null;
}

export interface ManagedDirs {
  /** Scratch space for downloads and intermediate audio. Never the user's home. */
  tempDir: string;
  /** Where installed runtime packs live. */
  runtimesDir: string;
  /** Where models live. */
  modelsDir: string;
}

export async function isExecutable(path: string | null | undefined): Promise<boolean> {
  if (path === null || path === undefined || path.length === 0) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function fileExists(path: string | null | undefined): Promise<boolean> {
  if (path === null || path === undefined || path.length === 0) return false;
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * THE single definition of where installed artifacts live.
 *
 * ── Why this takes an explicit `dataDir` (D-08 D4) ────────────────────────────────────
 * The earlier version derived everything from environment variables. That works when the
 * daemon is started via `OPENMEMO_DATA_DIR`, and silently breaks when it is started with
 * `--data-dir`: the daemon installs into `<flag-dir>/models` while `discoverTools()` goes
 * looking under the platform default and finds nothing. The user sees "installed
 * successfully" followed by "not installed" — the exact bug T-042 fixed for the default
 * directory and did NOT fix for a non-default one.
 *
 * So callers that know the data directory MUST pass it. The env/platform fallback is only
 * for standalone use (CLI tools, tests) where nobody knows better.
 *
 * ── Windows: APPDATA, not LOCALAPPDATA (D-08 D3) ──────────────────────────────────────
 * There were three derivations of this path and they disagreed: the daemon's
 * `config/paths.ts` used `%APPDATA%` while this file and `@openmemo/downloader`'s
 * `store.ts` used `%LOCALAPPDATA%`. On Windows that means the downloader writes to
 * `…\Local\OpenMemo\models` and the pipeline searches `…\Roaming\OpenMemo\models` —
 * an installed pack could never be found, on every Windows machine, always.
 *
 * The daemon's `paths.ts` is canonical (D-02 §6.1 defines the data dir), so this now
 * follows APPDATA. Note that with `resolveStoreRoot(dataDir)` wired through, this
 * fallback is not reached on the daemon path at all — which is the real fix; matching the
 * constant is belt and braces.
 */
export function resolveStoreRoot(dataDir?: string): string {
  const explicit = process.env['OPENMEMO_MODELS'];
  if (explicit !== undefined && explicit.length > 0) return explicit;

  if (dataDir !== undefined && dataDir.length > 0) return join(dataDir, 'models');

  const envDataDir = process.env['OPENMEMO_DATA_DIR'];
  if (envDataDir !== undefined && envDataDir.length > 0) return join(envDataDir, 'models');

  const home = homedir();
  if (process.platform === 'win32') {
    // APPDATA (Roaming) — matches apps/daemon/src/config/paths.ts, the canonical source.
    return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'OpenMemo', 'models');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'OpenMemo', 'models');
  }
  return join(process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'openmemo', 'models');
}

/** @deprecated Pass the data directory explicitly via {@link resolveStoreRoot}. */
export function defaultStoreRoot(): string {
  return resolveStoreRoot();
}

/* ==========================================================================================
 * 后端包的**选择**（T-162）
 * ========================================================================================== */

/**
 * 用户在「运行时」页选中的后端，落盘的位置。
 *
 * `RestState` 把偏好写在 `<storeRoot>/prefs.json`（`POST /api/backends/select` →
 * `prefs.selectedBackend` → 落盘），与 `active.json`（哪个模型被激活）是同一族：
 * **用户的选择存放在制品旁边，流水线在装配时读回来**
 * （`apps/daemon/src/pipeline/modelStore.ts` 读 `active.json` 早就是这个形状）。
 *
 * 路径在这里导出、由 `RestState.prefsFile` 反过来引用，所以"这个文件叫什么"
 * 只有一个答案。同一个问题有两个答案，本仓已经付过四次代价
 * （`%APPDATA%` vs `%LOCALAPPDATA%`、`bin/runtime` vs `by-name/backend`、
 * `installPath` 的三个含义、whisper-cli 的四个出口）。
 */
export function backendPrefsPath(storeRoot: string): string {
  return join(storeRoot, 'prefs.json');
}

/**
 * 用户选中的后端；从未选过（或文件读不出来）返回 `null`。
 *
 * `null` 的含义是"**没有选择**"，不是"选了 cpu" —— 两者在下面的排序里不同：
 * 前者交给 `priority` 决定，后者是用户明确要求跑 CPU 那个包。
 */
export async function readSelectedBackend(storeRoot: string): Promise<Backend | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(backendPrefsPath(storeRoot), 'utf8'));
    const value = (raw as { selectedBackend?: unknown }).selectedBackend;
    if (typeof value !== 'string') return null;
    return (BACKENDS as readonly string[]).includes(value) ? (value as Backend) : null;
  } catch {
    return null;
  }
}

/** 一个 `by-name/backend/` 下的目录属于哪个已安装的包。 */
export interface BackendPackOrigin {
  readonly packId: string;
  readonly backend: Backend;
  /**
   * `InstalledBackendPack.engine`（whisper.cpp / ffmpeg / yt-dlp / …）。
   *
   * 用来回答"选中的后端**本来**该不该提供这个二进制"：whisper 包与 media-tools 包
   * 是两个引擎，选了 vulkan 而 ffmpeg 来自 media-tools 是**正常**的，不是降级。
   * 少了这一格，`degraded` 会对每一个不相干的工具报警 —— 而
   * 「一条会对不相干的东西发表意见的检查，说对的时候也不该被相信」。
   */
  readonly engine: string;
  /**
   * 目录里那条 `BackendPack.priority`（"Higher wins when several packs match the same
   * hardware"），安装时抄进安装记录。**老安装记录没有这个字段 → `null`**，
   * 排序时按 0 处理：它只在"用户没选过后端"时才起作用，重装一次该包即可回填。
   */
  readonly priority: number | null;
}

interface RawInstalledPack {
  id?: unknown;
  backend?: unknown;
  engine?: unknown;
  priority?: unknown;
  files?: { name?: unknown }[];
}

/**
 * 把 `by-name/backend/` 下的每个条目**反查**回是哪个包装的。
 *
 * 证据来自安装记录 `<storeRoot>/manifests/backend/<id>.json`（`InstalledBackendPack`），
 * 不是目录名里的字符串。判据必须是结构而不是关键词：目录名叫
 * `whispercpp-vulkan-linux-x64` 只是上游今天的命名习惯，而
 * `jellyfin-ffmpeg_8.1.2-2_portable_macarm64-gpl.tar.xz` 里一个后端名都没有。
 * 按名字猜是"同名不同物、而系统按名字工作"那一族（`tokens.txt` 互相顶掉是最近一例）。
 *
 * 一个包会占两个键：解包目录（`unpackDirName(files[].name)`，安装器建目录用的就是它）
 * 与扁平硬链名（`files[].name` 本身，单文件包如 yt-dlp 走这条）。
 */
async function readInstalledPackOrigins(
  storeRoot: string,
): Promise<Map<string, BackendPackOrigin>> {
  const out = new Map<string, BackendPackOrigin>();
  const dir = join(storeRoot, 'manifests', 'backend');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let rec: RawInstalledPack;
    try {
      rec = JSON.parse(await readFile(join(dir, entry), 'utf8')) as RawInstalledPack;
    } catch {
      continue; // 读不出来的记录 = 没有记录，不猜
    }
    const packId = typeof rec.id === 'string' ? rec.id : null;
    const backend =
      typeof rec.backend === 'string' && (BACKENDS as readonly string[]).includes(rec.backend)
        ? (rec.backend as Backend)
        : null;
    if (packId === null || backend === null) continue;
    const origin: BackendPackOrigin = {
      packId,
      backend,
      engine: typeof rec.engine === 'string' ? rec.engine : '',
      priority: typeof rec.priority === 'number' ? rec.priority : null,
    };
    for (const f of rec.files ?? []) {
      if (typeof f.name !== 'string') continue;
      out.set(unpackDirName(f.name), origin);
      out.set(f.name, origin);
    }
  }
  return out;
}

/** {@link resolveBackendTool} 的第三个参数。 */
export interface BackendToolPreference {
  /**
   * 用户选中的后端。
   *   - **不传（`undefined`）** = 生产默认：从 `<storeRoot>/prefs.json` 读回来。
   *     这是刻意的 —— 见 {@link resolveBackendTool} 的"为什么不做成必填参数"。
   *   - `null` = 显式表示"没有选择"（测试与不关心偏好的调用方用）。
   *   - 某个后端 = 就用它，不读盘。
   */
  readonly selectedBackend?: Backend | null;
  /**
   * **只在这一个已安装包里找**（T-166 ①）。不传 = 不限制（默认，全部调用方的行为不变）。
   *
   * 语义是**硬限制，不是偏好**：那个包里没有这个二进制就返回 `null`，
   * 绝不像 `selectedBackend` 那样往下回退。两者的区别是刻意的：
   *
   *   - `selectedBackend` 回答的是"**平时**该跑哪个"——回退 + 出声是对的，
   *     因为不回退就会因为一个装了一半的包把整条转写链打死（见下面的三条依据）。
   *   - `packId` 回答的是"**这一个包**行不行"。这里回退等于换一个包去跑，然后把
   *     结果记到用户点的那张卡片上 —— 那正是 `POST /api/backends/selftest` 此前
   *     做不到"自测这一个包"的原因，也是「凭空造证据」那一类里最贵的一种。
   *     **拿不到就说拿不到。**
   *
   * 因此钉住时 {@link ResolvedBackendTool.degraded} 恒为 `false`：既然不回退，
   * 就没有"退了一档"这回事，报 true 会变成一个永远说不清指向谁的假红灯。
   */
  readonly packId?: string;
}

/** {@link resolveBackendTool} 的结果 —— 路径**以及它是从哪个包来的**。 */
export interface ResolvedBackendTool {
  readonly path: string;
  /** 提供它的已安装包；没有安装记录时为 `null`（冷启动脚本 / 手工解包 / 装到一半崩了）。 */
  readonly packId: string | null;
  readonly backend: Backend | null;
  /** 本次解析生效的偏好。`null` = 用户从未选过。 */
  readonly preferred: Backend | null;
  /**
   * `true` = **同一个引擎**里，用户选中的后端有已装的包，而这个二进制却来自别的包
   * （选中的那个包里没有它）→ 已按下面的回退策略退了一档。
   *
   * "同一个引擎"是必要的限定：选了 vulkan 时 ffmpeg 来自 `media-tools-*`（engine
   * `ffmpeg`）是正常的，把它也算成降级就是假红灯，而假红灯会训练人忽略告警。
   * 来源不明的目录（没有安装记录）一律**不**声称降级 —— 我们无从判断，
   * "我拿不到" ≠ "这里没有"。
   *
   * **这条必须有人报出去**：静默降级正是本仓最贵的那一类。
   */
  readonly degraded: boolean;
}

/**
 * Find an executable inside an installed backend pack, honouring the user's choice.
 *
 * Layout comes from `@openmemo/downloader`'s ArtifactStore:
 *     <storeRoot>/by-name/backend/<name>                              (pack = one binary)
 *     <storeRoot>/by-name/backend/<archive-basename>/[<nested>/]<binary>   (pack = archive)
 *
 * The nested level exists because upstream archives carry their own top-level directory
 * (whisper.cpp's Linux tarball unpacks to `whisper-bin-ubuntu-x64/`), so a fixed depth
 * would miss it.
 *
 * ── ★ T-162：这段注释此前描述的是一个不存在的行为 ──────────────────────────────────
 *
 * 原文（保留在此，因为它正是缺陷的成因）：
 *
 *     "We scan two levels, **newest first**, and take the first hit."
 *
 * **实现里没有任何排序** —— 候选按 `readdir` 返回的顺序拼，取第一个能执行的。
 * `[amd-vulkan 本机实测]` 同时装 CPU 包与 Vulkan 包时跑的是 **CPU 包里的 whisper-cli**，
 * **两种安装顺序结果相同**；Windows 上目录里那个"唯一能用的加速包"
 * `whispercpp-cuda-12.4-win-x64` 与 `whispercpp-cpu-win-x64` 同装时同样被顶掉。
 * 后果不是"装不上"，是**装上了、点得动、跑起来还是 CPU，且没有任何地方会说**：
 * ggml 只在**二进制自身所在目录**里 dlopen 后端模块，所以另一个包里的
 * `libggml-vulkan.so` 虽然就在盘上，也永远不会被加载。
 *
 * 这条与「`priority` 有 11 条声明、零个读取方」「`selectedBackend` 只驱动两个展示标志」
 * 是同一件事的三个断面：**结论算出来了，做决定的那个函数看不见它。**
 *
 * ⚠️ **上面这两句描述的是 T-162 之前的状态，今天都已不成立** —— 本文件的 `rankOf()`
 *    （见下面 `resolveBackendTool`）现在真的按 `selectedBackend → priority → packId` 排序，
 *    `priority` 由 `readInstalledPackOrigins()` 从安装记录里读出来。
 *    保留原文是因为它是成因；加这一句是因为**它已经被一轮审计当成现状引用过一次**
 *    （`closure-audit` 据此把 `priority` 列为可裁字段）。历史段落必须自己说明自己是历史。
 *
 * ── 现在的选择规则，以及每一条的依据 ─────────────────────────────────────────────
 *
 *   0. **扁平命中最先**（`by-name/backend/<name>`）。它不是搜索是查表 —— 安装器就写在
 *      这个精确位置，而且只有"包本身就是一个可执行文件"的包（yt-dlp）会落在这里，
 *      不可能与任何 whisper 包争同一个名字。T-132 的回归守卫钉的就是它。
 *   1. **用户选中的后端优先**：`prefs.selectedBackend` 对应的包排最前。
 *      依据 = `POST /api/backends/select` 是产品里**唯一**一处"用户表达后端偏好"的入口，
 *      在此之前它只驱动 `recommended` / `active` 两个徽章。用户能改的东西必须真的管事。
 *   2. **没选过 → 按 `priority` 降序**，这正是 `BackendPack.priority` 的文档语义
 *      （"Higher wins when several packs match the same hardware"）。目录里
 *      cuda 包是 90、cpu 包是 10 —— 装了加速包又没有另行指定，就用加速包。
 *      安全性依据：加速包**自包含**（T-161 起每个包都带全 CPU 模块与 whisper-cli，
 *      CI 实测 `providesFiles` 23 个），所以即使 GPU 不可用，ggml 也只是
 *      `No devices found.` 退回 CPU 跑 —— 不会更差。**两个改动是配套的。**
 *   3. **同优先级、以及没有安装记录的目录**：按 packId / 目录名字典序。
 *      不是"随便定个顺序"，是**只要求确定性**：与 `readdir` 的区别在于它与文件系统、
 *      与安装顺序、与磁盘状态都无关，因此可复现、可断言。
 *      没有安装记录的目录一律排在有记录的之后 —— 它们是"装到一半崩在 writeManifest
 *      之前"或手工解包的产物（`gates-fix` §5.2 的 A/B 分叉），证据强度更低。
 *
 * ── 选中的包里没有这个文件时怎么办：**回退，并且出声** ───────────────────────────
 *
 * 显式决定（不是沿用现状）：**继续往下找，绝不报错**。三条依据：
 *   · 这个函数同时在解析 ffmpeg / ffprobe / yt-dlp / openmemo-probe，
 *     它们与"选中哪个后端"毫无关系；为 whisper-cli 报错会把无关的工具一起打死。
 *   · 顶格的包缺文件恰恰是"装到一半"这个**按设计会发生**的中间态
 *     （安装器刻意 blob 先落、manifest 最后写）。把降级状态变成死机不是修复。
 *   · CPU 是 ADR-003 降级链的地板，`manager.ts` 实测记着 ggml 在加速包不可用时
 *     优雅降级 —— "our job is not to prevent it; it is to explain it"。
 * 代价是"解释"这半边必须真的做到，所以 {@link ResolvedBackendTool.degraded} 会翻真，
 * `buildPipeline()` 会 warn，自检里有一条 `backend.selection`。
 * **只回退不出声，就是把这个 bug 换个位置重来一遍。**
 *
 * ── Why the FLAT case is checked too ──────────────────────────────────────────────────
 * `ArtifactStore.linkByName()` hardlinks every installed file to
 * `by-name/<kind>/<name>`, and only files with `unpack` set additionally get expanded
 * into a directory. So a pack whose payload is a standalone executable — yt-dlp ships
 * exactly that, one PyInstaller binary per platform with no archive — lands as a plain
 * file directly under `by-name/backend/`. An implementation that only enumerates
 * DIRECTORIES cannot see it: install succeeds, sha256 matches, the manifest is written,
 * and `discoverTools()` still reports the tool as missing. That is the T-093 /
 * media-tools failure shape again, and it is why this is a listed candidate rather than
 * a lucky side effect of the directory scan.
 *
 * ── 为什么偏好不做成必填参数 ─────────────────────────────────────────────────────
 * 调用方有五处，分布在三个包、两个进程（daemon 与 `scripts/selfcheck.mjs` 这条 CLI）。
 * CLI 那条**拿不到 `RestState`**，而 T-148/T-149 立下的规矩是"两个出口必须调同一个函数、
 * 得出同一个答案"。让每个调用方各自去拿偏好，等价于把"忘了传"变成一种可能的状态 ——
 * `gates-fix` 刚在 `isPackApplicable` 的可选第四参数上写下"能传而不传 = 选择了死锁"。
 * 偏好和"装了什么"一样是 `storeRoot` 里的事实，所以由本函数负责读，调用方不需要知道。
 */
export async function resolveBackendTool(
  storeRoot: string,
  binaryName: string,
  preference?: BackendToolPreference,
): Promise<ResolvedBackendTool | null> {
  const backendRoot = join(storeRoot, 'by-name', 'backend');

  const preferred =
    preference === undefined || preference.selectedBackend === undefined
      ? await readSelectedBackend(storeRoot)
      : preference.selectedBackend;

  const origins = await readInstalledPackOrigins(storeRoot);
  /** 钉住某个包时的硬过滤器。`null` = 不限制。 */
  const pinned = preference?.packId ?? null;

  const listDirs = async (dir: string): Promise<string[]> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };

  /*
   * 排序键。**先 tier 后 priority 后名字**，三层全部确定 —— 任何一层留成
   * `readdir` 顺序，这个函数就又变回"看文件系统心情"。
   */
  const packDirs = (await listDirs(backendRoot)).filter(
    (name) => pinned === null || origins.get(name)?.packId === pinned,
  );
  const rankOf = (name: string): [number, number, string] => {
    const origin = origins.get(name);
    if (origin === undefined) return [2, 0, name];
    const tier = preferred !== null && origin.backend === preferred ? 0 : 1;
    return [tier, -(origin.priority ?? 0), origin.packId];
  };
  const ordered = packDirs
    .map((name) => ({ name, rank: rankOf(name) }))
    .sort((a, b) => {
      for (let i = 0; i < 3; i += 1) {
        const x = a.rank[i] as number | string;
        const y = b.rank[i] as number | string;
        if (x < y) return -1;
        if (x > y) return 1;
      }
      return 0;
    })
    .map((e) => e.name);

  /*
   * `bin/` is checked at every level because the archive layout is upstream's choice,
   * not ours, and it differs per project: whisper.cpp's tarball puts `whisper-cli` at the
   * root of its top directory, while BtbN's ffmpeg build puts `ffmpeg`/`ffprobe` under
   * `<top>/bin/`. A scan that only walks bare directories finds the first and silently
   * misses the second — and "silently" is the whole problem here: a missing ffmpeg does
   * not fail loudly at install time, it fails much later as "every transcription is
   * blocked", because every audio file has to be normalised to 16 kHz mono first.
   */
  // Flat first: it is the exact, unambiguous location the installer wrote to. The
  // directory scan below is a search; this is a lookup.
  //
  // 钉住某个包时，扁平命中同样要**先证明它属于那个包**才算数：`by-name/backend/yt-dlp`
  // 是所有单文件包共用的一格，不查来源就等于"钉住"被一个同名文件绕过去。
  const candidates: { path: string; dir: string | null }[] =
    pinned === null || origins.get(binaryName)?.packId === pinned
      ? [{ path: join(backendRoot, binaryName), dir: null }]
      : [];
  for (const name of ordered) {
    const packDir = join(backendRoot, name);
    candidates.push(
      { path: join(packDir, binaryName), dir: name },
      { path: join(packDir, 'bin', binaryName), dir: name },
    );
    for (const nested of await listDirs(packDir)) {
      const nestedDir = join(packDir, nested);
      candidates.push(
        { path: join(nestedDir, binaryName), dir: name },
        { path: join(nestedDir, 'bin', binaryName), dir: name },
      );
    }
  }

  /** 选中的后端下面已经装了哪些包（按引擎分组用）。 */
  const selectedPacks =
    preferred === null ? [] : [...origins.values()].filter((o) => o.backend === preferred);

  for (const c of candidates) {
    if (!(await isExecutable(c.path))) continue;
    const origin = c.dir === null ? origins.get(binaryName) : origins.get(c.dir);
    return {
      path: c.path,
      packId: origin?.packId ?? null,
      backend: origin?.backend ?? null,
      preferred,
      degraded:
        // 钉住时不回退 → 没有"退了一档"这回事（见 BackendToolPreference.packId）
        pinned === null &&
        origin !== undefined &&
        preferred !== null &&
        origin.backend !== preferred &&
        selectedPacks.some((p) => p.engine === origin.engine),
    };
  }
  return null;
}

/**
 * {@link resolveBackendTool} 的路径视角。
 *
 * 保留这个签名是因为它有五个调用方，而其中三个只关心"路径是什么"。
 * ⚠️ 要判断"跑的是哪个包"请用 `resolveBackendTool()` —— 一个只回路径的函数
 * 天然说不出"我退了一档"，而那正是 T-162 之前没人发现的原因。
 */
export async function findInBackendPacks(
  storeRoot: string,
  binaryName: string,
  preference?: BackendToolPreference,
): Promise<string | null> {
  return (await resolveBackendTool(storeRoot, binaryName, preference))?.path ?? null;
}

/**
 * Find a NON-executable file (or directory) inside an installed backend pack.
 *
 * Same two-level scan as {@link findInBackendPacks}; split out because a `.so` has no
 * exec bit and a dictionary directory is not a file at all, so the `isExecutable`
 * test there rejects exactly the things we need here.
 */
export async function findFileInBackendPacks(
  storeRoot: string,
  name: string,
): Promise<string | null> {
  const backendRoot = join(storeRoot, 'by-name', 'backend');
  const listDirs = async (dir: string): Promise<string[]> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
    } catch {
      return [];
    }
  };

  const candidates: string[] = [];
  // Same `bin/` and `lib/` reasoning as findInBackendPacks: shared objects ship under
  // `lib/` in most upstream archives, next to the `bin/` the executables live in.
  for (const packDir of await listDirs(backendRoot)) {
    candidates.push(join(packDir, name), join(packDir, 'bin', name), join(packDir, 'lib', name));
    for (const nested of await listDirs(packDir)) {
      candidates.push(join(nested, name), join(nested, 'bin', name), join(nested, 'lib', name));
    }
  }
  for (const c of candidates) {
    if (await fileExists(c)) return c;
  }
  return null;
}

export interface MaterializedExtensions {
  /** Absolute paths that now exist under `extDir`, keyed by the name we created. */
  linked: Record<string, string>;
  /** Names we looked for and did not find in any installed pack. */
  missing: string[];
}

export interface SqliteExtensionSource {
  /**
   * The name that has to exist under `bin/ext` afterwards — i.e. exactly what
   * `@openmemo/db`'s `defaultExtensionPaths(root)` will `existsSync()` and hand to
   * `sqlite3_load_extension()`. This side of the mapping is OURS.
   */
  readonly dst: string;
  /**
   * The names to look for INSIDE the installed packs, in order. This side is UPSTREAM'S,
   * and upstream does not have to agree with us — see the win32 row below.
   */
  readonly candidates: readonly string[];
}

/**
 * What `bin/ext` must end up containing, and what to look for in the packs to get it.
 *
 * ── ★ Why this is a table and not `libsimple${suffix}` (measured, T-147) ───────────────
 * The upstream libsimple release archives do NOT use one naming rule across platforms:
 *
 * ```
 * libsimple-linux-ubuntu-22.04.zip → libsimple-linux-ubuntu-22.04/libsimple.so
 * libsimple-osx-arm64.zip          → libsimple-osx-arm64/libsimple.dylib
 * libsimple-windows-x64.zip        → libsimple-windows-x64/simple.dll     ← ★ no `lib`
 * ```
 * (`[实测]` v0.7.1, the three archives named in `vendor/manifests/sqlite-ext.json`,
 * unzipped and listed. MSVC does not prefix `lib`; the CMake target is `simple`.)
 *
 * The old code derived one name for all three (`libsimple` + platform suffix), so on
 * Windows it searched for a file that is not in any archive. Consequence measured on a
 * clean win32 cold start (CI `cold-start-audit`, D-11 §7): every pack installs and
 * verifies, `sqlite-vec` loads, and the daemon comes up
 * `tokenizer=trigram libsimple=false` — **Chinese two-character search silently does not
 * work, with no error anywhere**. That is T-093 reproduced on another platform, and it is
 * why the mapping is written down per platform instead of being computed.
 *
 * ── Why `dst` may differ from the name we found ────────────────────────────────────────
 * We copy `simple.dll` to `bin/ext/libsimple.dll` rather than teaching every consumer a
 * second name. That is safe, and the reason is specific: with no explicit entry point,
 * SQLite derives one from the FILE NAME — it strips the directory, skips a leading `lib`,
 * and takes the alphabetic characters up to the first `.` (`sqlite3.c`, the
 * `zAltEntry` block). Both `simple.dll` and `libsimple.dll` therefore derive
 * `sqlite3_simple_init`, which is the ONLY `sqlite3_*` symbol the DLL exports
 * (`[实测]` PE export table of v0.7.1 `simple.dll`: 2623 exports, exactly one matching
 * `sqlite3*`). Renaming it to anything else — `chinese.dll`, `tokenizer.dll` — would
 * break loading with "no entry point", which is what `__tests__/extensions.test.ts`
 * pins down.
 */
export function sqliteExtensionSources(
  platform: NodeJS.Platform = process.platform,
): SqliteExtensionSource[] {
  const suffix = platform === 'win32' ? '.dll' : platform === 'darwin' ? '.dylib' : '.so';
  return [
    {
      dst: `libsimple${suffix}`,
      // Canonical name first (that is what a future upstream may ship, and what our own
      // builds produce), the real Windows archive name second.
      candidates:
        platform === 'win32' ? [`libsimple${suffix}`, `simple${suffix}`] : [`libsimple${suffix}`],
    },
    { dst: `vec0${suffix}`, candidates: [`vec0${suffix}`] },
    // jieba dictionary — a directory, not a file. Same name on every platform.
    { dst: 'dict', candidates: ['dict'] },
  ];
}

/**
 * Make `<dataDir>/bin/ext` actually contain the SQLite extensions.
 *
 * ── Why this function has to exist ───────────────────────────────────────────────
 * Every consumer assumes ONE directory holding `libsimple.so`, `vec0.so` and `dict/`:
 * `@openmemo/db`'s `defaultExtensionPaths(root)` takes a single root, `AppPaths.
 * extensionsDir` is `<dataDir>/bin/ext`, `OPENMEMO_EXT_DIR` overrides that one dir, and
 * the sqlite-ext manifests literally declare `linkInto: "bin/ext"`.
 *
 * Reality after ADR-015 (upstream prebuilts instead of our own build) is the opposite:
 * each upstream archive lands in its OWN `by-name/backend/<archive>/` directory, with its
 * own internal layout — libsimple's zip nests one more level (`libsimple-…/libsimple-…/
 * libsimple.so`), sqlite-vec's tarball is flat. So the two extensions are never in the
 * same directory, which is precisely why `linkInto` is a LINK target and not an unpack
 * target: linking adds files to a shared directory, unpacking would replace it.
 *
 * Measured consequence on a clean cold start (T-093): all packs download and verify OK,
 * yet the daemon comes up `tokenizer=trigram, vec=off` — i.e. **Chinese two-character
 * search silently does not work**, which is the single most important feature for this
 * product's users. Nothing reports an error, because "extension not found" is a designed
 * graceful degradation.
 *
 * Fixing it by teaching every consumer to resolve per-file would spread pack-layout
 * knowledge across three packages. Instead we make the shared assumption TRUE: after
 * install, link the real files into the one directory everybody already looks in.
 *
 * Symlinks (not copies) on POSIX so an uninstall/upgrade of the pack is visible
 * immediately and `du` does not double-count ~10 MB of jieba dictionary. Windows
 * symlinks need elevation or developer mode, so there we copy.
 *
 * The name mapping (what to look for vs what to create) lives in
 * {@link sqliteExtensionSources} — read the comment there before touching it, the Windows
 * row is not guessable.
 *
 * `platform` is injectable so the Windows mapping and the copy branch are reachable from
 * a test on any host. Production always calls it with two arguments.
 *
 * Idempotent: safe to call on every startup, and re-linking after an upgrade is the point.
 */
export async function materializeSqliteExtensions(
  storeRoot: string,
  extDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<MaterializedExtensions> {
  const linked: Record<string, string> = {};
  const missing: string[] = [];

  for (const { dst: name, candidates } of sqliteExtensionSources(platform)) {
    let src: string | null = null;
    for (const candidate of candidates) {
      src = await findFileInBackendPacks(storeRoot, candidate);
      if (src !== null) break;
    }
    if (src === null) {
      missing.push(name);
      continue;
    }
    const dst = join(extDir, name);
    try {
      await mkdir(extDir, { recursive: true });
      // Replace unconditionally: a stale link from a previous pack version is worse
      // than no link, and `existsSync` on a dangling symlink is false anyway.
      await rm(dst, { recursive: true, force: true });
      if (platform === 'win32') {
        await cp(src, dst, { recursive: true });
      } else {
        /*
         * RELATIVE, not absolute.
         *
         * The data directory is movable (`/api/settings/data-dir`). An absolute link
         * survives the copy but keeps pointing at the OLD location, so after the user
         * moves their data and deletes the old path, Chinese search silently breaks
         * again — the exact failure this function exists to prevent, just delayed.
         * A relative link moves with the tree. Verified by an actual move in T-093.
         */
        await symlink(relative(extDir, src), dst);
      }
      linked[name] = dst;
    } catch {
      // Read-only or otherwise unwritable dataDir: degrade to "not linked" rather than
      // taking the daemon down. The caller still gets `missing` and can report it.
      missing.push(name);
    }
  }
  return { linked, missing };
}

/*
 * ★ T-166：`findInstalledModel(storeRoot, kind, names[], accept)` **已删除**。
 *
 * 它全仓只有一个调用方 —— `discoverTools()` 里那句"在 `by-name/asr/` 下按三个写死的
 * 文件名找 VAD 权重"。而那正是本轮修掉的缺陷：桶名过期（T-149 之后 VAD 在 `vad/`）、
 * 名单过期（上游发新版本就查不到）。`D-08 §D12` 早在设计评审里就点过同一件事：
 * 「`findInstalledModel` 又把 VAD 文件名写死了，与同轮 `modelStore.ts` 强调的
 *  『不要写死文件名』自相矛盾」——两年半后它以 `meta.sameSource` 红线的形式兑现了。
 *
 * 唯一调用方换成 {@link findWhisperVadWeights} 之后，它成了一个零调用方导出。
 * **留着比删掉贵**：这个仓库里"写好了没人调"的东西已经骗过好几轮审计
 * （`check-orphan-exports.mjs` 的第三档就是为它们加的）。所以直接删，
 * 把教训留在这条注释和 `findWhisperVadWeights` 的文档里。
 */

/**
 * whisper.cpp 能加载的那份 VAD 权重，**按桶 + 关键词 + 内容判**，不按固定文件名。
 *
 * ── ★ T-166：这是一次"只改了一边"的迁移留下的静默降级 ────────────────────────────
 *
 * T-149（`9ab2ada`）把 `role=vad` 挪进了自己的桶（`by-name/vad/`）。
 * `apps/daemon` 那一侧跟上了（`resolveWhisperVadModel()` 两个桶都看），
 * **这一侧没有** —— `discoverTools()` 一直只在 `by-name/asr/` 里按三个写死的文件名找。
 *
 * `[CI 实测 · runner-migrate]` 后果是 `meta.sameSource` 三平台一致地红：
 * ```
 * model.vad   本地=warn  端点=ok
 * ```
 * daemon 出口报 ok（它读 `bundle.tools.vadModel`，那是 `buildPipeline()` 用
 * `resolveWhisperVadModel()` **覆盖**过的），CLI 出口报 warn（它直接用
 * `discoverTools()` 的答案）。**同一台机器、同一个 store、两个答案。**
 *
 * 用户侧的后果不在自检里，在转写上：`vadModel` 变成 `null` →
 * **离线转写的静音切分静默降级为固定窗口**，断句变差，而模型页、安装记录、
 * sha256 校验**全绿**。这正是本仓最贵的那一类。
 *
 * ── 为什么规则是"后缀 + 关键词 + ggml 魔数"，而不是文件名清单 ────────────────────
 *
 * 原来那份清单（`ggml-silero-v6.2.0.bin` / `v5.1.2` / `silero-vad.bin`）
 * 与 daemon 那侧的规则（`scanByName(..., {ext:'.bin', includes:'silero'})`）**不同**。
 * 只把桶名改对、清单留着的话，下一次上游发 `v7` 时两边会**再一次**分叉 ——
 * 而且只有 CLI 那一侧会哑掉。所以两边现在用同一条规则：
 *
 *   桶：`vad`（T-149 之后的正式位置）→ `asr`（老布局，VAD 曾被塞在这里）
 *   名：`*.bin` 且文件名含 `silero`
 *   收：`isGgmlModelFile()` —— 读头四字节，**这正是 whisper 自己会检查的东西**，
 *       所以 `silero_vad.onnx`（sherpa 专用）在任何桶里都不会被交出去。
 *
 * ⚠️ 这个函数**不读安装记录**（`active.json` / `role`）——那一层在 daemon 的
 * `resolveWhisperVadModel()` 里，它排在这条兜底之前。两边的**结论**必须一致，
 * 由 `apps/daemon/src/pipeline/vadSameSource.test.ts` 逐场景钉住。
 *
 * @param onRejected 名字对得上、内容却不是 ggml 的候选。**必须能报出去** ——
 *   它的形态是"用户装了 VAD，结果比没装更糟"，静默跳过就等于把它藏起来。
 */
export async function findWhisperVadWeights(
  storeRoot: string,
  onRejected?: (path: string) => void,
): Promise<string | null> {
  /*
   * 搜索位置，按证据强度排：
   *   `by-name/vad`  T-149 之后的正式桶
   *   `by-name/asr`  老布局（VAD 曾被塞进 ASR 桶）
   *   `<storeRoot>`  更老的扁平布局（daemon 那侧原本写死 `ggml-silero-v6.2.0.bin`
   *                  这一个名字；用同一条规则覆盖它，少一个会过期的字面量）
   */
  const dirs = [join(storeRoot, 'by-name', 'vad'), join(storeRoot, 'by-name', 'asr'), storeRoot];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.bin')) continue;
      if (!name.toLowerCase().includes('silero')) continue;
      const p = join(dir, name);
      if (await isGgmlModelFile(p)) return p;
      onRejected?.(p);
    }
  }
  return null;
}

/**
 * `by-name/` 下的桶名。
 *
 * ⚠️ **T-166**：解析 VAD 权重的那个函数以前把这个参数写成 `'asr' | 'llm'`，
 * 而 T-149 起 `role=vad` / `punctuation` 各有自己的桶。
 * 类型窄成两个值的后果**不是"编译不过"**，是**没有人能表达 `vad`** ——
 * 于是它只好继续去 `asr` 桶里找 VAD 权重，而安装器早就写到 `by-name/vad/` 了。
 * **一个过窄的类型把一条真实的迁移挡在了外面，而且一个字都不说。**
 */
export type ByNameBucket = 'asr' | 'llm' | 'vad' | 'punctuation' | 'backend';

/** List everything installed under a by-name kind — used by the self-check report. */
export async function listInstalledModels(
  storeRoot: string,
  kind: ByNameBucket,
): Promise<string[]> {
  try {
    return (await readdir(join(storeRoot, 'by-name', kind))).sort();
  } catch {
    return [];
  }
}

/**
 * The three tiers any of these tools might be found in.
 *
 * Which order to *check* them in is per-tool, not shared — see `RESOLUTION_PLANS` below.
 */
export type ResolutionTier = 'pack' | 'path' | 'bundle';

export interface ResolutionPlan {
  order: readonly [ResolutionTier, ResolutionTier, ResolutionTier];
  /** One sentence, non-empty by construction — see `toolResolutionOrder.test.ts`. */
  reason: string;
}

/**
 * ⚠️ 每个工具必须显式声明解析顺序 —— **键的类型直接派生自 `ToolPaths`**
 * （`Exclude<keyof ToolPaths, 'vadModel'>`；`vadModel` 走另一条解析路径，见
 * `discoverTools` 里 `findWhisperVadWeights` 那一段），不是手抄的白名单：
 * 给 `ToolPaths` 加一个新字段却忘了在这里补一条，`tsc` 直接编译不过。
 * `toolResolutionOrder.test.ts` 补运行时那一半 —— 断言每条 `reason` 非空，
 * 防止有人用空字符串把编译器糊弄过去。**新工具不许静默继承别的工具的顺序。**
 *
 * 2026-08-10 Manager 裁决：内置（随包出厂）该排在系统 PATH 之前 —— 但只对
 * **没有多档加速变体**的工具成立。这正是 ffmpeg/ffprobe/yt-dlp 与
 * whisper-cli/whisper-vad 的分野，不是一刀切，理由见各条目自己的注释。
 */
export const RESOLUTION_PLANS: Record<Exclude<keyof ToolPaths, 'vadModel'>, ResolutionPlan> = {
  /*
   * ffmpeg/ffprobe：内置排在 PATH 之前。
   *   · 本仓的 ffmpeg pack 目录里没有"多档加速变体"这回事（不像 whisper.cpp 有
   *     CPU/Vulkan/CUDA 各一个包）—— 内置排前面不会有"装了加速却没用上"的
   *     regression，whisper 那条顾虑在这里不成立。
   *   · 内置这份**比下载更是"产品自己的"**：Linux/Windows 内置字节与下载走的是
   *     同一个 `backends.json` pack（`build-bundle.mjs` 的 `assembleFfmpeg()`
   *     直接引用 `T.ffmpegPackId`），sha256 对着 manifest 校验过，构建时还
   *     额外跑 `ffmpeg -L` 核对横幅真的是 Lesser；系统 PATH 上那份完全不受控，
   *     可能是任意年份、任意构建选项（甚至专利编码器）的产物。
   *   · 用户原话"产品自己下载的优先级大于系统自带的" —— 内置字面上比下载更"自己"，
   *     排在下载之后、PATH 之前，是把这句话往强处兑现，不是违反它。
   */
  ffmpeg: {
    order: ['pack', 'bundle', 'path'],
    reason:
      'no acceleration-tier variants exist for ffmpeg in this repo; built-in is sha256- and `-L`-verified, more "our own" than a system binary, so it outranks PATH',
  },
  ffprobe: {
    order: ['pack', 'bundle', 'path'],
    reason: 'same build/pack as ffmpeg — see ffmpeg.reason',
  },
  /*
   * whisper-cli/whisper-vad：内置维持排最后，原样保留（2026-08-08 Manager 裁决）。
   *   包内目录只有 CPU 后端模块。一旦排到已安装后端包/PATH 前面，用户装完
   *   Vulkan/CUDA 包之后仍可能落到包内这个 CPU 二进制上 —— 表现是"装了加速却
   *   没变快"，比"要先下一个包"更难查，因为它发生在用户以为已经装好之后。
   *   它只在前两级都落空时才出手，结构上不可能让既有安装变差：任何已经能
   *   解析到 whisper-cli 的机器，走的还是原来那条路。
   *   ⚠️ 这条理由是 whisper.cpp 专属的 —— ffmpeg 没有这个顾虑，两者顺序不同
   *   不是漏改，是同一份 `resolveByOrder()` 用了两组不同的、各自写明理由的参数。
   */
  whisperCli: {
    order: ['pack', 'path', 'bundle'],
    reason:
      'whisper.cpp ships multiple acceleration-tier packs (CPU/Vulkan/CUDA); ranking bundle above an installed accelerated pack would silently downgrade it to the CPU-only bundled binary',
  },
  whisperVad: {
    order: ['pack', 'path', 'bundle'],
    reason: 'same binary family/pack as whisper-cli — see whisperCli.reason',
  },
  /*
   * yt-dlp：今天没有内置档（`fromBundle()` 恒返回 null）—— `build-bundle.mjs`
   * 文件头与 D-17 §1 都写着"不打包 yt-dlp"，理由是 GPL 传染顾虑 + D-20 §1.1
   * 的二进制内嵌依赖清点（mutagen/readline）还没扫完，扫完之前不许打进包。
   * ⚠️ 但那条审计将来完成、yt-dlp 真的进了 `runtime/probe/` 的那天：它和 ffmpeg
   * 一样，本仓的 yt-dlp pack 也是每平台一个、没有多档加速变体，排到 PATH 之前
   * 不会有 whisper 那种"盖掉加速包"的风险。**现在就把顺序声明成 ffmpeg 那一档**，
   * 这样"内置字节哪天真的落地"和"顺序该怎么排"这两件事不用绑在一起处理 ——
   * 不会重演这次 ffmpeg 排最后、顺序被动继承、没人单独论证过的事。
   */
  ytDlp: {
    order: ['pack', 'bundle', 'path'],
    reason:
      'no bundle exists yet (GPL/embedded-dep audit gate — D-17 §1 / D-20 §1.1), but yt-dlp has no acceleration-tier variants either; declared like ffmpeg now so the order does not need remembering later',
  },
};

/**
 * Resolve the native tools.
 *
 * Every tool is resolved through the same three possible tiers — installed backend
 * pack, system PATH, packed-in-the-app bundle — via the single `resolveByOrder()`
 * walker below. **Which order to check them in is declared per tool** in
 * `RESOLUTION_PLANS` above; there is exactly one implementation of "walk a declared
 * order, return the first hit," only the order argument varies.
 *
 * Step 2 (installed backend packs) used to be missing entirely, which is why a
 * correctly installed backend pack still left the daemon reporting
 * `pipeline.missing: ["whisper-cli"]`: nothing ever looked in the place the installer
 * writes to.
 *
 * ── 一处误引，两次订正 ──────────────────────────────────────────────────────────
 *
 * 本文件与 `discoverTools` 早前都写过「D-01 §8.4 L2 forbids PATH lookups for real
 * invocations」。`[实测]` 去查了 D-01 §8.4：**L2 是「绝不经过 shell」，通篇没有
 * 禁止 PATH 查找** —— 那条禁令是这段注释自己发明并挂到文档名下的，文档没错，
 * 错的是引用。D-01 真正说的是 spawn 时用**绝对路径**（`§8.4` 第三层），
 * "解析阶段能不能查 PATH" 是另一件事。
 *
 * **2026-08-09 第一次订正只改了这里，漏了两份同一句话的副本**
 * （本文件文件头、`apps/daemon/src/pipeline/setup.ts:7`）——
 * 订正也需要数有几份副本在场，这轮漏数了。**2026-08-10 全仓 grep 复核，一并改掉。**
 *
 * 用户 2026-08-09 原话（`PROTOCOL §13`）：
 *
 * > 「早先我们定的策略是**允许**用系统里的 ffmpeg 啊，只是**优先用产品自己下载的**，
 * >   产品自己下载的**优先级大于**系统自带的。」
 *
 * **2026-08-10 追加裁决**：内置（随包出厂）比下载**更是"产品自己的"** ——
 * sha256 校验过，Linux/Windows 的 ffmpeg 内置那份构建时还真的跑过 `ffmpeg -L`
 * 核对 Lesser 横幅；系统那份完全不受控。所以 ffmpeg/ffprobe/yt-dlp 的内置档
 * 这次改到 PATH 之前，whisper-cli/whisper-vad 维持内置排最后 —— 理由各自写在
 * `RESOLUTION_PLANS` 对应条目旁边，不是一刀切。
 *
 * ── 安全那一半**一个字没变** ────────────────────────────────────────────────────
 *
 * D-01 §8.4 L2 真正在防的是**注入**：PATH 里靠前的一个恶意 `ffmpeg` 会赢。
 * 这条威胁是真的，缓解措施**与顺序无关，保持不变且不许动**：
 *   · **永远 spawn 解析后的绝对路径，绝不 spawn 裸命令名**（本文件与 subprocess/ 一直如此）；
 *   · 借到的那一个**必须在自检里报出绝对路径**，让用户看得见自己用的是哪一个。
 * "允许借" ≠ "不设防"：允许的是**使用**，防的是**冒名**。
 */
export async function discoverTools(
  overrides: Partial<ToolPaths> & {
    /** Explicit store root. Wins over everything. */
    storeRoot?: string;
    /** The daemon's data directory — pass this whenever it is known (D-08 D4). */
    dataDir?: string;
    /**
     * 用户选中的后端。不传 = 从 `<storeRoot>/prefs.json` 读（生产路径）。
     * 见 {@link resolveBackendTool}。
     */
    selectedBackend?: Backend | null;
  } = {},
): Promise<ToolPaths> {
  const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name);

  const storeRoot = overrides.storeRoot ?? resolveStoreRoot(overrides.dataDir);
  /*
   * 偏好**读一次**，五个工具共用。逐个工具各读一次不只是浪费 I/O：
   * 中途有人改了 prefs.json，同一次装配就会出现"ffmpeg 按旧偏好、whisper-cli 按新偏好"，
   * 而那种不一致查起来比慢一点贵得多。
   */
  const selectedBackend =
    overrides.selectedBackend === undefined
      ? await readSelectedBackend(storeRoot)
      : overrides.selectedBackend;

  const fromPath = async (name: string): Promise<string | null> => {
    const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    for (const dir of dirs) {
      const candidate = join(dir, exe(name));
      if (await isExecutable(candidate)) return candidate;
    }
    return null;
  };

  /*
   * 随预编译包出厂的 **CPU 基线运行时**（`runtime/probe/`，2026-08-08 Manager 裁决
   * 落地，同一个目录里还装着探针与 ggml 核心 —— 共用一份 ggml，不长第二份，见
   * `scripts/build-bundle.mjs` 的说明）。这个函数只回答"这个目录里有没有这个可
   * 执行文件"——**它在几个工具的解析顺序里排第几，不由这个函数决定**，
   * 由调用方传入的 `order`（见下方 `RESOLUTION_PLANS`）决定。
   *
   * ⚠️ 这里不直接读 `OPENMEMO_BUNDLED_WHISPER_DIR`：那**只覆盖"经启动器起"这一条路**，
   * `scripts/selfcheck.mjs` 直接调 `discoverTools()`、CI 直接起 daemon，都看不见包内
   * 那份。改用 `bundledRuntimeDir()`（环境变量优先，取不到就从模块位置向上找），
   * 三个消费者共用同一份解析规则。
   */
  const fromBundle = async (name: string): Promise<string | null> => {
    const bundledDir = bundledRuntimeDir();
    if (bundledDir === null) return null;
    const candidate = join(bundledDir, exe(name));
    return (await isExecutable(candidate)) ? candidate : null;
  };

  const fromPack = (name: string): Promise<string | null> =>
    findInBackendPacks(storeRoot, exe(name), { selectedBackend });

  /** 三档查找函数各自的名字，与 `ResolutionTier` 的三个字面量一一对应。 */
  const TIER_LOOKUP = {
    pack: fromPack,
    path: fromPath,
    bundle: fromBundle,
  } satisfies Record<ResolutionTier, (name: string) => Promise<string | null>>;

  /** 单一实现：按声明的顺序逐档查找，返回第一个命中的。顺序本身不写在这里。 */
  const resolveByOrder = async (
    name: string,
    order: readonly ResolutionTier[],
  ): Promise<string | null> => {
    for (const tier of order) {
      const hit = await TIER_LOOKUP[tier](name);
      if (hit !== null) return hit;
    }
    return null;
  };

  /*
   * VAD model ships as a ggml file inside the whisper.cpp pack's sibling model store.
   *
   * The acceptance test is the ggml magic, NOT the file name (T-148). Two reasons, both
   * measured rather than imagined:
   *   1. a fixed name list is a guess about upstream's release naming — it was written
   *      for `v5.1.2` and the catalog now pins `v6.2.0`; a third version breaks it again;
   *   2. `whisper-vad-speech-segments` reports EVERY load failure as the same sentence
   *      (`error: failed to initialize whisper context`, exit 2) — wrong file, missing
   *      file and empty path are indistinguishable downstream, so the check has to happen
   *      here, where we still know which candidate we picked.
   */
  const vadModel = overrides.vadModel ?? (await findWhisperVadWeights(storeRoot));

  return {
    ffmpeg:
      overrides.ffmpeg ?? (await resolveByOrder('ffmpeg', RESOLUTION_PLANS.ffmpeg.order)) ?? '',
    ffprobe:
      overrides.ffprobe ?? (await resolveByOrder('ffprobe', RESOLUTION_PLANS.ffprobe.order)) ?? '',
    whisperCli:
      overrides.whisperCli ??
      (await resolveByOrder('whisper-cli', RESOLUTION_PLANS.whisperCli.order)),
    whisperVad:
      overrides.whisperVad ??
      (await resolveByOrder('whisper-vad-speech-segments', RESOLUTION_PLANS.whisperVad.order)),
    vadModel,
    ytDlp: overrides.ytDlp ?? (await resolveByOrder('yt-dlp', RESOLUTION_PLANS.ytDlp.order)),
  };
}
