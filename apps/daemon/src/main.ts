/**
 * daemon 引导与生命周期（D-01 §2）。
 *
 * 启动序列（顺序是有讲究的，别改）：
 *   1. 解析数据目录
 *   2. 建 server 并挂 handler（先挂后绑，避免绑定成功却还没有 handler 的窗口）
 *   3. 获取单实例锁 = 绑定端口（原子、崩溃自动释放）
 *   4. 打开/迁移数据库
 *   5. 崩溃恢复扫描
 *   6. 写 runtime.json（0600，内含 token）
 *   7. 就绪
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

import { openAppDatabase, defaultExtensionPaths, type AppDatabase } from '@openmemo/db';

import {
  BIND_HOST,
  DEFAULT_PORT,
  DataDirLockedError,
  acquireDataDirLock,
  acquireSingleInstance,
  createUnboundServer,
  removeRuntimeJson,
  writeRuntimeJson,
  type RuntimeInfo,
} from './bootstrap/single-instance.js';
import { resolvePaths, type AppPaths } from './config/paths.js';
import { reclaimOrphans } from './bootstrap/orphans.js';
import { SessionStore, loadOrCreateToken, type Session } from './http/auth.js';
import { attachHttpHandlers } from './http/server.js';
import { SseHub } from './http/sse.js';
import { attachWebSocket } from './http/ws.js';
import { JobQueue } from './jobs/queue.js';
import { LanePool } from './jobs/lanes.js';
import { Repos } from './db/repos.js';
import { buildPipeline, type PipelineBundle } from './pipeline/setup.js';
import { resolveExtensionDir } from './pipeline/modelStore.js';
import { Scheduler, type JobHandler } from './jobs/scheduler.js';
import { runTranscribeJob } from './jobs/runners/transcribe.js';
import { createNoteRoutes } from './http/rest/notes.js';
import { createContentRoutes } from './http/rest/content.js';
import { createRuntimeRoutes } from './http/rest/hardware.js';
import { createSelfCheckRoutes } from './http/rest/selfcheck.js';
import { setPipelineJobHooks } from './http/rest/jobs.js';
import { createSettingsRoutes } from './http/rest/settings.js';
import { createOrganizeRoutes } from './http/rest/organize.js';
import { createUploadRoutes } from './http/upload.js';
import { SecretStore } from '@openmemo/llm';
import { MindMapRepo } from './db/mindmapRepo.js';
import { runMindmapJob } from './jobs/runners/mindmap.js';
import { resolveConfiguredProvider } from './llm/resolve.js';
import { createSearchRoutes } from './http/rest/search.js';
import { createMediaRoutes } from './http/media.js';
import type { RouteModule } from './http/server.js';

export const VERSION = '0.1.0';

export interface StartOptions {
  readonly port?: number;
  readonly dataDir?: string;
  /** 端口扫描上限；测试里会调小以便快速触发冲突分支。 */
  readonly maxPort?: number;
}

export interface RunningDaemon {
  readonly port: number;
  readonly token: string;
  readonly instanceId: string;
  readonly paths: AppPaths;
  readonly database: AppDatabase;
  readonly queue: JobQueue;
  readonly lanes: LanePool;
  readonly sse: SseHub;
  readonly portDrifted: boolean;
  /** 端口漂移时给用户看的警告；未漂移则为 undefined。 */
  readonly portWarning?: string | undefined;
  stop(): Promise<void>;
  /**
   * 自我重启：优雅停 → 拉起一个新进程接管同一个端口与数据目录 → 本进程退出。
   *
   * 存在的理由：SQLite 扩展（libsimple 中文分词 / sqlite-vec）是在**打开 DB 的那个连接**
   * 上加载的，没法对已开连接补加载。用户在网页上装完扩展后必须换一个新连接才生效 ——
   * 但**让用户去开终端重启 daemon 就等于没做到"全部通过网页完成"**。
   * 让 daemon 自己重启，用户只点一下按钮，字面上仍然成立。
   *
   * 在途任务不会丢：T-054 把三个中止意图拆开了，这里走 `shutdown` →
   * 任务置回 `queued`，新进程起来后自动续跑。
   */
  restart(reason: string): Promise<void>;
}

export class AlreadyRunningError extends Error {
  constructor(readonly info: RuntimeInfo) {
    super(`OpenMemo 已在运行：http://${info.host}:${info.port}（pid ${info.pid}）`);
    this.name = 'AlreadyRunningError';
  }
}

export class StartupConflictError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'StartupConflictError';
  }
}

export async function startDaemon(opts: StartOptions = {}): Promise<RunningDaemon> {
  const paths = resolvePaths(opts.dataDir);
  for (const dir of [paths.dataDir, paths.runtimeDir, paths.logsDir, paths.tmpDir]) {
    mkdirSync(dir, { recursive: true });
  }

  /*
   * 自我重启的接力棒：token 和会话必须**跨进程延续**。
   *
   * 否则点一下"立即重启"，浏览器那一页就废了 —— cookie 里的 sid 在新进程的内存里
   * 不存在（SessionStore 是 Map），新进程又换了 token，而前端在握手时就把 URL 里的
   * token 抹掉了（防截图泄露），刷新也救不回来。用户只能去终端读新地址，
   * 正好是"用户不碰命令行"要消灭的场景。
   *
   * 走 env 不走 argv：/proc/<pid>/cmdline 同机任何用户可读，environ 只有 owner 能读。
   * 读完立刻从 process.env 抹掉 —— daemon 会 spawn ffmpeg / whisper-cli，
   * 不抹的话这些子进程会一路继承 token。
   */
  const inheritedToken = process.env['OPENMEMO_BOOT_TOKEN'];
  delete process.env['OPENMEMO_BOOT_TOKEN'];
  const inheritedSessionsRaw = process.env['OPENMEMO_SESSIONS'];
  delete process.env['OPENMEMO_SESSIONS'];
  /*
   * 先取值再删，顺序不能反 —— 删掉之后下面 acquireSingleInstance 就读不到了，
   * 同端口重试会**永远不生效**：平时端口释放得快看不出来，等到释放慢的那次
   * （机器忙、连接没断干净、Windows）就悄悄漂到下一个端口，
   * 而端口一变浏览器的麦克风授权就没了。这种"平时全绿、关键时刻失灵"最难查。
   */
  const waitForPortRaw = process.env['OPENMEMO_WAIT_FOR_PORT_MS'];
  delete process.env['OPENMEMO_WAIT_FOR_PORT_MS'];
  /*
   * 接班等待：只有自我重启拉起的进程才有 OPENMEMO_WAIT_FOR_PORT_MS，
   * 它同时意味着"前任正在退，别一撞锁就放弃"。普通启动 = 0 = 行为不变。
   */
  const handoverWaitMs =
    waitForPortRaw && Number.isFinite(Number(waitForPortRaw)) ? Number(waitForPortRaw) : 0;

  /*
   * 数据目录锁必须在**打开数据库之前**拿到 —— 否则第二个实例已经写过库了才被拒。
   * 端口锁挡不住"换端口、同 dataDir"这种情况（D-01 §2.3 第二道）。
   */
  const dirLock = acquireDataDirLock(paths.dataDir, handoverWaitMs);


  // 自我重启的接力棒优先；否则复用磁盘上那个**跨重启稳定**的 token，
  // 这样用户保存的 `#t=...` 链接不会因为一次重启就作废（见 loadOrCreateToken）
  const token =
    inheritedToken && inheritedToken.length >= 16
      ? inheritedToken
      : loadOrCreateToken(paths.runtimeDir);
  let inheritedSessions: Session[] = [];
  if (inheritedSessionsRaw) {
    try {
      const parsed: unknown = JSON.parse(inheritedSessionsRaw);
      if (Array.isArray(parsed)) inheritedSessions = parsed as Session[];
    } catch {
      /* 接力棒坏了不致命：退化成"要重新握手"，不要因此起不来 */
    }
  }
  const sessions = new SessionStore(token, inheritedSessions);
  const sse = new SseHub();
  const server = createUnboundServer();

  let boundPort = 0;
  let instanceIdRef = '';
  let repos: Repos | undefined;
  let bundle: PipelineBundle | undefined;
  let lastExtDir = '';
  // 用 holder 而不是 let：restart 定义在 stop 之后，而 http handler 必须更早挂好
  const restartHook: { run?: (reason: string) => Promise<void> } = {};
  let scheduler: Scheduler | undefined;
  const routers: RouteModule[] = [];
  let database: AppDatabase | undefined;
  let queue: JobQueue | undefined;
  const lanes = new LanePool();

  /** 磁盘上已经有扩展、但当前连接没加载它 → 需要重启才能生效。 */
  const restartRequirement = (): {
    required: boolean;
    extensions: string[];
    messageZh: string;
    endpoint: string;
  } => {
    const pending: string[] = [];
    try {
      if (database) {
        const ext = defaultExtensionPaths(resolveExtensionDir(paths.modelsDir, paths.extensionsDir));
        if (ext.libsimple && existsSync(ext.libsimple) && !database.extensions.libsimple) {
          pending.push('libsimple');
        }
        if (ext.sqliteVec && existsSync(ext.sqliteVec) && !database.extensions.sqliteVec) {
          pending.push('sqlite-vec');
        }
      }
    } catch {
      /* 探测失败就当"不需要重启"，绝不因为这个字段把状态接口搞挂 */
    }
    return {
      required: pending.length > 0,
      extensions: pending,
      messageZh: pending.includes('libsimple')
        ? '中文分词器已安装，需重启生效'
        : pending.length > 0
          ? '搜索扩展已安装，需重启生效'
          : '',
      endpoint: '/api/daemon/restart',
    };
  };

  // 先挂 handler 再绑定 —— 否则会有"端口已通但请求打到空 server"的窗口，
  // 而单实例探测正好靠 /api/health，这个窗口会让探测误判。
  attachHttpHandlers(server, {
    sessions,
    sse,
    instanceId: () => instanceIdRef,
    version: VERSION,
    dataDir: paths.dataDir,
    port: () => boundPort,
    routers,
    requestRestart: (reason: string) => {
      // 不 await：让 HTTP 响应先发出去，前端才能显示"正在重启"
      void restartHook.run?.(reason);
    },
    status: () => ({
      /*
       * 「装了但没生效」—— 前端那条横幅「中文分词器已安装，需重启生效 →[立即重启]」
       * 的唯一触发源。
       *
       * 为什么非要有这个字段：SQLite 扩展是在**打开 DB 的那个连接**上加载的，
       * model-mgmt 把 libsimple 装到磁盘上之后，本进程的 tokenizer 仍然是 trigram。
       * 只看 extensions.libsimple=false，前端分不清"没装"和"装了但要重启" ——
       * 前者该显示"去安装"，后者该显示"点一下重启"。这跟 T-060 那次
       * 「检测中」和「检测过了但不可用」必须分开是同一类问题。
       */
      restartRequired: restartRequirement(),
      db: database
        ? {
            driver: database.driver,
            sqliteVersion: database.sqliteVersion,
            journalMode: database.journalMode,
            schemaVersion: database.schema.to,
            extensions: {
              libsimple: database.extensions.libsimple,
              sqliteVec: database.extensions.sqliteVec,
              tokenizer: database.extensions.tokenizer,
              failures: database.extensions.failures,
            },
            search: { ok: database.search.ok, tokenizer: database.search.tokenizer },
          }
        : null,
      jobs: queue ? queue.counts() : null,
      lanes: lanes.snapshot(),
      sseClients: sse.clientCount,
      scheduler: scheduler ? { running: scheduler.runningCount } : null,
      pipeline: bundle
        ? {
            missing: bundle.missing,
            modelPath: bundle.modelPath,
            streamAvailable: bundle.streamAvailable,
            streamModelId: bundle.streamModelId,
            paraformerAvailable: bundle.paraformerAvailable,
            engines: bundle.candidates.map((c) => ({
              id: c.engine.id,
              available: c.available,
              ...(c.unavailableReason ? { reason: c.unavailableReason } : {}),
            })),
            ffmpeg: bundle.tools.ffmpeg || null,
            whisperCli: bundle.tools.whisperCli,
          }
        : null,
    }),
  });

  const outcome = await acquireSingleInstance({
    server,
    dataDir: paths.dataDir,
    ...(opts.port === undefined ? {} : { requestedPort: opts.port }),
    ...(opts.maxPort === undefined ? {} : { maxPort: opts.maxPort }),
    // 自我重启拉起的新进程会带上它：在同一端口上等老进程退干净，绝不顺延
    ...(waitForPortRaw && Number.isFinite(Number(waitForPortRaw))
      ? { waitForPortMs: Number(waitForPortRaw) }
      : {}),
  });

  if (outcome.kind === 'existing') {
    server.close();
    sse.close();
    dirLock.release();
    throw new AlreadyRunningError(outcome.info);
  }
  if (outcome.kind === 'conflict') {
    server.close();
    sse.close();
    dirLock.release();
    throw new StartupConflictError(outcome.reason);
  }

  boundPort = outcome.port;
  const instanceId = outcome.instanceId;
  instanceIdRef = instanceId;

  try {
    // ---- DB：业务 schema 失败 = 启动失败；扩展/索引失败只降级 ----
    database = openAppDatabase({
      filename: paths.dbFile,
      // 扩展目录优先取**已安装的 sqlite-ext 包**的解包位置（ADR-014 ③），
      // 找不到才退回 OPENMEMO_EXT_DIR / <dataDir>/bin/ext
      extensions: defaultExtensionPaths(resolveExtensionDir(paths.modelsDir, paths.extensionsDir)),
      backupDir: paths.backupsDir,
    });

    queue = new JobQueue(database.db, instanceId);
    const recovered = queue.recoverOnStartup();
    if (recovered > 0) {
      console.log(`[daemon] 崩溃恢复：${recovered} 个中断的任务已重新入队`);
    }

    /*
     * 孤儿回收（D-01 §2.7 B）—— 必须在崩溃恢复**之后、调度器启动之前**。
     * 顺序理由：先把上次强杀留下的子进程清掉，再让调度器重新派活，
     * 否则新旧两个 whisper 会同时吃 CPU 抢同一块音频。
     */
    const orphans = await reclaimOrphans(paths.dataDir);
    if (orphans.killed.length > 0) {
      console.log(
        `[daemon] 回收上次强杀残留的子进程 ${orphans.killed.length} 个: ` +
          orphans.killed.map((k) => k.pid).join(', '),
      );
    }

    repos = new Repos(database.db);
    repos.ensureDefaultFolder();
    const mindmaps = new MindMapRepo(database.db);

    bundle = await buildPipeline(paths);

    /**
     * 取当前流水线。**所有消费方都必须走它，不能捕获快照** ——
     * 装完模型/后端包后 `bundle` 会被整体替换，捕获了旧引用的地方会继续用旧工具表。
     */
    const getBundle = (): PipelineBundle => bundle as PipelineBundle;

    /*
     * ★ 热刷新工具表（T-060）★
     *
     * 此前 `buildPipeline()` 只在启动时跑一次，工具与模型路径**固化在启动那一刻**。
     * 后果：用户在网页上把后端包和模型全装好（job succeeded、文件在盘、selfcheck 全 ✔），
     * daemon 仍然认为"缺 whisper-cli / asr-model"，导入的笔记一直卡在 processing，
     * **连 transcribe job 都排不上**；只有重启 daemon 才好。
     * 「全部通过网页完成」在最后一步断掉 —— 让用户去重启 daemon 就等于没做到要求 2.1。
     *
     * 挂在 SSE 事件上而不是各安装点：生产方分散在 models.ts / backends.ts，
     * 集中挂一处不会漏，也不需要改他们的文件。
     */
    let refreshTimer: NodeJS.Timeout | undefined;
    const REFRESH_EVENTS = new Set([
      'model.installed',
      'model.removed',
      'model.activated',
      'backend.installed',
      'backend.removed',
    ]);
    sse.observe((event) => {
      if (!REFRESH_EVENTS.has(event.type)) return;
      // 合并抖动：一次安装会连发多个事件，没必要重建多次
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void (async () => {
          try {
            const before = bundle?.missing.join(',') ?? '';
            const next = await buildPipeline(paths);
            bundle = next;
            const after = next.missing.join(',');
            if (before !== after) {
              console.log(
                `[daemon] 工具表已热刷新: missing [${before || '无'}] → [${after || '无'}]`,
              );
            }
            /*
             * 扩展（libsimple / sqlite-vec）装上后要让检索从 trigram 切回 simple。
             * 扩展是在**打开 DB 的连接上**加载的，没法对已开连接补加载 ——
             * 这里如实提示需要重开连接，而不是假装已经生效。
             */
            /*
             * 缺件而 blocked 的任务要**自动解除阻塞**。
             * 否则用户装完模型，之前那条卡住的导入还是 blocked ——
             * 他得自己找到那条任务点重试，这跟"让他重启 daemon"是同一类毛病。
             */
            if (next.missing.length === 0 && queue_) {
              const unblocked = queue_.listBlocked(['MISSING_ASR_MODEL', 'LLM_NOT_CONFIGURED']);
              for (const j of unblocked) queue_.unblock(j.id);
              if (unblocked.length > 0) {
                console.log(`[daemon] 缺件已补齐，自动解除 ${unblocked.length} 个任务的阻塞`);
              }
            }

            const extDir = resolveExtensionDir(paths.modelsDir, paths.extensionsDir);
            if (extDir !== lastExtDir) {
              lastExtDir = extDir;
              console.log(
                `[daemon] 检测到 SQLite 扩展目录变化 (${extDir})；` +
                  `中文分词将在下次打开数据库连接时生效`,
              );
            }
          } catch (err) {
            console.warn('[daemon] 工具表热刷新失败:', err);
          }
        })();
      }, 800);
      refreshTimer.unref?.();
    });
    if (bundle.missing.length > 0) {
      console.warn(`[daemon] ⚠️  流水线缺少工具: ${bundle.missing.join(', ')} —— 相关任务会转 blocked`);
    }

    // ---- job 处理器注册表 ----
    const handlers = new Map<string, JobHandler>();
    const repos_ = repos;
    const queue_ = queue;
    handlers.set('transcribe', (job, signal) =>
      runTranscribeJob(
        job,
        {
          repos: repos_,
          sse,
          queue: queue_,
          pipelineFor: (lang) => getBundle().pipelineFor(lang),
          modelPath: getBundle().modelPath,
          mediaRoot: paths.mediaDir,
          modelId: getBundle().modelPath?.split('/').pop() ?? 'unknown',
        },
        signal,
      ),
    );

    // F4：思维导图生成（gpu.llm lane —— 与 gpu.asr 通过 gpu.exclusive 互斥）
    const database_ = database;
    handlers.set('mindmap', (job, signal) =>
      runMindmapJob(
        job,
        {
          repos: repos_,
          mindmaps,
          sse,
          queue: queue_,
          resolveProvider: () => resolveConfiguredProvider(database_.db, paths.dataDir),
        },
        signal,
      ),
    );

    scheduler = new Scheduler({ queue, lanes, sse, handlers });
    scheduler.start();

    // 把流水线任务的取消/暂停接到 /api/jobs/:id/*（此前 Scheduler.cancel 零调用方）
    const sched = scheduler;
    setPipelineJobHooks({
      cancel: (uid, hard) => {
        const job = queue_.byUid(uid);
        if (!job) return false;
        sched.cancel(job.id, hard);
        return true;
      },
      pause: (uid) => {
        const job = queue_.byUid(uid);
        if (!job) return false;
        // 在跑的：让 scheduler 按 'pause' 意图中止（停下后置 state='paused'，可 resume）
        if (sched.pause(job.id)) return true;
        // 还在排队的：没有 worker 要停，直接置 paused
        if (job.state === 'queued' || job.state === 'blocked') {
          queue_.pauseQueued(job.id);
          return true;
        }
        return false;
      },
      resume: (uid) => {
        const job = queue_.byUid(uid);
        if (!job) return false;
        queue_.resume(job.id);
        return true;
      },
    });

    // WS 必须在 pipeline 就绪之后挂 —— 录音会话依赖流式引擎
    attachWebSocket(server, {
      sessions,
      port: () => boundPort,
      recorder: {
        repos: repos_,
        queue: queue_,
        sse,
        mediaDir: paths.mediaDir,
        openStream: (req) => getBundle().openStream(req),
        get streamModelId() {
          return getBundle().streamModelId;
        },
      },
    });

    // ---- 路由装配 ----
    routers.push(
      // 硬件探测 / probe 断路器 / 后端自检（@openmemo/runtime 真实实现，非 stub）
      createRuntimeRoutes({ paths }),
      createNoteRoutes({
        repos,
        queue,
        sse,
        get registry() {
          return getBundle().registry;
        },
        // 本地导入允许的根：数据目录 + 显式配置的额外目录
        importRoots: [
          paths.dataDir,
          ...(process.env['OPENMEMO_IMPORT_ROOTS'] ?? '').split(':').filter(Boolean),
        ],
      }),
      createContentRoutes({ db: database.db, repos, mindmaps, queue, sse }),
      // 功能级自检（一份实现两个出口：gpu-runtime 的 CLI + 这个端点）
      createSelfCheckRoutes({
        paths,
        db: database.db,
        extensions: {
          libsimple: database.extensions.libsimple,
          sqliteVec: database.extensions.sqliteVec,
        },
        bundle: () => bundle,
        extensionsDir: resolveExtensionDir(paths.modelsDir, paths.extensionsDir),
      }),
      // 设置 / 密钥（ADR-006 决策 1：明文 0600 + disclosure 显式告知）
      createSettingsRoutes({ db: database.db, secretStore: new SecretStore(paths.dataDir) }),
      // 标签 / 星标 / 文件夹
      createOrganizeRoutes({ repos }),
      // F2 主入口：浏览器拖拽上传（流式落盘，不进内存）
      createUploadRoutes({ repos, queue, sse, uploadDir: paths.mediaDir }),
      createSearchRoutes({
        db: database.db,
        hasChineseTokenizer: database.extensions.libsimple,
        hasVectorIndex: database.extensions.sqliteVec,
      }),
      createMediaRoutes({
        repos,
        mediaRoot: paths.mediaDir,
        extraRoots: [paths.tmpDir, paths.dataDir],
      }),
    );
  } catch (err) {
    server.close();
    sse.close();
    dirLock.release();
    throw err;
  }

  const info: RuntimeInfo = {
    schema: 1,
    app: 'openmemo',
    version: VERSION,
    pid: process.pid,
    instanceId,
    startedAt: new Date().toISOString(),
    host: BIND_HOST,
    port: boundPort,
    token,
    dataDir: paths.dataDir,
  };
  writeRuntimeJson(paths.runtimeJson, info);

  // 端口漂移必须**显式可见**：麦克风授权按 origin 隔离，端口变了要重新授权（ADR-006 决策 2）
  const portWarning = outcome.portDrifted
    ? `端口已从 ${outcome.requestedPort} 变更为 ${boundPort}。` +
      `浏览器会把它当作新站点，**麦克风授权需要重新点一次**（影响录音转文字）。`
    : undefined;
  if (portWarning) console.warn(`[daemon] ⚠️  ${portWarning}`);

  console.log(`[daemon] 就绪 http://${BIND_HOST}:${boundPort}/#t=${token}`);
  console.log(
    `[daemon] db=${database.driver} sqlite=${database.sqliteVersion} ` +
      `schema=v${database.schema.to} tokenizer=${database.extensions.tokenizer} ` +
      `vec=${database.extensions.sqliteVec ? 'on' : 'off'}`,
  );

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await scheduler?.stop();
    sse.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      database?.db.setPragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* 关闭路径上的 checkpoint 失败不阻塞退出 */
    }
    database?.close();
    removeRuntimeJson(paths.runtimeJson);
    dirLock.release();
  };

  const restart = async (reason: string): Promise<void> => {
    console.log(`[daemon] 自我重启（${reason}）…`);
    /*
     * 先拉新进程、确认它没当场死掉，再停自己。
     *
     * 反过来做（先 stop 再 spawn）有个要命的后果：万一新进程起不来，
     * 用户就**一个 daemon 都不剩**了 —— 网页全白，只能去开终端，
     * 比"提示他手动重启"还糟。而自我重启的全部意义就是别让他碰命令行。
     *
     * 新进程起来时端口还被本进程占着，所以它带 OPENMEMO_WAIT_FOR_PORT_MS
     * 在**同一个端口**上等（绝不顺延：端口一变浏览器麦克风授权就没了）。
     * 若本进程最后决定不退，它会探到一个健康的同 dataDir 实例，然后干净地退出。
     */
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        OPENMEMO_WAIT_FOR_PORT_MS: '15000',
        // 接力棒：token + 会话必须跨进程延续，否则浏览器那一页当场被踢
        OPENMEMO_BOOT_TOKEN: token,
        OPENMEMO_SESSIONS: JSON.stringify(sessions.export()),
      },
    });

    // 先不 unref：留一个窗口观察它是不是当场就死
    const bornOk = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean): void => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      child.once('error', () => done(false));
      child.once('exit', () => done(false)); // 这么快就退了 = 起不来
      setTimeout(() => done(true), 1000);
    });

    if (!bornOk) {
      console.error('[daemon] ❌ 新进程没起来，取消重启（本进程继续服务，不让用户失去 daemon）');
      return;
    }
    child.unref();
    console.log(`[daemon] 新进程 pid=${child.pid ?? '?'} 已就位，本进程退出`);

    await stop();
    setTimeout(() => process.exit(0), 50);
  };
  // http 层通过这个 holder 触发重启（handler 早于 restart 定义就挂好了）
  restartHook.run = restart;

  return {
    port: boundPort,
    token,
    instanceId,
    paths,
    database,
    queue,
    lanes,
    sse,
    portDrifted: outcome.portDrifted,
    portWarning,
    stop,
    restart,
  };
}

/** CLI 入口。 */
async function mainCli(): Promise<void> {
  const args = process.argv.slice(2);
  const portArg = args.indexOf('--port');
  const dataArg = args.indexOf('--data-dir');

  try {
    const daemon = await startDaemon({
      ...(portArg >= 0 ? { port: Number(args[portArg + 1]) } : {}),
      ...(dataArg >= 0 ? { dataDir: args[dataArg + 1] } : {}),
    });

    // 优雅退出（D-01 §2.5）。Windows 上 OS 只给约 5 秒，所以宽限期要短。
    const graceMs = process.platform === 'win32' ? 4000 : 15000;
    const shutdown = (signal: string): void => {
      console.log(`[daemon] 收到 ${signal}，开始优雅退出（宽限 ${graceMs}ms）`);
      const hard = setTimeout(() => {
        console.error('[daemon] 优雅退出超时，强制结束');
        process.exit(1);
      }, graceMs);
      hard.unref();
      void daemon.stop().then(() => {
        clearTimeout(hard);
        process.exit(0);
      });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      console.error(`[daemon] ${err.message}`);
      console.error('[daemon] 单实例锁生效：不会启动第二个进程。');
      process.exit(3);
    }
    if (err instanceof DataDirLockedError) {
      console.error(`[daemon] ${err.message}`);
      console.error('[daemon] 数据目录锁生效：不会启动第二个实例。');
      process.exit(5);
    }
    if (err instanceof StartupConflictError) {
      console.error(`[daemon] 启动冲突：${err.message}`);
      process.exit(4);
    }
    console.error('[daemon] 启动失败：', err);
    process.exit(1);
  }
}

// 仅在被直接执行时启动（被 import 时不自启，方便测试）
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void mainCli();
}

export { DEFAULT_PORT };
