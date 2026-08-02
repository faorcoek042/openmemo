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
import { mkdirSync } from 'node:fs';

import { openAppDatabase, defaultExtensionPaths, type AppDatabase } from '@openmemo/db';

import {
  BIND_HOST,
  DEFAULT_PORT,
  acquireSingleInstance,
  createUnboundServer,
  removeRuntimeJson,
  writeRuntimeJson,
  type RuntimeInfo,
} from './bootstrap/single-instance.js';
import { resolvePaths, type AppPaths } from './config/paths.js';
import { SessionStore, generateToken } from './http/auth.js';
import { attachHttpHandlers } from './http/server.js';
import { SseHub } from './http/sse.js';
import { attachWebSocket } from './http/ws.js';
import { JobQueue } from './jobs/queue.js';
import { LanePool } from './jobs/lanes.js';
import { Repos } from './db/repos.js';
import { buildPipeline, type PipelineBundle } from './pipeline/setup.js';
import { Scheduler, type JobHandler } from './jobs/scheduler.js';
import { runTranscribeJob } from './jobs/runners/transcribe.js';
import { createNoteRoutes } from './http/rest/notes.js';
import { createContentRoutes } from './http/rest/content.js';
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

  const token = generateToken();
  const sessions = new SessionStore(token);
  const sse = new SseHub();
  const server = createUnboundServer();

  let boundPort = 0;
  let instanceIdRef = '';
  let repos: Repos | undefined;
  let bundle: PipelineBundle | undefined;
  let scheduler: Scheduler | undefined;
  const routers: RouteModule[] = [];
  let database: AppDatabase | undefined;
  let queue: JobQueue | undefined;
  const lanes = new LanePool();

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
    status: () => ({
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
  });

  if (outcome.kind === 'existing') {
    server.close();
    sse.close();
    throw new AlreadyRunningError(outcome.info);
  }
  if (outcome.kind === 'conflict') {
    server.close();
    sse.close();
    throw new StartupConflictError(outcome.reason);
  }

  boundPort = outcome.port;
  const instanceId = outcome.instanceId;
  instanceIdRef = instanceId;

  try {
    // ---- DB：业务 schema 失败 = 启动失败；扩展/索引失败只降级 ----
    database = openAppDatabase({
      filename: paths.dbFile,
      extensions: defaultExtensionPaths(paths.extensionsDir),
      backupDir: paths.backupsDir,
    });

    queue = new JobQueue(database.db, instanceId);
    const recovered = queue.recoverOnStartup();
    if (recovered > 0) {
      console.log(`[daemon] 崩溃恢复：${recovered} 个中断的任务已重新入队`);
    }

    repos = new Repos(database.db);
    repos.ensureDefaultFolder();
    const mindmaps = new MindMapRepo(database.db);

    bundle = await buildPipeline(paths);
    if (bundle.missing.length > 0) {
      console.warn(`[daemon] ⚠️  流水线缺少工具: ${bundle.missing.join(', ')} —— 相关任务会转 blocked`);
    }

    // ---- job 处理器注册表 ----
    const handlers = new Map<string, JobHandler>();
    const repos_ = repos;
    const bundle_ = bundle;
    const queue_ = queue;
    handlers.set('transcribe', (job, signal) =>
      runTranscribeJob(
        job,
        {
          repos: repos_,
          sse,
          queue: queue_,
          pipeline: bundle_.pipeline,
          modelPath: bundle_.modelPath,
          mediaRoot: paths.mediaDir,
          modelId: bundle_.modelPath ? bundle_.modelPath.split('/').pop() ?? 'unknown' : 'unknown',
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

    // WS 必须在 pipeline 就绪之后挂 —— 录音会话依赖流式引擎
    attachWebSocket(server, {
      sessions,
      port: () => boundPort,
      recorder: {
        repos: repos_,
        queue: queue_,
        sse,
        mediaDir: paths.mediaDir,
        openStream: (req) => bundle_.openStream(req),
        streamModelId: bundle_.streamModelId,
      },
    });

    // ---- 路由装配 ----
    routers.push(
      createNoteRoutes({
        repos,
        queue,
        sse,
        // 本地导入允许的根：数据目录 + 显式配置的额外目录
        importRoots: [
          paths.dataDir,
          ...(process.env['OPENMEMO_IMPORT_ROOTS'] ?? '').split(':').filter(Boolean),
        ],
      }),
      createContentRoutes({ db: database.db, repos, mindmaps, queue, sse }),
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
  };

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
