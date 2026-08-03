/**
 * Functional self-check, as a library. **One implementation, two surfaces.**
 *
 * ADR-014 promotes this to the project-wide acceptance standard:
 *
 *   Verify that the FEATURE works, not that the COMPONENT loaded — because every layer
 *   degrades gracefully, and stacked graceful degradations are exactly how a product
 *   ends up running degraded with nobody aware.
 *
 * So: not "is libsimple loaded" but "does 用户 match in FTS5". Not "does whisper-cli
 * exist" but "is it executable at a path the daemon will actually resolve".
 *
 * ─── T-119: 真正同源 ───────────────────────────────────────────────────────────────
 * 这里曾经只是 `scripts/selfcheck.mjs` 的**真子集**：CLI 有硬件探测、数据目录自洽性、
 * 本地 LLM 探测、代理三条，端点没有 —— 于是**网页绿 ≠ CLI 绿**，而两个都自称"自检"。
 * 一个自检工具最不能出的问题就是它自己两个出口给的答案不一样。
 *
 * 现在检查项**全部**在这里，CLI 与 `GET /api/selfcheck` 调同一个 `runSelfCheck()`。
 * **差异只允许在渲染层**（CLI 上色分节、端点回 JSON），不允许在检查项。
 * `scripts/selfcheck.mjs --daemon …` 会把本地结果与端点结果**逐 id 比对**，
 * 任何漂移都会被报成 required 失败 —— 这条比"我保证同源"这句话可靠。
 *
 * ─── 为什么探针是注入的 ────────────────────────────────────────────────────────────
 * `packages/runtime` **刻意不 import `packages/pipeline`**：pipeline 已经依赖 runtime，
 * 反向就成环。所以凡是需要别的包才能回答的问题（工具路径、引擎候选、SQLite 扩展、
 * 本地 LLM 服务、代理配置），一律声明成回调由调用方注入。
 * `@openmemo/llm` 其实不成环（它只依赖 shared），但仍然走注入 —— 让 runtime 只保留
 * "硬件"这一件它真正拥有的事，是这个包能一直保持轻的原因。
 *
 * 未提供的探针**不会让检查项消失**，只会让那一条报 `warn: 未探测`。
 * 检查项列表在任何情况下都是同一份、同一个顺序 —— 否则"两边一致"就无从比对。
 */

import { access, constants, readdir } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';

import { detectCpu, detectMemory, detectOs } from './detect/system.js';
import { runProbe } from './probe/runProbe.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  /** Grouping for display: hardware / tools / models / llm / ext / datadir / engines / proxy. */
  layer: string;
  /** Stable id so the UI can map to a remediation, tests can assert, and the CLI can diff. */
  id: string;
  label: string;
  labelZh: string;
  status: CheckStatus;
  detail: string;
  /** A failing required check means the product is broken, not merely degraded. */
  required: boolean;
  /** What the user should do. Null when nothing is wrong. */
  remediation: string | null;
}

export interface SelfCheckReport {
  ok: boolean;
  ranAt: string;
  dataDir: string;
  storeRoot: string;
  extensionsDir: string;
  counts: { ok: number; warn: number; fail: number };
  results: CheckResult[];
}

export interface SelfCheckToolPaths {
  ffmpeg: string | null;
  ffprobe: string | null;
  whisperCli: string | null;
  whisperVad: string | null;
  vadModel: string | null;
  ytDlp: string | null;
}

export interface MediaAssetRef {
  role: string;
  relPath: string;
}

export interface DetectedLlmService {
  label: string;
  models: number;
}

export interface LlmKeyConfig {
  providerId: string | null;
  hasKey: boolean;
}

export interface ProxySummary {
  mode: string;
  /** Already redacted by the caller — credentials must never reach a self-check report. */
  activeUrl: string | null;
  /** `ffmpegProxySupport()` 的结论：SOCKS 下 ffmpeg 不走代理。 */
  ffmpegSupported: boolean;
  ffmpegReason: string | null;
}

export interface ProxyConnectivity {
  ok: boolean;
  probes: { target: string; result: string; viaProxy: boolean }[];
}

export interface SelfCheckProbes {
  /** Resolved native tool paths, as the pipeline would resolve them. */
  tools: () => Promise<SelfCheckToolPaths>;
  /** Installed artifact names by store kind. */
  installed: (kind: 'asr' | 'llm' | 'backend') => Promise<string[]>;
  /**
   * Run the four-word Chinese FTS5 test.
   * Returns hit counts, or null when the tokenizer could not even be loaded.
   */
  chineseSearch: () => Promise<Record<string, number> | null>;
  /** sqlite-vec version, or null when unavailable. */
  vecVersion: () => Promise<string | null>;
  /** ASR engine candidates with availability. */
  engines: () => Promise<{ id: string; available: boolean; reason?: string }[]>;
  /** Auto-selected engine per language; null when nothing is available. */
  selectFor: (language: string) => Promise<{ engineId: string; reason: string } | null>;

  /* ---- T-119：从 CLI 上移进来的四类 ---------------------------------------------- */

  /** `openmemo-probe` 的绝对路径。它藏在后端包里，只有 pipeline 的两层扫描找得到。 */
  probePath?: () => Promise<string | null>;
  /** `media_assets` 的 (role, rel_path)。null = 读不到库（全新安装还没建库是正常的）。 */
  mediaAssets?: () => Promise<MediaAssetRef[] | null>;
  /** 档 2：本机已装且**真能用**的 LLM 服务（Ollama / LM Studio）。 */
  localLlmServices?: () => Promise<DetectedLlmService[] | null>;
  /** 档 1：配没配在线 provider + Key。**只读配置，绝不代发请求。** */
  llmKeyConfig?: () => Promise<LlmKeyConfig | null>;
  /** 代理配置摘要（URL 必须已脱敏）。 */
  proxy?: () => Promise<ProxySummary | null>;
  /** 真发一次外网请求验代理。只在 `proxyTest` 为真时被调用。 */
  proxyConnectivity?: () => Promise<ProxyConnectivity | null>;
}

export interface SelfCheckInput {
  dataDir: string;
  storeRoot: string;
  extensionsDir: string;
  /**
   * Injected so this module stays dependency-free — see the file header.
   */
  probes: SelfCheckProbes;
  /**
   * 真发一次外网请求验证代理。**默认 false**：自检必须能在离线环境跑完，
   * 否则"这台机器没网"会被渲染成"产品坏了"，那是另一种谎。
   */
  proxyTest?: boolean;
}

/** The words that were silently returning zero before libsimple shipped (T-035). */
export const CHINESE_PROBE_WORDS = ['用户', '推特', '中国', '服务'] as const;

/**
 * `by-name/asr` 下这些名字**不是**语音识别模型。
 *
 * 实测（T-067）：VAD 模型 `ggml-silero-v6.2.0.bin` 也被存成 StoreKind='asr'
 * —— StoreKind 只有 asr|llm|backend，而 ModelRole 有 asr|llm|vad|punctuation|…，
 * 两个轴被压成了一个。于是"只装了 VAD"会被报成"ASR 就绪"，是个假绿灯。
 * 按名字剔除不是完美判据（真正的修法是让安装记录带上 catalog 的 role），
 * 但它至少不会把"什么都没装"说成"装好了"。
 */
const NON_ASR_NAME = /silero|vad|punct|ct-transformer|speaker|diariz/i;

async function exists(p: string | null | undefined, mode: number): Promise<boolean> {
  if (p === null || p === undefined || p.length === 0) return false;
  try {
    await access(p, mode);
    return true;
  } catch {
    return false;
  }
}

function libSuffix(): string {
  if (process.platform === 'win32') return '.dll';
  if (process.platform === 'darwin') return '.dylib';
  return '.so';
}

export async function runSelfCheck(input: SelfCheckInput): Promise<SelfCheckReport> {
  const results: CheckResult[] = [];
  const add = (r: CheckResult): void => {
    results.push(r);
  };
  /** 探针没给 → 检查项照常出现，只是如实说"没测"。列表必须两边一样长。 */
  const notProbed = (
    layer: string,
    id: string,
    label: string,
    labelZh: string,
  ): void =>
    add({
      layer,
      id,
      label,
      labelZh,
      status: 'warn',
      detail: '未探测（本次运行未提供该探针）',
      required: false,
      remediation: null,
    });

  // ---- hardware ---------------------------------------------------------------------
  // runtime 自己就拥有硬件探测，这里不需要任何注入。
  const os = detectOs();
  add({
    layer: 'hardware',
    id: 'hw.os',
    label: 'OS / arch',
    labelZh: 'OS / 架构',
    status: 'ok',
    detail: `${os.platform}/${os.arch} ${os.version}`,
    required: false,
    remediation: null,
  });

  const cpu = await detectCpu();
  add({
    layer: 'hardware',
    id: 'hw.cpu',
    label: 'CPU instruction sets',
    labelZh: 'CPU 指令集',
    status: cpu.features.length > 0 ? 'ok' : 'warn',
    detail: `${cpu.brand} · ${cpu.physicalCores}核 · ${cpu.features.slice(0, 6).join(',') || '未检出'}`,
    required: false,
    remediation:
      cpu.features.length > 0
        ? null
        : '未检出指令集 → 只能用最保守的 CPU 后端，推理会明显更慢',
  });

  const ram = detectMemory();
  add({
    layer: 'hardware',
    id: 'hw.memory',
    label: 'memory',
    labelZh: '内存',
    status: 'ok',
    detail: `${ram.totalMB} MB total`,
    required: false,
    remediation: null,
  });

  /*
   * 设备枚举必须由**子进程**回答。
   *
   * 磁盘上躺着一个 loader 什么都不证明 —— ggml 在 `GGML_BACKEND_DL=ON` 下会 dlopen
   * 一堆后端并静默跳过不能用的那些，所以"文件在"和"这台机器能用它"是两回事。
   * 而且 whisper.cpp 在没有可用 CPU 后端时会 `ggml_abort()` → SIGABRT，
   * 所以它只能在子进程里问，不能在 daemon 进程里问。
   */
  if (input.probes.probePath === undefined) {
    notProbed('hardware', 'hw.probe', 'device enumeration (subprocess)', 'probe 子进程枚举设备');
  } else {
    const probePath = await input.probes.probePath();
    if (probePath === null || !(await exists(probePath, constants.X_OK))) {
      add({
        layer: 'hardware',
        id: 'hw.probe',
        label: 'device enumeration (subprocess)',
        labelZh: 'probe 子进程枚举设备',
        status: 'warn',
        detail: 'openmemo-probe 未安装（后端能力未知）',
        required: false,
        remediation: '安装后端包后会带上 openmemo-probe；在此之前只能按 CPU 保守选择',
      });
    } else {
      const r = await runProbe({ probePath, backendDir: dirname(probePath) });
      add({
        layer: 'hardware',
        id: 'hw.probe',
        label: 'device enumeration (subprocess)',
        labelZh: 'probe 子进程枚举设备',
        status: r.ok ? 'ok' : 'warn',
        detail: r.ok ? `${r.output.deviceCount} 个设备, ggml ${r.output.ggmlVersion}` : r.message,
        required: false,
        remediation: r.ok ? null : '探测失败 → 加速后端不可判定，会退回 L1 CPU',
      });
    }
  }

  // ---- tools ------------------------------------------------------------------------
  const tools = await input.probes.tools();
  const backendPacks = await input.probes.installed('backend');

  add({
    layer: 'tools',
    id: 'backend.packs',
    label: 'installed backend packs',
    labelZh: '已安装后端包',
    status: backendPacks.length > 0 ? 'ok' : 'warn',
    detail: backendPacks.length > 0 ? backendPacks.join(', ') : '无',
    required: false,
    remediation: backendPacks.length > 0 ? null : '在「运行时」页安装 CPU 基础包',
  });

  /*
   * 「找到了」和「装上了」是两件事。
   *
   * `discoverTools()` 的第 3 顺位是 PATH，那是**开发便利**，不是产品路径。
   * 开发机上有 `/usr/bin/ffmpeg`，于是这条一直是绿的 —— 但用户机器上没有，
   * 而 ffmpeg 目前**没有任何 HTTP 安装通道**（T-093 实测三个安装端点全拒）。
   * 报绿等于把"这台开发机恰好有"当成"产品能装上"，正是自检要防的那种假绿灯。
   *
   * 判据：装在 storeRoot 里 = ok；只在系统 PATH 上 = warn（能跑，但不可分发）；没有 = fail。
   */
  const fromStore = (p: string | null): boolean => p !== null && p.startsWith(input.storeRoot);
  for (const [id, labelZh, path, required] of [
    ['tool.ffmpeg', 'ffmpeg', tools.ffmpeg, true],
    ['tool.ffprobe', 'ffprobe', tools.ffprobe, true],
    ['tool.whisperCli', 'whisper-cli', tools.whisperCli, true],
    ['tool.whisperVad', 'VAD 切分器', tools.whisperVad, false],
    ['tool.ytDlp', 'yt-dlp（可选，GPL）', tools.ytDlp, false],
  ] as const) {
    const found = await exists(path, constants.X_OK);
    if (!found) {
      add({
        layer: 'tools',
        id,
        label: labelZh,
        labelZh,
        status: required ? 'fail' : 'warn',
        detail: '未找到',
        required,
        remediation: '在「运行时」页安装对应组件',
      });
    } else if (fromStore(path)) {
      add({
        layer: 'tools',
        id,
        label: labelZh,
        labelZh,
        status: 'ok',
        detail: path as string,
        required,
        remediation: null,
      });
    } else {
      add({
        layer: 'tools',
        id,
        label: labelZh,
        labelZh,
        status: 'warn',
        detail: `${path as string}（来自系统 PATH，非本产品安装 —— 用户机器上不一定有）`,
        // 借来的工具能跑，所以不算"坏了"；但它不可分发，所以也不能算 ok。
        required: false,
        remediation: '产品自带的安装通道尚未覆盖该工具，当前依赖系统里已有的版本',
      });
    }
  }

  const vadOk = await exists(tools.vadModel, constants.R_OK);
  add({
    layer: 'tools',
    id: 'model.vad',
    label: 'VAD model',
    labelZh: 'VAD 模型',
    status: vadOk ? 'ok' : 'warn',
    detail: vadOk ? (tools.vadModel as string) : '未安装 → 切分降级为固定窗口',
    required: false,
    remediation: vadOk ? null : '在「模型」页安装 silero VAD（ggml 格式）',
  });

  // ---- models -----------------------------------------------------------------------
  const asr = await input.probes.installed('asr');
  const realAsr = asr.filter((n) => !NON_ASR_NAME.test(n));
  const misfiled = asr.filter((n) => NON_ASR_NAME.test(n));
  add({
    layer: 'models',
    id: 'model.asr',
    label: 'ASR models',
    labelZh: 'ASR 模型',
    status: realAsr.length > 0 ? 'ok' : 'fail',
    detail:
      realAsr.length > 0
        ? realAsr.join(', ')
        : misfiled.length > 0
          ? `无可用 ASR 模型（by-name/asr 下只有非 ASR 角色的文件：${misfiled.join(', ')}）`
          : '无',
    required: true,
    remediation: realAsr.length > 0 ? null : '在「模型」页下载一个语音识别模型',
  });

  /*
   * ---- LLM（ADR-016 之后只剩在线）------------------------------------------------
   *
   * 这里原来查的是 `by-name/llm` 下有没有 GGUF。ADR-016 砍掉内置 llama.cpp 之后，
   * 那条判据查的是一个**产品已经不再提供的东西**，永远 warn —— 纯噪音，
   * 而且会让用户以为"再装个本地模型就好了"，其实根本没这个入口。
   *
   * 两档的**可自检性完全不同**，所以拆成两条、不合并：
   *   档 1（BYO Key）：**没法自检**。唯一的验法是拿用户的 Key 发一次真请求 ——
   *                    那要花他的钱，还可能在他不知情时把 Key 发出去。
   *                    所以只报"配没配"，并在文案里明写这不等于"能用"。
   *   档 2（本机 Ollama / LM Studio）：**能真验**。探针会真发 `/v1/models` 并要求
   *                    至少有一个模型 —— 端口开着但没下模型不算可用。纯本机请求。
   */
  if (input.probes.llmKeyConfig === undefined) {
    notProbed('llm', 'llm.tier1', 'online LLM configured', '档 1 在线 LLM 已配置');
  } else {
    const cfg = await input.probes.llmKeyConfig();
    const configured = cfg !== null && cfg.providerId !== null && cfg.hasKey;
    add({
      layer: 'llm',
      id: 'llm.tier1',
      label: 'online LLM configured',
      labelZh: '档 1 在线 LLM 已配置',
      status: configured ? 'ok' : 'warn',
      detail: configured
        ? `${cfg.providerId as string} + 已存 Key（★ 只表示配了，未代发请求验证可用性）`
        : `未配置（provider=${cfg?.providerId ?? '无'} key=${cfg?.hasKey ? '有' : '无'}）`,
      required: false,
      remediation: configured ? null : '在设置页填一个在线模型的 API Key，否则 F4 思维导图会转 blocked',
    });
  }

  if (input.probes.localLlmServices === undefined) {
    notProbed('llm', 'llm.tier2', 'local LLM services', '档 2 本机已装服务');
  } else {
    const svc = await input.probes.localLlmServices();
    add({
      layer: 'llm',
      id: 'llm.tier2',
      label: 'local LLM services',
      labelZh: '档 2 本机已装服务',
      status: svc !== null && svc.length > 0 ? 'ok' : 'warn',
      detail:
        svc !== null && svc.length > 0
          ? svc.map((s) => `${s.label}(${s.models} 模型)`).join(', ')
          : '未探测到 Ollama / LM Studio（正常：用户没装就没有）',
      required: false,
      remediation: null,
    });
  }

  // ---- extensions: tested by FEATURE ------------------------------------------------
  /*
   * 词典缺失**不是**致命的：libsimple 没有 jieba 词典仍然工作，只是退化成按字切分
   * （仍然远好于 trigram 完全搜不到双字词）。所以这条是 warn，不是 fail。
   */
  const dictDir = join(input.extensionsDir, 'dict');
  const hasDict = await exists(join(dictDir, 'jieba.dict.utf8'), constants.R_OK);
  add({
    layer: 'ext',
    id: 'ext.jiebaDict',
    label: 'jieba dictionary',
    labelZh: 'jieba 词典',
    status: hasDict ? 'ok' : 'warn',
    detail: hasDict ? dictDir : '缺失 → 分词退化为字符切分（仍优于 trigram）',
    required: false,
    remediation: hasDict ? null : '重新安装中文分词扩展 libsimple（上游包自带 dict/）',
  });

  const hits = await input.probes.chineseSearch();
  if (hits === null) {
    add({
      layer: 'ext',
      id: 'ext.chineseSearch',
      label: 'Chinese two-character search',
      labelZh: '中文双字词可搜索',
      status: 'fail',
      detail: '分词器不可用，未能测试',
      required: true,
      remediation: '安装中文分词扩展（libsimple）',
    });
  } else {
    const misses = Object.entries(hits)
      .filter(([, n]) => n === 0)
      .map(([w]) => w);
    add({
      layer: 'ext',
      id: 'ext.chineseSearch',
      label: 'Chinese two-character search',
      labelZh: '中文双字词可搜索',
      status: misses.length === 0 ? 'ok' : 'fail',
      detail: Object.entries(hits)
        .map(([w, n]) => `${w}:${n}`)
        .join(' '),
      required: true,
      remediation:
        misses.length === 0
          ? null
          : `这些词搜不到：${misses.join('、')}。多半是分词器退回 trigram（无法匹配 3 字以下）`,
    });
  }

  const vec = await input.probes.vecVersion();
  add({
    layer: 'ext',
    id: 'ext.sqliteVec',
    label: 'sqlite-vec',
    labelZh: '向量检索扩展',
    status: vec !== null ? 'ok' : 'warn',
    detail: vec ?? '不可用 → 语义检索关闭',
    required: false,
    remediation: vec !== null ? null : '安装向量检索扩展',
  });

  /*
   * ---- 数据目录自洽性 -------------------------------------------------------------
   *
   * 用户的要求原话是"数据存放是独立文件夹且描述清楚，删除不要影响程序本体运行"。
   * 反过来说：**程序自己的引用也不许跑到那个文件夹外面**，
   * 否则"搬走数据目录"就等于"弄坏数据"，而这两件事在用户眼里毫不相干。
   *
   * 这条查的是真东西：把 `media_assets` 每条路径解析出来，看它落不落在 dataDir 内、
   * 文件在不在。T-093 就是靠它坐实了 `audio16k` 存的是**绝对路径**且指向
   * `<dataDir>/tmp/job-*` —— 移动数据目录后该资产直接 403，而设置页还把 tmp
   * 描述成「可随时删」。只看目录结构、不看数据库引用，这种问题永远查不出来。
   */
  if (input.probes.mediaAssets === undefined) {
    notProbed('datadir', 'datadir.assetsContained', 'assets inside dataDir', 'media_assets 路径全在 dataDir 内');
    notProbed('datadir', 'datadir.assetsPresent', 'asset files present', 'media_assets 文件都在');
  } else {
    const rows = await input.probes.mediaAssets();
    if (rows === null) {
      add({
        layer: 'datadir',
        id: 'datadir.assetsContained',
        label: 'assets inside dataDir',
        labelZh: 'media_assets 路径全在 dataDir 内',
        status: 'warn',
        detail: '读不到数据库（全新安装尚未建库时属正常）',
        required: false,
        remediation: null,
      });
      add({
        layer: 'datadir',
        id: 'datadir.assetsPresent',
        label: 'asset files present',
        labelZh: 'media_assets 文件都在',
        status: 'warn',
        detail: '读不到数据库',
        required: false,
        remediation: null,
      });
    } else {
      const mediaRoot = join(input.dataDir, 'media');
      const escaped: string[] = [];
      const dangling: string[] = [];
      for (const r of rows) {
        const abs = resolvePath(mediaRoot, r.relPath);
        if (abs !== input.dataDir && !abs.startsWith(input.dataDir + '/')) {
          escaped.push(`${r.role}→${r.relPath}`);
        } else if (!(await exists(abs, constants.R_OK))) {
          dangling.push(`${r.role}→${r.relPath}`);
        }
      }
      add({
        layer: 'datadir',
        id: 'datadir.assetsContained',
        label: 'assets inside dataDir',
        labelZh: 'media_assets 路径全在 dataDir 内',
        status: escaped.length === 0 ? 'ok' : 'fail',
        detail:
          escaped.length === 0
            ? `${rows.length} 条资产全部落在 ${input.dataDir} 内`
            : `${escaped.length}/${rows.length} 条指向 dataDir 外（移动数据目录后会失效）：${escaped.slice(0, 3).join(' ')}`,
        required: true,
        remediation:
          escaped.length === 0
            ? null
            : '这些资产存的是绝对路径或落在 dataDir 之外，搬家后会取不到；需要把文件收进 <dataDir>/media 并改存相对路径',
      });
      add({
        layer: 'datadir',
        id: 'datadir.assetsPresent',
        label: 'asset files present',
        labelZh: 'media_assets 文件都在',
        status: dangling.length === 0 ? 'ok' : 'warn',
        detail:
          dangling.length === 0
            ? '无悬空引用'
            : `${dangling.length} 条文件已不存在：${dangling.slice(0, 3).join(' ')}`,
        required: false,
        remediation: dangling.length === 0 ? null : '对应的媒体文件已被删除，相关笔记无法回放',
      });
    }
  }

  // ---- engines ----------------------------------------------------------------------
  for (const e of await input.probes.engines()) {
    add({
      layer: 'engines',
      id: `engine.${e.id}`,
      label: e.id,
      labelZh: e.id,
      status: e.available ? 'ok' : 'warn',
      detail: e.available ? '可用' : (e.reason ?? '不可用'),
      required: false,
      remediation: e.available ? null : '安装该引擎所需的后端包与模型',
    });
  }

  for (const [lang, labelZh] of [
    ['zh', '中文自动选择'],
    ['en', '英文自动选择'],
  ] as const) {
    const sel = await input.probes.selectFor(lang);
    add({
      layer: 'engines',
      id: `engine.select.${lang}`,
      label: `auto engine (${lang})`,
      labelZh,
      status: sel !== null ? 'ok' : 'fail',
      detail: sel !== null ? `${sel.engineId}（${sel.reason}）` : '无可用引擎',
      required: true,
      remediation: sel !== null ? null : '安装 CPU 基础包与一个语音识别模型',
    });
  }

  // ---- proxy ------------------------------------------------------------------------
  if (input.probes.proxy === undefined) {
    notProbed('proxy', 'proxy.config', 'proxy configuration', '代理配置');
    notProbed('proxy', 'proxy.ffmpeg', 'proxy covers ffmpeg', '代理覆盖 ffmpeg');
  } else {
    const px = await input.probes.proxy();
    add({
      layer: 'proxy',
      id: 'proxy.config',
      label: 'proxy configuration',
      labelZh: '代理配置',
      status: 'ok',
      detail:
        px === null
          ? '未配置（off=直连 / system=继承环境变量 / manual=手填）'
          : `mode=${px.mode}${px.activeUrl ? ` → ${px.activeUrl}` : ''}`,
      required: false,
      remediation: null,
    });

    /*
     * 这条是**别处没人会说**的功能性事实，所以哪怕默认不联网也要报：
     * ffmpeg 不支持 SOCKS（libavformat 的 http 协议只读 `http_proxy`，不认 `ALL_PROXY`）。
     * 配了 SOCKS 的用户会以为"全都走代理了"，直到在线拉流直连失败也想不到是这个原因。
     */
    const ffOk = px === null || px.ffmpegSupported;
    add({
      layer: 'proxy',
      id: 'proxy.ffmpeg',
      label: 'proxy covers ffmpeg',
      labelZh: '代理覆盖 ffmpeg',
      status: ffOk ? 'ok' : 'warn',
      detail: ffOk ? '当前代理形态 ffmpeg 可用' : (px?.ffmpegReason ?? 'ffmpeg 不走当前代理'),
      required: false,
      remediation: ffOk ? null : '模型下载与站点解析仍走代理；若要在线拉流也走代理，请改填 HTTP 代理地址',
    });
  }

  if (input.proxyTest === true && input.probes.proxyConnectivity !== undefined) {
    const px = input.probes.proxy === undefined ? null : await input.probes.proxy();
    const rep = await input.probes.proxyConnectivity();
    const manual = px?.mode === 'manual';
    const detail =
      rep === null
        ? '探测失败'
        : rep.probes.map((p) => `${p.target}:${p.result}${p.viaProxy ? '(经代理)' : '(直连)'}`).join(' ') ||
          '无探针结果';
    /*
     * 只有 mode=manual 时才算"必需项"。
     * 用户明确填了代理却连不上 = 配置坏了，下载一定会失败，该红。
     * 而 off/system 下探针失败可能只是**这台机器没网** —— 把"离线"渲染成"产品坏了"
     * 和"绿灯不代表能用"是同一个病的两面。
     */
    add({
      layer: 'proxy',
      id: 'proxy.connectivity',
      label: 'proxy reachability',
      labelZh: '代理实连测试',
      status: rep?.ok === true ? 'ok' : manual ? 'fail' : 'warn',
      detail: detail + (manual ? '' : '（未配代理：失败可能只是本机离线）'),
      required: manual,
      remediation: rep?.ok === true ? null : '检查代理地址与端口，或先确认本机能出网',
    });
  }

  const counts = {
    ok: results.filter((r) => r.status === 'ok').length,
    warn: results.filter((r) => r.status === 'warn').length,
    fail: results.filter((r) => r.status === 'fail').length,
  };

  return {
    // "ok" means no REQUIRED check failed. Warnings are degradations the user chose or
    // has not got to yet; failures mean something is actually broken.
    ok: results.every((r) => !(r.status === 'fail' && r.required)),
    ranAt: new Date().toISOString(),
    dataDir: input.dataDir,
    storeRoot: input.storeRoot,
    extensionsDir: input.extensionsDir,
    counts,
    results,
  };
}

/** List installed artifact names under `<storeRoot>/by-name/<kind>/`. */
export async function listByName(storeRoot: string, kind: string): Promise<string[]> {
  try {
    return (await readdir(join(storeRoot, 'by-name', kind))).sort();
  } catch {
    return [];
  }
}

/** `<extensionsDir>/libsimple.so` 等的平台后缀。CLI 与 daemon 都要用同一份。 */
export function extensionFileName(base: 'libsimple' | 'vec0'): string {
  return `${base}${libSuffix()}`;
}

/* ------------------------------------------------------------------------------------ */
/* 同源校验：把两份报告逐 id 比对                                                          */
/* ------------------------------------------------------------------------------------ */

export interface SelfCheckDiffEntry {
  id: string;
  /**
   * `missing-here`  对方有、我没有
   * `missing-there` 我有、对方没有
   * `status`        结论不同
   * `required`      必需性不同 —— 纯逻辑，两边**永远**不该不一样
   */
  kind: 'missing-here' | 'missing-there' | 'status' | 'required';
  here: string | null;
  there: string | null;
}

/**
 * 比对两份自检报告。**这才是"同源"的证据** —— 光在注释里保证是不算数的。
 *
 * 比 id、status 和 required：
 *   - id 集合  —— 检查项必须完全一致，这是"网页绿 ≠ CLI 绿"的直接成因；
 *   - status   —— 同样的机器同样的判据，结论必须一样；
 *   - required —— 纯逻辑推导，不受环境影响，两边不同就是判据被改分叉了。
 *
 * 刻意**不比 detail**：detail 里有绝对路径、设备数、版本号这类本来就会不同的东西
 * （CLI 在仓库根跑，daemon 在自己的进程里跑）。拿它们做判据只会制造假报警，
 * 而一条经常误报的红线，很快就等于没有这条线。
 */
export function diffSelfCheckReports(
  here: SelfCheckReport,
  there: SelfCheckReport,
): SelfCheckDiffEntry[] {
  const a = new Map(here.results.map((r) => [r.id, r]));
  const b = new Map(there.results.map((r) => [r.id, r]));
  const out: SelfCheckDiffEntry[] = [];

  for (const [id, ra] of a) {
    const rb = b.get(id);
    if (rb === undefined) {
      out.push({ id, kind: 'missing-there', here: ra.status, there: null });
      continue;
    }
    if (rb.status !== ra.status) {
      out.push({ id, kind: 'status', here: ra.status, there: rb.status });
    }
    if (rb.required !== ra.required) {
      out.push({
        id,
        kind: 'required',
        here: `required=${String(ra.required)}`,
        there: `required=${String(rb.required)}`,
      });
    }
  }
  for (const [id, rb] of b) {
    if (!a.has(id)) out.push({ id, kind: 'missing-here', here: null, there: rb.status });
  }
  return out.sort((x, y) => x.id.localeCompare(y.id));
}
