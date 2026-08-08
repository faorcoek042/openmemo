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

import { backendPrefsPath, resolveStoreRoot } from '@openmemo/pipeline';

import {
  ArtifactStore,
  DownloadQueue,
  STORE_KINDS,
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
  MODEL_ROLES,
  computeFit,
  makeEvent,
  referenceSpeedOf,
  topics,
  type Backend,
  type BackendPack,
  type CatalogGroupWithFitness,
  type CatalogVariant,
  type DownloadJob,
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
  type SourceProbe,
  type SseEvent,
  type StorageBreakdownItem,
} from '@openmemo/shared';

import { byModelDir } from '../../pipeline/modelStore.js';
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
import { roleToActivationSlot } from './roleMap.js';

export const HARDWARE_SNAPSHOT_ID = 'hw-local';

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
  event: 'job.created' | 'job.progress' | 'job.done' | 'job.failed',
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
   * 指纹变了 ⇒ 快照必然重算。新增一个改变机器状态的动作时，
   * 只要它影响的是这三样东西之一，**不写任何代码它就已经被覆盖了**；
   * 影响别的东西时，`hardwareInputsGuard()` 会当场把它逼出来（见下）。
   */
  private async machineFingerprint(): Promise<string> {
    const packs = await this.listInstalledBackends();
    return [
      this.modelsRoot,
      this.prefs.selectedBackend ?? '',
      ...packs.map((p) => p.id).sort(),
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
    this.hardwareFingerprint = fp;
    return this.hardware;
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

    const [modelCatalog, backendCatalog] = await Promise.all([
      loadModelCatalog(deps.manifestDir),
      loadBackendCatalog(deps.manifestDir),
    ]);
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
          pct: job.totalBytes ? job.completedBytes / job.totalBytes : null,
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
  async dropInstalledFiles(id: string): Promise<void> {
    const roots = { models: this.store.root };
    for (const kind of STORE_KINDS) {
      if (kind === 'backend') continue;
      const rec = await this.store.readManifest<InstalledModel>(kind, id);
      if (!rec) continue;
      for (const f of rec.files ?? []) {
        let abs: string;
        try {
          abs = resolveInstalledFile(f, roots);
        } catch {
          continue; // 记录损坏/越界 —— 宁可留下也不按猜出来的路径去 rm
        }
        await fs.rm(abs, { force: true }).catch(() => undefined);
        // 归档包展开出来的目录（`by-name/<kind>/<unpackDirName(name)>`）
        const dir = path.join(path.dirname(abs), unpackDirName(f.name));
        if (dir !== abs) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
      // `materializeModelDir()` 摊出来的每模型独占目录（T-160 ①附）
      await fs
        .rm(byModelDir(this.store.root, id), { recursive: true, force: true })
        .catch(() => undefined);
    }
  }

  /** 把某个 id 的安装记录从**所有**桶里删干净（旧布局可能不止一处）。 */
  async dropInstalledRecord(id: string): Promise<void> {
    // ★ 顺序不能反：先按记录删文件，再删记录 —— 记录没了就不知道该删哪些文件了
    await this.dropInstalledFiles(id);
    for (const kind of STORE_KINDS) {
      if (kind === 'backend') continue;
      await this.store.removeManifest(kind, id);
    }
  }

  async listInstalledBackends(): Promise<InstalledBackendPack[]> {
    return this.store.listManifests<InstalledBackendPack>('backend');
  }

  /* -------------------------------- 目录 -------------------------------- */

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
    const groups = new Map<string, CatalogGroupWithFitness>();

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
        this.hardware,
      );

      const variant: CatalogVariant = { ...m, installed: installedIds.has(m.id), fitness };
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

  async buildStorage(): Promise<GetStorageResponse> {
    const [installed, packs, usedBytes, garbage] = await Promise.all([
      this.listInstalled(),
      this.listInstalledBackends(),
      this.store.usedBytes(),
      this.store.findGarbage(),
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
  async probeMirrors(mirrors: readonly Mirror[]): Promise<ProbeOutcome[]> {
    const outcomes = await probeAll(
      mirrors.map((m) => ({ provider: m.provider, url: m.url, official: m.official })),
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
