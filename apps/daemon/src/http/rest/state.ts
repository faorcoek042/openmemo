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

import { resolveStoreRoot } from '@openmemo/pipeline';

import {
  ArtifactStore,
  DownloadQueue,
  orderSourcesForDownload,
  probeAll,
  type ProbeOutcome,
  type ProbeTarget,
} from '@openmemo/downloader';
import {
  MODEL_ROLES,
  computeFit,
  makeEvent,
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

import type { SseHub } from '../sse.js';
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

/** 用户偏好，落盘在 models 根目录，重启后保持。 */
interface Prefs {
  sourceProvider: ProviderId | 'auto';
  sourceBaseUrl: string | null;
  selectedBackend: Backend | null;
}

const DEFAULT_PREFS: Prefs = { sourceProvider: 'auto', sourceBaseUrl: null, selectedBackend: null };

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
  ) {
    this.store = new ArtifactStore(modelsRoot);
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
    const hardware = await detectLocalHardware(modelsRoot);

    // 与 AppPaths.extensionsDir 同一个定义（config/paths.ts:91）。
    const extensionsDir =
      process.env['OPENMEMO_EXT_DIR'] ?? path.join(deps.dataDir, 'bin', 'ext');

    const state = new RestState(
      deps.sse,
      modelsRoot,
      extensionsDir,
      modelCatalog,
      backendCatalog,
      hardware,
    );
    await state.store.init();
    await state.loadPersisted();
    state.bridgeQueueToSse();
    return state;
  }

  /* ----------------------------- 落盘状态 ------------------------------- */

  private get activeFile(): string {
    return path.join(this.modelsRoot, 'active.json');
  }
  private get prefsFile(): string {
    return path.join(this.modelsRoot, 'prefs.json');
  }

  private async loadPersisted(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.activeFile, 'utf8'));
      const rec = raw as Partial<Record<ModelRole, string | null>>;
      this.active.asr = typeof rec.asr === 'string' ? rec.asr : null;
      this.active.llm = typeof rec.llm === 'string' ? rec.llm : null;
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

  async listInstalled(): Promise<InstalledModel[]> {
    const out: InstalledModel[] = [];
    for (const role of ['asr', 'llm'] as const) {
      out.push(...(await this.store.listManifests<InstalledModel>(role)));
    }
    return out;
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
          referenceRtf: m.referenceBenchmark?.rtf ?? null,
          referenceBackend: m.referenceBenchmark?.backend ?? null,
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
    };
  }
}
