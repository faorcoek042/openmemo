/**
 * GPU/推理后端包 REST（`/api/backends**`）。
 *
 * ADR-003 决策 6：后端包与模型权重**共用同一个下载器** —— 同样的 SHA-256 校验、
 * 断点续传、镜像切换、GC。这里的差异只有两处：manifest 来源不同、落在 store 的
 * `backend` 命名空间下。
 *
 * ★ 诚实边界：**本文件写下的** `selfTest` 恒为 `null`（= 从未运行），绝不写 `passed: true`。
 * ADR-003 决策 3 要求自检必须跑**真实推理**（内嵌音频），那需要引擎二进制；
 * 没跑就报 null，永远不假装通过。
 *
 * ⚠️ 订正（T-166）：这句原文是「`selfTest` 恒为 `null`」，**已经不成立**——
 * `http/rest/hardware.ts` 的 `recordSelfTest()` 会在自检真跑完之后写回它
 * （在那之前它确实全仓只有下面那一句 `selfTest: null` 在写，三条 UI 分支永不亮）。
 * 边界仍然在，只是范围缩小了：**安装这条路上永不写非 null**。
 * 重装/升级时这里照旧写回 `null` 是**刻意的** —— 二进制换了，旧的自检结论就作废了，
 * 留着它等于用上一个版本的证据替这一个版本作证。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { install, isInsideRoot, toPortableRecord } from '@openmemo/downloader';
import * as path from 'node:path';

import { discoverTools, materializeSqliteExtensions } from '@openmemo/pipeline';
import { isBundledRuntimePath, isPackApplicable } from '@openmemo/runtime';
import {
  BACKENDS,
  makeEvent,
  topics,
  type Backend,
  type BackendPack,
  type DownloadJob,
  type GetBackendCatalogResponse,
  type GetInstalledBackendsResponse,
  type InapplicableKind,
  type InstalledBackendPack,
  type PlatformSelector,
} from '@openmemo/shared';

import {
  warmProbeCache,
  type WarmProbeCacheOptions,
  type WarmProbeCacheResult,
} from '../../runtime/warmup.js';
import { sendError, sendJson } from '../respond.js';
import { currentArch, inferDataDir } from './hardware.js';
import { toPullResponse } from './jobs.js';
import { asString, decodePathSegment, readBody } from './request.js';
import type { RestState } from './state.js';

/** 本机的 os/arch。**导出**：`backendReconcile.ts` 必须用同一份判定，不另写一个。 */
export function currentPlatform(): PlatformSelector {
  return {
    os: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    arch: currentArch(),
  };
}

/** 这个包能不能装在本机：os/arch 对得上，且对应后端**真的枚举到了设备**。 */
/**
 * 适用性判定 —— 策略在 `@openmemo/runtime`，这里只做调用（ADR-014 决策 2）。
 *
 * 原实现要求 `hardware.backends[].available`，而该标志来自 probe，
 * **probe 可执行文件本身装在后端包里** → 干净机器上装不了任何包（T-044 实测：
 * 4 个 linux/x64 包全部 409）。现在 L1（CPU / macOS Metal）无条件可装，
 * L2 加速包维持 probe gate。
 *
 * ★ T-160：ADR-014 只把死锁**挪**了一格，没解开 —— `available` 要求 probe 枚举到该
 * 后端的设备，而 probe 只枚举**其 ggml 库已经装了**的后端，那个库就在包里。
 * 于是"没装"成了"不该装"的理由。解法是把 `state.advisoryBackends`（nvidia-smi /
 * sysfs / DXGI 探到的、**不依赖任何包**的证据）也交给策略函数 ——
 * 少传这个参数，死锁就原样还在，所以它不是可选的锦上添花。
 */
function applicability(
  state: RestState,
  pack: BackendPack,
): { applicable: boolean; reason: string | null; kind: InapplicableKind } {
  const platform = currentPlatform();
  const r = isPackApplicable(
    { id: pack.id, backend: pack.backend, os: pack.os, arch: pack.arch },
    platform,
    state.hardware,
    state.advisoryBackends,
  );
  return { applicable: r.applicable, reason: r.reason, kind: inapplicableKind(state, pack, r) };
}

/**
 * 「不可用」的三种含义 —— 定义**已搬到 `@openmemo/shared`**（T-165）。
 *
 * 搬家的理由不是整洁：它住在这里的时候，daemon 一直真的把这个字段发出去，
 * 而契约类型里没有它 ⇒ 前端拿到的 `pack` 上**根本不存在这个属性**，
 * 于是"精心区分了三档"与"界面零消费"可以长期共存，编译器一个字都不会说。
 * 现在发送方与接收方共用同一个类型，那条线才有人守。
 * 这里保留再导出，避免既有 import 断掉。
 */
export type { InapplicableKind };

function inapplicableKind(
  state: RestState,
  pack: BackendPack,
  r: { applicable: boolean; reason: string | null },
): InapplicableKind {
  if (r.applicable) return 'applicable';
  const platform = currentPlatform();
  if (pack.os !== platform.os || pack.arch !== platform.arch) return 'platform';

  const status = state.hardware.backends.find((b) => b.id === pack.backend);
  /*
   * ★★ #105 ②：判据是 **`probed`，只是 `probed`** —— 不再要求"而且它已经装了"。
   *
   * ── 现场（闸门 2026-08-12，真浏览器，同一屏，两句都在视口内）──────────────────
   *   · 硬件卡：「**还没查过** —— 这轮没有加载任何能枚举显卡的后端」
   *   · 折叠区 Vulkan（linux/x64）：芯片「本机不支持」+「**已经探测过了**：
   *     这台机器上没有这个后端可用的设备。」
   * 同一次探测，两句互相打脸。
   *
   * ── 为什么是这一行 ────────────────────────────────────────────────────────────
   * 上一版多了 `status.installed === true &&` 这半句。于是 **包没装** 的路径绕过了
   * 结构判据，落到下面那条正则上；而没装时 `manager.ts` 给的理由是
   * `backend package not installed`（`kind: 'not_installed'`）——**它不含 `probe` 这个词**，
   * 正则不命中 ⇒ 一路掉到 `return 'unsupported'`。
   *
   * 可"包没装"恰恰是**最不可能测出结论的**那一档：probe 只能枚举**其 ggml 库已经在
   * 扫描目录里**的后端（`applicability.ts` 文件头的 T-160 那一段写的就是这件事），
   * 库就在包里。**没装 ⇒ 没有库 ⇒ 什么都没枚举**，这是"没测过"的教科书定义，
   * 而我们把它说成了"测过了，你的机器不支持"。
   *
   * `applicability.ts:247` 那段注释早就把话说全了 ——
   * > `probed === false` is exactly "no verdict exists", which is the same epistemic
   * > state as "not installed" and must break the cycle the same way.
   * 那里已经这么做了（环打破器读的就是 `installed !== true || probed !== true`），
   * **只有这里还留着 `installed &&` 那半句**。现在两处对齐。
   *
   * ── 它同时把「同屏两句话」钉成了一条结构蕴含 ──────────────────────────────────
   * `HardwareCard.gpuEnumerationHappened()` 说"查过了"的条件是
   * 「**某个能枚举显卡的后端** `probed === true`」。而 vulkan/cuda/rocm/metal
   * 都在那张 `BACKEND_CAN_ENUMERATE_GPU` 表里为 `true`。于是：
   *
   *   这里说 `unsupported` ⟹ 该后端 `probed === true` ⟹ 硬件卡不可能说「还没查过」。
   *
   * **两句话现在真的来自同一次探测的同一个字段**，不是两处各自"看起来对"。
   *
   * ⚠️ 正则那一行**删掉了，不是忘了**：probe 没跑成时 `manager.ts` 给每个后端写的
   * `probed` 都是 false，上面这一行必然先命中 —— 它已经不可达。留着一条永远不会
   * 触发的字符串嗅探，比没有更坏（它看起来像还有人在守，其实没有）。
   */
  if (status?.probed !== true) return 'undetermined';
  return 'unsupported';
}

/**
 * 目录条目 → 安装记录。
 *
 * ── 为什么它是一个**导出的纯函数**，而不是留在 `startPackInstall` 里 ────────────────
 *
 * 因为它抄的东西里有一条是有人依赖的：`priority`。
 *
 * 做"跑哪个包"这个决定的是 `findInBackendPacks()`（`packages/pipeline`），而它
 * **只看得见 `<storeRoot>`**，看不见 `vendor/manifests/backends.json`。
 * 于是 `priority` 在目录里有 11 条声明、**零个读取方**，而它的文档写着
 * "Higher wins when several packs match the same hardware" —— 不抄进安装记录，
 * 那句话就永远只是一句话（T-162）。
 *
 * ⚠️ **「零个读取方」是 T-162 之前的状态，今天已不成立。** 现在有两个真实读取方：
 *    `packages/pipeline/src/tools.ts` 的 `rankOf()`（读安装记录里这份拷贝，决定跑哪个包）
 *    与 `apps/web/.../RuntimePage.tsx` 的展示排序（读目录里那份）。
 *    加这一句是因为**这段话已经被一轮审计当成现状引用过一次** —— 差点据此把 `priority` 裁掉。
 *
 * 留在 `startPackInstall` 的闭包里就只能靠"真的装一次"才测得到，而那需要网络；
 * 抽出来之后可以拿**真实目录**里的每一条去断言"抄全了"。
 */
/**
 * ★★ T-107 ①：一个文件路径 → **可移植记录**，库外的文件则一个路径字段都不写。
 *
 * 这是这一轮的治本点，理由在 `InstalledBackendPack.files` 的注释里写全了。
 * 一句话：上一版无条件抄绝对 `path`，于是「随应用出厂那份」有办法把
 * `<安装目录>/runtime/probe/ffmpeg` 写进安装记录，而删除路径照着它 `fs.rm`。
 *
 * ⚠️ 这里**不看 `pack.source`、不看 id**，判据是**结构性的**：路径在不在库里。
 * 按 `source === 'bundled'` 分叉等于把同一条规则写第二遍，而写第二遍的那两份
 * 迟早会不一致 —— 本轮的启动迁移就是这么绕过守卫的（见 `migrateRecords.ts`）。
 * 结构判据顺带覆盖了**将来任何**把库外路径塞进记录的新写法，不只今天这一个。
 */
function toRecordFile(
  f: { name: string; sha256: string; sizeBytes: number; path: string },
  modelsRoot: string,
): InstalledBackendPack['files'][number] {
  const base = { name: f.name, sha256: f.sha256, sizeBytes: f.sizeBytes };
  if (!isInsideRoot(modelsRoot, f.path)) return base;
  return { ...base, ...toPortableRecord(f.path, modelsRoot) };
}

export function toInstalledRecord(
  pack: BackendPack,
  files: readonly { name: string; sha256: string; sizeBytes: number; path: string }[],
  opts: { modelsRoot: string },
): InstalledBackendPack {
  return {
    schemaVersion: 1,
    id: pack.id,
    engine: pack.engine,
    engineVersion: pack.engineVersion,
    backend: pack.backend,
    installedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    integrity: 'ok',
    priority: pack.priority,
    ...(pack.linkInto ? { linkInto: pack.linkInto } : {}),
    files: files.map((f) => toRecordFile(f, opts.modelsRoot)),
    // ★ 从未运行 ≠ 通过。需要真实推理自检才能填，见文件头注释。
    selfTest: null,
  };
}

/**
 * 把一个后端包排进下载队列。
 *
 * 也被 `POST /api/models/pull`（`kind: "backend-pack"`）复用 —— 契约里 PullRequest
 * 明确允许用同一个入口拉后端包。
 */
/**
 * 可注入的接缝。**只有引擎可以被顶替**，路由/落盘/事件全是产品自己的路径 ——
 * 与 `RuntimeRoutesDeps.runSelfTest`（hardware.ts:111）同一条边界、同一个理由：
 * 「捂热失败不许让装包失败」这条**必须能被测到**，而它在没有 Mac 的机器上无法自然发生。
 */
export interface StartPackInstallDeps {
  readonly warmProbeCache?: (options: WarmProbeCacheOptions) => Promise<WarmProbeCacheResult>;
}

export function startPackInstall(
  state: RestState,
  pack: BackendPack,
  deps: StartPackInstallDeps = {},
): { job: DownloadJob; deduplicated: boolean } {
  const platform = currentPlatform();
  const { job, deduplicated } = state.queue.enqueue(
    {
      kind: 'backend-pack',
      targetId: pack.id,
      displayName: pack.displayNameZh,
      totalBytes: pack.totalSizeBytes,
    },
    async (ctx) => {
      ctx.setStep('resolving');
      // T-198：把取消信号带进探测 —— 否则 resolving 期间点取消是空操作
      const probes = await state.probeMirrors(pack.files[0].mirrors, ctx.signal);

      /*
       * ⚠️ **这里刻意不把清单里的目录字段传给安装器的 `unpackInto`。** 不是遗漏，是查过之后的决定。
       * 谁要"顺手接上"，先读完这两条：
       *
       * 1. **两份清单里的目录字段根本不是同一个概念**（正因如此，字段已按下述结论分家：
       *    后端包不再有该字段，sqlite-ext 的改叫 `linkInto`）。
       *    `backends.json` 填的是 `whispercpp/v1.9.1/cpu` 这种
       *    ——「引擎运行时目录」布局；而安装器 `unpackInto` 的语义是「相对 dataRoot 解压到此」。
       *    照传下去，包会落到 `<dataDir>/whispercpp/v1.9.1/cpu`，
       *    而 `findInBackendPacks` 扫的是 `by-name/` —— **刚验证通过的 ffmpeg 发现会当场失效**。
       *
       * 2. **sqlite-ext 那 11 个包全都填同一个目录 `bin/ext`（现名 `linkInto`）**，
       *    而安装器为了保证原子性会 `fs.rm(finalDir, {recursive:true})` 再 rename。
       *    于是装完 libsimple 再装 sqlite-vec，**第二个会把第一个整个删掉** ——
       *    把一个能用的环境变成坏的，而且没有任何报错。
       *
       * sqlite 扩展落到 `bin/ext` 由下面的 `materializeSqliteExtensions` 完成：
       * 它是**往目录里补文件**，不是替换整个目录，所以多个包可以共存。
       *
       * → 结论：这个字段在当前语义下**无法被安装器兑现**，已请 `model-mgmt` 改名或删除。
       *   在那之前保持不传，并用这段注释挡住"看起来像漏了"的误修。
       */
      const result = await install({
        store: state.store,
        target: { id: pack.id, kind: 'backend', displayName: pack.displayName, files: pack.files },
        probes,
        platform,
        pinnedProvider: state.prefs.sourceProvider,
        signal: ctx.signal,
        maxParts: 4,
        onProgress: (p) => {
          ctx.setProvider(p.provider);
          ctx.setFile(p.currentFile, p.fileIndex, p.fileCount);
          /*
           * `unpacking` 与其余三档一样是**实际正在发生的事** —— 解包期间不报它，
           * 界面就会停在上一档 `verifying`，而那句话是不实的（用户已因此误报过原因）。
           */
          if (
            p.phase === 'downloading' ||
            p.phase === 'resolving' ||
            p.phase === 'verifying' ||
            p.phase === 'unpacking'
          ) {
            ctx.setStep(p.phase);
          }
          ctx.progress({
            completedBytes: p.completedBytes,
            totalBytes: p.totalBytes,
            speedBps: p.speedBps,
            etaSeconds: p.etaSeconds,
          });
        },
      });

      ctx.setStep('installing');
      const record = toInstalledRecord(pack, result.files, { modelsRoot: state.store.root });
      // blob 先落、manifest 最后写：中途崩溃只会留下可回收的孤儿 blob，
      // 绝不会留下指向不存在文件的 manifest。
      await state.store.writeManifest('backend', pack.id, record);

      /*
       * sqlite 扩展：解包位置是 `by-name/backend/<archive>/…`，但 db / OPENMEMO_EXT_DIR /
       * 清单的 `linkInto` 都只认 `<dataDir>/bin/ext` 这一个目录。装完立刻链过去，
       * 否则 `restartRequirement` 看不到"磁盘上已有扩展"，用户永远等不到那句"需重启生效"
       * —— 这正是 T-093 冷启动实测到的：包装完了，中文搜索还是不工作且无人报错。
       */
      if (pack.engine === 'sqlite-ext') {
        await materializeSqliteExtensions(state.modelsRoot, state.extensionsDir).catch(
          (err: unknown) => {
            /*
             * 不静默吞：链接失败的后果是**包显示已安装、扩展却永远不生效**，
             * 且 `restartRequirement` 也看不到磁盘上的扩展 → 连"需重启生效"都不会提示。
             * 那正是 T-093 那个"装好了但中文搜不到、零报错"的形状。
             * 安装本身已经成功，所以这里不改变返回结果，但**必须留下痕迹**。
             */
            console.warn(
              `[backends] sqlite 扩展链接到 ${state.extensionsDir} 失败：${String(err)} —— ` +
                `包已装好，但中文分词/向量检索不会生效，且不会提示"需重启"`,
            );
          },
        );
      }

      /*
       * ★ T-172：装完立刻把 GPU 着色器缓存捂热（只在 macOS，见 runtime/warmup.ts 文件头）。
       *
       * 为什么放在这里：macOS 上第一次触碰 Metal 要 16 s 上下（实测区间 16–21 s，n=2，
       * 真机 UNKNOWN），而 `PROBE_TIMEOUT_MS` 是 ADR-003 定死的 10 s ——
       * 冷机器上首次硬件探测**必然超时**，而且两次超时就会把断路器打开、
       * 把 metal **永久**拉黑（指纹变化只给一次重试，不是复位）。
       * 装包这里进度条本来就在转、用户已经在等，把这一发挪到这里，
       * 用户就从不在交互路径上付那 16 s，10 s 这个诊断阈值也保住了。
       *
       * ★★ **两层保护，且都不是装饰**：
       *   ① `warmProbeCache()` 契约上永不抛（自己全包 try/catch，warmup.test.ts 六组敌对输入钉着）；
       *   ② 这里再套一层 try/catch。
       * 因为 `DownloadQueue.run()` 是 `await entry.task(ctx)` 外面套 try/catch
       * （queue.ts:201），**任务里任何一处抛出都会把整个 job 判失败** ——
       * 而捂热是优化、不是安装的前提。这条比"捂热成功"重要得多。
       */
      try {
        const warm = await (deps.warmProbeCache ?? warmProbeCache)({
          dataDir: inferDataDir(state.modelsRoot),
          modelsDir: state.modelsRoot,
          onBeforeProbe: () => {
            ctx.setStep('warming');
            /*
             * `ctx.setStep()` 自己**不发任何 SSE**（queue.ts:186 只改字段 + updatedAt）。
             * 不补这一发 `progress`，这一步在前端就是隐形的 —— 而它要转十几秒，
             * 用户看到的就是"进度条卡在 100% 不动"。
             */
            ctx.progress({
              completedBytes: result.totalBytes,
              totalBytes: result.totalBytes,
              speedBps: 0,
              etaSeconds: null,
            });
          },
          log: (message) => {
            console.info(`[backends] ${message}`);
          },
        });
        if (warm.attempted && !warm.ok) {
          console.warn(`[backends] ${warm.detail}`);
        }
      } catch (err) {
        console.warn(
          `[backends] GPU 着色器缓存预热抛了异常：${String(err)} —— ` +
            `包已装好，安装结果不受影响（捂热是优化，不是前提）`,
        );
      }

      state.publish(
        makeEvent('backend.installed', topics.backends(), {
          packId: pack.id,
          backend: pack.backend,
          selfTestPassed: null,
        }),
      );
      await state.emitStorageChanged();
    },
  );
  return { job, deduplicated };
}

export async function handleBackendRoutes(
  state: RestState,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
): Promise<boolean> {
  /*
   * ★★ 回答"这台机器上有什么"之前，**先让硬件快照跟上现实**。
   *
   * 这一行修的是要求 2.1 主路径上的一个死胡同（`[CI 实测 run 31250730491]`，三平台全中）：
   *
   *   用户在网页上装完加速后端 → 点"启用" → **409「backend package not installed」**
   *   —— 而那个包就是他上一步刚装的，`/api/backends/installed` 里明明有它。
   *
   * 成因是 `state.hardware` 是 `RestState.create()` 那一刻的快照，装包不会刷新它，
   * 于是 `backends[].installed` 恒为 false，`select` 的闸门据此拒绝。
   * 同一份陈旧快照还让目录在装完 CPU 基础包之后继续说「请先安装 CPU 基础包」。
   *
   * 放在**入口**而不是逐个端点里，是因为这里的每一条路
   * （catalog 的 applicable / install 的闸门 / select 的闸门）读的都是它 ——
   * 逐个补是第 N 次修症状，而本轮已经看到"只在 install 后面补"漏掉了卸载与切换。
   * `freshHardware()` 靠指纹判断要不要真探测，没变化时是一次 readdir，不会拖慢请求。
   */
  await state.freshHardware();

  /* ---------------------- GET /api/backends/catalog ---------------------- */
  if (pathname === '/api/backends/catalog') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    const installedRecords = await state.listInstalledBackends();
    const installedIds = new Set(installedRecords.map((p) => p.id));

    /*
     * ★★ T-197：**没有安装记录，但这个包该提供的东西正被用着** —— 第三态。
     *
     * `[实测 :10000]` `/runtime` 对**正在被使用的** ffmpeg 显示「安装 119 MB」。
     * 同一时刻 `tool.ffmpeg` 是绿的、流水线正拿它转码 —— 盘上是 **7.1.5**、
     * 目录已升到 **8.1.2**：**归档文件名都不同**，对账按目录声明的名字去 stat，
     * 连痕迹都找不到（`sawSomething` 恒 false），所以它既不在 `installed` 里、
     * **也不在对账的 skipped 里** —— 对账那一侧根本没有这半句话可说。
     *
     * 所以证据只能来自**解析器**：`discoverTools()` 是流水线装配时调的同一个函数，
     * 它现在把 ffmpeg 解析到哪儿，哪儿就是用户实际在用的那份。
     * 如果那个路径**不在任何安装记录认领的范围内**（`claimedInstallPaths()`，
     * 与 `findUnclaimedFiles()` 共用同一份"认领"定义，不另写一份），
     * 那就是"有一份没人记录的副本正在服役"。
     *
     * ⚠️ 只对 `installed === false` 的包算 —— 已有记录的包本来就该由记录说话。
     * ⚠️ 代价：一次 `discoverTools()`（几次 fs 查表，不 spawn、不读内容），
     *    目录接口不是热路径。**不做 `du`**。
     */
    const notInstalled = state.backendCatalog.packs.some(
      (p) => !installedIds.has(p.id) && (p.providesFiles ?? []).length > 0,
    );
    let servedFromUnrecorded = new Map<string, { file: string; path: string }>();
    /**
     * 「系统里已经有一份」——**借宿主 PATH 的**那一档（#87 / 轴1③）。
     *
     * 与上面那一格**分开两个 Map**：一个是"我们 store 里没登记的副本"，
     * 一个是"根本不是我们的东西"。合成一个就又把两种状态说成同一种了。
     */
    let servedFromSystemPath = new Map<string, { file: string; path: string }>();
    if (notInstalled) {
      try {
        const tools = await discoverTools({ storeRoot: state.modelsRoot });
        const claimed = await state.claimedInstallPaths();
        /** 现在真的解析到的路径，按 basename 索引。 */
        const live = new Map<string, string>();
        /** 借宿主 PATH 的那些，按 basename 索引。 */
        const onSystemPath = new Map<string, string>();
        const storeRoot = state.modelsRoot.endsWith(path.sep)
          ? state.modelsRoot
          : state.modelsRoot + path.sep;
        for (const v of Object.values(tools)) {
          if (typeof v !== 'string' || v.length === 0) continue;
          /*
           * ★ 只认**落在我们自己 store 里**的那些。
           *
           * ⚠️ 这一条是被用例逼出来的：`discoverTools()` 也会从**系统 PATH** 解析
           * （`[实测]` 它在这台机器上把 ffprobe 解析到 `/usr/bin/ffprobe`）。
           * 把那个报成"盘上有一份没人记录的副本"是**说错了一件事的性质** ——
           * 那是「借宿主 PATH 的」，与「我们 store 里有一份没登记的」是两种状态，
           * 而本仓专门修过"把借来的说成自家的 / 把自家的说成借来的"那一族
           * （`bundledRuntime.ts` 的表里就记着这条）。借 PATH 那一格由自检负责说。
           */
          if (!v.startsWith(storeRoot)) {
            /*
             * ★ #87：落在 store 之外的分两种，**不能一起丢掉**。
             *   · 包内自带（`runtime/probe/`）—— 那是**我们的**，由 bundled 那条路认领；
             *   · 其余 ⇒ 借宿主 PATH 的那一份。它就是"用户自己 brew install 了一个"
             *     的证据，而目录此刻正准备请他再下一遍 145 MB。
             * 判据是结构性的（路径落在哪儿），与 `selfcheck.ts` 同源 ——
             * 解析器把命中的档位丢掉了，所以不去问它要"档位"。
             */
            if (!isBundledRuntimePath(v)) onSystemPath.set(path.basename(v), v);
            continue;
          }
          // 落在已认领范围内的不算"没人记录的副本"
          if ([...claimed].some((c) => v === c || v.startsWith(c + path.sep))) continue;
          live.set(path.basename(v), v);
        }
        for (const p of state.backendCatalog.packs) {
          if (installedIds.has(p.id)) continue;
          for (const name of p.providesFiles ?? []) {
            const hit = live.get(name);
            if (hit !== undefined) {
              servedFromUnrecorded.set(p.id, { file: name, path: hit });
              break;
            }
          }
          for (const name of p.providesFiles ?? []) {
            const hit = onSystemPath.get(name);
            if (hit !== undefined) {
              servedFromSystemPath.set(p.id, { file: name, path: hit });
              break;
            }
          }
        }
      } catch {
        /*
         * 解析器失败 ⇒ **什么都不说**（这一格保持缺失）。
         * 「我问不出来」不等于「没有别处的副本」—— 与 `hw.probe` 对探针缺失、
         * `check-elf-glibc` 对 objdump 缺失同源。
         */
        servedFromUnrecorded = new Map();
        servedFromSystemPath = new Map();
      }
    }
    /**
     * 「装的是不是目录里现在这一版」——按**内容**（sha256 集合）算，不是按 id。
     *
     * `[用户真机实测 2026-08-09]` 这一格此前不存在，后果是：T-167 把
     * `whispercpp-cpu-linux-x64` 从上游归档换成我们自建的那一份（多了
     * `openmemo-probe`）之后，08-02 装过它的机器上 `installed` 恒为 true，
     * 界面上没有任何地方说它是旧的，而硬件探测整条链是死的（六个后端全不可用）。
     *
     * 判据取 sha256 的**集合**而不是拼接串：同一个包里文件的顺序不该影响结论。
     * 任一侧缺 sha256（老记录 / 目录里没写）⇒ **不下结论**（返回 false），
     * 因为"我比不了"不等于"它是旧的" —— 报一句假的"有更新"会把用户推去做
     * 一次没有必要的下载，那是另一种谎。
     */
    const shaSetOf = (files: readonly { sha256?: string }[] | undefined): string =>
      [...new Set((files ?? []).map((f) => f.sha256 ?? ''))].sort().join(',');
    const installedShaById = new Map(installedRecords.map((p) => [p.id, shaSetOf(p.files)]));
    /**
     * 随应用出厂 ⇒ **卸不掉**（`DELETE` 会 409 `BUNDLED_NOT_REMOVABLE`）。
     *
     * 发这一格是为了让卡片**在按下之前**就把按钮灰掉并说出理由，
     * 而不是让用户点完确认框才收到一句拒绝。规则的权威留在这一侧
     * （真正执行 `fs.rm` 的是 daemon），前端只读结论 —— 送 `source` 过去
     * 等于请前端再实现一遍同一条规则，两处必然漂移。
     */
    const bundledIds = new Set(
      installedRecords.filter((p) => p.source === 'bundled').map((p) => p.id),
    );
    /**
     * ★ T-193 ③：**机器上那一份**的版本与体积，与目录里的那份分开发。
     *
     * `updateAvailable` 只回答了"要不要动"，没回答"我现在手里是哪一份"——
     * 而卡片副标题渲染的一直是目录的 `engineVersion`，于是屏幕上会出现
     * 「已安装 · ffmpeg n8.1.2 · 112 MB」而机器上跑的是 **n7.1.5**。
     * 「已安装」+ 一个它并不拥有的版本号，连起来读就是一句假话。
     *
     * 体积按**安装记录里各文件的字节数求和**算，不复用目录的 `totalSizeBytes`：
     * 换版本时体积往往也变了，拿目录那个数去标"你装的那份有多大"是同一个错。
     */
    const installedFactsById = new Map(
      installedRecords.map((p) => [
        p.id,
        {
          engineVersion: p.engineVersion,
          /*
           * ★ #87：这里原来是 `reduce((n, f) => n + (f.sizeBytes ?? 0), 0)`。
           *
           * 老记录里 `files[].sizeBytes` 可能缺失 —— 每缺一个就少加一份，
           * **全缺时求和恰好是 `0`**。而 `0 != null`，于是
           * `BackendPackCard` 那道**刻意的三态守卫**（`installedSizeBytes != null`
           * 才用机器上那份、否则回落目录值）**永远不会触发**，卡片渲染出
           * 「ffmpeg n7.1.5 · linux/x64 · **0 B**」。
           *
           * 守卫是对的、位置是对的，被上游一个默认值架空了 —— 所以修上游，不动守卫。
           * 判据：**只要有一个文件说不出大小，这份总和就是"不知道"，不是某个数字。**
           */
          sizeBytes: (() => {
            const files = p.files ?? [];
            if (files.length === 0) return null;
            let total = 0;
            for (const f of files) {
              if (f.sizeBytes == null) return null;
              total += f.sizeBytes;
            }
            return total;
          })(),
        },
      ]),
    );
    const body: GetBackendCatalogResponse = {
      catalogVersion: state.backendCatalog.catalogVersion,
      source: 'bundled',
      // ★ 诚实：内置目录，不是签名过的远端目录
      stale: true,
      packs: state.backendCatalog.packs.map((pack) => {
        const { applicable, reason, kind } = applicability(state, pack);
        const installedSha = installedShaById.get(pack.id);
        const catalogSha = shaSetOf(pack.files);
        return {
          ...pack,
          installed: installedIds.has(pack.id),
          updateAvailable:
            installedSha !== undefined &&
            installedSha !== '' &&
            catalogSha !== '' &&
            installedSha !== catalogSha,
          /*
           * 只在**真有证据**时才发这一格；没有证据就让它缺失（缺失 ≠ 否）。
           * 前端据此说「盘上有一份正在用的副本，但它不是目录里这一版」，
           * 而不是继续把一个正在服役的 ffmpeg 说成「安装 119 MB」。
           */
          ...(servedFromUnrecorded.has(pack.id)
            ? { installedOnDiskButUnrecorded: servedFromUnrecorded.get(pack.id) }
            : {}),
          /*
           * 同上，只在真有证据时才发：系统里已经有一份可用的同名二进制。
           * 前端据此在装按钮旁边说一句实话，而不是继续请用户把已经有的东西再下一遍。
           */
          ...(servedFromSystemPath.has(pack.id)
            ? { servedFromSystemPath: servedFromSystemPath.get(pack.id) }
            : {}),
          /*
           * 没装 ⇒ `null`（不是 undefined 也不是目录的值）：**"我没有"和"我不知道"
           * 都不该被渲染成"和目录一样"**，那正是这次要修的那句假话的来源。
           */
          installedEngineVersion: installedFactsById.get(pack.id)?.engineVersion ?? null,
          installedSizeBytes: installedFactsById.get(pack.id)?.sizeBytes ?? null,
          /*
           * 这一格**无条件发**（不是"只在真时才发"）：daemon 手里有安装记录，
           * "它不是随包出厂的"同样是一句它**知道**的话，不是"我不知道"。
           * 三态由**字段在不在**承担（老 daemon 不发 ⇒ 客户端表达"不知道"）。
           */
          bundledWithApp: bundledIds.has(pack.id),
          applicable,
          /**
           * 区分"还没测出来"和"测完了不支持"。UI 据此决定说
           *「检测中 / 装上 CPU 包后可检测」还是「本机不支持」。
           */
          inapplicableKind: kind,
          inapplicableReason: reason,
          recommended: applicable && pack.backend === state.hardware.selectedBackend,
        };
      }),
    };
    sendJson(res, 200, body);
    return true;
  }

  /* --------------------- GET /api/backends/installed --------------------- */
  if (pathname === '/api/backends/installed') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    const body: GetInstalledBackendsResponse = {
      packs: await state.listInstalledBackends(),
      selectedBackend: state.hardware.selectedBackend,
    };
    sendJson(res, 200, body);
    return true;
  }

  /* ---------------------- POST /api/backends/install --------------------- */
  if (pathname === '/api/backends/install') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    const body = await readBody(req);
    const id = asString(body['id']);
    if (!id) {
      sendError(res, 400, 'BAD_REQUEST', 'id is required', '缺少后端包 id');
      return true;
    }
    const pack = state.findCatalogPack(id);
    if (!pack) {
      sendError(res, 404, 'NOT_FOUND', `no backend pack ${id}`, `目录里没有后端包 ${id}`);
      return true;
    }
    const { applicable, reason } = applicability(state, pack);
    if (!applicable) {
      sendError(
        res,
        409,
        'CONFLICT',
        `pack ${id} is not applicable to this machine: ${reason ?? 'unknown'}`,
        `该后端包不适用于本机：${reason ?? '原因未知'}`,
      );
      return true;
    }
    /*
     * ★ T-196 ④：与 `applicability` 并列的第二道闸 —— **「能不能装」以前网页有闸、服务端一个字都不读。**
     *
     * 在这之前，这个 handler 只查 `id` + `applicability()`，零处读 `availability`。
     * 后果是同一个问题两个答案：
     *   · 网页：按钮 `disabled`，文案「尚未发布，暂不可安装」（`BackendPackCard.tsx`）
     *   · 服务端：`POST /api/backends/install` 照样 **202**，起一个**必然失败**的 job
     *
     * 「必然失败」不是修辞：`pending-ci` 的语义就是"还没有可下载的地址"。
     * 于是用户得到一个排队中的任务 → 下载阶段报错 → 他去查"为什么下载失败"，
     * 而正确的问题是"这东西根本还没发布"。**一个 202 把一句本可以立刻说清的话，
     * 推迟成了一个几十秒后才出现、且指向错误方向的失败。**
     *
     * ⚠️ 顺序刻意放在 `applicability` **之后**：一个包既不适用、又没发布时，
     * 「这是别的平台的包」是关于用户机器的确定事实，比「我们还没发布」更能回答他此刻的疑问。
     * 这与前端 `packStatus()` 的优先级（`platform` 先于 `not-published`）**是同一条**——
     * 两层给同一件事排出不同的顺序，就是下一个"两处说法不一致"。
     *
     * ⚠️ 这条今天在**数据层**打不起来（`b0cbf08` 之后目录里一个 `pending-ci` 都没有），
     * 它现在只在**代码层**成立。所以它的用例喂的是自己造的 pending-ci 包，
     * 而不是依赖目录里恰好有一个 —— 依赖那个的话，这道闸会随着目录变化悄悄失去覆盖。
     */
    if (pack.availability === 'pending-ci') {
      sendError(
        res,
        409,
        'CONFLICT',
        `pack ${id} is not published yet (availability=pending-ci): it has no downloadable URL`,
        `该组件尚未发布下载地址，现在装不了 —— 不是你的机器的问题`,
        {
          remediation: {
            action: 'upgradeApp',
            params: { packId: id },
            labelZh: '等待新版本',
            label: 'Wait for a new version',
          },
        },
      );
      return true;
    }
    const started = startPackInstall(state, pack);
    sendJson(res, 202, toPullResponse(started.job, started.deduplicated));
    return true;
  }

  /* ---------------------- POST /api/backends/select ---------------------- */
  if (pathname === '/api/backends/select') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    const body = await readBody(req);
    const raw = asString(body['backend']);
    const backend = BACKENDS.find((b) => b === raw);
    if (!backend) {
      sendError(
        res,
        400,
        'BAD_REQUEST',
        `backend must be one of ${BACKENDS.join('|')}`,
        `backend 必须是 ${BACKENDS.join('、')} 之一`,
      );
      return true;
    }
    const status = state.hardware.backends.find((b) => b.id === backend);
    /*
     * ★ T-168：**这道闸门此前会把用户锁死在 CPU 上。**
     *
     * 链条是闭合的：用户选了 cpu → `findInBackendPacks` 把 cpu 包排到最前 →
     * `backendDir` 指向 cpu 包目录 → 探测报 `vulkan.available=false` →
     * 用户想选回 vulkan，这里 409，理由是那句**编出来的**
     * 「installed but enumerated no devices (driver missing or too old)」。
     * 逃不出去：唯一的出路是卸掉 cpu 包或手改 prefs.json。
     * 而拦住他的那个 `available=false`，恰恰是**他自己上一次选择**造成的。
     *
     * 判据改成「有没有真结论」，不是「available 是不是 true」：
     *   · 包没装      → 继续拒（理由为真，且可操作：去装）
     *   · 装了、探过、确实没设备 → 继续拒（真结论）
     *   · 装了、**这次没探它**   → 放行。没有证据时拒绝，正是 ADR-014 那个死锁的形状，
     *     而"选中它"本身就是拿到证据的唯一办法。代价上限见 manager.ts 文件头实测①：
     *     装了个用不了的加速包是**无害的** —— ggml 会静默退回 CPU。
     *     「我们的职责不是阻止它，而是解释它。」
     */
    const noVerdictYet = status?.installed === true && status.probed !== true;
    // CPU 同理：它是 L1 兜底，选它永远合法（ADR-014 决策 1）
    if (backend !== 'cpu' && status?.available !== true && !noVerdictYet) {
      sendError(
        res,
        409,
        'CONFLICT',
        `backend ${backend} is not available on this machine`,
        `本机无法使用 ${backend}：${status?.unavailableReason ?? '未枚举到设备'}`,
        {
          remediation: {
            action: 'install_backend',
            params: { backend },
            labelZh: '去安装后端包',
            label: 'Install a backend pack',
          },
        },
      );
      return true;
    }

    state.hardware = { ...state.hardware, selectedBackend: backend };
    state.prefs.selectedBackend = backend;
    await state.persistPrefs();
    // 后端一变，**所有 fit 判定都失效** —— 客户端必须重拉模型目录，不能只刷硬件面板。
    state.publish(makeEvent('hardware.changed', topics.runtime(), { hardware: state.hardware }));
    sendJson(res, 200, { selectedBackend: backend } satisfies { selectedBackend: Backend });
    return true;
  }

  /*
   * `POST /api/backends/selftest` **不在这里** —— 真实现在 `hardware.ts` 的
   * `createRuntimeRoutes`（它在 main.ts 的 routers 里注册得更早，所以先命中）。
   *
   * 这里原来还留着一个 501 桩，被真实现**永久遮蔽、不可达**。删掉的理由不是"多余"，
   * 而是**它会骗人**：下一个人读到它会以为自检没实现，甚至去"修"这段死代码，
   * 而线上跑的根本是另一份。与 `MINDMAP_SAVE_SUPPORTED` 同一族 ——
   * 临时占位没人回来清；没有这个死分支，就不会有人误改到它。
   */

  /* ---------------------- DELETE /api/backends/:id ----------------------- */
  const single = /^\/api\/backends\/(.+)$/.exec(pathname);
  if (single) {
    if (method !== 'DELETE') return methodNotAllowed(res, 'DELETE');
    const id = decodePathSegment(single[1]);
    const installed = await state.listInstalledBackends();
    const record = installed.find((p) => p.id === id);
    if (!record) {
      sendError(res, 404, 'NOT_FOUND', `backend pack ${id} is not installed`, '未安装该后端包');
      return true;
    }
    /*
     * ★★ **产品不许删掉自己** —— 随应用出厂的那一档故障关闭。
     *
     * `[隔离实例实测]` `DELETE /api/backends/media-tools-linux-x64` → **204**，
     * 而包内 `runtime/probe/ffmpeg`、`runtime/probe/ffprobe` **就此消失**。
     * 真机上那是 ~115 MB × 2 ≈ 230 MB，并且它们**不在用户的数据目录里** ——
     * 删掉的是**已安装的应用本体**的一部分，除了把整个产品重下一遍拿不回来。
     * 界面那一侧没有拦住它：`/runtime` 那颗卸载按钮是**亮的**，前面只有一个
     * 泛泛的 `window.confirm`。
     *
     * ## 为什么闸门落在这里，而不是"把路径修正确"
     *
     * 链条有三环，这里只补**第二环**：
     *   ① `backendReconcile.ts` 给包内那份补记录时写的是 **legacy 形状**
     *      （绝对 `path`、无 `root`/`relPath`），并且如实标了 `source: 'bundled'`；
     *   ② 本处**不看 `source`**，直接 `dropInstalledFiles` + `removeManifest`；
     *   ③ `resolveInstalledFile()` 的越界检查**只写在 `root + relPath` 那条分支**上，
     *      legacy 分支是 `if (rec.path) return rec.path;` —— 原样返回、不作检查，
     *      于是那个指向模型根之外的绝对路径畅通无阻地走到 `fs.rm`。
     *
     * ③ 是**通用**的洞：收紧它会影响每一条 legacy 记录（模型桶也在内），
     * 该有它自己的影响面分析，不该顺手夹在这次改动里。
     * 而 ② 是**这台机器上唯一知道"这些字节属于谁"的地方** —— 记录自己就带着
     * `source`，服务端据此拒绝是一次小而确定的防御：**没有证据说该删，就不删。**
     *
     * ⚠️ 只挡 `bundled` 那一档。下载装进 store 的包**照旧删得掉** ——
     * 把它一起锁死不是安全，是"用户拿不回自己的磁盘"（`packStatus.ts`
     * 的 `isLoadBearingPack()` 已经为同一句话付过一次代价）。
     * ⚠️ 也**不删记录**：拒绝之后记录必须原样留着，否则界面开始说「未安装」、
     * 而文件还在盘上被解析器用着 —— 那正是本仓反复在清的"第三个答案"。
     */
    if (record.source === 'bundled') {
      sendError(
        res,
        409,
        'BUNDLED_NOT_REMOVABLE',
        `backend pack ${id} ships inside the application itself, so uninstalling it would delete ` +
          `files belonging to OpenMemo rather than to your data folder. Those bytes only come ` +
          `back by reinstalling the app, so this pack cannot be uninstalled here.`,
        // ⚠️ 用户可见的原话，**不要写 markdown 强调**：界面按纯文本渲染，
        // `**…**` 会原样显示出来（邻居那几条 messageZh 也都是纯文本）。
        `${id} 是随应用一起出厂的：它的文件在程序自己的安装目录里，不在你的数据目录里。` +
          `删掉它等于删掉产品自身的一部分（只能重装应用才能拿回来），所以这里不允许卸载。`,
      );
      return true;
    }
    /*
     * ★★ T-192：**先按记录删文件，再删记录** —— 顺序不能反（记录没了就不知道该删哪些文件）。
     *
     * 此前这里只有 `removeManifest` + `collectGarbage(['orphan_blobs'])`，
     * 而 `findGarbage()` **只扫 `blobs/`**：`by-name/backend/<归档名>` 那条硬链和
     * 解开的目录原封不动 ⇒ blob 的 inode 仍被引用 ⇒ **磁盘一个字节都不回收**，
     * 事件里却照样报一个 `freedBytes`（`[实测]` 差值恒为 0，而报的是整包大小）。
     *
     * 第二个后果更重：`by-name/backend/` 是 `findInBackendPacks()` 的**发现路径**。
     * 一个"已卸载"的包留在那儿**仍然会被解析到并真的跑起来** ——
     * 用户以为删了，产品还在用它。
     *
     * 与 T-164 在模型那一格修的是同一件事、同一个成因；那次**没有覆盖 backend 桶**
     * （`dropInstalledFiles()` 里那句 `if (kind === 'backend') continue`）。
     */
    const dropped = await state.dropInstalledFiles(id, ['backend']);
    await state.store.removeManifest('backend', id);
    // 链都删干净了，blob 这才真的成为孤儿 —— 现在回收它才对得上账
    const gc = await state.store.collectGarbage(['orphan_blobs']);
    state.publish(
      makeEvent('backend.removed', topics.backends(), { packId: id, freedBytes: gc.freedBytes }),
    );
    await state.emitStorageChanged();
    /*
     * ★★ T-107 ②：有东西被拒绝删除时，**回一个说得出话的 200，而不是一个沉默的 204**。
     *
     * 为什么记录照删、不改成 409：这条记录指向的字节**已经不属于我们**
     * （越界，或者路径早就失效）。硬把整条 DELETE 变成 409 的话，用户会
     * **永远清不掉一条烂记录** —— 那是另一个方向的坏。所以卸载动作照常兑现
     * （manifest 走掉、界面上它真的消失），同时如实说清「有几个文件没删、为什么」。
     *
     * 干净的那条路**仍然是 204**：不为了统一形状去改一个正确的既有契约
     * （e2e 的 A-UNINSTALL-* 两条腿钉的就是它）。
     */
    if (dropped.refused.length > 0) {
      sendJson(res, 200, {
        packId: id,
        freedBytes: gc.freedBytes,
        filesNotRemoved: dropped.refused.map((r) => ({ name: r.name, reason: r.reason })),
      });
      return true;
    }
    res.writeHead(204);
    res.end();
    return true;
  }

  return false;
}

function methodNotAllowed(res: ServerResponse, expected: string): boolean {
  sendError(res, 405, 'METHOD_NOT_ALLOWED', `use ${expected}`, '方法不允许');
  return true;
}
