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

import { access, constants, open, readdir, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

/*
 * ★ 唯一一处 import 别的工作区包（`@openmemo/downloader` 早已在 package.json 的
 * dependencies 里，只是此前没被用过）。**刻意不在这里重写一份魔数判定**：
 * `store.ts` 里那条"两处实现必须手工保持同步"的注释就是前车之鉴 ——
 * 一条要靠人记得同步的规则，等价于一条迟早会漂移的规则。
 */
import { isGgmlModelFile } from '@openmemo/downloader';

import { mediaAssetRoots, probeAssetFile } from './assetPaths.js';
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

/**
 * `by-name/asr` 下这些名字是 **VAD 权重**（T-148）。
 *
 * 只在 `model.vad` 拿不到可加载权重时用来把话说具体：
 * 「一个都没装」和「装了但 whisper.cpp 用不了那一个」在用户那里是完全不同的两件事，
 * 而前一版这条自检把两者都说成「未安装」。
 */
const VAD_WEIGHT_NAME = /silero|vad/i;

/**
 * whisper.cpp 自己算 CoreML encoder 路径的规则 —— **逐条复刻，不另发明**。
 *
 * `vendor/whisper.cpp/src/whisper.cpp:3326-3348`（v1.9.1 / f049fff）：
 *   ① 去掉最后一个 `.` 之后的部分（`.bin`）
 *   ② 若结尾正好是 5 个字符的 `-qX_X`，**再去掉它**
 *   ③ 拼上 `-encoder.mlmodelc`
 *
 * ② 这一步很关键，它是上游**显式支持「量化模型 + CoreML encoder」**的证据：
 * `ggml-large-v3-turbo-q5_0.bin` 找的是 `ggml-large-v3-turbo-encoder.mlmodelc`，
 * 同一份 encoder 给该模型的所有量化档位共用 —— 所以"用 ANE 就得多发一份非量化模型"
 * 这个说法不成立。
 *
 * 导出是为了让测试能拿同一条规则钉住它（而不是把期望值抄成字面量）。
 */
export function coreMlEncoderNameFor(modelFileName: string): string {
  let s = modelFileName;
  const dot = s.lastIndexOf('.');
  if (dot !== -1) s = s.slice(0, dot);
  const dash = s.lastIndexOf('-');
  if (dash !== -1) {
    const sub = s.slice(dash);
    if (sub.length === 5 && sub[1] === 'q' && sub[3] === '_') s = s.slice(0, dash);
  }
  return `${s}-encoder.mlmodelc`;
}

/**
 * `asr.coreml` —— **这台 Mac 到底走没走神经引擎（ANE）？**
 *
 * ─── 为什么必须有这一条 ───────────────────────────────────────────────────────
 *
 * macOS 的核心 whisper 包从 T-146 起带 `-DWHISPER_COREML=ON`
 * **和 `-DWHISPER_COREML_ALLOW_FALLBACK=ON`**。后者的意思是：
 * `.mlmodelc` 加载失败时 whisper.cpp **打一行 ERROR 然后照常跑**（whisper.cpp:3440-3452）。
 *
 * 而那一行 ERROR **谁也看不见** —— `packages/pipeline/src/asr/whisperCpp.ts:101`
 * 传的是 `--no-prints`，whisper-cli 收到它做的第一件事就是
 * `whisper_log_set(cb_log_disable, NULL)`（examples/cli/cli.cpp:1039-1040），
 * 整个日志通道被关掉。
 *
 * 于是不加这一条的话，产品就会造出一个**新的假绿灯**：
 * 用户以为在用神经引擎，实际一直在 CPU/GPU 上跑，而且没有任何地方会告诉他。
 * 这正是本仓最贵的那类 bug（回退了却不说）的教科书形状 ——
 * **判据不是"能不能回退"，是"回退了看不看得见"。**
 *
 * ─── 三档分别对应什么 ────────────────────────────────────────────────────────
 *   ok    encoder 目录在，且里面有 `coremldata.bin`（= 真的是编译好的 mlmodelc）
 *   warn  没装 encoder → ANE 没用上，转写走 Metal/CPU（**功能正常，只是慢**）
 *   fail  目录在、但里面没有 `coremldata.bin` → **whisper 会静默回退**，
 *         用户看到的是"装了 ANE 却没有变快"，而没有任何东西会报错
 *
 * `fail` 那一档不是假想：`ArtifactFile.unpack` 把 `<X>.mlmodelc.zip` 解到
 * `by-name/asr/<X>.mlmodelc/`，而 zip 内部**自带一层同名顶层目录**，
 * 于是真实结构是 `<X>.mlmodelc/<X>.mlmodelc/coremldata.bin` —— 外层是个空壳。
 */
async function checkCoreMl(
  input: SelfCheckInput,
  realAsr: string[],
  add: (r: CheckResult) => void,
): Promise<void> {
  // ANE 只有 Apple Silicon 有。别的平台连这一项都不该出现，免得变成永久噪音。
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;

  const asrDir = join(input.storeRoot, 'by-name', 'asr');
  const emit = (status: CheckResult['status'], detail: string, remediation: string | null): void => {
    add({
      layer: 'models',
      id: 'asr.coreml',
      label: 'CoreML encoder (Apple Neural Engine)',
      labelZh: 'CoreML 编码器（神经引擎 ANE）',
      status,
      detail,
      /*
       * required=false 是有意的：**没有 ANE 不影响能不能转写**，只影响快不快
       * （CoreML 只接管 encoder，whisper.cpp:2412）。把它标成 required 会让
       * 一台完全正常的 Mac 报红，那是另一种谎。
       */
      required: false,
      remediation,
    });
  };

  if (realAsr.length === 0) {
    emit('warn', '还没有 ASR 模型，无从判断 ANE 是否可用', '先在「模型」页装一个语音识别模型');
    return;
  }

  /*
   * ★ 只有 whisper.cpp 的 ggml `.bin` 才谈得上 CoreML encoder。
   *
   * `by-name/asr` 下也躺着 sherpa 的 onnx 分片（`encoder-epoch-99-avg-1.int8.onnx` 之类）——
   * 第一次真跑时这一项就对着它算出了 `缺 decoder-epoch-99-avg-1.int8-encoder.mlmodelc`，
   * 一句**语法正确但毫无意义**的话。一条会对不相干的东西发表意见的检查，
   * 说对的时候也不该被相信。
   */
  const ggml = realAsr.filter((n) => n.toLowerCase().endsWith('.bin'));
  if (ggml.length === 0) {
    emit(
      'warn',
      `没有 whisper.cpp 的 ggml 模型，ANE 不适用（CoreML encoder 只服务 whisper.cpp；`
        + `当前 by-name/asr 下是：${realAsr.slice(0, 4).join(', ')}）`,
      null,
    );
    return;
  }

  const found: string[] = [];
  const shells: string[] = [];
  const missing: string[] = [];
  for (const bin of ggml) {
    const encName = coreMlEncoderNameFor(bin);
    const encDir = join(asrDir, encName);
    let entries: string[];
    try {
      entries = await readdir(encDir);
    } catch {
      missing.push(`${bin} → 缺 ${encName}`);
      continue;
    }
    /*
     * 判据是**目录里有没有 `coremldata.bin`**，不是"目录在不在"。
     * 「目录存在」正是那个空壳的表现 —— 只查存在性等于把 fail 读成 ok。
     */
    if (entries.includes('coremldata.bin')) found.push(`${bin} → ${encName}`);
    else shells.push(`${encName}（里面是 ${entries.slice(0, 3).join(', ') || '空'}，不是编译好的 mlmodelc）`);
  }

  if (shells.length > 0) {
    emit(
      'fail',
      `CoreML encoder 目录结构不对，whisper 会**静默回退**到 Metal/CPU：${shells.join('；')}`,
      '删掉该目录重装；若重装后仍是这个结构，是解包多了一层同名目录（installer.ts 的 stripExt + zip 自带顶层目录）',
    );
    return;
  }
  if (found.length > 0) {
    emit(
      'ok',
      `ANE 已就绪（encoder 只接管 whisper 的 encoder 部分，decoder 仍走 Metal/CPU）：${found.join('；')}`,
      null,
    );
    return;
  }
  emit(
    'warn',
    `未启用 ANE —— 转写会走 Metal/CPU（功能正常，只是慢）：${missing.join('；')}`,
    '在「模型」页为该模型安装可选的 CoreML encoder（role=coreml-encoder）',
  );
}

async function exists(p: string | null | undefined, mode: number): Promise<boolean> {
  if (p === null || p === undefined || p.length === 0) return false;
  try {
    await access(p, mode);
    return true;
  } catch {
    return false;
  }
}

export interface SymlinkHealth {
  /** 相对 `by-name/backend/` 的路径 */
  rel: string;
  /** `readlink` 的原样结果 */
  target: string;
  /** 顺着链真的读到内容了吗 */
  readable: boolean;
  /** 读不到时的原因（errno），读得到时是首 4 字节的十六进制 */
  note: string;
}

/**
 * 检查后端包里的符号链接**是不是真的能用**。
 *
 * ─── 为什么这条检查必须存在（T-128）──────────────────────────────────────────────
 * 用户移动数据目录后，whisper.cpp 的 8 条 `.so` 链接全部悬空（`fs.cp` 把相对链接
 * 改写成了指向旧位置的绝对路径），转写完全不可用 —— 而**产品里没有任何地方会发现它**：
 * 安装记录里没有链接的痕迹，模型校验只比 sha256（链接不是文件），
 * 目录结构看起来完好无损。除了真去跑一次转写，无人知晓。
 *
 * ─── 判据为什么必须是"真的读到内容"────────────────────────────────────────────────
 * **不能用 `lstat()`**：它根本不跟随链接，对一条彻底悬空的链接**照样返回成功**。
 * **也不用 `access()`**：它虽然跟随链接、悬空时确实会失败，但它只回答"能不能"，
 * 不产生任何可核对的证据。这里 `open()` + 读**首 4 字节**：
 * 悬空 → ENOENT；指向空文件/被截断 → 读不满 4 字节。代价是常数级，不受 `.so` 体积影响。
 *
 * 这是 ADR-014 那条标准在这个位置的具体形态：**验功能可用，不验组件存在**。
 */
export async function checkBackendSymlinks(storeRoot: string): Promise<SymlinkHealth[]> {
  const root = join(storeRoot, 'by-name', 'backend');
  const out: SymlinkHealth[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return; // 目录不存在 = 没装后端包，交给调用方判断，不在这里假装成功
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) {
        const target = await readlink(p).catch(() => '<readlink 失败>');
        let readable = false;
        let note: string;
        let fh;
        try {
          // open() 跟随符号链接 —— 悬空链接在这里就会抛 ENOENT
          fh = await open(p, 'r');
          const buf = Buffer.alloc(4);
          const { bytesRead } = await fh.read(buf, 0, 4, 0);
          readable = bytesRead === 4;
          note = readable
            ? buf.toString('hex')
            : `只读到 ${bytesRead} 字节（文件为空或被截断）`;
        } catch (err) {
          note = (err as NodeJS.ErrnoException).code ?? String(err);
        } finally {
          await fh?.close().catch(() => {});
        }
        out.push({ rel: p.slice(root.length + 1), target, readable, note });
      } else if (e.isDirectory()) {
        await walk(p);
      }
    }
  };
  await walk(root);
  return out;
}

/**
 * 悬空链接指向的是不是"另一个数据目录"。
 *
 * 用来把 remediation 说准：如果断掉的目标里出现了 `by-name/backend`，
 * 那几乎可以肯定是**搬过家**留下的（旧位置已被删），而不是安装本身出了错。
 */
function looksLikeMovedDataDir(links: SymlinkHealth[]): boolean {
  return links.some((l) => !l.readable && isAbsolute(l.target) && l.target.includes('by-name'));
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

  /*
   * ---- 后端 .so 符号链接（T-128）---------------------------------------------------
   *
   * `required: true` 是**无条件**的，不随环境变化 —— 判据是一句纯逻辑：
   * "后端的 .so 链断了 = 转写不能用"。环境差异全部由 status 承担。
   * 这一点对同源比对很要紧：`diffSelfCheckReports` 把 required 不一致直接判为
   * "判据被改分叉了"，所以 required 不能写成依赖 storeRoot 内容的条件表达式
   * （CLI 与 daemon 的 storeRoot 可以不同）。
   */
  const soLinks = await checkBackendSymlinks(input.storeRoot);
  const brokenLinks = soLinks.filter((l) => !l.readable);
  add({
    layer: 'tools',
    id: 'backend.libLinks',
    label: 'backend shared-library symlinks resolve',
    labelZh: '后端 .so 符号链接可解析',
    status:
      backendPacks.length === 0
        ? 'warn'
        : brokenLinks.length > 0
          ? 'fail'
          : soLinks.length === 0
            ? 'warn'
            : 'ok',
    detail:
      backendPacks.length === 0
        ? '未安装后端包，无可检查的链接'
        : brokenLinks.length > 0
          ? `${brokenLinks.length}/${soLinks.length} 条链接读不到目标：` +
            brokenLinks
              .slice(0, 3)
              .map((l) => `${l.rel}→${l.target}(${l.note})`)
              .join('  ')
          : soLinks.length === 0
            ? '该后端包不含符号链接（未做检查，不代表后端可用）'
            : `${soLinks.length} 条链接全部可读到目标内容`,
    required: true,
    remediation:
      brokenLinks.length === 0
        ? null
        : looksLikeMovedDataDir(brokenLinks)
          ? '这些链接指向的是旧数据目录（多半是移动数据目录后留下的）。在「运行时」页重新安装该后端包即可修复；数据与笔记不受影响。'
          : '在「运行时」页重新安装该后端包 —— 链接的目标文件已不存在，whisper 会报 "cannot open shared object file" 而无法加载。',
  });

  /*
   * ★ T-148 —— 这条以前查的是 `access(R_OK)`，也就是**"有没有一个文件"**。
   *
   * 而 `by-name/asr` 底下合法地同时躺着两个 VAD 权重：
   * `ggml-silero-v6.2.0.bin`（whisper.cpp 用）与 `silero_vad.onnx`（sherpa 用），
   * 两条清单条目自己都写着"另一个引擎加载不了我"。存在性检查对这两者一视同仁 ——
   * 于是 daemon 把 ONNX 交给 whisper 的 VAD 二进制、整单转写死掉的同时，
   * **这条自检是绿的**（`[CI 实测]` run 31039460495）。
   *
   * 现在判据换成"whisper.cpp 真的能加载它吗"（读头四字节比 GGML 魔数，
   * 与 `whisper_vad_init_with_params` 的第一步逐字对应）。三档的分工：
   *   ok   —— 是 ggml 权重，按静音切分
   *   warn —— 一个都没装：**正常状态**，退回固定窗口，功能可用只是断句差
   *   fail —— 装了、文件也在，但 whisper.cpp 加载不了。**这一档才是本次要抓的那格**，
   *           它比 warn 更糟：用户以为自己装好了。
   */
  const vadPresent = await exists(tools.vadModel, constants.R_OK);
  const vadLoadable = await isGgmlModelFile(tools.vadModel);
  /*
   * 兜底观测：即使解析器已经拒绝交出坏文件（tools.vadModel === null），
   * by-name/asr 里那份 ONNX 仍然在，用户仍然需要知道"你装的那个 whisper 用不了"。
   * 只看 tools.vadModel 会让这条永远说"未安装"，那是一句正确但没用的话。
   */
  const asrBucket = await input.probes.installed('asr');
  const strandedVad = vadLoadable ? [] : asrBucket.filter((n) => VAD_WEIGHT_NAME.test(n));
  add({
    layer: 'tools',
    id: 'model.vad',
    label: 'VAD model',
    labelZh: 'VAD 模型',
    /*
     * `fail` 只留给"解析器把一个加载不了的文件当成了 VAD 权重交出来" ——
     * 修好之后这一档在正常运行里不可达，它存在的意义是**反向验证时会红**，
     * 以及万一将来又有人绕过解析器时当场出声。
     * 「装错了那一个」是 `warn`：功能仍然可用（退回固定窗口），
     * 而且只装 sherpa ONNX 对流式用户是完全合法的选择 —— 报红会是假红灯。
     */
    status: vadLoadable ? 'ok' : vadPresent ? 'fail' : 'warn',
    detail: vadLoadable
      ? (tools.vadModel as string)
      : vadPresent
        ? `${tools.vadModel as string} 不是 ggml 格式，whisper.cpp 加载不了（会报 bad magic）→ 切分降级为固定窗口`
        : strandedVad.length > 0
          ? `已装的 VAD 权重 whisper.cpp 用不了（${strandedVad.join('、')}，那是 sherpa 引擎的 ONNX 格式）→ 切分降级为固定窗口`
          : '未安装 → 切分降级为固定窗口',
    required: false,
    remediation: vadLoadable
      ? null
      : '在「模型」页安装 `vad/silero-vad-ggml`（whisper.cpp 用的 ggml 格式；`vad/silero-vad-onnx` 是 sherpa 引擎用的，两者不能互换）',
  });

  // ---- models -----------------------------------------------------------------------
  const asr = asrBucket;
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

  await checkCoreMl(input, realAsr, add);

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
   * 这条查的是真东西：把 `media_assets` 每条路径**按播放端那份规则**解析出来
   * （`assetPaths.ts`，T-136 起同源），看它落不落在 dataDir 内、内容读不读得到。
   * T-093 就是靠它坐实了 `audio16k` 存的是**绝对路径**且指向
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
      /*
       * ★ T-136：解析基准与**播放端完全同一份**（`assetPaths.ts`）。
       *
       * 上一版这里写死 `resolve(<dataDir>/media, relPath)` 一个基准，而 `rel_path`
       * 实际有三种历史形态（见 `assetPaths.ts` 的表）。后果不是漏报，是**说错话**：
       * 用户库里 3 条相对 `<dataDir>` 存的记录被算成 `…/media/media/legacy/…`，
       * 于是报「3 条文件已不存在」「对应的媒体文件已被删除」——
       * **那 3 个文件一个没少，全在盘上。** 用户会去翻备份、会怀疑自己删过东西。
       *
       * 判据也从 `access()` 换成**真的打开并读首 4 字节**（与 T-128 同一条标准）：
       * `access` 只回答"能不能"，不产生任何可核对的证据；现在 detail 里给的是
       * 真读到的字节，以及**程序到底找过哪几个位置**。
       */
      const roots = mediaAssetRoots(input.dataDir);
      const escaped: string[] = [];
      const dangling: string[] = [];
      let evidence = '';
      for (const r of rows) {
        const probe = await probeAssetFile(roots, r.relPath);
        if (probe.tried.length === 0) {
          escaped.push(`${r.role}→${r.relPath}`);
        } else if (probe.abs === null && probe.escaped.length > 0) {
          /*
           * ★ T-143 ①：候选**落在根内**，但顺着符号链接解析出去了。
           * 这必须算进"越界"这一档，不能算"读不到"—— 否则
           * `assetsContained` 会一边报 "全部落在 dataDir 内" 一边指着一条
           * 指向 /etc 的软链，那正是本项目定义的最贵的一种假红灯：**结论对、理由假**。
           */
          escaped.push(`${r.role}→${r.relPath}（软链指向根外：${probe.escaped.join('、')}）`);
        } else if (probe.abs === null) {
          dangling.push(`${r.role}→${r.relPath}（找过：${probe.tried.join('、')}）`);
        } else if (probe.bytesRead === 0) {
          dangling.push(`${r.role}→${r.relPath}（${probe.abs} 是 0 字节，播不了）`);
        } else if (evidence === '') {
          evidence = `${r.relPath} → ${probe.abs} 首 4 字节 ${probe.note}`;
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
            ? rows.length === 0
              ? '没有媒体资产'
              : `${rows.length} 条资产都真的读到了内容（例：${evidence}）`
            : `${dangling.length}/${rows.length} 条读不出来：${dangling.slice(0, 3).join('；')}`,
        required: false,
        /*
         * 措辞是这条检查最要命的地方 —— 旧文案直接断言"已被删除"，而实测中
         * 更常见的成因是**记录里的路径和文件实际位置对不上**。
         * 一句说错的红灯会让用户去翻备份、怀疑自己误删，还会淹没真正丢了的那条。
         */
        remediation:
          dangling.length === 0
            ? null
            : '⚠️ 这**不等于**文件被删除：更常见的是记录里的路径与文件实际位置对不上（括号里就是程序真正找过的位置，可以自己去核对）。重启 daemon 会跑一次路径迁移，能自动修好一部分；仍然报的才需要找回文件。',
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
