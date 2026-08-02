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
function applicability(
  state: RestState,
  pack: BackendPack,
): { applicable: boolean; reason: string | null } {
  const platform = currentPlatform();
  const platformOk = pack.os === platform.os && pack.arch === platform.arch;
  if (!platformOk) {
    return { applicable: false, reason: `适用于 ${pack.os}/${pack.arch}，与本机不符` };
  }
  const status = state.hardware.backends.find((b) => b.id === pack.backend);
  if (!status?.available) {
    return { applicable: false, reason: status?.unavailableReason ?? '该后端在本机不可用' };
  }
  return { applicable: true, reason: null };
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
        installPath: pack.installPath,
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
        const { applicable, reason } = applicability(state, pack);
        return {
          ...pack,
          installed: installedIds.has(pack.id),
          applicable,
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
    if (!status?.available) {
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

  /* --------------------- POST /api/backends/selftest --------------------- */
  if (pathname === '/api/backends/selftest') {
    // 契约的 ENDPOINTS 里没有这条，但前端有按钮。真实自检要跑内嵌音频的推理，
    // 需要引擎二进制 —— 没有就明确 501，绝不返回一个假的 passed。
    sendError(
      res,
      501,
      'NOT_IMPLEMENTED',
      'self-test requires the engine binary and a real inference run (ADR-003 decision 3)',
      '自检需要已安装的推理引擎并真实跑一次推理（ADR-003 决策 3），当前未实现 —— 绝不返回伪造的"通过"',
    );
    return true;
  }

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
