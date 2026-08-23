/**
 * 模型 / 后端 / 任务三个 REST 子域共享的运行时状态。
 *
 * 这一层持有**真东西**：真实的 `ArtifactStore`（内容寻址 + SHA-256）、真实的
 * `DownloadQueue`、真实的 `vendor/manifests`、真实的 `computeFit`。没有任何 mock。
 *
 * 事件方向遵守 D-01 §3.3："事件只是'该去拉数据了'的提示，真相永远在 REST"。
 * 因此这里发出的 SSE 除 `job.progress` 外都只带最小载荷。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { backendPrefsPath, discoverTools, resolveStoreRoot } from '@openmemo/pipeline';
import { detectDisks, detectMemory } from '@openmemo/runtime';

import {
  ArtifactStore,
  DownloadQueue,
  STORE_KINDS,
  assertInsideInstallRoots,
  bucketForRole,
  orderSourcesForDownload,
  probeAll,
  resolveInstalledFile,
  unpackDirName,
  type ProbeOutcome,
  type ProbeTarget,
  type StoreKind,
} from '@openmemo/downloader';
import {
  BUNDLED_MODEL_IDS,
  MODEL_ROLES,
  PROGRESS_UNREPORTABLE,
  computeFit,
  makeEvent,
  progressOf,
  referenceSpeedOf,
  topics,
  type ActiveSlotUnusable,
  type Backend,
  type BackendPack,
  type CatalogGroupWithFitness,
  type CatalogVariant,
  type DownloadJob,
  type FailedFileReport,
  type GetCatalogResponse,
  type GetStorageResponse,
  type GetSourcesResponse,
  type HardwareInfo,
  type InstalledBackendPack,
  type InstalledModel,
  type JobState,
  type Mirror,
  type ModelEntry,
  type ModelRole,
  type ProviderId,
  type RemovalFailureKind,
  type SourceProbe,
  type SseEvent,
  type StorageBreakdownItem,
} from '@openmemo/shared';

import {
  byModelDir,
  loadableByRoleConsumer,
  soleConsumerEngine,
} from '../../pipeline/modelStore.js';
import type { SseHub } from '../sse.js';
/*
 * ⚠️ **静态 import，不许改成动态 `import()`。**
 * daemon 的 dist 里目前没有任何对本地模块的动态 import —— 这条性质保证了
 * "重建产物时正在跑的进程不会半新半旧"（`gates-fix §8` 靠它才敢重建 dist）。
 * `backends.ts` 对 `state.ts` 是 **type-only** 引用，所以这条边不构成运行时环。
 */
import { reconcileBackendManifests } from './backendReconcile.js';
import { currentPlatform } from './backends.js';
import { detectLocalHardware } from './hardware.js';
import {
  loadBackendCatalog,
  loadModelCatalog,
  type BackendCatalog,
  type ModelCatalog,
} from './manifests.js';
import { reconcileBundledModels } from './modelReconcile.js';
import { roleToActivationSlot, roleToStoreKind } from './roleMap.js';

export const HARDWARE_SNAPSHOT_ID = 'hw-local';

/**
 * 一个路径在磁盘上占多少字节（`du` 的语义：目录递归，(dev, ino) 去重）。
 *
 * 去重不是洁癖：`by-name/<kind>/<归档名>` 与 `blobs/sha256-…` 是**同一个 inode**
 * （`[实测]` `ino=289895 links=2`），数两遍会让"能回收多少"报出一个用户永远拿不到的数。
 */
/**
 * 「工具解析器不可用，因此无法证明这个残留没在用」的具名标记。
 *
 * 用一个**会显示给用户**的字符串而不是布尔：这一格出现时，用户看到的是
 * 「这几项不能回收，因为我们现在问不出它们在不在用」——
 * 那比一个安静地不出现在可回收里的数字诚实得多。
 */
const RESOLVER_UNAVAILABLE = '工具解析器当前不可用，无法证明它没在被使用';

/** 一条**被拒绝删除**的记录项 —— 不是"删了但不在"，是"知道它在、不肯去删"。 */
export interface RefusedFile {
  /** 安装记录里那个文件的名字（`files[].name`），用户界面能对上号的那个。 */
  readonly name: string;
  /** 为什么拒绝。原样来自解析层的异常，里面带着路径与允许的根。 */
  readonly reason: string;
}

/**
 * 一条**试着删了、没删动**的记录项（#113）—— 与 {@link RefusedFile} 是两件事。
 *
 * ★ 直接**别名**契约里那个类型，不像 `RefusedFile` 那样另抄一份字段：
 * 这一格是 #113 新加的，没有历史包袱，而两份结构各写一遍的代价本仓已经付过
 * （`filesNotRemoved` 那次靠 `satisfies` 才把两侧钉住）。别名之后
 * daemon 与网线上的形状**在类型上就是同一个**，漂不了。
 */
export type FailedFile = FailedFileReport;

/**
 * `dropInstalledFiles()` 的账。
 *
 * 存在的理由见该方法的注释：**没有这份返回值，「拒绝」就无法与「本来就没有」区分**，
 * 于是既没法告诉用户，也没法写一条会红的断言。
 */
export interface DropFilesReport {
  /**
   * **真的删成了**的条目数。
   *
   * ⚠️ #113 之前这里数的是「走到了 `fs.rm` 那一行」—— 而那一行是
   * `fs.rm(...).catch(() => undefined)`，**抛了也照样 `removed += 1`**。
   * 于是这个数在数它没删掉的东西，用户拿到一个干净的成功而文件还在盘上。
   * 现在只有 `fs.rm` **没有抛**才计数。
   *
   * `force: true` 的语义不变：文件本来就不在**算删成了**（那正是我们要的终态），
   * 它和「删不动」在 `fs.rm` 那里本来就是两个结果，不需要我们再分一次。
   */
  readonly removed: number;
  /** 我们**拒绝**去删的条目。空数组 = 这次卸载没有任何东西因越界被留下。 */
  readonly refused: readonly RefusedFile[];
  /**
   * 我们**试了、没删动**的条目（#113）。空数组 = 没有任何一次 `fs.rm` 抛过。
   *
   * 🔴 **不许并进 `refused`**：那一格的语义是「我们主动不删」，这一格是
   * 「我们想删、删不动」，**对用户的下一步动作不同**（前者只能他自己去删，
   * 后者重启一次多半就好）。详见 `FailedFileReport` 的文件头。
   */
  readonly failed: readonly FailedFile[];
}

/**
 * 一个 `fs.rm` 抛出来的错 → 用户读得懂的那一档。
 *
 * ## 🔴 判据是「用户会做一件别的事吗」，不是 errno 好看
 *
 * 三格，一个都不多。多分一格却给不出不同的建议 = 拿分类学冒充信息，
 * 而这一族缺陷（说了一堆话、用户仍然不知道该干什么）本仓正在清。
 *
 * ## ⚠️ 认不出来的一律 `unknown`，**不许猜**
 *
 * `fs.rm` 能抛的东西没有边界（`ERR_FS_EISDIR`、`ENOTDIR`、文件系统自己的
 * 各种 errno…）。给一个我们没看懂的错编一个成因，比说「不知道」更坏：
 * 用户会照着那个编出来的建议去做一件没有用的事，然后连"要不要相信这句话"
 * 都判断不了。`unknown` 那一格的界面文案本身就把这件事说了出来。
 *
 * ## 为什么 `EPERM` 不按平台分叉
 *
 * 诱惑是「win32 的 EPERM 多半是句柄被占 ⇒ 报 `in_use`，让用户去重启」。
 * **但那是在猜**：libuv 在 Windows 上把「只读属性」「文件被映射（正在运行的 DLL）」
 * 和「ACL 不允许」都收敛到同一批错误码上，我们分不出来。
 * 所以 `EPERM`/`EACCES` 统一进 `permission_denied`，而**那一格的措辞
 * 把两种可能都说出来**（见 locale 里 `uninstall.removalFailure.permission_denied`）
 * —— 说「可能是 A 也可能是 B」是诚实的，挑一个说得斩钉截铁不是。
 */
export function classifyRemovalFailure(err: unknown): RemovalFailureKind {
  const code =
    typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : '';
  switch (code) {
    // 有别的东西正握着它。**这一格有解药，而且用户做得到**：关掉它，或者重启。
    case 'EBUSY':
    case 'ETXTBSY':
      return 'in_use';
    // 系统不让删。Windows 上「被打开着」也会落到这里 —— 措辞里两种都说。
    case 'EACCES':
    case 'EPERM':
      return 'permission_denied';
    default:
      return 'unknown';
  }
}

/**
 * 产品**现在**把工具解析到了哪些路径 —— 「无法识别的残留」的第二道闸。
 *
 * 返回 `null` 表示**解析器自己失败了**（不是"没有工具"）。调用方必须把它
 * 当成"可能在用"，而不是"可以删"。两者混同过一次，代价见 `findUnclaimedFiles()`。
 */
async function resolveLiveToolPaths(storeRoot: string): Promise<string[] | null> {
  try {
    const tools = await discoverTools({ storeRoot });
    return Object.values(tools).filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return null;
  }
}

async function duBytes(root: string): Promise<number> {
  const seen = new Set<string>();
  let total = 0;
  const walk = async (p: string): Promise<void> => {
    let st;
    try {
      st = await fs.lstat(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let entries: string[];
      try {
        entries = await fs.readdir(p);
      } catch {
        return;
      }
      for (const e of entries) await walk(path.join(p, e));
      return;
    }
    if (!st.isFile()) return;
    const key = `${String(st.dev)}:${String(st.ino)}`;
    if (seen.has(key)) return;
    seen.add(key);
    total += st.size;
  };
  await walk(root);
  return total;
}

/**
 * 已安装后端记录里**不进硬件指纹**的字段 —— 与 `machineFingerprint()` 配套。
 *
 * ## 为什么是"排除表"而不是"包含表"
 *
 * 上一版的指纹是手挑三样（模型根 / 选中的后端 / 包 **id**），并在注释里承诺
 * 「不写任何代码它就已经被覆盖了」。**那句承诺是假的**：把同一个 id 重装成不同的
 * 字节落在三样之外，于是用户机器上探针装上了、界面照旧说没有（T-191，用户真机实测）。
 *
 * 包含表的失效模式是**沉默**：漏了一样，没有任何东西会说话。
 * 排除表反过来 —— 新增字段默认进指纹，想让它不进就**必须在这里写下来**，
 * 而这是一处看得见的 diff，还有 `hardwareFingerprintCoverage.test.ts` 逐字段变异钉着。
 *
 * ## 这三个为什么可以排除（每条都有代价说明，不是"看着像没用"）
 *
 * · `installedAt` / `verifiedAt` —— 时间戳。它们会在**内容没变**时更新
 *   （重新校验完整性就会写 `verifiedAt`）。放进指纹的话，每一次完整性校验
 *   都会触发一次真探测（spawn probe / nvidia-smi，几百 ms 到几秒），
 *   而探测结果**必然与上次相同** —— 那是纯粹的开销，换不到任何新信息。
 *   ⚠️ 代价：如果哪天有人**只改时间戳来表达"内容变了"**，这里会漏。
 *   今天不会：安装器换内容必然换 `files[].sha256`。
 * · `selfTest` —— 自检结果是**探测的产物**，不是探测的输入。
 *   放进去会成环：跑自检 → 写回结果 → 指纹变 → 重探 → …
 */
export const FINGERPRINT_IGNORED_FIELDS: readonly string[] = [
  'installedAt',
  'verifiedAt',
  'selfTest',
];

/**
 * 一条已安装记录的规范化指纹：**全文，减去 {@link FINGERPRINT_IGNORED_FIELDS}**。
 *
 * 键按字典序输出，所以 JSON 里字段顺序的变化不会被误报成"机器变了"。
 * 导出是为了让守卫能直接对它做逐字段变异，而不是去构造整个 `RestState`。
 */
export function canonicalPackFingerprint(record: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        if (FINGERPRINT_IGNORED_FIELDS.includes(k)) continue;
        out[k] = canon((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(canon(record));
}

/**
 * 队列事件的类型收窄。
 *
 * `DownloadQueueEvents` 带 `[k: string]: unknown[]` 索引签名（downloader 那边为了让
 * EventEmitter 泛型能接受任意事件名而加的），TS 因此把监听器参数推成 `unknown[]`。
 * 在这两个 helper 里**集中断言一次**，好过让每个 handler 内部散落 `as`。
 * 断言是安全的：downloader 的 `DownloadQueueEvents` 已声明了各事件的真实载荷。
 */
function onJob(
  queue: DownloadQueue,
  event: 'job.created' | 'job.progress' | 'job.step' | 'job.done' | 'job.failed',
  fn: (job: DownloadJob) => void,
): void {
  queue.on(event, (...args: unknown[]) => {
    fn(args[0] as DownloadJob);
  });
}

function onJobState(queue: DownloadQueue, fn: (job: DownloadJob, prev: JobState) => void): void {
  queue.on('job.state', (...args: unknown[]) => {
    fn(args[0] as DownloadJob, args[1] as JobState);
  });
}

/**
 * 用户偏好，落盘在 models 根目录，重启后保持。
 *
 * ★ T-171 删掉了 `sourceBaseUrl`（A-6）。它曾在 `models.ts` 里被写入并随本对象落盘，
 *   而**全仓没有任何一处读它** —— 不出现在 `buildSources()` 的返回里，
 *   也不在 `GetSourcesResponse` 上，所以连泄漏给客户端都做不到。
 *   对照：同一个对象里的 `sourceProvider` 与 `selectedBackend` 各有真实读取方
 *   （见下面 `loadPrefs` 紧跟着的两行、以及 `effectiveProvider()`）。
 *
 *   判据不是"省下一个字段的空间"，是**零读取方的字段会让下一个人以为它在起作用**。
 *   这个仓库刚因为同一个形状吃过亏：一个从未被调用的验签函数，
 *   让人以为目录是被验签的。
 */
interface Prefs {
  sourceProvider: ProviderId | 'auto';
  selectedBackend: Backend | null;
}

const DEFAULT_PREFS: Prefs = { sourceProvider: 'auto', selectedBackend: null };

export interface RestStateDeps {
  sse: SseHub;
  dataDir: string;
  manifestDir: string;
}

/**
 * 已被裁掉、但清单里还留着条目的 role。
 *
 * 今天只有一个：**`llm`** —— `ADR-016` 决策 3 砍掉了内置本地 LLM
 * （`llama-server` 线整体下线），只保留在线的 BYO API Key 与探测已装的 Ollama / LM Studio。
 */
const RETIRED_ROLES: ReadonlySet<string> = new Set(['llm']);

/**
 * 把已裁掉的 role 从模型目录里**摘掉 —— 在服务端，不是在前端**。
 *
 * ## 为什么必须在这一层
 *
 * `[实测 2026-08-08]` 在此之前：`vendor/manifests/models-llm.json` 的 5 条 GGUF
 * （`llm/qwen3-4b-q4_k_m` 等）**确实到达 `/api/models/catalog`** ——
 * `manifests.ts` 已改成列目录加载所有 `*.json`，服务端没有任何过滤；
 * 只是 `apps/web` 的 `ASR_TAB_ROLES = ['asr','vad','punctuation']` 把它们挡在了界面外。
 *
 * 也就是说它是**一个活着的 API 面，只是今天没人走**：
 * `POST /api/models/pull` 直接喂 `llm/qwen3-8b-q4_k_m` 仍然能下载一个
 * **`ADR-016` 已经裁掉的东西**，而且任何客户端（或哪天有人把那个 role 白名单放宽）
 * 都会重新把它显示出来。
 *
 * Manager 2026-08-08 裁定「**关掉**」，依据是本仓这一整轮反复用的同一条：
 *
 * > **不许留半个功能。** 零读者字段最坏的地方不是浪费空间，
 * > 是**下一个人会以为它在起作用**。而这条比零读者更糟 —— **它是活的，只是今天没人走。**
 *
 * 并明确：**前端过滤是装饰不是闸门**，要关在服务端。
 *
 * ## 为什么是"过滤"而不是"删掉那个 manifest 文件"
 *
 * 删文件会让下一个人**看不出这里曾经有过什么、以及为什么没了**，
 * 于是他很可能把它加回来（§13 那张表就是这么来的）。
 * 留着文件 + 在这里摘掉 + 在 `ADR-016` 里写清历史，三件事一起才叫关完。
 *
 * ## 一个刻意的例外
 *
 * **已经装在盘上的记录不受影响** —— `listInstalled()` 读的是 `manifests/` 下的
 * 安装记录，不是这份目录。用户此前装过的东西不该因为我们改了主意就从界面上消失，
 * 那是"数据在界面上消失"那一族。这里关的是**新的下载入口**。
 */
function withoutRetiredRoles(catalog: ModelCatalog): ModelCatalog {
  const kept = catalog.models.filter((m) => !RETIRED_ROLES.has(m.role));
  const dropped = catalog.models.length - kept.length;
  if (dropped > 0) {
    /*
     * ⚠️ **降级为 debug（2026-08-09）。** 原意是对的 —— 静默地少几条目录，
     *   下一个人排查"我的模型去哪了"会很难受，所以要出声。
     *   但出声的**对象搞错了**：cmd 窗口里这些行，对一个双击启动的 Windows 用户
     *   来说**就是产品的界面**，而"已裁 role 的条目 / ADR-016 决策 3"对他毫无意义
     *   （用户实测把它和别的噪音一起贴出来问这是什么）。
     *   它服务的是**排查的人**，所以挪到 `OPENMEMO_DEBUG=1` 后面：需要的人拿得到，
     *   不需要的人看不见。**没有删** —— 删了就又变回"静默地少几条"。
     */
    if (process.env.OPENMEMO_DEBUG === '1') {
      console.log(
        `[models] 目录里摘掉 ${dropped} 条已裁 role 的条目（${[...RETIRED_ROLES].join('、')}）—— ADR-016 决策 3`,
      );
    }
  }
  return { ...catalog, models: kept };
}

export class RestState {
  readonly store: ArtifactStore;
  /**
   * 全局并发 2：更多并行大文件只是把同一条带宽切碎，让每个 ETA 都不准。
   * 单文件分片并行（4）是另一个正交的旋钮，在 install() 里给。
   */
  readonly queue = new DownloadQueue(2);

  /**
   * 各 role 的当前激活模型。
   * ⚠️ 必须覆盖 `MODEL_ROLES` 的**全部** 7 个 role ——
   * shared 把它从 2 个扩到 7 个后，只写 `{asr, llm}` 会编译失败（这是好事：漏了会被逼出来）。
   */
  readonly active: Record<ModelRole, string | null> = Object.fromEntries(
    MODEL_ROLES.map((r) => [r, null]),
  ) as Record<ModelRole, string | null>;
  prefs: Prefs = { ...DEFAULT_PREFS };
  /** 最近一次探测结果；未探测过就是空数组（而不是编造的"全部可用"）。 */
  lastProbes: SourceProbe[] = [];

  private constructor(
    private readonly sse: SseHub,
    readonly modelsRoot: string,
    /** `<dataDir>/bin/ext` —— sqlite 扩展装完后链接到这里，见 startPackInstall。 */
    readonly extensionsDir: string,
    readonly modelCatalog: ModelCatalog,
    readonly backendCatalog: BackendCatalog,
    public hardware: HardwareInfo,
    /**
     * advisory 探测（nvidia-smi / sysfs / system_profiler / DXGI）认为本机可能支持的后端。
     *
     * **不是"能用"的结论**（那只能来自 probe），但它是 L2 适用性判定里唯一
     * **不依赖"包已经装了"** 的证据 —— 也就是解开
     * 「要先有 A 才能装 B，而 A 要 B 装好才能被发现」那个环的东西。
     * 见 `packages/runtime/src/backends/applicability.ts` 的文件头。
     */
    public advisoryBackends: readonly Backend[],
  ) {
    this.store = new ArtifactStore(modelsRoot);
  }

  /* ─────────────────── 硬件快照的失效：结构化，不靠人记得 ─────────────────── */

  /**
   * 上一次探测时，「机器上有什么」长什么样。`null` = 还没算过。
   *
   * 见 `machineFingerprint()` 与 `freshHardware()`。
   */
  private hardwareFingerprint: string | null = null;

  /**
   * 结构探测那一刻解析出来的 runtimes 目录。
   *
   * 只用来给 `detectDisks()` 指路 —— **路径本身是结构事实**，随快照一起缓存是对的；
   * 现算的是它上面的**读数**。为它单独再跑一次 `resolveRuntimeLayout()` 会白做一遍
   * 目录扫描，而在本文件里再推导一次 `<dataDir>/bin/runtime` 就是第二份路径约定
   * （`inferDataDir` 的注释里记着这一族缺陷的成因）。
   */
  private runtimesRoot: string | null = null;

  /**
   * 「机器上有什么」的**廉价指纹**：装了哪些后端包 + 用户选了哪个后端 + 模型根目录。
   *
   * **不 spawn、不探测**（只是一次 `listManifests` 的 readdir），所以可以在每个
   * 相关请求上算一遍。
   *
   * ## 为什么是指纹，而不是"在 install 后面补一次刷新"
   *
   * Manager 2026-08-08 的判据：**一个会过期的快照，不该被当成事实来源；
   * 如果它必须是快照，那么"谁在什么时候让它失效"必须是显式的、且穷尽的。**
   *
   * 「穷尽」是这里的难点。改变"机器上有什么"的动作至少有：装包、卸包、切后端、
   * 数据目录搬迁、断路器复位 —— 而**本轮实测已经证明"逐个补刷新"这条路走不通**：
   * 只在 install 后面补，卸载与切后端那两条同样会漂
   * （`[实测]` 装完加速包后 `select` 回 409「backend package not installed」，
   * 而包就是刚装上的 —— 读的正是这份没刷新的快照）。
   *
   * 所以这里把"失效"变成**从输入派生**的，而不是需要人去调用的：
   * 指纹变了 ⇒ 快照必然重算。
   *
   * ══ ★ T-191：上一版这里写着一句**免检承诺，而且它是假的** ═══════════════════
   *
   * 原文是：
   *
   * > 「新增一个改变机器状态的动作时，只要它影响的是这三样东西之一，
   * >   **不写任何代码它就已经被覆盖了**」
   *
   * 那三样是「模型根 + 选中的后端 + 装了哪些包的 **id**」。
   * **而"把同一个 id 重装成不同的字节"恰好落在三样之外**，于是它没有被覆盖，
   * 而那句话让人不必去想这件事。`[用户真机实测 2026-08-09，:10000]`：
   *
   *   08-02  用户装 `whispercpp-cpu-linux-x64` —— 当时目录指向**上游**
   *          `whisper-bin-ubuntu-x64.tar.gz`（9,379,235 B，**里面没有 openmemo-probe**）
   *   08-07  T-167 把**同一个 id** 换成我们自建的那份（6,752,275 B，**带探针**）
   *   今天   `installed: true`、`recommended: true`，而六个后端全部
   *          「probe executable not found」
   *
   *   走产品自己的安装路重装之后，**磁盘上探针出现了，接口照旧说找不到** ——
   *   装前装后 id 集合一模一样，指纹没变，快照就不重算。
   *   `?refresh=1` 一发就对（`cpu available=true`）⇒ 解析链没瞎，是失效条件漏了一格。
   *
   * ── 修法：**不再承诺完整性，而是让它由构造保证、并且可检验** ──────────────────
   *
   * 指纹不再是"手挑几样"，而是**已安装记录的全文**（规范化 JSON），
   * 只显式排除 {@link FINGERPRINT_IGNORED_FIELDS} 里那几个。于是：
   *
   *   · `InstalledBackendPack` 上**新增任何字段**，它自动进指纹 —— 不需要谁记得；
   *   · 想让某个字段不进指纹，**必须把它写进那个集合**，那是一处看得见的 diff；
   *   · `hardwareFingerprintCoverage.test.ts` 会逐字段变异一遍：
   *     不在排除集里的字段，改了它指纹**必须**变；在排除集里的，**必须**不变。
   *     新加字段而忘了表态 ⇒ 当场红。
   *
   * **判据从"记得覆盖"变成了"漏了会红"** —— 这正是上一版那句免检承诺缺的东西。
   *
   * ⚠️ 仍然**不 spawn、不探测**：`listInstalledBackends()` 本来就把这些 manifest
   *   读进内存了，这里只是把它们序列化一遍。
   */
  private async machineFingerprint(): Promise<string> {
    const packs = await this.listInstalledBackends();
    return [
      this.modelsRoot,
      this.prefs.selectedBackend ?? '',
      ...packs.map((p) => canonicalPackFingerprint(p)).sort(),
    ].join('|');
  }

  /**
   * **回答"这台机器上有什么"之前必须先调它。**
   *
   * 指纹没变 ⇒ 直接用缓存（探测要 spawn probe / nvidia-smi，几百 ms 到几秒，
   * 不能每个请求都跑）；指纹变了 ⇒ 重新探测一次并把结果写回。
   *
   * 用户**显式选过**的后端要在重探之后重新盖上去：`detectLocalHardware()` 会按
   * 偏好顺序自己算一个 `selectedBackend`，而那是"没人选过时"的默认值，
   * 不能拿它覆盖用户的选择（`loadPersisted()` 里是同一条规则）。
   */
  async freshHardware(): Promise<HardwareInfo> {
    const fp = await this.machineFingerprint();
    if (fp === this.hardwareFingerprint) return this.hardware;
    const detection = await detectLocalHardware(this.modelsRoot);
    this.hardware = this.prefs.selectedBackend
      ? { ...detection.hardware, selectedBackend: this.prefs.selectedBackend }
      : detection.hardware;
    this.advisoryBackends = detection.advisoryBackends;
    // 路径是**结构事实**（只随数据目录搬迁而变），读数才是环境事实。
    // 记下来，好让 `hardwareWithLiveReadings()` 不必为了拿一个路径再跑一次探测。
    this.runtimesRoot = detection.layout.runtimesRoot;
    this.hardwareFingerprint = fp;
    return this.hardware;
  }

  /**
   * ★★ T-195：把**环境读数**换成现算的，结构事实照旧用缓存。
   *
   * ## 判据不在"几份快照"那个轴上，在"这一格该不该被缓存"那个轴上
   *
   * `HardwareInfo` 把两类**寿命完全不同**的事实装在同一个 blob 里：
   *
   * | 类 | 字段 | 取一次的代价 | 什么时候变 |
   * |---|---|---|---|
   * | 结构事实 | cpu / gpus / backends / os | **spawn**：probe(≤10s) + nvidia-smi | 换机器、装卸后端包、换驱动 |
   * | 环境读数 | `disks[].freeMB`、`ram.availableMB` | `statfs` + `os.freemem()`，**零 spawn** | 一直在变（任何一次下载，甚至别的程序） |
   *
   * 缓存的存在理由（"探测要 spawn"）**只对第一类成立**。缓存第二类不省任何东西，
   * 代价却是判断建立在假数字上。
   *
   * ## 为什么这一格在 `state.ts` 里是**承重**的
   *
   * `buildCatalog()` 把 `this.hardware` 喂给 `computeFit()`，而
   * `fitness.ts:196` 的 `modelsRootFreeMB()` 读的就是 `disks[].freeMB` ——
   * 它决定一个模型是不是 `blocked_disk`，也就是**用户能不能装**。
   * 而**用户刚腾出空间的那一刻，正是他最可能去装东西的那一刻**。
   *
   * ## ⚠️ `state.ts` 的消费方我自己数过一遍，没有照抄 `hardware.ts` 的结论
   *
   * `this.hardware` 在本文件与 `backends.ts` 里的读取点共 8 处，除 `computeFit`
   * 之外全部只读**结构那一半**（`backends[]` 判适用性 / `selectedBackend` 判推荐与
   * 活动状态）—— 它们用缓存是对的，现算反而会让"装了什么"的结论随机漂。
   * 所以这里**不把整份快照改成现算**，只在真正吃环境读数的那一处换。
   *
   * ⚠️ `detectedAt` 不跟着刷新：那句话说的是**结构探测**发生在什么时候，
   * 刷成"现在"等于声称刚跑过一次 probe —— 而我们恰恰没有跑，那正是省下来的东西。
   */
  private async hardwareWithLiveReadings(): Promise<HardwareInfo> {
    if (this.runtimesRoot === null) return this.hardware;
    return {
      ...this.hardware,
      disks: await detectDisks({
        modelsRoot: this.modelsRoot,
        runtimesRoot: this.runtimesRoot,
      }),
      ram: detectMemory(),
    };
  }

  /**
   * 让快照**立刻**失效。给指纹看不见的那些变化用（例如断路器复位 ——
   * 它改的是 runtime 包里的进程内状态，不在 manifest 里）。
   *
   * 刻意不做成"顺手调一下也无妨"的样子：正常路径应当靠指纹，
   * 需要显式调用的地方都该在这里留下理由。
   */
  invalidateHardware(): void {
    this.hardwareFingerprint = null;
  }

  /**
   * 守卫：**新增一个会改变"机器上有什么"的动作、却没让快照失效时，当场红。**
   *
   * 判据不是"记得调 invalidate"，而是"忘了也会被抓住"。测试拿它来断言：
   * 做完某个动作之后，指纹**必须**已经和快照记录的那个不一样了。
   * 返回 `true` = 快照此刻仍然当真（指纹一致）。
   */
  async hardwareSnapshotIsCurrent(): Promise<boolean> {
    return (await this.machineFingerprint()) === this.hardwareFingerprint;
  }

  static async create(deps: RestStateDeps): Promise<RestState> {
    // 与 downloader 的 `resolveModelsRoot` 语义一致：OPENMEMO_MODELS 优先，
    // 否则落在 daemon 的 dataDir 里（AppPaths.modelsDir 的约定）。
    // 与 pipeline 共用同一个定义（D-08 D4）——各算各的正是"装了却找不到"的成因。
    const modelsRoot = resolveStoreRoot(deps.dataDir);

    const [loadedModelCatalog, backendCatalog] = await Promise.all([
      loadModelCatalog(deps.manifestDir),
      loadBackendCatalog(deps.manifestDir),
    ]);
    const modelCatalog = withoutRetiredRoles(loadedModelCatalog);
    /*
     * ★ T-153：清单**读不了**和清单**里零条**必须在日志里也分得开。
     *
     * `resolveManifestDir()` 已经在"连目录都没找到"时喊过一声，但它管不到
     * 「路径找到了、readdir 失败了」（没权限 / 是个文件 / 中途被删）。
     * 那种情况下用户看到的仍然是 `packs 0`，而**日志里一个字都没有**。
     * 这一行不改变红绿，只保证"什么都没加载"这件事在事后查得到。
     */
    const loadError = loadedModelCatalog.loadError ?? backendCatalog.loadError;
    if (loadError) {
      console.error(
        `[daemon] ✘ 内置目录没能读取 —— 组件页/模型页会是空的，但**不是因为没有东西可装**。\n` +
          `   目录：${loadError.dir}\n   原因：${loadError.code} ${loadError.message}`,
      );
    }
    await fs.mkdir(modelsRoot, { recursive: true });
    const detection = await detectLocalHardware(modelsRoot);

    // 与 AppPaths.extensionsDir 同一个定义（config/paths.ts:91）。
    const extensionsDir = process.env['OPENMEMO_EXT_DIR'] ?? path.join(deps.dataDir, 'bin', 'ext');

    const state = new RestState(
      deps.sse,
      modelsRoot,
      extensionsDir,
      modelCatalog,
      backendCatalog,
      detection.hardware,
      detection.advisoryBackends,
    );
    await state.store.init();
    await state.loadPersisted();
    await state.reconcileBackends();
    await state.reconcileModels();
    /*
     * ★ 把指纹**钉在这一刻**，而不是留成 `null`。
     *
     * 留 null 的话，`freshHardware()` 的第一次调用必然判定"过期"并**再探一遍** ——
     * 而上面几行刚探过。那既是白跑一次（探测要 spawn probe / nvidia-smi），
     * 也会把调用方手里那份 hardware 换掉：`backendNotProbed.test.ts` 正是这么红的
     * （它 `create()` 之后手工注入一份"vulkan 装了但没探过"的状态来复现 T-168，
     * 而第一个请求就把它冲掉了）。
     *
     * 必须放在 `reconcileBackends()` **之后**：对账会给"盘上有、记录没有"的包补记录，
     * 那本身就会改变指纹。放在它前面的话，启动完第一个请求又会重探一次。
     */
    state.hardwareFingerprint = await state.machineFingerprint();
    /*
     * ★ T-195：启动这一次探测也要把 runtimesRoot 记下来。
     *
     * ⚠️ 这一行是**被用例逼出来的**，不是我一开始想到的：只在 `freshHardware()` 里赋值时，
     * 冷启动之后指纹一直没变 ⇒ 那条早退分支直接 return ⇒ `runtimesRoot` 永远是 null
     * ⇒ `hardwareWithLiveReadings()` 一路退回缓存，**修复静默失效**。
     * 用例（投毒快照后判定必须不变）当场变红把它照了出来。
     */
    state.runtimesRoot = detection.layout.runtimesRoot;
    state.bridgeQueueToSse();
    return state;
  }

  /**
   * 启动对账：**盘上真的装着、却没有安装记录**的后端包，补一份记录。
   *
   * 修的是「`/runtime` 对已装的 ffmpeg 显示「安装 119 MB」」（`gates-fix §5.2`）。
   * 判据、为什么选这条路而不是"catalog 现算"、以及补出来的记录凭什么算数，
   * 全写在 `backendReconcile.ts` 的文件头。
   *
   * **不阻断启动**：这是一次修补，不是前置条件。它失败时最坏的结果是回到今天的样子
   * （界面说没装），而抛出去会变成 daemon 起不来 —— 那是把一个显示问题升级成宕机。
   * 但**必须出声**：静默的自愈与静默的降级是同一族。
   */
  private async reconcileBackends(): Promise<void> {
    try {
      const report = await reconcileBackendManifests({
        store: this.store,
        packs: this.backendCatalog.packs,
        platform: currentPlatform(),
      });
      for (const r of report.reconciled) {
        console.warn(
          `[backends] ${r.packId} 盘上已装好但没有安装记录（安装器是"blob 先落、manifest 最后写"，` +
            `中途崩就是这个状态）——已按实测 sha256 补回记录，${String(r.bytes)} 字节，界面不再让你重下一遍`,
        );
      }
      for (const s of report.skipped) {
        console.warn(`[backends] ${s.packId} 没有补记录：${s.reason}`);
      }
    } catch (err: unknown) {
      console.warn(
        `[backends] 启动对账失败：${String(err)} —— 已装但没记录的包会继续显示成"未安装"`,
      );
    }
  }

  /**
   * 首次运行对账：把随包出厂的模型字节"装"进 ArtifactStore（D-20 §11.2）。
   *
   * 与 `reconcileBackends()` 同一条纪律，细节全部在 `modelReconcile.ts` 的文件头：
   * sha256 现算、`installedAt` 取文件本身的 mtime、`verifiedAt` 才是"现在"、
   * 已经装过的 role/id 组合绝不覆盖。**不阻断启动**：这是一次修补，不是前置条件——
   * 失败的最坏结果是回到"没有内置模型"的老样子，抛出去会把一个可修的缺口
   * 升级成宕机。但**必须出声**：静默的自愈与静默的降级是同一族。
   *
   * 装完之后，仍是空的 role 槽位就地激活成刚装好的那个——与 `models.ts` 的
   * `startModelPull()` 里"没人选过就用这次装的"是同一条规则。不然内置模型
   * 装完了却没人在用它，用户看到的还是"没有可用的 ASR/VAD"。
   *
   * ══ 必须发 `model.installed`/`model.activated`（真实机器上跑出来才发现的洞）══════
   *
   * `[实测 2026-08-09]` 用真实构建的包（`build-bundle.mjs` 产物）跑通首次启动：
   * `RestState.create()` 是**懒的**——只在第一次命中 `/api/models/*` 之类的路由时
   * 才真正执行（`models.ts` 的 `statePromise ??= RestState.create(deps)`）。而
   * `main.ts` 在启动时就**无条件、提前**跑了一遍 `buildPipeline()` 把结果缓存进
   * `bundle`，之后只在收到 `main.ts` 里 `REFRESH_EVENTS`
   * （`model.installed` / `model.removed` / `model.activated` / `backend.installed` /
   * `backend.removed`）时才会重算。这份 SSE 监听是 `main.ts` 自己挂的，本文件写
   * `ArtifactStore` 不会自动触发它。
   *
   * 后果实测复现：`curl /api/models/installed` 确认三个内置模型都已导入
   * （`verifiedAt` 是本次启动时间），但同一进程的 `curl /api/health` 里
   * `pipeline.missing` 仍然是 `["asr-model"]`、`streamAvailable:false`、
   * `vad.model:null`——**界面说"已安装"，转写流水线说"还没有"，两边各读各的缓存**。
   * 不发事件的话，这个分裂状态会一直持续到用户凑巧触发了另一次真实的模型/后端安装
   * （顺带把 `bundle` 整体重算一次），或者重启 daemon（下次启动时 `ArtifactStore` 里
   * 已经有记录，`buildPipeline()` 第一次跑就是对的）——但**冷装第一次**、也就是这个
   * 机制最该生效的那一次，反而看不到效果。
   *
   * 修法：装完之后照抄 `models.ts` 走完整安装流程时发的两个事件，**不发明新事件类型**
   * ——`main.ts` 的监听集合已经认这两个名字，不需要它跟着改。
   */
  private async reconcileModels(): Promise<void> {
    try {
      const report = await reconcileBundledModels({
        store: this.store,
        models: this.modelCatalog.models,
      });
      for (const r of report.imported) {
        console.warn(
          `[models] ${r.modelId} 内置模型已导入 ArtifactStore（${String(r.bytes)} 字节，` +
            `包内那份原样保留——同盘是硬链接、不占双份空间，跨盘才会真复制）`,
        );
        const model = this.modelCatalog.models.find((m) => m.id === r.modelId);
        /*
         * ★★ A-4 ①（第二处）：**"先装的赢"在这里也有一份，判据必须与 `models.ts` 同一个。**
         *
         * 这一处极容易被漏掉：病灶报告指的是 `rest/models.ts` 的下载安装路径，
         * 而**内置模型首次运行导入**走的是这里，两条路都会去占 `active[role]`。
         * 只修一边的话，另一条路照样能造出同一个矛盾，而修复报告会说"已修"。
         * 所以两处调**同一个** `loadableByRoleConsumer()`，三态语义一字不差
         * （`null` = 说不出 ⇒ 放行；只有**确知加载不了**才不占这个槽位）。
         *
         * ⚠️ **如实记一句：这道闸今天在这条路上打不起来。**
         *   `BUNDLED_MODEL_IDS` 里的 VAD 只有 `vad/silero-vad-ggml`（whisper.cpp 读得动），
         *   另外两个是 asr —— 而 `asr` 没有唯一消费方（`selectEngine()` 按语言现挑），
         *   `soleConsumerEngine()` 对它返回 `null`。也就是说它现在只在**代码层**成立。
         *   保留的理由是"两个写入点不许对同一件事有两种判断"，不是"它今天挡住了什么"。
         *
         * ⚠️ 用 `readManifest` 单点读，不是 `listInstalled()` 全量扫：这在启动路径上，
         *   而且非 vad 的 role 连这一次读都不会发生（下面的 `soleConsumerEngine` 先短路）。
         */
        const verdict =
          model === undefined || soleConsumerEngine(model.role) === null
            ? null
            : await loadableByRoleConsumer(
                this.modelsRoot,
                (await this.store.readManifest<InstalledModel>(
                  roleToStoreKind(model.role),
                  model.id,
                )) ?? { role: model.role },
              );
        if (model && !this.active[model.role] && verdict !== false) {
          const previous = this.active[model.role];
          this.active[model.role] = model.id;
          await this.persistActive();
          this.publish(
            makeEvent('model.activated', topics.models(), {
              role: roleToActivationSlot(model.role),
              modelId: model.id,
              previous,
            }),
          );
        }
        this.publish(
          makeEvent('model.installed', topics.models(), {
            modelId: r.modelId,
            active: model ? this.active[model.role] === r.modelId : false,
          }),
        );
      }
      for (const s of report.skipped) {
        console.warn(`[models] ${s.modelId} 没有导入：${s.reason}`);
      }
      if (report.imported.length > 0) await this.emitStorageChanged();
    } catch (err: unknown) {
      console.warn(`[models] 内置模型首次运行导入失败：${String(err)} —— 本次启动没有内置模型可用`);
    }
  }

  /* ----------------------------- 落盘状态 ------------------------------- */

  private get activeFile(): string {
    return path.join(this.modelsRoot, 'active.json');
  }
  /**
   * ★ T-162：路径由 `@openmemo/pipeline` 定义，**这里只是引用**。
   *
   * `selectedBackend` 从这个文件出去、由 `findInBackendPacks()` 读回来 ——
   * 写的人和读的人各写一个字面量，就又是一次 `%APPDATA%` vs `%LOCALAPPDATA%`：
   * 两边都"对"，产品静默不生效。
   */
  private get prefsFile(): string {
    return backendPrefsPath(this.modelsRoot);
  }

  private async loadPersisted(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.activeFile, 'utf8'));
      const rec = raw as Partial<Record<ModelRole, string | null>>;
      /*
       * ★ **按 `MODEL_ROLES` 遍历，不要逐个字面量写。**
       *
       * 这里原本只有 `asr` 与 `llm` 两行，而 `persistActive()` 写的是
       * `JSON.stringify(this.active)` —— **全部 7 个 role**。
       * 写七个、读两个，于是 vad / punctuation / diarization / embedding / tts
       * 这五个槽位**每次重启都被静默清空**。
       *
       * `[实测 2026-08-08]` 网页上把 VAD 切到 `vad/silero-vad-ggml` → `active.json`
       * 里确实写着它 → `POST /api/daemon/restart` → `GET /api/models/active`
       * 回来 `vad: null`。文件没坏、没有任何报错，用户的选择就是没了；
       * 之后 pipeline 退回"任意已装记录（readdir 原序）"去挑权重。
       * 这条正落在章程要求 2.2 的「切换」上，而产品自己在装完组件后
       * **还会主动请用户重启** —— 也就是说这条路几乎必然被走到。
       *
       * 为什么它能活这么久：上面 `active` 声明处那句注释说得没错 ——
       * 初始化器漏了 role 编译器会红。但**这里是逐个属性赋值**，
       * 漏掉一个 role 类型完全合法，编译器一个字都不会说。
       * 改成遍历之后，新增 role 自动被带上，不再依赖"有人记得回来加一行"。
       */
      for (const role of MODEL_ROLES) {
        const v = rec[role];
        this.active[role] = typeof v === 'string' ? v : null;
      }
    } catch {
      /* 首次运行 */
    }
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.prefsFile, 'utf8'));
      this.prefs = { ...DEFAULT_PREFS, ...(raw as Partial<Prefs>) };
      if (this.prefs.selectedBackend) this.hardware.selectedBackend = this.prefs.selectedBackend;
    } catch {
      /* 首次运行 */
    }
  }

  async persistActive(): Promise<void> {
    await fs.writeFile(this.activeFile, JSON.stringify(this.active), 'utf8');
  }

  async persistPrefs(): Promise<void> {
    await fs.writeFile(this.prefsFile, JSON.stringify(this.prefs), 'utf8');
  }

  /* -------------------------------- SSE --------------------------------- */

  /**
   * @param throttleTopic 传入则按 topic 做 250ms 合并。**只有进度类事件能传**；
   *   终态事件（done/failed/state）必须立即发，否则可能被后一条进度覆盖掉。
   */
  publish(event: SseEvent, throttleTopic?: string): void {
    this.sse.publish(event, throttleTopic);
  }

  private bridgeQueueToSse(): void {
    onJob(this.queue, 'job.created', (job) => {
      this.publish(makeEvent('job.created', topics.job(job.jobId), { job }));
    });

    onJob(this.queue, 'job.progress', (job) => {
      this.publish(
        makeEvent('job.progress', topics.job(job.jobId), {
          jobId: job.jobId,
          step: job.step,
          /*
           * 下载这一侧的刻度**一直是对的**（0..1），坏的是流水线那一侧
           * （`jobs/events.ts` 曾在这里写 `fraction * 100`）。这也正是 #90 那条
           * 「每条任务都显示 100%」能活下来的原因：**最常被人盯着看的那条
           * 进度条没坏**，坏的只有转写/导图。
           *
           * 现在两侧都必须经过 `progressOf()` —— 没有分母时它给的是
           * `no_denominator`，不是 0%。
           */
          progress: progressOf(job.completedBytes, job.totalBytes, 'downloadQueue'),
          completedBytes: job.completedBytes,
          totalBytes: job.totalBytes,
          speedBps: job.speedBps,
          etaSeconds: job.etaSeconds,
          state: job.state,
        }),
        // ★ 唯一需要节流的事件：8 MB/s 下逐字节推送会把浏览器渲染循环打满
        topics.job(job.jobId),
      );
    });

    /*
     * ★ step 变化：发一条**只带 step、不带刻度**的 job.progress。
     *
     * · `unreportable` 是契约里就写好的表达（`ProgressReading` 的第二格）——
     *   安装/解压没有字节刻度，**绝不编一个百分比**。它**不带 value 字段**，
     *   所以下游想 `?? 0` 兜成 0% 也写不出来（#90 一并修的第二半）。
     * · 字节计数一并置 null：它们是上一阶段（下载）的数，留着会让界面继续画
     *   一条"已完成 574MB/574MB"的满条，看起来像还在下载。
     * · **刻意不传 throttleTopic**：这是低频的阶段公告（每阶段一次），
     *   走未节流那条路才能①立刻到达②顺手把同 topic 上压着的旧进度先冲出去
     *   —— 否则它自己就会变成下一个被终态超车的受害者。
     */
    onJob(this.queue, 'job.step', (job) => {
      this.publish(
        makeEvent('job.progress', topics.job(job.jobId), {
          jobId: job.jobId,
          step: job.step,
          progress: PROGRESS_UNREPORTABLE.step_announcement,
          completedBytes: null,
          totalBytes: null,
          speedBps: null,
          etaSeconds: null,
          state: job.state,
        }),
      );
    });

    onJobState(this.queue, (job, previousState) => {
      this.publish(
        makeEvent('job.state', topics.job(job.jobId), {
          jobId: job.jobId,
          state: job.state,
          previousState,
        }),
      );
    });

    onJob(this.queue, 'job.done', (job) => {
      this.publish(
        makeEvent('job.done', topics.job(job.jobId), {
          jobId: job.jobId,
          resultUid: job.targetId,
          resultKind: job.kind === 'backend-pack' ? 'backend' : 'model',
        }),
      );
    });

    onJob(this.queue, 'job.failed', (job) => {
      this.publish(
        makeEvent('job.failed', topics.job(job.jobId), {
          jobId: job.jobId,
          error: job.error ?? {
            code: 'INTERNAL',
            message: 'job failed without an error record',
            messageZh: '任务失败但没有错误记录',
            retryable: false,
          },
          // 队列层不做自动重试（重试由用户或上层显式触发），所以这里恒为 false。
          willRetry: false,
          nextProvider: null,
        }),
      );
    });
  }

  async emitStorageChanged(): Promise<void> {
    const storage = await this.buildStorage();
    this.publish(
      makeEvent('storage.changed', topics.models(), {
        usedBytes: storage.usedBytes,
        freeBytes: storage.volume.freeBytes,
      }),
    );
  }

  /* ------------------------------ 已安装 -------------------------------- */

  findCatalogModel(id: string): ModelEntry | null {
    return this.modelCatalog.models.find((m) => m.id === id) ?? null;
  }

  findCatalogPack(id: string): BackendPack | null {
    return this.backendCatalog.packs.find((p) => p.id === id) ?? null;
  }

  /**
   * 已安装的模型 —— **扫全部桶**，不是只扫 `asr` 与 `llm`。
   *
   * ★ T-149：这里原来写死 `['asr','llm']`，而它与 `roleToStoreKind` 把七个 role
   * 压成两个桶**恰好互相掩盖**：因为没有东西写进 `vad/`，所以没有东西读不到。
   * 一旦落盘桶改成"一个 role 一个"（那才是 `store.ts` 一直声称的状态），
   * 这一行就会让**已装的 VAD / 标点模型从 `/api/models/installed` 里整个消失**
   * —— 界面上表现为"我明明装过，它没了"，而且没有任何报错。
   * 两个 bug 必须同一次改掉，所以它们在同一个提交里。
   *
   * 旧布局（VAD 记录躺在 `manifests/asr/`）**照样列得出来**：判据是记录里的 `role`，
   * 不是它在哪个目录。同一个 id 万一两个桶里都有（重装过一次的旧机器），
   * 取**桶与 role 对得上**的那一条 —— 而不是"先读到谁算谁"。
   */
  /**
   * **记为活动、但本机拿它的那个引擎加载不了的槽位。**（A-4 ②）
   *
   * ## 为什么必须有这一格
   *
   * A-4 ① 让**新装**的机器不再产生"激活态说在用、流水线说加载不了"这个矛盾。
   * 但它救不了**已经处在这个状态**的机器 —— 用户那台的 `active.json` 里
   * 那一行早就写下了，改判据不会把它擦掉。这一格就是说给那台机器听的。
   *
   * ## 判据与写入那一侧**是同一个函数**
   *
   * `loadableByRoleConsumer()` —— 与 `rest/models.ts` 的安装激活、
   * 上面 `reconcileModels()` 的内置导入调的是同一个。三处各判一次的话，
   * 会出现"写的时候认为能用、读的时候认为不能用"这种新的自相矛盾，
   * 而 A-4 要修的**恰恰就是两个消费方对同一件事说相反的话**。
   *
   * ## 三态，缺席 = 说不出
   *
   * 只有 `false`（**确知加载不了**）才在结果里占一格。`null` 什么都不写：
   * 例如 `asr` 由 `selectEngine()` 按语言现挑引擎，"谁来加载它"在一台机器上
   * 本来就没有唯一答案 —— 那时沉默是唯一诚实的回答。
   *
   * ⚠️ 代价：每个**有唯一消费方**的槽位一次 manifest 读 + 一次 4 字节文件读。
   *    今天只有 `vad` 一个（`soleConsumerEngine()` 先短路），不做 `du`、不 spawn。
   */
  async activeUnusable(): Promise<Partial<Record<ModelRole, ActiveSlotUnusable>>> {
    const out: Partial<Record<ModelRole, ActiveSlotUnusable>> = {};
    let installed: InstalledModel[] | null = null;
    for (const role of MODEL_ROLES) {
      const id = this.active[role];
      if (id == null) continue;
      const engine = soleConsumerEngine(role);
      if (engine === null) continue; // 说不出 ⇒ 什么都不说
      installed ??= await this.listInstalled();
      const rec = installed.find((m) => m.id === id);
      if (rec === undefined) continue; // 记为活动但记录不在了：不是"加载不了"，别混为一谈
      if ((await loadableByRoleConsumer(this.modelsRoot, rec)) !== false) continue;
      out[role] = { modelId: id, engine, ...(await this.usableAlternative(role, id, installed)) };
    }
    return out;
  }

  /**
   * 同一个 role 下，**本机已经装了的、这个引擎读得动的另一份**。
   *
   * 它决定用户看到的是「**激活**它」还是「**装**一个」——
   * 两句话对应的动作完全不同，糊在一起就会把已经装好的人送去重下一遍。
   *
   * 三态，返回的是**要不要写这个字段**：
   *   · `{ usableInstalled: id }`   —— 找到了（确知）；
   *   · `{ usableInstalled: null }` —— 逐个验过，确知一份都没有；
   *   · `{}`（字段缺失）            —— **说不出**：有候选的判据是 `null`
   *     （记录指不到文件），那时既不能说"有"也不能说"没有"。
   *     **宁可什么动作都不给，也不猜一个** —— 猜错的那句话会把人送去一条走不通的路。
   */
  private async usableAlternative(
    role: ModelRole,
    activeId: string,
    installed: readonly InstalledModel[],
  ): Promise<{ usableInstalled?: string | null }> {
    let sawUnknown = false;
    for (const m of installed) {
      if (m.role !== role || m.id === activeId) continue;
      const verdict = await loadableByRoleConsumer(this.modelsRoot, m);
      if (verdict === true) return { usableInstalled: m.id };
      if (verdict === null) sawUnknown = true;
    }
    return sawUnknown ? {} : { usableInstalled: null };
  }

  async listInstalled(): Promise<InstalledModel[]> {
    const byId = new Map<string, { kind: StoreKind; rec: InstalledModel }>();
    for (const kind of STORE_KINDS) {
      if (kind === 'backend') continue; // 后端包走 listInstalledBackends()
      for (const rec of await this.store.listManifests<InstalledModel>(kind)) {
        if (!rec?.id) continue;
        const prev = byId.get(rec.id);
        if (prev && bucketForRole(prev.rec.role) === prev.kind) continue;
        byId.set(rec.id, { kind, rec });
      }
    }
    return [...byId.values()].map((v) => v.rec);
  }

  /**
   * 某个 id 的安装记录**实际**躺在哪个桶里。
   *
   * 删除与校验必须用它，不能用 `bucketForRole(record.role)` 算：旧布局把 VAD 记录
   * 写在 `manifests/asr/` 下，按 role 算会去 `manifests/vad/` 找 ——
   * `removeManifest` 用的是 `fs.rm(..., {force:true})`，**找不到不报错**，
   * 于是删除返回 204、记录还在、模型看起来没删掉；校验则会在新桶里写出**第二份**记录。
   */
  async bucketOfInstalled(id: string): Promise<StoreKind | null> {
    for (const kind of STORE_KINDS) {
      if (kind === 'backend') continue;
      if (await this.store.readManifest<InstalledModel>(kind, id)) return kind;
    }
    return null;
  }

  /**
   * 把某个 id **在 `by-name/` 与 `by-model/` 里的硬链视图**删掉。
   *
   * ## 为什么删模型必须走这一步（T-164 ⑥）
   *
   * 删除现在的动作是「删 manifest → `collectGarbage(['orphan_blobs'])`」，
   * 而 `findGarbage()` **只扫 `blobs/`**。blob 确实被 `rm` 了，`freedBytes` 也照着
   * blob 的大小报了出去 —— 但 `by-name/<kind>/<file>` 那条**硬链还在**，
   * 硬链与 blob 共用同一个 inode，只要还有一条链指着它，**磁盘一个字节都不会回收**。
   *
   * `[复现]` 写 4 MiB blob → `linkByName` → 删 → `collectGarbage` 报
   * `freedBytes: 4194304`、`usedBytes()` 归 0，而 `du -sb` **仍是 4194304**。
   * 用户侧：删掉一堆模型、看着数字一路下降、磁盘越来越满，而且没有任何地方对得上账。
   *
   * 还有第二个后果，比空间更难查：**`by-name/` 是发现路径**。
   * `resolveActiveModel` / `scanByName` / `findInBackendPacks` 都按名字扫它 ——
   * 一个"已删除"的模型文件留在那里，会被当成还装着。
   *
   * ## 判据：删的是**记录里点名的那些文件**，不是按模式猜
   *
   * 逐条走 `record.files[].relPath`（安装器写下的、`root='models'` 的可移植路径），
   * 用 `resolveInstalledFile()` 解析 —— 它自带越界检查（记录若指到 models 根之外
   * 会抛，而不是让我们 `rm` 到别人家里去）。归档展开出来的目录按
   * `unpackDirName(name)` 推，那是安装器与发现侧**唯一**的那份约定，不另写一份。
   *
   * 删不掉不阻断删除流程：manifest 必须走掉，否则用户会卡在"删不掉"上；
   * 留下的孤儿链下一轮还能再清。
   */
  /**
   * @param kinds 只清这几个桶。默认是**除 `backend` 外的全部** —— 与 T-164 的行为一字不差。
   *
   * ★★ T-192：加这个参数，是因为 `backend` 那一格**从来没有人清过**，
   * 而它的后果比模型那一格更重：
   *
   * `[实测 2026-08-10]` `DELETE /api/backends/:id` 只做两件事 ——
   * `removeManifest()` + `collectGarbage(['orphan_blobs'])`。
   * 而 `findGarbage()` **只扫 `blobs/`**，`by-name/backend/<归档名>` 那条硬链
   * 与解开的目录**原封不动** ⇒ blob 的 inode 还被引用着 ⇒
   * **磁盘一个字节都不回收**，而事件里照样报一个 `freedBytes`。
   *
   * 第二个后果更难查：`by-name/backend/` 是 `findInBackendPacks()` 的**发现路径**。
   * 一个"已卸载"的后端包留在那里**仍然会被解析到并真的跑起来** ——
   * 用户以为删了，产品还在用它。
   *
   * 不把 `backend` 直接并进默认集合：`dropInstalledRecord()`（模型那条路）
   * 也调这个函数，而模型 id 与后端包 id 撞名时会误删。**显式传 kinds，别猜。**
   */
  /**
   * ★★ T-107 ②：**拒绝必须能被外面读到。**
   *
   * 上一版这里是一句光秃秃的 `catch { continue }` —— 于是「记录越界、我们拒绝去删」
   * 和「这条记录本来就没有文件」在函数外面**长得一模一样**：都是静默、都返回 204。
   * 一道说不出自己拦过什么的闸门，既没法向用户交代，**也没法写测试**
   * （把闸门整个抽掉，行为观察不出区别 ⇒ 变异存活 ⇒ 那条断言从来没被验证过）。
   *
   * 所以现在返回一份**逐条的账**。⚠️ 这三件事**不许再共用一个静默出口**：
   *   · `refused` —— 我们**知道**有个文件，但**不肯**按这条记录去 `rm`（越界/记录损坏）；
   *   · `failed`  —— 我们**试了**，`fs.rm` **抛了**（#113，见下）；
   *   · 删了但文件本来就不在 —— `fs.rm(..., {force:true})` 的正常语义，不进账。
   *
   * ## ★★ #113：第三档 —— **rm 真失败**，此前被吞掉
   *
   * 上一版这里三处 `fs.rm` 全是 `.catch(() => undefined)`，而**文件那一处
   * 吞完还照样 `removed += 1`**。后果不是"少了一条日志"：
   *
   *   > 用户点卸载 → 卡片消失 → 界面说成功 → **文件还在盘上**，
   *   > 而 `removed` 这个数在数它没删掉的东西。
   *
   * `[实证]` v0.7.3 发布跑：`e2e-runtime` 的 `A-UNINSTALL-BYTES-GONE` 在 win32 上
   * 如实报 UNKNOWN（盘上文件还在，而 `removed` 说删了）；linux 实删 24 MB、
   * darwin 7.5 MB 均 PASS。**原注释担心的 Windows 句柄问题是对的** ——
   * `fs.rm` 在那里确实可能因为句柄没释放而失败。所以这次要回答的问题**不是**
   * "怎么保证删得掉"，而是"**删不掉时该说什么**"。
   *
   * ## ⚠️ 三处 `fs.rm` 全都要收，不能只收第一处
   *
   * 只把文件那一处接进账，剩下两处（展开目录、`by-model/<id>/`）照旧静默 ——
   * 那是**在同一个函数里把刚修好的病又留了两份**。三处共用 {@link tryRemove}，
   * 判据是同一条：走到了 `fs.rm` 就必须为它的结果负责。
   *
   * ⚠️ 单个条目失败**不中断**整轮：卸载动作必须照常兑现（manifest 走掉、
   * 界面上它真的消失），否则用户会卡在"删不掉"上 —— 那是 #107 已经定过的方向。
   */
  async dropInstalledFiles(
    id: string,
    kinds: readonly (typeof STORE_KINDS)[number][] = STORE_KINDS.filter((k) => k !== 'backend'),
  ): Promise<DropFilesReport> {
    const roots = { models: this.store.root };
    const refused: RefusedFile[] = [];
    const failed: FailedFile[] = [];
    let removed = 0;
    /*
     * `by-model/<id>/` 是**每个 id 一个**，与 kind 无关 —— 而下面那个 rm 住在
     * kind 循环里，多个桶都有这条 id 的记录时会被试上好几遍。
     * 以前无所谓（失败静音、成功之后重试是空转），现在**会重复记账** ——
     * 同一个目录在界面上出现两次是一句我们自己造出来的噪音。试一次就够。
     */
    let modelDirTried = false;

    /**
     * 删一个路径；**删不动就如实记一笔**，而不是把异常咽掉。
     *
     * @returns 真的删成了吗 —— 调用方只在 `true` 时给 `removed` 加一。
     *   ⚠️ 返回值必须被用上：`removed` 与 `failed` 是同一件事的两半，
     *   加一那行若独立于这里的结果，第三档就又变成一句没人读的话。
     */
    const tryRemove = async (
      target: string,
      name: string,
      opts: { readonly recursive?: boolean } = {},
    ): Promise<boolean> => {
      try {
        await fs.rm(target, { force: true, ...opts });
        return true;
      } catch (err) {
        failed.push({
          name,
          // 「那个文件在哪儿」——这一档的用户动作是他自己去删，没有路径就无从下手
          path: target,
          kind: classifyRemovalFailure(err),
          // 原话照登、不翻译：`unknown` 那一档它是我们唯一说得出的东西
          detail: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    };

    for (const kind of kinds) {
      const rec = await this.store.readManifest<InstalledModel>(kind, id);
      if (!rec) continue;
      for (const f of rec.files ?? []) {
        let abs: string;
        try {
          abs = resolveInstalledFile(f, roots);
        } catch (err) {
          // 记录损坏/越界 —— 宁可留下也不按猜出来的路径去 rm，**但要说出来**
          refused.push({ name: f.name, reason: err instanceof Error ? err.message : String(err) });
          continue;
        }
        if (await tryRemove(abs, f.name)) removed += 1;
        /*
         * ⚠️ 上一行失败也要继续往下走：展开目录是**另一条独立的路径**，
         * 文件删不动不代表目录也删不动。`continue` 掉会让一次 EBUSY
         * 顺手把一整个目录留在 `by-name/` 里 —— 而那里是发现路径。
         */
        // 归档包展开出来的目录（`by-name/<kind>/<unpackDirName(name)>`）
        const dir = path.join(path.dirname(abs), unpackDirName(f.name));
        if (dir === abs) continue;
        /*
         * 🔴 T-107（硬要求 b）：**这条派生路径也要过同一道边界。**
         *
         * `abs` 过了闸不代表 `dir` 过得了：`unpackDirName(f.name)` 是拿**记录里的
         * 文件名**去拼的，一个带 `../` 的 `name`（或一条 `abs` 恰好贴着根边缘的记录）
         * 能让它落到根外 —— 而这一句是 `recursive: true`，越界的代价是**递归删**。
         * 用的是与解析层同一个 `assertInsideInstallRoots()`，不是另写一份判断。
         */
        try {
          assertInsideInstallRoots(dir, roots, `Unpack directory derived from ${f.name}`);
        } catch (err) {
          refused.push({
            name: unpackDirName(f.name),
            reason: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        await tryRemove(dir, unpackDirName(f.name), { recursive: true });
      }
      // `materializeModelDir()` 摊出来的每模型独占目录（T-160 ①附）
      if (!modelDirTried) {
        modelDirTried = true;
        const modelDir = byModelDir(this.store.root, id);
        await tryRemove(modelDir, path.basename(modelDir), { recursive: true });
      }
    }
    for (const r of refused) {
      console.warn(
        `[store] 拒绝按安装记录 ${id} 删除 ${r.name}：${r.reason} —— ` +
          `记录已按用户的卸载动作删掉，但这些字节留在盘上（我们不拥有它们）`,
      );
    }
    for (const f of failed) {
      console.warn(
        `[store] 按安装记录 ${id} 删除 ${f.name} 失败（${f.kind}）：${f.detail} —— ` +
          `记录已按用户的卸载动作删掉，但 ${f.path} 还在盘上`,
      );
    }
    return { removed, refused, failed };
  }

  /** 把某个 id 的安装记录从**所有**桶里删干净（旧布局可能不止一处）。 */
  async dropInstalledRecord(id: string): Promise<DropFilesReport> {
    // ★ 顺序不能反：先按记录删文件，再删记录 —— 记录没了就不知道该删哪些文件了
    const report = await this.dropInstalledFiles(id);
    for (const kind of STORE_KINDS) {
      if (kind === 'backend') continue;
      await this.store.removeManifest(kind, id);
    }
    return report;
  }

  async listInstalledBackends(): Promise<InstalledBackendPack[]> {
    return this.store.listManifests<InstalledBackendPack>('backend');
  }

  /* -------------------------------- 目录 -------------------------------- */

  /**
   * 组的"代表文案"（`descriptionZh/En`/`tags`/`displayName`/`license`）该取自
   * **哪一个变体** —— 不该默认是"清单数组里排第一个"。
   *
   * ## 真实事故（Manager 2026-08-10 点名，两个）
   *
   * `buildCatalog()` 原来在**第一次遇到某个 `groupId`** 时，把那条 `ModelEntry` 的
   * 文案复制成整组的代表值，后来者一律只贡献 `variants[]`。多数组里这恰好无害
   * （清单第一个变体碰巧就是随包默认档），但那只是"数组写的顺序"，没有任何东西
   * 保证它 —— 谁重排一下顺序、或者把警示文案写到了非默认变体上，组描述立刻讲
   * 错话，而没有任何检查会报警：
   *
   * - `asr/whisper-tiny`：质量警示只写在 `whisper-tiny-f16`（既不随包也不是默认档），
   *   随包默认档 `whisper-tiny-q5_1` 排数组第一位、原文无警示 —— 真实用户永远看不到
   *   这句话。
   * - `vad/silero-vad`：`silero-vad-onnx` 排第一位，组描述因此讲"sherpa-onnx 专用
   *   格式，whisper.cpp 用不了这个文件"；而**随包内置、真正落进用户机器的是
   *   `silero-vad-ggml`**（见 {@link BUNDLED_MODEL_IDS}）——描述文字与用户实际拿到
   *   的文件正好说反。
   *
   * ## 修法：显式排"代表变体"的优先级，不再隐式收下"第一个见到的"
   *
   * 1. 这个 `groupId` 下有变体在 `BUNDLED_MODEL_IDS` 里 —— 用它：随包出厂的字节
   *    就是绝大多数用户会真正撞见的那份，组描述该讲那份的事。
   * 2. 否则，变体的 `tags` 带 `recommended-default` 或 `benchmark-default` —— 用它：
   *    这两个标签本来就是清单作者显式标出的"这条是默认档"信号，不必猜。
   * 3. 否则，退回"第一次见到的那个"（原行为不变）——没有默认档信号时，清单顺序
   *    依然是唯一能用的信号，不强行编造一个更"聪明"的规则。
   *
   * 三条按数字从小到大是"更该被信任"；只在**严格更靠前**时才覆盖已选中的代表
   * ——同优先级不覆盖，保持"先到先得"，避免同一优先级下被后面的条目意外顶替。
   */
  private catalogDescriptionRank(m: ModelEntry): 0 | 1 | 2 {
    if ((BUNDLED_MODEL_IDS as readonly string[]).includes(m.id)) return 0;
    if (m.tags.includes('recommended-default') || m.tags.includes('benchmark-default')) return 1;
    return 2;
  }

  /**
   * @param targetLanguage 用户打算转写的语言（ADR-011 决策 1）。据此把"实测在该语言下
   *   不可用"的模型标出来 —— 例如 whisper base 把「维基百科」听成「危机摆科」。
   */
  async buildCatalog(
    roleFilter: ModelRole | 'all',
    targetLanguage: string | null,
  ): Promise<GetCatalogResponse> {
    const installed = await this.listInstalled();
    const installedIds = new Set(installed.map((m) => m.id));
    /*
     * ★ T-195：`computeFit` 吃 `disks[].freeMB` 判 `blocked_disk` —— 那是"能不能装"。
     * 取一次现算的读数（`statfs`，零 spawn），整份目录共用，避免每个变体各读一次。
     */
    const liveHardware = await this.hardwareWithLiveReadings();
    const groups = new Map<string, CatalogGroupWithFitness>();
    // 与 groups 一一对应：当前那个代表变体的优先级（越小越该被信任，见
    // catalogDescriptionRank()）。只在新变体的排名严格更靠前时才覆盖代表文案。
    const descriptionRanks = new Map<string, 0 | 1 | 2>();

    for (const m of this.modelCatalog.models) {
      if (roleFilter !== 'all' && m.role !== roleFilter) continue;

      // ★ fit 判定由 shared 的唯一实现算出来，前端只渲染不重算（两份实现必然漂移）
      const fitness = computeFit(
        {
          totalSizeBytes: m.totalSizeBytes,
          requirements: m.requirements,
          role: roleToActivationSlot(m.role),
          modelId: m.id,
          blockCount: m.gguf?.blockCount,
          benchmarkRtf: m.benchmark?.rtf ?? null,
          // ★ 只有 kind='measured' 的证据才会返回数字（`referenceSpeedOf` 保证）。
          // 估计值一律返回 null → speedSource 保持 'none' → UI 显示「速度未测量」。
          // 宁可少说，也不能把估计值渲染成「参考机实测」。
          referenceRtf: referenceSpeedOf(m.speedEvidence)?.rtf ?? null,
          referenceBackend: referenceSpeedOf(m.speedEvidence)?.backend ?? null,
          notRecommendedFor: m.notRecommendedFor ?? [],
          targetLanguage,
        },
        liveHardware,
      );

      const variant: CatalogVariant = { ...m, installed: installedIds.has(m.id), fitness };
      const rank = this.catalogDescriptionRank(m);
      let group = groups.get(m.groupId);
      if (!group) {
        group = {
          groupId: m.groupId,
          // ★ 这里必须是**真实的 ModelRole**，不能收窄成 store kind。
          // 收窄只用于"落到哪个磁盘目录"；把它漏进 API 响应会让 vad/punctuation
          // 在网页上全部显示成 asr —— 目录里明明有，用户却找不到那一类。
          role: m.role,
          family: m.family,
          // 组名去掉变体后缀：「Whisper large-v3 (q5_0)」→「Whisper large-v3」
          displayName: m.displayName.replace(/\s*\([^)]*\)\s*$/, ''),
          displayNameZh: m.displayNameZh.replace(/（[^）]*）\s*$/, ''),
          descriptionZh: m.descriptionZh,
          descriptionEn: m.descriptionEn,
          languages: m.languages,
          tags: m.tags,
          license: m.license,
          variants: [],
        };
        groups.set(m.groupId, group);
        descriptionRanks.set(m.groupId, rank);
      } else if (rank < (descriptionRanks.get(m.groupId) ?? 2)) {
        // 更值得信任的代表出现了（例如随包默认档排在清单第二位）——覆盖代表文案，
        // 但不动 displayName 的去后缀逻辑以外的东西：变体本身的事实（role/family/
        // languages）理论上组内一致，仍然一并覆盖，保持"代表 = 同一个变体"这条不变式。
        group.displayName = m.displayName.replace(/\s*\([^)]*\)\s*$/, '');
        group.displayNameZh = m.displayNameZh.replace(/（[^）]*）\s*$/, '');
        group.descriptionZh = m.descriptionZh;
        group.descriptionEn = m.descriptionEn;
        group.languages = m.languages;
        group.tags = m.tags;
        group.license = m.license;
        descriptionRanks.set(m.groupId, rank);
      }
      group.variants.push(variant);
    }

    return {
      catalogVersion: this.modelCatalog.catalogVersion,
      source: 'bundled',
      fetchedAt: new Date().toISOString(),
      // ★ 诚实：这是 git 里提交的内置目录，不是签名过的远端目录，所以恒为 stale。
      stale: true,
      hardwareSnapshotId: HARDWARE_SNAPSHOT_ID,
      groups: [...groups.values()],
    };
  }

  /* -------------------------------- 存储 -------------------------------- */

  /**
   * `by-name/**` 底下**没有任何安装记录认领**的顶层条目 —— 「无法识别的残留」。
   *
   * ## 它是什么（用户机器上真实存在的东西）
   *
   * `[用户真机实测 2026-08-10，:10000]`：
   * ```
   * by-name/backend/whisper-bin-ubuntu-x64/       24,259,400 B
   * by-name/backend/whisper-bin-ubuntu-x64.tar.gz  9,379,235 B
   * ```
   * 08-02 装的是当时目录指向的**上游归档**；08-07 T-167 把**同一个 id** 换成了
   * 我们自建的那份。重装之后安装记录指向新归档，**旧的两份没有任何人认领** ——
   * `breakdown` 里查不到（它按记录列）、界面上删不掉、GC 也不扫这里（只扫 `blobs/`）。
   * 对账正好：`usedBytes − breakdown∑ = 9,379,235`，就是那个孤儿归档。
   *
   * ⚠️ **成因是结构性的，不是一次意外**：只要目录里"同一个 id 换了内容"，
   * 重装就会留下一份。今天靠这里事后扫，**根治要在换的那一刻处理**（已报 Manager）。
   *
   * ## ★ 判据：**"没有记录认领" ≠ "没在用"**
   *
   * 这条区分是这个函数的全部难点。`by-name/backend/` 正是 `resolveBackendTool()`
   * 的**发现路径** —— 一个没有 manifest 的目录**仍然可能正在被解析、被执行**
   * （T-192 已经证明过这一点）。按"扫到没 manifest 的就删"去做，
   * **会让用户的转写当场坏掉，而且他不会知道为什么**。
   *
   * 所以这里在"没被认领"之外加了第二道：**用产品自己的解析器再问一遍**
   * （`discoverTools()` —— 与流水线装配时调的是同一个函数，不是我另写一份判断），
   * 凡是某个工具当前真的解析到它里面的，一律标 `inUseBy` 并**排除在可回收之外**。
   *
   * 判据不是"我觉得它没用"，是"**产品自己说它现在没在用它**"。
   */
  /**
   * **所有被安装记录点名的绝对路径**（归档本身 + 它解开出来的目录 + 每模型独占目录）。
   *
   * 抽成方法是因为它有**两个**消费者，而它们问的是同一件事的两面：
   *   · `findUnclaimedFiles()` —— "盘上这一坨**没人认领**吗"；
   *   · `/api/backends/catalog` 的第三态（T-197）—— "现在跑着的这个工具，
   *     是不是来自一份**没人认领**的副本"。
   * 各写一份的话，两处对"认领"的定义会漂 —— 而这一整轮修的正是那族。
   *
   * ⚠️ **不做 `du`、不读内容**：只是把记录里点名的路径算出来，可以每次请求都调。
   */
  async claimedInstallPaths(): Promise<Set<string>> {
    const roots = { models: this.store.root };
    const claimed = new Set<string>();
    const claimRecord = (id: string, files: readonly { name: string }[] | undefined): void => {
      for (const f of files ?? []) {
        let abs: string;
        try {
          abs = resolveInstalledFile(f as Parameters<typeof resolveInstalledFile>[0], roots);
        } catch {
          continue;
        }
        claimed.add(abs);
        const dir = path.join(path.dirname(abs), unpackDirName(f.name));
        if (dir !== abs) claimed.add(dir);
      }
      claimed.add(byModelDir(this.store.root, id));
    };
    for (const m of await this.listInstalled()) claimRecord(m.id, m.files);
    for (const p of await this.listInstalledBackends()) claimRecord(p.id, p.files);
    return claimed;
  }

  async findUnclaimedFiles(): Promise<
    { relPath: string; bytes: number; inUseBy: string | null }[]
  > {
    const claimed = await this.claimedInstallPaths();

    /*
     * 产品**现在**解析到的每一个工具路径。这是第二道闸，不是装饰：
     * `discoverTools()` 就是 `buildPipeline()` 装配时调的那一个。
     *
     * ★ `null` 与 `[]` 是**两件事**，这里必须分开：
     *   · `[]`   —— 解析器跑通了，它说"没有任何工具落在这些残留里"；
     *   · `null` —— **解析器自己失败了**，我们根本没拿到答案。
     * 上一版把两者都塞进 `[]`，于是解析器一失败，全部残留都会被算成"可回收" ——
     * 而真正的删除路径又会拒绝删（它另外做了一次自己的 try/catch）。
     * 结果是**界面报一个 298 MB 的可回收，点下去一个字节都不删**：
     * 又一次"产品报告了一件没发生的事"。
     * （顺带：那一版 `let livePaths = []` 的初值两条分支都会覆盖，
     *   `no-useless-assignment` 报的就是它 —— **是多余的赋值，不是漏了用**。）
     */
    const livePaths = await resolveLiveToolPaths(this.store.root);

    const out: { relPath: string; bytes: number; inUseBy: string | null }[] = [];
    for (const kind of STORE_KINDS) {
      const dir = this.store.byNameDir(kind);
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (claimed.has(abs)) continue;
        /*
         * 解析器不可用 ⇒ **一律当成"可能在用"**。判据与 `hw.probe` 对探针缺失、
         * `check-elf-glibc` 对 objdump 缺失同源：「我问不出来」不等于「它没在用」，
         * 而这一格的代价是**删掉用户正在跑的东西**。
         */
        const inUse =
          livePaths === null
            ? RESOLVER_UNAVAILABLE
            : (livePaths.find((lp) => lp === abs || lp.startsWith(abs + path.sep)) ?? null);
        out.push({
          relPath: path.relative(this.store.root, abs),
          bytes: await duBytes(abs),
          inUseBy: inUse,
        });
      }
    }
    return out.sort((a, b) => b.bytes - a.bytes);
  }

  /**
   * 删掉「无法识别的残留」里**确认没在用**的那些。
   *
   * 两条硬闸，缺一条都不删：
   *   ① 没有任何安装记录认领它；
   *   ② `discoverTools()` 当前没有把任何工具解析到它里面。
   *
   * ⚠️ 解析器本身失败时**一个都不删**（返回 0）—— "我问不出来"不等于"它没在用"。
   * 这与 `check-elf-glibc` 对 `objdump` 缺失的态度、与 `hw.probe` 对探针缺失的态度同源。
   */
  async collectUnclaimed(): Promise<{ freedBytes: number; removedFiles: number }> {
    /*
     * ★ 不在这里另做一次解析器判断。
     *
     * 上一版这里自己 try/catch 了一遍 `discoverTools()`，于是"能不能删"与
     * "算不算可回收"由**两处**各自决定 —— 解析器一失败，`buildStorage()` 报
     * 一个 298 MB 的可回收，而这里一个字节都不删。**两份判断必然漂移。**
     * 现在只有一处：`findUnclaimedFiles()` 在解析器不可用时把每一项都标成
     * `inUseBy = RESOLVER_UNAVAILABLE`，下面这句 `continue` 自动把它们跳过，
     * 而同一个字段也让它们不进 `reclaimable.unclaimedBytes`。
     */
    const items = await this.findUnclaimedFiles();
    let freed = 0;
    let removed = 0;
    for (const it of items) {
      if (it.inUseBy !== null) continue;
      const abs = path.join(this.store.root, it.relPath);
      try {
        await fs.rm(abs, { recursive: true, force: true });
        freed += it.bytes;
        removed += 1;
      } catch {
        /* 删不掉不阻断其余的 —— 下一轮还能再清 */
      }
    }
    return { freedBytes: freed, removedFiles: removed };
  }

  async buildStorage(): Promise<GetStorageResponse> {
    const [installed, packs, usedBytes, garbage, unclaimed] = await Promise.all([
      this.listInstalled(),
      this.listInstalledBackends(),
      this.store.usedBytes(),
      this.store.findGarbage(),
      this.findUnclaimedFiles(),
    ]);

    let freeBytes = 0;
    let totalBytes = 0;
    try {
      const st = await fs.statfs(this.modelsRoot);
      freeBytes = Number(st.bavail) * Number(st.bsize);
      totalBytes = Number(st.blocks) * Number(st.bsize);
    } catch {
      /* 取不到就是 0，不猜 */
    }

    const breakdown: StorageBreakdownItem[] = [
      ...installed.map((m) => ({
        id: m.id,
        kind: 'model' as const,
        displayName: m.displayName,
        bytes: m.totalSizeBytes,
        active: this.active[m.role] === m.id,
      })),
      // 后端包也占 blobs/ 的空间，不列出来的话 breakdown 加不回 usedBytes
      ...packs.map((p) => ({
        id: p.id,
        kind: 'backend-pack' as const,
        displayName: p.id,
        bytes: p.files.reduce((a, f) => a + f.sizeBytes, 0),
        active: this.hardware.selectedBackend === p.backend,
      })),
    ];

    /*
     * ★ T-193：让「无法识别的残留」**在明细里看得见**，哪怕它没有名字。
     *
     * 不列出来的话，用户看到的是 `usedBytes` 与明细合计对不上的一个差额
     * （`[实测]` 正好 9,379,235 B），而且没有任何地方能告诉他那是什么、能不能删。
     * 那正是他一直在问的那类东西。**正在被用的那些也列**，只是不计入可回收 ——
     * 藏起来才是把"说不清"变成"看不见"。
     */
    if (unclaimed.length > 0) {
      breakdown.push({
        id: '__unclaimed__',
        /*
         * ★ 这一档不再冒充 `backend-pack`，而且**这句中文不再是界面的措辞来源**：
         * `StorageBreakdown` 现在按 `kind` 取词条（`models.storage.unclaimedSegment`），
         * 英文界面上才不会再冒出「无法识别的残留（3 项）」。
         * 这里仍然发一句中文，只是给**旧前端**兜底，别让它显示空白。
         */
        kind: 'unclaimed' as const,
        /*
         * ⚠️ **这句中文还在，而且这条只在消费端绕过去了，没在生产端治。**
         *
         * `StorageBreakdown` 现在按 `kind` 取词条，所以 `/models` 那一处不再读它 ——
         * 但**任何别的消费者拿到的仍然是这句中文**（契约上 `displayName` 是必填的
         * 自由文本，没有语言维度）。留着它只是给**旧前端**兜底，别让它显示空白。
         *
         * 真正的治法是让 daemon 不再拼句子（同 `Remediation.labelZh` / `Inapplicability`
         * 那两轮的做法：契约换成机器可读，措辞归两份 locale）。**本轮按 Coordinator
         * 裁定不做，立此条目。** 新代码不许再往这个字段里拼句子。
         */
        displayName: `无法识别的残留（${String(unclaimed.length)} 项）`,
        // ★ 件数单独一格：界面按 kind 取词条之后，那句中文里的「（N 项）」就到不了屏幕了。
        itemCount: unclaimed.length,
        bytes: unclaimed.reduce((a, x) => a + x.bytes, 0),
        active: unclaimed.some((x) => x.inUseBy !== null),
      });
    }

    return {
      modelsRoot: this.modelsRoot,
      volume: { freeBytes, totalBytes },
      usedBytes,
      breakdown,
      reclaimable: {
        orphanBlobsBytes: garbage.orphanBlobs.reduce((a, x) => a + x.bytes, 0),
        stalePartialsBytes: garbage.stalePartials.reduce((a, x) => a + x.bytes, 0),
        inactiveModelsBytes: installed
          .filter((m) => this.active[m.role] !== m.id)
          .reduce((a, m) => a + m.totalSizeBytes, 0),
        // 只把**确认没在用**的那些算成可回收：正在被解析到的残留一个字节都不算
        unclaimedBytes: unclaimed
          .filter((x) => x.inUseBy === null)
          .reduce((a, x) => a + x.bytes, 0),
      },
    };
  }

  /* -------------------------------- 源 ---------------------------------- */

  /** 每个 provider 取一个代表 URL（目录里第一次出现的镜像）作为探测对象。 */
  probeTargets(): ProbeTarget[] {
    const seen = new Set<string>();
    const out: ProbeTarget[] = [];
    for (const model of this.modelCatalog.models) {
      for (const file of model.files) {
        for (const mirror of file.mirrors) {
          if (seen.has(mirror.provider)) continue;
          seen.add(mirror.provider);
          out.push({ provider: mirror.provider, url: mirror.url, official: mirror.official });
        }
      }
    }
    return out;
  }

  /**
   * 把 downloader 的探测结果并入缓存。
   *
   * 是**合并**不是覆盖：单个文件的镜像列表只覆盖部分 provider，直接替换会把其它
   * provider 的历史结果抹成"没探测过"。
   */
  mergeProbes(outcomes: ProbeOutcome[]): void {
    const byId = new Map(this.lastProbes.map((p) => [p.id, p]));
    for (const o of outcomes) {
      byId.set(o.provider as ProviderId, {
        // provider 来自已通过 schema 校验的 manifest，必然是合法 ProviderId
        id: o.provider as ProviderId,
        ok: o.ok,
        ttfbMs: o.ttfbMs,
        throughputKbps: o.throughputKbps,
        probedAt: o.probedAt,
        error: o.error,
      });
    }
    this.lastProbes = [...byId.values()];
  }

  /**
   * 探测一组镜像并广播 `sources.probed`。
   *
   * 下载前必探：ADR-004 决策 1 的核心是"不去回答 hf-mirror 在墙内通不通"，
   * 而是并发实测、按速度排序、失败自动切换。
   */
  async probeMirrors(
    mirrors: readonly Mirror[],
    /**
     * ★ T-198：任务的取消信号。**这是用户真机撞到的那个窗口** ——
     * 取消一个还停在 `resolving` 的下载时，探测完全不认 signal，`abort()` 成了空操作。
     * 可选：`/api/models/sources/probe` 那种"用户主动测速"没有任务上下文，不传即可。
     */
    signal?: AbortSignal,
  ): Promise<ProbeOutcome[]> {
    const outcomes = await probeAll(
      mirrors.map((m) => ({ provider: m.provider, url: m.url, official: m.official })),
      undefined,
      signal,
    );
    this.mergeProbes(outcomes);
    this.publish(
      makeEvent('sources.probed', topics.models(), {
        effective: this.effectiveProvider() ?? 'none',
        probes: outcomes.map((p) => ({
          id: p.provider,
          ok: p.ok,
          ttfbMs: p.ttfbMs,
          throughputKbps: p.throughputKbps,
        })),
      }),
    );
    return outcomes;
  }

  /**
   * 当前实际生效的 provider。
   *
   * 用户钉了源就是那个；否则用 downloader 的真实排序函数（吞吐为主、延迟次之、
   * 非官方镜像打 8 折），没探测过就是 null —— 不假装知道。
   */
  effectiveProvider(): ProviderId | null {
    if (this.prefs.sourceProvider !== 'auto') return this.prefs.sourceProvider;
    if (this.lastProbes.length === 0) return null;
    const outcomes: ProbeOutcome[] = this.lastProbes.map((p) => ({
      provider: p.id,
      ok: p.ok,
      ttfbMs: p.ttfbMs,
      throughputKbps: p.throughputKbps,
      error: p.error,
      probedAt: p.probedAt,
    }));
    const ordered = orderSourcesForDownload(this.probeTargets(), outcomes, null);
    const first = ordered[0];
    if (!first) return null;
    const outcome = outcomes.find((o) => o.provider === first.provider);
    return outcome?.ok ? (first.provider as ProviderId) : null;
  }

  buildSources(): GetSourcesResponse {
    return {
      selected: this.prefs.sourceProvider,
      effective: this.effectiveProvider(),
      probes: this.lastProbes,
      /*
       * ★ T-157 ④：能选哪些源，**由清单说了算**，不由前端写死一张表。
       *
       * `probeTargets()` 已经是"目录里真实出现过的 provider"这一份定义；
       * 让 UI 另写一份的话，清单加一个镜像它不会知道、删一个它会继续摆着一个
       * 点了没用的选项 —— 而两边都不会有任何东西报错。
       */
      available: [...new Set(this.probeTargets().map((t) => t.provider as ProviderId))],
    };
  }
}
