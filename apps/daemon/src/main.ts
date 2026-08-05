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
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

import { openAppDatabase, defaultExtensionPaths, type AppDatabase } from '@openmemo/db';
import { materializeSqliteExtensions } from '@openmemo/pipeline';

/** 与 @openmemo/db 的 libSuffix() 一致；只为 restartRequirement 做一次存在性探测。 */
const extSuffix = (): string =>
  process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';

import {
  BIND_HOST,
  DEFAULT_PORT,
  DataDirLockedError,
  acquireDataDirLock,
  acquireSingleInstance,
  createUnboundServer,
  IS_PUBLIC_BIND,
  removeRuntimeJson,
  writeRuntimeJson,
  type RuntimeInfo,
} from './bootstrap/single-instance.js';
import { readDataDirPointer, resolvePaths, type AppPaths } from './config/paths.js';
import { isDirectRun } from './bootstrap/entrypoint.js';
import { reclaimOrphans } from './bootstrap/orphans.js';
import { ensureSelfSignedCert, tlsEnabled } from './bootstrap/tls.js';
import { migrateInstallRecords } from './storage/migrateRecords.js';
import { migrateMediaAssets } from './storage/migrateAssets.js';
import { SessionStore, loadOrCreateToken, type Session } from './http/auth.js';
import { attachHttpHandlers } from './http/server.js';
import { SseHub } from './http/sse.js';
import { attachWebSocket } from './http/ws.js';
import { JobQueue } from './jobs/queue.js';
import type { PipelineJob } from '@openmemo/shared';
import { jobCreatedEvent, jobStateEvent, pipelineJobOf, pipelineKindOf } from './jobs/events.js';
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
import { SecretStore } from '@openmemo/llm/secrets';
import { applyProxyConfig } from '@openmemo/downloader';
import { MindMapRepo } from './db/mindmapRepo.js';
import { runMindmapJob } from './jobs/runners/mindmap.js';
import { resolveConfiguredProvider } from './llm/resolve.js';
import { createSearchRoutes } from './http/rest/search.js';
import { createStorageRoutes } from './http/rest/storage.js';
import { createProxyRoutes, readProxyConfig } from './http/rest/proxy.js';
import { createMediaRoutes } from './http/media.js';
import type { RouteModule } from './http/server.js';

export const VERSION = '0.1.0';

/**
 * 构建来源信息，由 `scripts/gen-build-info.mjs` 在构建时写进 `dist/build-info.json`。
 *
 * **读产物而不是读 git**：git 说的是工作区当前 commit，而我们跑的是上次构建出来的
 * JS —— 提交了没重建，两者就分叉，页面会显示新 commit 却跑着旧代码。版本号一旦
 * 会说谎就比没有更糟，因为用户正是拿它判断"我的改动生效了没有"。
 *
 * 文件缺失（没构建过 / 非 git 检出）时返回 unknown，不抛错也不猜。
 */
export interface BuildInfo {
  readonly commit: string;
  readonly commitTime: string | null;
  readonly dirty: boolean;
  readonly builtAt: string | null;
}

const UNKNOWN_BUILD: BuildInfo = { commit: 'unknown', commitTime: null, dirty: false, builtAt: null };

function readBuildInfo(): BuildInfo {
  try {
    // import.meta.url → dist/main.js，同目录下就是 build-info.json
    const p = new URL('./build-info.json', import.meta.url);
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<BuildInfo>;
    return {
      commit: typeof raw.commit === 'string' ? raw.commit : 'unknown',
      commitTime: typeof raw.commitTime === 'string' ? raw.commitTime : null,
      dirty: raw.dirty === true,
      builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : null,
    };
  } catch {
    return UNKNOWN_BUILD;
  }
}

export const BUILD_INFO: BuildInfo = readBuildInfo();

/** 本进程启动时刻。用户靠它判断"到底重启了没有" —— commit 没变时这是唯一的信号。 */
export const STARTED_AT = new Date().toISOString();

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
  restart(reason: string, opts?: { dataDir?: string }): Promise<void>;
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

  /*
   * ★ 显式旗标覆盖指针时**必须说出来**。
   *
   * 优先级本身是对的（显式 `--data-dir` 该赢），错在**一声不吭**：
   * 用户刚把数据迁到 A，运维用写死的 `--data-dir B` 重启，daemon 就安静地
   * 挂在那个几乎是空壳的 B 上 —— 界面表现为"转写组件缺失 / 中文分词未启用 /
   * 向量未启用"，看起来像产品坏了，实际只是指错了地方。
   * 这类"配置被静默覆盖"的排查成本极高，因为**每一层看起来都正常**。
   */
  const pointerTarget = readDataDirPointer();
  if (pointerTarget && opts.dataDir && resolve(pointerTarget) !== resolve(opts.dataDir)) {
    console.warn(
      `[daemon] ℹ️  指针文件指向 ${pointerTarget}，但命令行 --data-dir 指定了 ${opts.dataDir}，本次使用 ${opts.dataDir}。\n` +
        `[daemon]    若你想用迁移后的位置，去掉 --data-dir 即可（不传时会自动读指针）。`,
    );
  }
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
  /*
   * TLS：只有显式 `OPENMEMO_TLS=self-signed` 才启用。
   * 生成失败**直接抛**，不静默退回明文 —— 用户要 TLS 是为了让录音能用，
   * 悄悄给他明文等于让他以为能用而实际不能（正是这次要消灭的形状）。
   */
  const tls = tlsEnabled()
    ? ensureSelfSignedCert(
        paths.runtimeDir,
        (process.env['OPENMEMO_TLS_HOSTS'] ?? '').split(',').filter(Boolean),
      )
    : undefined;
  const server = createUnboundServer(tls ? { key: tls.key, cert: tls.cert } : undefined);

  let boundPort = 0;
  let instanceIdRef = '';
  let repos: Repos | undefined;
  let bundle: PipelineBundle | undefined;
  let lastExtDir = '';
  // 用 holder 而不是 let：restart 定义在 stop 之后，而 http handler 必须更早挂好
  const restartHook: { run?: (reason: string, o?: { dataDir?: string }) => Promise<void> } = {};
  let scheduler: Scheduler | undefined;
  const routers: RouteModule[] = [];
  let database: AppDatabase | undefined;
  let queue: JobQueue | undefined;
  const lanes = new LanePool();

  /**
   * LLM 是否真的可用（云 provider 或本地模型，任一即可）。
   * **不要在别处重新推断这件事** —— 重新推断就是这次矛盾的来源。
   */
  const llmAvailability = (): {
    configured: boolean;
    providerId: string | null;
    source: 'cloud' | 'local' | null;
    reasonZh: string;
  } => {
    try {
      const pid = database
        ? (JSON.parse(
            (
              database.db
                .prepare<{ value_json: string }>(
                  `SELECT value_json FROM settings WHERE key = 'llm.defaultProviderId'`,
                )
                .get() ?? { value_json: 'null' }
            ).value_json,
          ) as string | null)
        : null;
      if (typeof pid === 'string' && pid.length > 0) {
        return {
          configured: true,
          providerId: pid,
          source: 'cloud',
          reasonZh: `已配置语言模型提供方「${pid}」，思维导图与摘要可用。`,
        };
      }
    } catch {
      /* 读不到就按未配置处理，不猜 */
    }
    return {
      configured: false,
      providerId: null,
      source: null,
      reasonZh: '尚未配置语言模型提供方，思维导图与摘要不可用。请在设置中添加一个。',
    };
  };

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
        // 装完扩展后 startPackInstall 会立刻链进 bin/ext，所以这里看 bin/ext 就够；
        // 链不上（只读等）时才退回按安装记录猜解包位置。
        const ext = defaultExtensionPaths(
          existsSync(join(paths.extensionsDir, `libsimple${extSuffix()}`))
            ? paths.extensionsDir
            : resolveExtensionDir(paths.modelsDir, paths.extensionsDir),
        );
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
    build: { ...BUILD_INFO, startedAt: STARTED_AT },
    dataDir: paths.dataDir,
    port: () => boundPort,
    routers,
    requestRestart: (reason: string, o?: { dataDir?: string }) => {
      // 不 await：让 HTTP 响应先发出去，前端才能显示"正在重启"
      void restartHook.run?.(reason, o);
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
      /*
       * ★ LLM 可用性的**唯一权威**。
       *
       * 此前是"两处各答各的"：`/models` 看**本地模型库**（`model.llm` 有没有装权重），
       * `/settings` 看**已配置的 provider**。于是用户同时看到
       * 「语言模型未选择 · 思维导图不可用」和「当前生效 DeepSeek」——
       * 两边都没读错自己的源，**但它们在用同一句话回答不同的问题**。
       *
       * 真正决定思维导图能不能跑的，是 `resolveConfiguredProvider()` ——
       * 配了云厂商就能跑，本地有没有装权重无关。所以权威口径定在这里，
       * 前端两处都读它，不要各自推断。
       */
      llm: llmAvailability(),
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

  /*
   * ---- 把 <dataDir>/bin/ext 变成"真的有东西"（gpu-runtime, T-093）----
   *
   * ADR-015 改走上游预编译后，libsimple 与 sqlite-vec 各自解包到自己的
   * `by-name/backend/<archive>/` 目录（libsimple 还多嵌一层），**两者永远不在同一个目录**，
   * 而 `defaultExtensionPaths(root)` / `OPENMEMO_EXT_DIR` / 清单里的 `linkInto: "bin/ext"`
   * 全都假设"一个目录装齐"。T-093 冷启动实测：包全部下载校验成功，daemon 仍然
   * `tokenizer=trigram, vec=off` —— 中文双字词搜不到，且没有任何报错（"扩展缺失"是设计好的降级）。
   *
   * 这里在开库前把真实文件链接进那一个目录，让所有人共有的假设成立。失败只降级，不阻断启动。
   */
  let extensionRoot = paths.extensionsDir;
  try {
    const mat = await materializeSqliteExtensions(paths.modelsDir, paths.extensionsDir);
    if (Object.keys(mat.linked).length === 0) {
      // 一个都没链上（只读目录 / 还没装扩展）→ 退回按安装记录猜解包位置的老路径。
      extensionRoot = resolveExtensionDir(paths.modelsDir, paths.extensionsDir);
    }
  } catch {
    extensionRoot = resolveExtensionDir(paths.modelsDir, paths.extensionsDir);
  }

  try {
    // ---- DB：业务 schema 失败 = 启动失败；扩展/索引失败只降级 ----
    database = openAppDatabase({
      filename: paths.dbFile,
      extensions: defaultExtensionPaths(extensionRoot),
      backupDir: paths.backupsDir,
    });

    /*
     * ★ 每个流水线 job 一落库就广播 `job.created`（T-130）。
     *
     * 这是**全局消费方**（右下角 toast 层、任务中心）唯一一次被告知"有这么个任务、它叫什么"。
     * 缺了它，后续的 `job.state` / `job.blocked` 只是一串没有身份的 id，只能被丢掉 ——
     * 于是"没装 ASR 模型 → 导入 → 页面零反馈"。
     *
     * 挂在队列上而不是各入队点：入队点有 5 处且还会增加，漏一处的代价是整条任务在界面上消失，
     * 而且**不会有任何东西报错**。
     */
    queue = new JobQueue(database.db, instanceId, (row) => {
      const note = row.note_id === null ? undefined : repos?.noteById(row.note_id);
      const event = jobCreatedEvent(row, note ? { uid: note.uid, title: note.title } : undefined);
      // 下载类 job 不走这条队列；认不出的类型 `jobCreatedEvent` 返回 undefined，宁可不发也不编。
      if (event) sse.publish(event);
    });
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
              for (const j of unblocked) {
                queue_.unblock(j.id);
                /*
                 * ★ 解除阻塞**必须发事件**（T-130）。
                 * 否则页面上那条「暂时无法继续」会一直挂着：任务其实已经排回队列，
                 * 而用户看到的还是"卡住了"。装完模型之后前端不动，正是他会去重启 daemon 的时刻。
                 * 排在别人后面的任务可能要过很久才轮到，等 `job.state(running)` 来救不及。
                 */
                sse.publish(jobStateEvent(j.uid, 'queued', 'blocked'));
              }
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
          pipelineFor: (lang, override) => getBundle().pipelineFor(lang, override),
          modelsDir: paths.modelsDir,
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
      /*
       * ★ 让流水线任务在 `GET /api/jobs` 里**存在**（T-130）。
       * 在此之前该接口只返回下载队列，一条 blocked 的转写任务在任务中心里查无此人，
       * 而 blocked 提示上的「任务中心」按钮正是指向那里。
       */
      list: (limit) => {
        const out: PipelineJob[] = [];
        for (const row of queue_.list(limit)) {
          const note = row.note_id === null ? undefined : repos?.noteById(row.note_id);
          const job = pipelineJobOf(row, note ? { uid: note.uid, title: note.title } : undefined);
          // 认不出类型的（将来可能有别的 job.type）宁可不列，也不给它编一个 kind
          if (job) out.push(job);
        }
        return out;
      },
      get: (uid) => {
        const row = queue_.byUid(uid);
        if (!row) return undefined;
        const note = row.note_id === null ? undefined : repos?.noteById(row.note_id);
        return pipelineJobOf(row, note ? { uid: note.uid, title: note.title } : undefined);
      },
      retry: (uid) => {
        const row = queue_.byUid(uid);
        if (!row || !pipelineKindOf(row.type)) return false;
        if (!queue_.requeue(row.id)) return false;
        sse.publish(jobStateEvent(row.uid, 'queued', row.state));
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

    /*
     * 启动时把**已保存的**代理配置装上。
     *
     * 不做这一步的话：用户在设置页配好代理（PATCH 里已 applyProxyConfig，当场生效），
     * 但**重启后就悄悄失效了** —— 配置还在设置页显示着，实际请求却不再走代理，
     * 表现为"昨天还能下载，今天又不行了"，且界面上一切正常。
     */
    try {
      applyProxyConfig(readProxyConfig(repos));
    } catch (err) {
      console.warn('[daemon] 代理配置应用失败，按直连继续:', err);
    }

    /*
     * 安装记录迁移（幂等）。
     * 放在这里而不是"读时兼容"：读时兼容会让旧数据永远是旧的，
     * 下次改格式就要兼容两代。迁移一次，之后所有代码只面对一种格式。
     */
    try {
      const mig = await migrateInstallRecords(paths.modelsDir);
      if (mig.migrated > 0) {
        console.log(`[daemon] 安装记录迁移：${mig.migrated}/${mig.scanned} 条已升级为相对路径`);
        for (const n of mig.notes.slice(0, 8)) console.log(`[daemon]    ${n}`);
      }
      // 解析不到的**必须说出来**：记录说"装了"、文件却不在，是典型的假绿灯
      for (const u of mig.unresolved) console.warn(`[daemon] ⚠️  安装记录无法解析：${u}`);

      /*
       * `media_assets` 同样要迁 —— 这条更要命：安装记录坏了顶多重装，
       * **媒体资产坏了就是用户的录音找不回来**。
       * 实测用户库里 4 条有 3 条指向已被删除的旧 dataDir。
       */
      const am = await migrateMediaAssets(database.db, paths.dataDir, paths.mediaDir);
      if (am.migrated > 0) {
        console.log(`[daemon] 媒体资产路径迁移：${am.migrated}/${am.scanned} 条已重新归位`);
        for (const n of am.notes.slice(0, 8)) console.log(`[daemon]    ${n}`);
      }
      for (const u of am.unresolved) console.warn(`[daemon] ⚠️  媒体资产无法解析：${u}`);
    } catch (err) {
      console.warn('[daemon] 安装记录迁移失败（不影响启动）:', err);
    }

    // ---- 路由装配 ----
    // 路由里的回调是延迟执行的，闭包里拿不到 `repos` 的收窄结果（它是 `Repos | undefined`），
    // 所以在这里定一个已收窄的常量，与上面 handlers 用的 `repos_` 同理。
    const reposForRoutes = repos;
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
        /*
         * 本地导入允许的根：数据目录 + 显式配置的额外目录。
         *
         * ★ T-146：分隔符必须用 `path.delimiter`，**不能写死 `':'`**。
         *   Windows 上 `OPENMEMO_IMPORT_ROOTS=C:\media` 按 `':'` 切会变成
         *   `['C', '\media']` —— 两个都不是真实目录，于是"配了额外目录"这件事
         *   静默失效（而且报出来的错会说"路径不在允许的目录内"，指向完全错误的方向）。
         *   Windows 的 PATH 分隔符是 `;`，`path.delimiter` 会给对。
         */
        importRoots: [
          paths.dataDir,
          ...(process.env['OPENMEMO_IMPORT_ROOTS'] ?? '').split(delimiter).filter(Boolean),
        ],
      }),
      createContentRoutes({ db: database.db, repos, mindmaps, queue, sse }),
      // 数据目录：定义 / 修改 / 移动（路径名与 architect 的设置页对齐）
      createStorageRoutes({
        paths,
        db: database.db,
        runningJobs: () => scheduler?.runningCount ?? 0,
        requestRestart: (reason, o) => void restartHook.run?.(reason, o),
      }),
      // 功能级自检（一份实现两个出口：gpu-runtime 的 CLI + 这个端点）
      createSelfCheckRoutes({
        paths,
        db: database.db,
        extensions: {
          libsimple: database.extensions.libsimple,
          sqliteVec: database.extensions.sqliteVec,
        },
        bundle: () => bundle,
        /*
         * 必须是**开库时实际用的那个目录**，不能再算一遍。
         * 各算各的正是 T-093 那个洞的成因；而且 CLI 用的是 `<dataDir>/bin/ext`，
         * 这里若算出别的路径，`ext.jiebaDict` 两边就会不一致 —— 同源校验会当场抓到。
         */
        extensionsDir: extensionRoot,
        proxyConfig: () => readProxyConfig(reposForRoutes),
        // 只把**键名**交出去；SecretStore.list() 返回的是掩码形状，明文永远不出这个边界。
        secretKeys: () => new SecretStore(paths.dataDir).list().map((s) => s.key),
      }),
      // 代理设置（中文网络刚需：不配代理 HF/GitHub 根本连不上）
      createProxyRoutes({ repos }),
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

  const scheme = tls ? 'https' : 'http';
  console.log(`[daemon] 就绪 ${scheme}://${BIND_HOST}:${boundPort}/#t=${token}`);

  /*
   * ★ 非回环 + 明文时**必须显式警告**。
   *
   * 浏览器把 `http://<IP>` 判为**非安全上下文**，于是
   * `navigator.mediaDevices`（录音）和 `navigator.locks`（标签页选主）都是 undefined。
   * F3 录音转文字在这个地址下**根本用不了**，而界面只会说"当前浏览器不支持"——
   * 用户会以为是自己浏览器的问题，功能就这么静默缺失了。
   * 这条警告比 TLS 本身更重要：即使用户不开 TLS，也必须知道自己缺了什么。
   */
  /*
   * 非回环 + 明文：只陈述**后果**，不推销 TLS。
   * 用户明确说过"本地自用别搞那么复杂"，所以这里保留一句事实即可 ——
   * 但这句不能删：否则录音功能就是在用户不知情的情况下静默缺失的。
   */
  if (IS_PUBLIC_BIND && !tls) {
    console.warn(
      `[daemon] ⚠️  此地址下录音功能不可用（浏览器仅将 HTTPS 与 localhost 视为安全上下文，与浏览器版本无关）。`,
    );
  }

  if (tls) {
    console.log(
      `[daemon] TLS 已启用（自签证书）\n` +
        `[daemon]    证书: ${tls.certPath}\n` +
        `[daemon]    私钥: ${tls.keyPath}（0600）\n` +
        `[daemon]    证书内的名字: ${tls.sans.join(', ')}\n` +
        `[daemon]    ⚠️ 自签证书浏览器会拦一次，这是正常的，不是出错了：\n` +
        `[daemon]       点「高级」→「继续前往…（不安全）」即可，之后录音功能就能用了。\n` +
        `[daemon]       若你从 NAT 外部的地址访问（本机网卡上没有那个 IP），\n` +
        `[daemon]       还会多一条"名称不匹配"，同样点继续即可；\n` +
        `[daemon]       想消掉它可设 OPENMEMO_TLS_HOSTS=<你访问用的IP或域名> 后重启。`,
    );
  }
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

  const restart = async (
    reason: string,
    opts?: { dataDir?: string },
  ): Promise<void> => {
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
    /*
     * ⚠️ 搬完数据目录后必须**重写 argv 里的 `--data-dir`**。
     *
     * 自我重启是拿 `process.argv` 原样再跑一遍，而 `--data-dir` 的优先级高于指针文件。
     * 不重写的话，新进程会回到**刚刚被搬空的旧路径**，然后在那里重建一个空目录 ——
     * 用户会看到"笔记全没了"，而数据其实好端端躺在新位置。
     * 这是这次改动里最容易造成"数据看起来丢了"的一条路径。
     */
    /*
     * ★ 重启用哪个 dataDir，由**显式意图**决定，绝不靠"读哪个源"隐式推断。
     *
     * 这里原来是「读全局指针、用它覆盖 argv 的 --data-dir」，而正常启动是
     * 「--data-dir 覆盖指针」—— **两条启动路径对同一个输入给出相反答案**。
     * 后果：用户点一下界面上的「立即重启」，daemon 可能跳到**另一个**数据目录，
     * 表现就是"笔记全没了"，而数据其实好好地在原处。
     * （实测发生过：某实例自我重启后跳进了另一个实例的目录。）
     *
     * 两个场景必须分开，不能合并成一条规则：
     *   · 普通重启（装完扩展要生效）→ **保持当前 dataDir 原样**
     *   · 迁移后重启              → 由调用方**显式**传入新路径
     *
     * 做法：无论哪种，都把最终 dataDir **显式写进 argv**。
     * 这样子进程走的是"显式旗标"这条唯一优先级，与正常启动完全一致，
     * 也不再受"重启这一刻指针恰好是什么"的影响。
     */
    const targetDataDir = opts?.dataDir ?? paths.dataDir;
    const argv = process.argv.slice(1).filter((a, i, arr) => {
      if (a === '--data-dir') return false;
      return !(i > 0 && arr[i - 1] === '--data-dir');
    });
    argv.push('--data-dir', targetDataDir);
    if (targetDataDir !== paths.dataDir) {
      console.log(`[daemon] 重启后切换数据目录：${paths.dataDir} → ${targetDataDir}`);
    }

    const child = spawn(process.execPath, argv, {
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
//
// ★ T-143 ③：这里原来是 `import.meta.url === \`file://${process.argv[1]}\`` ——
// 手拼 URL 而不是转换 URL。路径里只要有空格 / 中文 / `#` / `?` / `%`，
// 或者入口是经由一条软链调用的，就永不匹配 → **进程静默退出 0，什么都不启动**。
// 判据与证据全在 `bootstrap/entrypoint.ts` 的文件头，那里也是它唯一能被测试执行的地方。
if (isDirectRun(import.meta.url, process.argv[1])) {
  void mainCli();
}

export { DEFAULT_PORT };
