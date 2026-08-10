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
  boundAddress,
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
import { openFailedHint, openerFor, shouldOpenBrowser } from './bootstrap/open-browser.js';
import { readyBannerLines, readyUrl } from './bootstrap/ready-banner.js';
import { migrateInstallRecords } from './storage/migrateRecords.js';
import { migrateMediaAssets } from './storage/migrateAssets.js';
import { SessionStore, authRequired, loadOrCreateToken, type Session } from './http/auth.js';
import { attachHttpHandlers } from './http/server.js';
import { modelRoutesFor } from './http/rest/models.js';
import { SseHub } from './http/sse.js';
import { attachWebSocket } from './http/ws.js';
import { JobQueue } from './jobs/queue.js';
import type { PipelineJob } from '@openmemo/shared';
import { jobCreatedEvent, jobStateEvent, pipelineJobOf, pipelineKindOf } from './jobs/events.js';
import { LanePool } from './jobs/lanes.js';
import { Repos } from './db/repos.js';
import { buildPipeline, type PipelineBundle } from './pipeline/setup.js';
import { toolRefreshMessage } from './bootstrap/tool-refresh-message.js';
import { resolveExtensionDir } from './pipeline/modelStore.js';
import { vadHealth } from './pipeline/vadStatus.js';
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
import { createLlmRoutes } from './http/rest/llm.js';
import { createUpdateRoutes } from './http/rest/updates.js';
import { resolveBundledWhisperDir, resolveManifestDir } from './http/rest/manifests.js';
import { createMediaRoutes } from './http/media.js';
import type { RouteModule } from './http/server.js';

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
  /** 产品版本号，见 `docs/design/D-12-versioning.md`。来源：根 `package.json` 的 `version`。 */
  readonly version: string;
  readonly commit: string;
  readonly commitTime: string | null;
  readonly dirty: boolean;
  readonly builtAt: string | null;
}

const UNKNOWN_BUILD: BuildInfo = {
  version: 'unknown',
  commit: 'unknown',
  commitTime: null,
  dirty: false,
  builtAt: null,
};

function readBuildInfo(): BuildInfo {
  try {
    // import.meta.url → dist/main.js，同目录下就是 build-info.json
    const p = new URL('./build-info.json', import.meta.url);
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<BuildInfo>;
    return {
      version: typeof raw.version === 'string' ? raw.version : 'unknown',
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

/**
 * 产品版本号 —— 回答的是「**这是第几个可用的东西**」。
 *
 * 它和旁边那三个信号各答各的，谁也替不了谁（这正是它们要同时显示的原因）：
 *
 * | 信号         | 回答的问题           | 为什么别的答不了                       |
 * |--------------|----------------------|----------------------------------------|
 * | `version`    | 第几个可用的东西     | commit 是 hash，比不出大小，也数不出"第几个" |
 * | `commit`     | 跑的是哪一份代码     | 同一个版本号下可以有几十个 commit      |
 * | `commitTime` | 那份代码是什么时候的 | commit 号本身没有时间序                |
 * | `startedAt`  | 到底重启了没有       | 前三个在重启前后一模一样               |
 *
 * ★ 曾经这里是一行 `export const VERSION = '0.1.0'` —— 一个**手写字面量**，
 * 和根 `package.json` 的 `0.0.0` 毫无关系，两个数谁也不知道对方存在。
 * 界面上那个 `v0.1.0` 因此从项目开始就没变过：它不是"忘了改"，
 * 而是**根本没有任何东西会让它改**。现在它由构建从唯一事实来源烘焙进产物，
 * 而 `scripts/check-version-sync.mjs` 守着"不许再有第二个地方写版本号字面量"。
 */
export const VERSION = BUILD_INFO.version;

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
  /*
   * ★ 随包出厂的 CPU 基线运行时：**没设环境变量时自己算出来**（2026-08-08）。
   *
   * 启动脚本会设 `OPENMEMO_BUNDLED_WHISPER_DIR`，但那只覆盖"双击"这一条路。
   * `[CI 实测 run 31263973429]` 直接起 daemon（CI 与开发者都这么跑）时，
   * 包里明明带了 whisper-cli，`pipeline.missing` 里照样有它 ——
   * 与 `vendor/manifests` 那条是同一个病：**能不能用不该取决于你从哪儿启动。**
   * 在这里补一次模块相对的解析，四种启动方式就都成立了。
   * 只在"算得出且真的存在"时设，且**不覆盖**用户/启动脚本已设的值。
   */
  if (!process.env['OPENMEMO_BUNDLED_WHISPER_DIR']) {
    const bundled = resolveBundledWhisperDir();
    if (bundled) process.env['OPENMEMO_BUNDLED_WHISPER_DIR'] = bundled;
  }

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
  /*
   * 实际绑定到的监听地址。**在 `server.address()` 之前先用 BIND_HOST 兜底** ——
   * 那是我们请求绑定的地址，绑定成功后再换成内核实际给的那个（两者只在
   * `localhost` / 主机名这类会解析的输入上才不同）。
   *
   * 绝不能像以前那样在 `/api/health` 里写死 `'127.0.0.1'`：那是**安全结论的输入**，
   * 见 `http/server.ts` 的 `ServerDeps.host`。
   */
  let boundHost = BIND_HOST;
  /*
   * ★ 就绪标志。**默认 false，且只在启动全部走完之后置一次 true。**
   *
   * 与 `boundPort` / `boundHost` 同理必须是可变量 + 取值函数：HTTP handler 必须在
   * 端口绑定**之前**就挂好（否则会有"端口已通但没有 handler"的窗口，
   * 单实例探测正好打 /api/health），而"装完了没有"这件事只有到最后才知道。
   * 详见 http/server.ts 的 `ServerDeps.ready`。
   */
  let isReady = false;
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
  /*
   * ★ 提成 const 而不是内联字面量：`server.ts` 用**这个对象的身份**做记忆化
   *（`modelRoutesFor(deps)` 走 WeakMap），所以想拿到"它已经建好的那份 RestState"，
   * 就必须拿着**同一个对象**去问。换一个等值的新对象 = 建第二份 state = 第二份目录缓存，
   * 而"再造一份缓存"正是本轮明确禁掉的（影子状态）。
   */
  const serverDeps = {
    sessions,
    sse,
    instanceId: () => instanceIdRef,
    version: VERSION,
    // `version` **故意**不进 build：它已经是 health 的顶层字段，
    // 同一份 JSON 里出现两份同名值，读的人迟早会挑错一个。build 只放构建来源。
    build: {
      commit: BUILD_INFO.commit,
      commitTime: BUILD_INFO.commitTime,
      dirty: BUILD_INFO.dirty,
      builtAt: BUILD_INFO.builtAt,
      startedAt: STARTED_AT,
    },
    dataDir: paths.dataDir,
    port: () => boundPort,
    host: () => boundHost,
    routers,
    /*
     * ★ 就绪信号。见 http/server.ts 的 `ServerDeps.ready` ——
     *   它防的是「health 已经答 200，而 routers 还没 push」那段真空。
     *   置位点在下面「就绪」横幅那一行之前，判据是**横幅打印时它必须已经是 true**。
     */
    ready: () => isReady,
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
            /*
             * ★ 必须把**没构造出来**的引擎也列进来（T-160）。
             *
             * 只列 `candidates` 的话，模型没装的引擎在这份列表里根本不存在 ——
             * 前端 `AsrEngineStatus` 会把它补成"未安装"，但**说不出原因、也给不出下一步**。
             * 而真实原因（"未安装流式中文模型，去模型页装 X"）daemon 是知道的。
             * 不说出来，就是把一次可操作的缺失变成一个用户查不下去的哑巴状态。
             */
            engines: [
              ...bundle.candidates.map((c) => ({
                id: c.engine.id,
                available: c.available,
                ...(c.unavailableReason ? { reason: c.unavailableReason } : {}),
              })),
              ...bundle.unavailableEngines.map((e) => ({
                id: e.id,
                available: false,
                reason: e.reasonZh,
              })),
            ],
            ffmpeg: bundle.tools.ffmpeg || null,
            whisperCli: bundle.tools.whisperCli,
            /*
             * 切分方式必须露到界面上（T-148）。
             * VAD 不可用时转写照样完成，只是断句变差 —— 一个用户看不见的降级，
             * 与假绿灯是同一类问题：结果给了，代价没说。
             */
            vad: vadHealth(bundle.vad),
          }
        : null,
    }),
  };
  attachHttpHandlers(server, serverDeps);

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
  boundHost = boundAddress(server) ?? BIND_HOST;
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
      /*
       * ★ 这里**刻意**用 `noteByIdIncludingDeleted` —— 理由不是"历史如此"：
       * **job 的生命期比笔记长。** 用户可以在一条转写/导图 job 还排着队时删掉那条笔记，
       * 而那条 job 仍然在任务中心里。此时标题不该变成空白 ——
       * 一条没有标题的失败任务，用户根本认不出它是哪来的。
       * 本文件另外两处（jobs 列表 / 单条 get）同理。
       *
       * ⚠️ 别"顺手统一"改成过滤版：那会**静默抽掉任务中心的标题**，不会有任何东西报错。
       * `db/repos.softDelete.test.ts` 有一条用例专门钉这个。
       */
      const note = row.note_id === null ? undefined : repos?.noteByIdIncludingDeleted(row.note_id);
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
            const before = [...(bundle?.missing ?? [])];
            const next = await buildPipeline(paths);
            bundle = next;
            const after = [...next.missing];
            if (before.join(',') !== after.join(',')) {
              /*
               * ★ 措辞抽到 `bootstrap/tool-refresh-message.ts`，因为它**被用户读反过**：
               *   原来是 `missing [asr-model] → [无]`，而那个「无」是"缺失列表空了"
               *   ＝好消息 —— 可它被放进了本该列工具名的方括号里，
               *   到底修饰"缺失项"还是"工具"一个字都没交代。
               *   抽成纯函数后，措辞变成可断言的性质（见同目录 .test.ts）。
               */
              console.log(`[daemon] ${toolRefreshMessage(before, after)}`);
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
      /*
       * ★ 这句话是**冷装用户看到的第一行**（它打在就绪横幅之前）。
       *
       * 原文是「⚠️ 流水线缺少工具: … —— 相关任务会转 blocked」。**内容没错**：
       * 冷装之后本来就没有 ffmpeg / whisper-cli / 模型。但对一个刚双击开包的人来说，
       * 它读起来像**"这个软件坏了"** —— 一个警告符号、一串他没见过的名字、
       * 一个他不知道是什么意思的状态词（blocked）。
       *
       * 判据：**「尚未完成的一步」和「出错了」必须区分得开。**
       * 这是本仓"不适用 vs 不支持"那条的同一族 —— 差别不在措辞好不好听，
       * 在于用户据此做出的下一个动作是"去装组件"还是"卸载算了"。
       *
       * 所以改成三件事：① 说清这是正常的；② 说清下一步去哪；③ 说清代价（任务先等着，不丢）。
       * 不降级成 console.log：它确实是"功能还不完整"的状态，只是不该被读成故障。
       */
      /*
       * ★ 两处补强（2026-08-08，冷启动那位提的，Manager 采纳）：
       *
       * ① **内部 id 换成用户认得的词**。`whisper-cli` / `asr-model` 是我们的内部叫法，
       *    用户没有任何办法把它对应到界面上的任何一个按钮。
       * ② **给出体积**。没人知道 `asr-model` 要下几百 MB ——
       *    而**十分钟的静默等待本身就是另一种"没反应"**：用户会以为它卡死了，
       *    然后去点别的、或者直接关掉。说清量级，等待才变成"预期之中"。
       *
       * 体积是**量级提示**，不是精确值：真实大小取决于平台包与用户选的模型
       * （`[实测 2026-08-08 读 vendor/manifests]` ASR 模型 31 MB–4 GB，
       *  media-tools 约 119 MB，whisper 引擎包约 6 MB）。所以这里写区间与约数，
       * **不写一个会烂掉的精确数字**。
       */
      const FRIENDLY: Record<string, string> = {
        ffmpeg: '音视频解码器 ffmpeg（约 119 MB，和 ffprobe 同一个包）',
        ffprobe: '音视频信息读取 ffprobe（与 ffmpeg 同包，不额外下载）',
        'whisper-cli': '语音转文字引擎 whisper.cpp（约 6 MB）',
        'whisper-vad': '语音活动检测 VAD（约 2 MB）',
        'asr-model': '语音识别模型（31 MB–4 GB，取决于你选哪个；小的够用，大的更准）',
        'yt-dlp': '链接下载器 yt-dlp（约 30 MB）',
      };
      const pretty = bundle.missing.map((m) => FRIENDLY[m] ?? m);
      console.warn(
        `[daemon] 还有 ${bundle.missing.length} 个组件没装：\n` +
          pretty.map((p) => `[daemon]    · ${p}`).join('\n') +
          `\n[daemon]    这是首次启动的正常状态，不是出错了。\n` +
          `[daemon]    打开网页后在「设置 → 本机组件」里点安装，装好会自动生效（不用重启）。\n` +
          `[daemon]    下载要花几分钟到十几分钟，期间界面不会卡 —— 转写类任务会先排队等着（blocked），不会丢。`,
      );
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
          dataDir: paths.dataDir,
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
          const note =
            row.note_id === null ? undefined : repos?.noteByIdIncludingDeleted(row.note_id);
          const job = pipelineJobOf(row, note ? { uid: note.uid, title: note.title } : undefined);
          // 认不出类型的（将来可能有别的 job.type）宁可不列，也不给它编一个 kind
          if (job) out.push(job);
        }
        return out;
      },
      get: (uid) => {
        const row = queue_.byUid(uid);
        if (!row) return undefined;
        const note =
          row.note_id === null ? undefined : repos?.noteByIdIncludingDeleted(row.note_id);
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
        dataDir: paths.dataDir,
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
        /*
         * ★★ 搬迁期间必须关库 —— 否则 Windows 上删不掉源目录。
         *
         * `[CI 实测 run 31296921806, windows-2025]` 搬迁本身在 Windows 上是好的
         * （同卷真 rename、跨卷真删源）；卡住的是 `openmemo.db` 还开着：
         * POSIX 允许 unlink 已打开的文件，而 **Windows 的 SQLite 共享模式不含
         * `FILE_SHARE_DELETE`** → 删源必然失败 → 用户每一次搬迁都留下一份
         * 含明文 `secrets.json` 的旧目录。
         *
         * ⚠️ 重开出来的新句柄**只给"搬完迁 media_assets"用**。
         * 本进程里另外 10 处消费方（`Repos` / `JobQueue` / `MindMapRepo` …）
         * 手上的旧句柄已经作废，且它们缓存了 prepared statement ——
         * **只有重启能把它们全部重建**，所以搬迁成功/失败两条路都会请求重启。
         */
        closeDatabase: () => database?.db.close(),
        reopenDatabase: (dataDir) => {
          const reopened = openAppDatabase({
            filename: join(dataDir, 'openmemo.db'),
            extensions: defaultExtensionPaths(extensionRoot),
            backupDir: join(dataDir, 'backups'),
          });
          database = reopened;
          return reopened.db;
        },
        requestRestart: (reason, o) => void restartHook.run?.(reason, o),
      }),
      // 功能级自检（一份实现两个出口：gpu-runtime 的 CLI + 这个端点）
      createSelfCheckRoutes({
        /*
         * ★ 非强制窥视口：目录**已经加载好**才给，没加载好给 null（=「还没读到」）。
         *   走 `serverDeps` 是为了拿到 `server.ts` 已经建好的**同一份** RestState ——
         *   `modelRoutesFor` 按对象身份记忆化，换个等值对象就会建第二份目录缓存。
         *   ⚠️ 它**不触发**加载：那条懒加载是为了不给启动路径加 I/O，
         *      让一个只想"看一眼"的调用方把它拉起来，等于把那条决定悄悄推翻。
         */
        peekBackendCatalog: () => modelRoutesFor(serverDeps).peekBackendCatalog(),
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
      /*
       * 本地 LLM 探测（ADR-003 档 2）+ 模型列表枚举（D-10 #26）。
       *
       * ★ 这两条端点在 T-153 之前**不存在**，而 `detectLocalBackends()` 早就写好了 ——
       *   只在 mindmap runner 与 selfcheck 内部被调用，前端够不着。
       *   后果不是"少一个功能"，是**档 2 在界面上等于没做**：产品自己探得到用户的
       *   Ollama，却要他去手填 IP 和端口。
       */
      createLlmRoutes({
        db: database.db,
        // SecretStore 的根。明文只在 `llm/enumerate.ts` 里存在，不进路由层。
        dataDir: paths.dataDir,
        manifestDir: resolveManifestDir(),
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
      /*
       * 检测更新（D-20 §17）。只读：查"有没有新版本"，不下载、不安装、不改任何本地状态
       * ——`checkForUpdates()`（`@openmemo/downloader`）结构上没有写入能力，见其文件头。
       * `OPENMEMO_CATALOG_UPDATE_URL` 生产里未设时诚实回 `source: 'not-configured'`。
       */
      createUpdateRoutes(),
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
    // 与 /api/health 同一个来源：两条路径都会喂给 AlreadyRunningError 的提示 URL
    host: boundHost,
    port: boundPort,
    token,
    dataDir: paths.dataDir,
  };
  writeRuntimeJson(paths.runtimeJson, info);

  /*
   * ★ 到这里为止，routers 已经 push 完、pipeline / WS / 调度器全部挂好。
   *   在此之前 `/api/health` 一直回 503（`ready:false`），落到 404 的请求回
   *   503 `SERVICE_STARTING` —— 见 http/server.ts 里 `ServerDeps.ready` 的说明。
   *
   *   **置位必须在「就绪」横幅之前**：横幅是打印给用户看的"可以用了"，
   *   两者说的是同一件事，不允许它们不一致。
   */
  isReady = true;

  // 端口漂移必须**显式可见**：麦克风授权按 origin 隔离，端口变了要重新授权（ADR-006 决策 2）
  const portWarning = outcome.portDrifted
    ? `端口已从 ${outcome.requestedPort} 变更为 ${boundPort}。` +
      `浏览器会把它当作新站点，**麦克风授权需要重新点一次**（影响录音转文字）。`
    : undefined;
  if (portWarning) console.warn(`[daemon] ⚠️  ${portWarning}`);

  const scheme = tls ? 'https' : 'http';
  /*
   * ★ 鉴权关着的时候，**那串 token 不该出现在用户眼前**。
   *
   * 用户 2026-08-08 的原话：「怎么还有 token？不是早都删除了这套安全验证流程吗」。
   * 鉴权确实是关的（`auth.ts` 的 `authMode()` 默认 `'none'`，
   * `http/server.ts` 的鉴权闸门整段跳过），但横幅照样把 `#t=<token>` 打出来 ——
   * 它今天**不承担任何作用**，只是让人以为还要过一道验证。
   *
   * 判据：**打印出来的东西必须对应一个真实存在的机制。**
   * 一个不起作用的凭据出现在最显眼的位置，与一句假注释是同一类东西
   * —— 它让读的人对系统建立了错误的模型。
   *
   * ⚠️ `OPENMEMO_AUTH=token` 那条恢复路径**要留着**：开着的时候当然要打，
   *   否则用户拿不到唯一的入口。两个方向都有用例钉着（见 startup-banner.test.ts）。
   *
   * ★★ 另一半：**不是打个 URL 就完事**。双击打开的人面对的是一个控制台窗口，
   *   一个裸 URL 不告诉他该干什么。所以这里给的是**一句他能照着做的话**。
   */
  const bannerInput = {
    scheme,
    host: BIND_HOST,
    port: boundPort,
    token,
    authRequired: authRequired(),
  };
  const openUrl = readyUrl(bannerInput);
  for (const line of readyBannerLines(bannerInput)) console.log(`[daemon] ${line}`);

  /*
   * ★ 双击进来的人没有别的入口 —— 启动器会设 OPENMEMO_OPEN_BROWSER=1，这里替他打开。
   *   默认关；脚本 / CI 直接跑 dist/main.js 因而不受影响。理由见 open-browser.ts。
   *
   *   spawn 留在本文件而不是 open-browser.ts：D-01 §8.4 L1 的白名单恰好 7 个文件
   *   且有守卫测试钉着，不该为了开个浏览器再加一行（详见 open-browser.ts 顶部）。
   *   detached + unref：浏览器的生命周期与 daemon 无关，否则 daemon 会因为
   *   还挂着一个活子进程而迟迟不退出。
   */
  if (shouldOpenBrowser()) {
    const { cmd, args } = openerFor(process.platform, openUrl);
    try {
      const opener = spawn(cmd, args, { stdio: 'ignore', detached: true });
      opener.on('error', () => console.warn(openFailedHint(cmd)));
      opener.unref();
    } catch {
      console.warn(openFailedHint(cmd));
    }
  }

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

  const restart = async (reason: string, opts?: { dataDir?: string }): Promise<void> => {
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
/**
 * **进程级兜底：一个后台 promise 炸了，不许把整个 daemon 带走。**
 *
 * ## 为什么这一条比"修好那个具体的 bug"更重要
 *
 * `[CI 实测 run 31261593715, win32-x64]` 用户点一次「下载模型」，
 * `writeSidecar()` 的 `rename` 撞上 ENOENT，而那个调用挂在
 * `setInterval(() => void persist())` 上 —— 一个 floating promise。
 * Node 默认 `--unhandled-rejections=throw`：**进程直接退出，exit code 1**。
 *
 * > **daemon 一死，页面上每个请求同时失败 —— 那就是用户报的"点按钮完全没反应"。**
 *
 * 具体那两处已经各自修好了（sidecar 的 tmp 命名、download/queue 的 catch）。
 * 但**那只修了已经被发现的那两处**。这个 daemon 是个长活进程，前台是一个网页：
 * 任何一个后台任务的 promise 漏了 catch，代价都是**用户所有页面同时变砖**，
 * 而且现场只留下一行 stack —— 用户既不会看，也读不懂。
 *
 * ## 判据：代价上限 = 那一个任务失败，不是整个进程没了
 *
 * ⚠️ 它**不是**"把错误吞掉"。吞掉会变成本仓最贵的那类故障（静默）。
 * 所以这里**只做一件事：把它吼出来，然后继续服务**。
 * 真正该让用户知道的失败，仍然由各自被 await 的路径冒泡成任务失败 ——
 * 那条路径不受这里影响。
 *
 * ⚠️ `uncaughtException` **刻意不接管**：那一族（同步抛到栈顶）通常意味着状态已经坏了，
 * 继续跑比退出更危险。这里只接 promise 那一族，它的典型成因是"某个后台调用没写 catch"，
 * 而那与进程状态是否可信无关。
 */
function installCrashGuards(): void {
  process.on('unhandledRejection', (reason: unknown) => {
    const e = reason instanceof Error ? reason : new Error(String(reason));
    console.error(
      '[daemon] ⚠️  有一个后台任务的 promise 没有被 catch。**daemon 不会因此退出**，' +
        '但这是个需要修的缺陷，请把下面这段贴给开发者：',
    );
    console.error(`[daemon]     ${e.name}: ${e.message}`);
    if (e.stack) console.error(e.stack);
  });
}

async function mainCli(): Promise<void> {
  installCrashGuards();
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
