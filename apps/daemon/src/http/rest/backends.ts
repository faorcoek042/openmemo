/**
 * GPU/推理后端包 REST（`/api/backends**`）。
 *
 * ADR-003 决策 6：后端包与模型权重**共用同一个下载器** —— 同样的 SHA-256 校验、
 * 断点续传、镜像切换、GC。这里的差异只有两处：manifest 来源不同、落在 store 的
 * `backend` 命名空间下。
 *
 * ★ 诚实边界：`selfTest` 恒为 `null`（= 从未运行），绝不写 `passed: true`。
 * ADR-003 决策 3 要求自检必须跑**真实推理**（内嵌音频），那需要引擎二进制；
 * 没跑就报 null，永远不假装通过。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { install } from '@openmemo/downloader';
import { materializeSqliteExtensions } from '@openmemo/pipeline';
import { isPackApplicable } from '@openmemo/runtime';
import {
  BACKENDS,
  makeEvent,
  topics,
  type Backend,
  type BackendPack,
  type DownloadJob,
  type GetBackendCatalogResponse,
  type GetInstalledBackendsResponse,
  type InstalledBackendPack,
  type PlatformSelector,
} from '@openmemo/shared';

import { sendError, sendJson } from '../respond.js';
import { currentArch } from './hardware.js';
import { toPullResponse } from './jobs.js';
import { asString, decodePathSegment, readBody } from './request.js';
import type { RestState } from './state.js';

function currentPlatform(): PlatformSelector {
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
 * 「不可用」的三种含义 —— **不能用同一个 `applicable=false` 表达**。
 *
 * 用户看到"不可用"会以为自己的机器不支持，然后就不装了。但在干净机器上，
 * 绝大多数情况其实是**我们还没法判断**：probe 可执行文件装在后端包里，
 * 包没装 → probe 跑不了 → 加速后端一律显示"不可用"。
 * 这跟"探测完成、确认你没有这块卡"是完全不同的两件事，UI 该说的话也不同。
 */
export type InapplicableKind =
  /** 可装 */
  | 'applicable'
  /** os/arch 就对不上，换台机器也没用 */
  | 'platform'
  /** **尚未探测**（probe 没跑成）——「检测中/待检测」，不是"不支持" */
  | 'undetermined'
  /** 探测完成，确认本机没有可用设备 */
  | 'unsupported';

function inapplicableKind(
  state: RestState,
  pack: BackendPack,
  r: { applicable: boolean; reason: string | null },
): InapplicableKind {
  if (r.applicable) return 'applicable';
  const platform = currentPlatform();
  if (pack.os !== platform.os || pack.arch !== platform.arch) return 'platform';

  const status = state.hardware.backends.find((b) => b.id === pack.backend);
  const why = status?.unavailableReason ?? '';
  // runtime 在 probe 没跑成时给的就是这句 —— 它代表"未知"，不代表"不支持"
  if (/probe did not complete|probe skipped/i.test(why)) return 'undetermined';
  return 'unsupported';
}

/**
 * 把一个后端包排进下载队列。
 *
 * 也被 `POST /api/models/pull`（`kind: "backend-pack"`）复用 —— 契约里 PullRequest
 * 明确允许用同一个入口拉后端包。
 */
export function startPackInstall(
  state: RestState,
  pack: BackendPack,
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
      const probes = await state.probeMirrors(pack.files[0].mirrors);

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
          if (p.phase === 'downloading' || p.phase === 'resolving' || p.phase === 'verifying') {
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
      const record: InstalledBackendPack = {
        schemaVersion: 1,
        id: pack.id,
        engine: pack.engine,
        engineVersion: pack.engineVersion,
        backend: pack.backend,
        installedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
        integrity: 'ok',
        ...(pack.linkInto ? { linkInto: pack.linkInto } : {}),
        files: result.files.map((f) => ({
          name: f.name,
          sha256: f.sha256,
          sizeBytes: f.sizeBytes,
          path: f.path,
        })),
        // ★ 从未运行 ≠ 通过。需要真实推理自检才能填，见文件头注释。
        selfTest: null,
      };
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
  /* ---------------------- GET /api/backends/catalog ---------------------- */
  if (pathname === '/api/backends/catalog') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    const installedIds = new Set((await state.listInstalledBackends()).map((p) => p.id));
    const body: GetBackendCatalogResponse = {
      catalogVersion: state.backendCatalog.catalogVersion,
      source: 'bundled',
      // ★ 诚实：内置目录，不是签名过的远端目录
      stale: true,
      packs: state.backendCatalog.packs.map((pack) => {
        const { applicable, reason, kind } = applicability(state, pack);
        return {
          ...pack,
          installed: installedIds.has(pack.id),
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
    // CPU 同理：它是 L1 兜底，选它永远合法（ADR-014 决策 1）
    if (backend !== 'cpu' && !status?.available) {
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
    await state.store.removeManifest('backend', id);
    // 删 manifest 之后原来的 blob 就成了孤儿，立刻回收
    const gc = await state.store.collectGarbage(['orphan_blobs']);
    state.publish(
      makeEvent('backend.removed', topics.backends(), { packId: id, freedBytes: gc.freedBytes }),
    );
    await state.emitStorageChanged();
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
