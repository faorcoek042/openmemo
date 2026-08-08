/**
 * 模型管理 REST —— `packages/shared` `ENDPOINTS` 27 条里除 `/api/events` 之外的全部。
 *
 * 本模块是 `packages/downloader/scripts/reference-server.mjs` 的 TypeScript 移植：
 * 同一份契约、同一个真实下载器、同一份 `vendor/manifests`、同一个 `computeFit`。
 * **没有 mock**：
 *
 *   web UI → 真实 HTTP 契约 → 真实 DownloadQueue → 真实分片/断点续传下载
 *          → 真实 SHA-256 校验 → 真实内容寻址 store → 真实 SSE → UI 进度
 *
 * 明确标注为"未实现"而不是伪造的部分（见各处 501）：
 *   - 基准测试：需要真实推理后端二进制
 *   - 后端自检：同上（ADR-003 决策 3 要求跑真实推理）
 *   - 任务暂停/继续：`DownloadQueue` 没有 paused 状态
 *   - hf_repo 导入：拿不到官方 SHA-256，拒绝安装未校验的字节（ADR-004 决策 5）
 *
 * 路由分工：`/api/jobs**` 在 jobs.ts，`/api/backends**` 在 backends.ts。
 */
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';

import { DownloadError, install, sha256File, verifyFile } from '@openmemo/downloader';
import {
  LLM_GRAPH_OVERHEAD_MB,
  MODEL_ROLES,
  PROVIDERS,
  QUANTIZATIONS,
  makeEvent,
  topics,
  whisperMemoryMB,
  type ActivateResponse,
  type DownloadJob,
  type GcResponse,
  type GetActiveResponse,
  type GetHardwareResponse,
  type GetInstalledResponse,
  type InstalledModel,
  type ModelEntry,
  type PlatformSelector,
  type ProviderId,
  type Quantization,
} from '@openmemo/shared';

import { sendError, sendJson } from '../respond.js';
import type { SseHub } from '../sse.js';
import { handleBackendRoutes, startPackInstall } from './backends.js';
import { createComponentRoutes, resolveComponentRegistryPath } from './components.js';
import { currentArch } from './hardware.js';
import { handleJobRoutes, toPullResponse } from './jobs.js';
import { resolveManifestDir } from './manifests.js';
import { asString, asStringArray, decodePathSegment, readBody } from './request.js';
import { HARDWARE_SNAPSHOT_ID, RestState } from './state.js';
import { roleToActivationSlot, roleToStoreKind } from './roleMap.js';

/** 绝对路径 → 相对 models 根的路径（写入安装记录用）。 */
function toModelsRelPath(modelsRoot: string, abs: string): string {
  const rel = path.relative(modelsRoot, abs);
  // 落在根之外时退回 basename —— 记录里绝不放 `../` 这种能逃出根的相对路径
  return rel.startsWith('..') ? path.basename(abs) : rel;
}

/**
 * 安装记录 → 绝对路径。**优先 root+relPath**，旧记录回退到废弃的 `path`。
 * 兼容分支是必须的：已经装过模型的用户，记录里只有绝对路径。
 */
function resolveInstalledFile(
  modelsRoot: string,
  f: { root?: string; relPath?: string; path?: string },
): string {
  if (f.relPath) return path.join(modelsRoot, f.relPath);
  return f.path ?? '';
}

export interface ModelRoutesDeps {
  sse: SseHub;
  dataDir: string;
  manifestDir: string;
}

export interface ModelRoutes {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
}

/** 本模块负责的路径前缀。不匹配就返回 false，交回主路由去 404。 */
function owns(pathname: string): boolean {
  return (
    pathname === '/api/runtime/hardware' ||
    pathname.startsWith('/api/models/') ||
    pathname.startsWith('/api/jobs') ||
    pathname.startsWith('/api/backends/') ||
    // 组件清单与更新：**挂在这里而不是单独一个 router**，因为它要用同一个 RestState
    // （同一个 ArtifactStore + 同一个下载队列）。再造一个会有两份 store 状态。
    pathname === '/api/components' ||
    pathname.startsWith('/api/components/')
  );
}

function currentPlatform(): PlatformSelector {
  return {
    os: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    arch: currentArch(),
  };
}

export function createModelRoutes(deps: ModelRoutesDeps): ModelRoutes {
  /**
   * 状态是**懒初始化**的：加载并校验 manifest、探测硬件、扫描 store 都要 I/O，
   * 不该在进程启动路径上做（daemon 的启动序列对时间敏感）。失败时清掉缓存，
   * 让下一次请求重试，而不是把一个 rejected promise 永久钉在这里。
   */
  const componentRoutes = createComponentRoutes({
    registryPath: resolveComponentRegistryPath(),
  });
  let statePromise: Promise<RestState> | null = null;
  const getState = (): Promise<RestState> => {
    statePromise ??= RestState.create(deps).catch((err: unknown) => {
      statePromise = null;
      throw err;
    });
    return statePromise;
  };

  return {
    async handle(req, res, url, method): Promise<boolean> {
      const p = url.pathname;
      if (!owns(p)) return false;

      const state = await getState();

      if (p === '/api/components' || p.startsWith('/api/components/')) {
        return componentRoutes.handle(req, res, url, method, state);
      }
      if (p.startsWith('/api/jobs')) return handleJobRoutes(state, res, p, method);
      if (p.startsWith('/api/backends/')) {
        return handleBackendRoutes(state, req, res, p, method);
      }
      if (p === '/api/runtime/hardware') {
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        sendJson(res, 200, await buildHardwareResponse(state));
        return true;
      }
      return handleModelRoutes(state, req, res, p, method, url);
    },
  };
}

/**
 * 便于在 `server.ts` 一行接线：按 ServerDeps 实例记忆化，避免每个请求重建。
 * `manifestDir` 由 `resolveManifestDir()` 定位 `vendor/manifests`。
 */
const routesByDeps = new WeakMap<object, ModelRoutes>();
export function modelRoutesFor(deps: { sse: SseHub; dataDir: string }): ModelRoutes {
  let routes = routesByDeps.get(deps);
  if (!routes) {
    routes = createModelRoutes({
      sse: deps.sse,
      dataDir: deps.dataDir,
      manifestDir: resolveManifestDir(),
    });
    routesByDeps.set(deps, routes);
  }
  return routes;
}

/* ========================================================================== */
/* 硬件                                                                        */
/* ========================================================================== */

async function buildHardwareResponse(state: RestState): Promise<GetHardwareResponse> {
  // 先让快照跟上现实，理由见 backends.ts 入口那段：装/卸/切之后不刷新，
  // 这里回的 `backends[].probed` / `available` 就是上一次启动时的答案。
  const base = await state.freshHardware();
  // `installed` 反映的是"后端包是否装在磁盘上"，这是我们能确知的事实；
  // `available`（设备是否枚举得到）仍然由探测决定，两者不能互相推断。
  const installedBackends = new Set((await state.listInstalledBackends()).map((p) => p.backend));
  const hardware = {
    ...base,
    backends: base.backends.map((b) => ({
      ...b,
      installed: b.id === 'cpu' ? true : installedBackends.has(b.id),
    })),
  };
  return { hardware, snapshotId: HARDWARE_SNAPSHOT_ID };
}

/* ========================================================================== */
/* 模型路由                                                                    */
/* ========================================================================== */

async function handleModelRoutes(
  state: RestState,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  url: URL,
): Promise<boolean> {
  switch (pathname) {
    case '/api/models/catalog': {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      const roleParam = url.searchParams.get('role') ?? 'all';
      const role = MODEL_ROLES.find((r) => r === roleParam) ?? 'all';
      // `lang` 是用户打算转写的语言（ADR-011 决策 1），不是界面语言
      sendJson(res, 200, await state.buildCatalog(role, url.searchParams.get('lang')));
      return true;
    }

    case '/api/models/installed': {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      const body: GetInstalledResponse = {
        models: await state.listInstalled(),
        active: { ...state.active },
      };
      sendJson(res, 200, body);
      return true;
    }

    case '/api/models/active': {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      sendJson(res, 200, { active: { ...state.active } } satisfies GetActiveResponse);
      return true;
    }

    case '/api/models/storage': {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      sendJson(res, 200, await state.buildStorage());
      return true;
    }

    case '/api/models/sources': {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      sendJson(res, 200, state.buildSources());
      return true;
    }

    case '/api/models/sources/probe': {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      // 每个 provider 取一个代表 URL 做 256 KiB Range 实测，5s 超时、并发跑。
      // 结果同时走 SSE `sources.probed`（UI 可以不等这个响应）。
      const targets = state.probeTargets();
      await state.probeMirrors(
        targets.map((t) => ({
          provider: t.provider as ProviderId,
          url: t.url,
          official: t.official,
        })),
      );
      sendJson(res, 200, state.buildSources());
      return true;
    }

    case '/api/models/sources/select':
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return selectSource(state, req, res);

    case '/api/models/pull':
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return pullModel(state, req, res);

    case '/api/models/activate':
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return activateModel(state, req, res);

    case '/api/models/verify':
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return verifyModel(state, req, res);

    case '/api/models/import':
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return importModel(state, req, res);

    case '/api/models/gc':
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return runGc(state, req, res);

    case '/api/models/benchmark': {
      // 契约的 ENDPOINTS 里没有这条，但前端有按钮。真实基准要在本机跑推理，
      // 需要引擎二进制 —— ADR-004 决策 3 禁止编造数字，所以宁可 501。
      sendError(
        res,
        501,
        'NOT_IMPLEMENTED',
        'benchmarking requires an installed inference backend',
        '基准测试需要已安装的推理后端才能在本机实测，当前未实现 —— 绝不返回论文里的数字',
      );
      return true;
    }

    default:
      break;
  }

  /* ------------------- GET / DELETE /api/models/:id ---------------------- */
  const single = /^\/api\/models\/(.+)$/.exec(pathname);
  if (!single) return false;
  const id = decodePathSegment(single[1]);

  if (method === 'GET') {
    const model = state.findCatalogModel(id);
    if (!model) {
      sendError(res, 404, 'NOT_FOUND', `no model ${id} in the catalog`, `目录里没有 ${id}`);
      return true;
    }
    sendJson(res, 200, model);
    return true;
  }

  if (method === 'DELETE') return deleteModel(state, res, id);

  return methodNotAllowed(res, 'GET, DELETE');
}

/* --------------------------------- pull ---------------------------------- */

async function pullModel(
  state: RestState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const body = await readBody(req);
  const id = asString(body['id']);
  if (!id) {
    sendError(res, 400, 'BAD_REQUEST', 'id is required', '缺少 id');
    return true;
  }

  // 契约允许用同一个入口拉后端包（PullRequest.kind）
  if (body['kind'] === 'backend-pack') {
    const pack = state.findCatalogPack(id);
    if (!pack) {
      sendError(res, 404, 'NOT_FOUND', `no backend pack ${id}`, `目录里没有后端包 ${id}`);
      return true;
    }
    const started = startPackInstall(state, pack);
    sendJson(res, 202, toPullResponse(started.job, started.deduplicated));
    return true;
  }

  const model = state.findCatalogModel(id);
  if (!model) {
    sendError(res, 404, 'NOT_FOUND', `no model ${id} in the catalog`, `目录里没有 ${id}`);
    return true;
  }

  // ADR-004 决策 2：受限权重我们**从不转存**，必须用户自己去上游接受条款。
  if (
    (model.license.gated || model.license.requiresAcceptance) &&
    body['licenseAccepted'] !== true
  ) {
    sendError(
      res,
      403,
      'GATED_REPO',
      `model ${id} requires accepting the upstream license first`,
      '该模型需要先到上游接受许可条款后才能下载',
      {
        remediation: {
          action: 'accept_license',
          params: { modelId: id, url: model.license.url },
          labelZh: '去接受许可',
          label: 'Accept the license',
        },
      },
    );
    return true;
  }

  // 磁盘预检：先失败，别在传了 2 GB 之后才发现装不下（ADR-007 决策 2 的机器可读补救）
  const storage = await state.buildStorage();
  const needBytes = Math.ceil(model.totalSizeBytes * 1.1);
  if (storage.volume.freeBytes > 0 && storage.volume.freeBytes < needBytes) {
    sendError(res, 507, 'DISK_FULL', 'not enough free disk space', '磁盘空间不足', {
      remediation: {
        action: 'free_disk',
        params: { neededBytes: needBytes, freeBytes: storage.volume.freeBytes },
        labelZh: '去清理空间',
        label: 'Free up space',
      },
    });
    return true;
  }

  const providerRaw = asString(body['provider']);
  const pinnedProvider =
    providerRaw && (providerRaw === 'auto' || PROVIDERS.some((p) => p === providerRaw))
      ? (providerRaw as ProviderId | 'auto')
      : state.prefs.sourceProvider;

  const { job, deduplicated } = startModelPull(state, model, {
    includeOptional: asStringArray(body['includeOptional']),
    pinnedProvider,
    activateOnSuccess: body['activateOnSuccess'] === true,
  });
  sendJson(res, 202, toPullResponse(job, deduplicated));
  return true;
}

interface PullOptions {
  includeOptional: string[];
  pinnedProvider: ProviderId | 'auto';
  activateOnSuccess: boolean;
}

function startModelPull(
  state: RestState,
  model: ModelEntry,
  opts: PullOptions,
): { job: DownloadJob; deduplicated: boolean } {
  const platform = currentPlatform();

  return state.queue.enqueue(
    {
      kind: 'model',
      targetId: model.id,
      displayName: model.displayNameZh,
      totalBytes: model.totalSizeBytes,
    },
    async (ctx) => {
      ctx.setStep('resolving');
      const probes = await state.probeMirrors(model.files[0].mirrors);

      const result = await install({
        store: state.store,
        target: {
          id: model.id,
          kind: roleToStoreKind(model.role),
          displayName: model.displayName,
          files: model.files,
        },
        probes,
        platform,
        pinnedProvider: opts.pinnedProvider,
        includeOptional: opts.includeOptional,
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
      const record: InstalledModel = {
        schemaVersion: 1,
        id: model.id,
        groupId: model.groupId,
        role: model.role,
        // 随记录一起落盘：目录名不能表达类型（见 role 那次修复），
        // 目录名同样不能表达"谁能加载它"和"该用哪套 modelConfig"。
        engines: model.engines,
        family: model.family,
        displayName: model.displayName,
        quantization: model.quantization,
        totalSizeBytes: model.totalSizeBytes,
        installedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
        integrity: 'ok',
        /*
         * 相对路径 + 根锚点（shared 新契约）。
         * 绝对路径会把当前数据目录烤进记录里：搬数据目录、换 Windows 盘符、
         * 把 profile 拷到另一台机器 —— blob 还在、校验也还对，记录却指不到它了。
         * `path` 仍然写出，仅供尚未迁移的旧读取方兼容，新代码一律读 root+relPath。
         */
        files: result.files.map((f) => ({
          role: f.role,
          name: f.name,
          sha256: f.sha256,
          sizeBytes: f.sizeBytes,
          root: 'models' as const,
          relPath: toModelsRelPath(state.store.root, f.path),
          path: f.path,
        })),
        requirements: model.requirements,
        ...(model.gguf ? { gguf: model.gguf } : {}),
        license: model.license,
        source: model.source,
        // ★ null，直到用户在本机真跑一次基准（ADR-004 决策 3）
        benchmark: null,
        catalogVersion: model.catalogVersion,
      };
      /*
       * ★ T-149 就地自愈：旧布局里同一个 id 可能已经躺在 `manifests/asr/` 下。
       * 先把所有桶里的旧记录清掉，再写进正确的桶 —— 否则重装一次就会留下两份记录。
       * 顺序不能反：先删后写，中途崩溃最多退回"没装"，不会留下两条互相矛盾的记录。
       */
      await state.dropInstalledRecord(model.id);
      // blob 先落、manifest 最后写：中途崩溃只会留下可回收的孤儿 blob。
      await state.store.writeManifest(roleToStoreKind(model.role), model.id, record);

      if (opts.activateOnSuccess || !state.active[model.role]) {
        const previous = state.active[model.role];
        state.active[model.role] = model.id;
        await state.persistActive();
        state.publish(
          makeEvent('model.activated', topics.models(), {
            role: roleToActivationSlot(model.role),
            modelId: model.id,
            previous,
          }),
        );
      }
      state.publish(
        makeEvent('model.installed', topics.models(), {
          modelId: model.id,
          active: state.active[model.role] === model.id,
        }),
      );
      await state.emitStorageChanged();
    },
  );
}

/* ------------------------------- activate -------------------------------- */

async function activateModel(
  state: RestState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const body = await readBody(req);
  const roleRaw = asString(body['role']);
  const role = MODEL_ROLES.find((r) => r === roleRaw);
  if (!role) {
    sendError(
      res,
      400,
      'BAD_REQUEST',
      `role must be one of ${MODEL_ROLES.join('|')}`,
      `role 必须是 ${MODEL_ROLES.join('、')} 之一`,
    );
    return true;
  }

  // id === null 表示清空该槽位（契约明确允许）
  const id = typeof body['id'] === 'string' ? body['id'] : null;
  if (id !== null) {
    const installed = await state.listInstalled();
    const record = installed.find((m) => m.id === id);
    if (!record) {
      sendError(res, 404, 'NOT_FOUND', `model ${id} is not installed`, '未安装该模型，无法启用');
      return true;
    }
    if (record.role !== role) {
      sendError(
        res,
        409,
        'CONFLICT',
        `model ${id} has role ${record.role}, not ${role}`,
        `模型 ${id} 的用途是 ${record.role}，不能放进 ${role} 槽位`,
      );
      return true;
    }
  }

  const previous = state.active[role];
  state.active[role] = id;
  await state.persistActive();
  state.publish(
    makeEvent('model.activated', topics.models(), {
      role: roleToActivationSlot(role),
      modelId: id,
      previous,
    }),
  );

  const body_: ActivateResponse = {
    role,
    active: id,
    previous,
    // 推理进程要重新加载才生效
    reloadRequired: true,
  };
  sendJson(res, 200, body_);
  return true;
}

/* -------------------------------- delete --------------------------------- */

async function deleteModel(state: RestState, res: ServerResponse, id: string): Promise<boolean> {
  const installed = await state.listInstalled();
  const record = installed.find((m) => m.id === id);
  if (!record) {
    sendError(res, 404, 'NOT_FOUND', `model ${id} is not installed`, '未安装该模型');
    return true;
  }
  if (state.active[record.role] === id) {
    sendError(
      res,
      409,
      'MODEL_IN_USE',
      'the active model cannot be deleted',
      '该模型正在使用中，请先切换到其它模型',
      {
        remediation: {
          action: 'activate_model',
          params: { role: record.role },
          labelZh: '去切换模型',
          label: 'Switch model',
        },
      },
    );
    return true;
  }

  /*
   * ★ T-149：**从所有桶里删**，不是从 `roleToStoreKind(record.role)` 算出来的那个桶删。
   * 旧布局把 VAD / 标点记录写在 `manifests/asr/` 下；按 role 算会去 `manifests/vad/` 删，
   * 而 `removeManifest` 是 `fs.rm(..., {force:true})` —— **找不到不报错**。
   * 后果：HTTP 返回 204、事件也发了、记录还在，模型看起来"删不掉"。
   */
  await state.dropInstalledRecord(id);
  // manifest 没了，它引用的 blob 立刻变孤儿 —— 顺手回收
  const gc = await state.store.collectGarbage(['orphan_blobs']);
  state.publish(
    makeEvent('model.removed', topics.models(), { modelId: id, freedBytes: gc.freedBytes }),
  );
  await state.emitStorageChanged();
  res.writeHead(204);
  res.end();
  return true;
}

/* -------------------------------- verify --------------------------------- */

async function verifyModel(
  state: RestState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const body = await readBody(req);
  const id = asString(body['id']);
  if (!id) {
    sendError(res, 400, 'BAD_REQUEST', 'id is required', '缺少 id');
    return true;
  }
  const installed = await state.listInstalled();
  const record = installed.find((m) => m.id === id);
  if (!record) {
    sendError(res, 404, 'NOT_FOUND', `model ${id} is not installed`, '未安装该模型');
    return true;
  }

  // 全量哈希几 GB 很慢，所以走队列 + SSE，不阻塞 HTTP（D-01 §3.2 规则 2）。
  // targetId 用模型 id：正在下载同一个模型时会被去重掉，这正是我们想要的
  // —— 没下完的东西没有校验的意义。
  const { job, deduplicated } = state.queue.enqueue(
    {
      kind: 'model',
      targetId: record.id,
      displayName: `校验 ${record.displayName}`,
      totalBytes: record.totalSizeBytes,
    },
    async (ctx) => {
      ctx.setStep('verifying');
      let hashedBefore = 0;
      const mismatched: string[] = [];

      for (let i = 0; i < record.files.length; i++) {
        const f = record.files[i];
        ctx.setFile(f.name, i, record.files.length);
        const abs = resolveInstalledFile(state.store.root, f);
        const result = await verifyFile(abs, f.sha256, f.sizeBytes, (hashed) => {
          ctx.progress({
            completedBytes: hashedBefore + hashed,
            totalBytes: record.totalSizeBytes,
            speedBps: 0,
            etaSeconds: null,
          });
        });
        hashedBefore += f.sizeBytes;
        if (!result.ok)
          mismatched.push(`${f.name}: 期望 ${result.expected}，实测 ${result.actual}`);
      }

      const updated: InstalledModel = {
        ...record,
        integrity: mismatched.length === 0 ? 'ok' : 'corrupt',
        verifiedAt: new Date().toISOString(),
      };
      /*
       * ★ T-149：写回**记录原来所在的那个桶**。按 role 算的话，旧布局下这一次校验会
       * 在新桶里写出**第二份**记录 —— 同一个模型在 `/api/models/installed` 里出现两次。
       */
      const bucket = (await state.bucketOfInstalled(record.id)) ?? roleToStoreKind(record.role);
      await state.store.writeManifest(bucket, record.id, updated);

      if (mismatched.length > 0) {
        // 抛出去让队列走 job.failed，前端才能拿到具体是哪个文件坏了
        throw new DownloadError(
          `integrity check failed: ${mismatched.join('; ')}`,
          'CHECKSUM_MISMATCH',
          true,
        );
      }
      state.publish(
        makeEvent('model.installed', topics.models(), {
          modelId: record.id,
          active: state.active[record.role] === record.id,
        }),
      );
    },
  );

  sendJson(res, 202, toPullResponse(job, deduplicated));
  return true;
}

/* -------------------------------- import --------------------------------- */

/** 从文件名推断量化等级。推断不出来就明说，不默认成 f16。 */
function inferQuantization(fileName: string): Quantization | null {
  const lower = fileName.toLowerCase();
  // 长的先匹配，否则 "q5_k_m" 会被 "q5_1" 之类的短串抢先命中
  const ordered = [...QUANTIZATIONS].sort((a, b) => b.length - a.length);
  return ordered.find((q) => lower.includes(q)) ?? null;
}

async function importModel(
  state: RestState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const body = await readBody(req);
  const kind = asString(body['kind']);
  const roleRaw = asString(body['role']);
  const role = MODEL_ROLES.find((r) => r === roleRaw);
  if (!role) {
    sendError(
      res,
      400,
      'BAD_REQUEST',
      `role must be one of ${MODEL_ROLES.join('|')}`,
      `role 必须是 ${MODEL_ROLES.join('、')} 之一`,
    );
    return true;
  }

  if (kind === 'hf_repo') {
    // 我们没有官方 SHA-256 可比对。"verified == installed" 是硬规则（ADR-004 决策 5），
    // 装一份无法校验的权重比不装更危险，所以明确拒绝而不是悄悄放行。
    sendError(
      res,
      501,
      'NOT_IMPLEMENTED',
      'hf_repo import needs an authoritative SHA-256 before anything may be installed',
      'HF 仓库导入尚未实现：没有官方 SHA-256 就无法校验，我们不安装未经校验的权重（ADR-004 决策 5）。可以先手动下载后用「本地文件」导入。',
    );
    return true;
  }

  if (kind !== 'local_file') {
    sendError(
      res,
      400,
      'BAD_REQUEST',
      'kind must be "local_file" or "hf_repo"',
      'kind 必须是 local_file 或 hf_repo',
    );
    return true;
  }

  const filePath = asString(body['path']);
  if (!filePath || !path.isAbsolute(filePath)) {
    sendError(res, 400, 'BAD_PATH', 'path must be absolute', '本地路径必须是绝对路径');
    return true;
  }

  let sizeBytes: number;
  try {
    const st = await fs.stat(filePath);
    if (!st.isFile()) throw new Error('not a regular file');
    sizeBytes = st.size;
  } catch {
    sendError(res, 404, 'NOT_FOUND', `cannot read ${filePath}`, `读不到文件：${filePath}`);
    return true;
  }

  const fileName = path.basename(filePath);
  const quantization = inferQuantization(fileName);
  if (!quantization) {
    sendError(
      res,
      400,
      'BAD_REQUEST',
      `cannot infer quantization from "${fileName}"`,
      `无法从文件名「${fileName}」推断量化等级。请把文件名改成包含量化标识（如 model-q5_0.gguf）再导入 —— 我们不会替你猜一个。`,
    );
    return true;
  }

  const modelId = `${role}/imported-${fileName.replace(/\.[^.]+$/, '')}`;
  const { job, deduplicated } = state.queue.enqueue(
    { kind: 'model', targetId: modelId, displayName: fileName, totalBytes: sizeBytes },
    async (ctx) => {
      // 1. 真实哈希（几 GB 的文件流式过一遍，恒定内存）
      ctx.setStep('verifying');
      ctx.setFile(fileName, 0, 1);
      const digest = await sha256File(filePath, sizeBytes, (hashed, total) => {
        ctx.progress({
          completedBytes: hashed,
          totalBytes: total,
          speedBps: 0,
          etaSeconds: null,
        });
      });

      // 2. 落进内容寻址 store：先写 .tmp 再 rename，保证 blob 要么完整要么不存在
      ctx.setStep('installing');
      const blobPath = state.store.blobPath(digest);
      if (!(await state.store.hasBlob(digest))) {
        const tmp = `${blobPath}.import.tmp`;
        await fs.copyFile(filePath, tmp);
        await fs.rename(tmp, blobPath);
      }
      const linked = await state.store.linkByName(roleToStoreKind(role), digest, fileName);

      // 3. 内存需求用 shared 里的**真实公式**算，不手打数字
      const ramRequiredMB =
        role === 'asr'
          ? whisperMemoryMB(sizeBytes, fileName)
          : Math.round((sizeBytes / 1e6) * 1.05) + LLM_GRAPH_OVERHEAD_MB;

      const record: InstalledModel = {
        schemaVersion: 1,
        id: modelId,
        groupId: modelId,
        role,
        displayName: fileName,
        quantization,
        totalSizeBytes: sizeBytes,
        installedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
        integrity: 'ok',
        files: [
          {
            role: 'weights',
            name: fileName,
            sha256: digest,
            sizeBytes,
            root: 'models' as const,
            relPath: toModelsRelPath(state.store.root, linked),
            path: linked,
          },
        ],
        requirements: {
          ramRequiredMB,
          // 没跑过显存探测，也没有 GGUF 头 —— 0 表示"未知"，绝不编一个数
          vramRequiredMB: 0,
          diskRequiredMB: Math.ceil((sizeBytes / 1e6) * 1.1),
          cpuFeatures: [],
          // LLM 走到这里时 KV cache 项无法计算（没有 GGUF 头），所以上面的
          // ramRequiredMB 是"零上下文"下的下限；0 如实表达了这一点。
          computedAtContext: role === 'llm' ? 0 : null,
        },
        license: { id: 'unknown', gated: false, url: '' },
        source: { provider: 'custom', repo: filePath, revision: 'local' },
        benchmark: null,
        catalogVersion: 'imported',
      };
      // T-149：与下载安装同一条纪律 —— 先把旧布局遗留的同 id 记录清掉，再写正确的桶。
      await state.dropInstalledRecord(modelId);
      await state.store.writeManifest(roleToStoreKind(role), modelId, record);

      state.publish(
        makeEvent('model.installed', topics.models(), {
          modelId,
          active: state.active[role] === modelId,
        }),
      );
      await state.emitStorageChanged();
    },
  );

  sendJson(res, 202, toPullResponse(job, deduplicated));
  return true;
}

/* ---------------------------------- gc ----------------------------------- */

const GC_TARGETS = ['orphan_blobs', 'stale_partials'] as const;
type GcTarget = (typeof GC_TARGETS)[number];

async function runGc(
  state: RestState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const body = await readBody(req);
  const requested = asStringArray(body['targets']);
  const targets: GcTarget[] =
    requested.length === 0 ? [...GC_TARGETS] : GC_TARGETS.filter((t) => requested.includes(t));

  if (targets.length === 0) {
    sendError(
      res,
      400,
      'BAD_REQUEST',
      `targets must contain one of ${GC_TARGETS.join('|')}`,
      `targets 只能包含 ${GC_TARGETS.join('、')}`,
    );
    return true;
  }

  const result: GcResponse = await state.store.collectGarbage(targets);
  await state.emitStorageChanged();
  sendJson(res, 200, result);
  return true;
}

/* ------------------------------- sources --------------------------------- */

async function selectSource(
  state: RestState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const body = await readBody(req);
  const raw = asString(body['provider']);
  const provider = raw === 'auto' ? 'auto' : PROVIDERS.find((p) => p === raw);
  if (!provider) {
    sendError(
      res,
      400,
      'BAD_REQUEST',
      `provider must be "auto" or one of ${PROVIDERS.join('|')}`,
      `provider 必须是 auto 或 ${PROVIDERS.join('、')} 之一`,
    );
    return true;
  }

  /*
   * ★ T-171（A-6）：`custom` 是一个**从来没有实现过的源**，现在明确拒绝它。
   *
   * 此前这里收一个 `baseUrl`：`provider==='custom'` 且没给 `baseUrl` → 400，
   * 给了 → 200，然后 `state.prefs.sourceBaseUrl = baseUrl` 落盘。
   * 但**全仓没有任何下载路径读过 `sourceBaseUrl`**，所以"给了 baseUrl"那一支
   * 才是坏的那一支：它返回 200、把 `sourceProvider='custom'` 存下来，
   * 而 `orderSourcesForDownload()`（`packages/downloader/src/probe.ts:139-143`）
   * 用 pinned 去 filter 镜像时**一个都匹配不上**（清单里没有任何 provider 为 custom
   * 的镜像），于是 `hit=[]`、返回未经排序的全表 —— 探针排序被静默关掉，
   * 下载还能跑，只是不再按实测吞吐选源。**没有任何地方会报错。**
   *
   * 也就是说这个端点此前有两支：一支 400，一支"看起来成功、实则悄悄降级"。
   * 两支都不是"自定义源"这个功能。所以不是补 `baseUrl` 的读取方，是**把这半个功能拆掉**：
   * 字段删掉，`custom` 在门口就拒绝，理由说清楚。
   *
   * ⚠️ `custom` 仍留在 `ProviderId` 里（`packages/shared/src/artifacts.ts`），
   *    因为那个联合类型还描述着清单里镜像的 `provider` 字段；
   *    这里拒的是"把它选成下载源"，不是把这个名字从类型系统里抹掉。
   */
  if (provider === 'custom') {
    sendError(
      res,
      400,
      'BAD_REQUEST',
      'provider "custom" is not implemented: no download path resolves a user-supplied base URL',
      '自定义源尚未实现：没有任何下载路径会使用用户填写的地址，选它只会静默关掉按实测速度选源',
    );
    return true;
  }

  state.prefs.sourceProvider = provider;
  await state.persistPrefs();
  sendJson(res, 200, state.buildSources());
  return true;
}

/* -------------------------------- helpers -------------------------------- */

function methodNotAllowed(res: ServerResponse, expected: string): boolean {
  sendError(res, 405, 'METHOD_NOT_ALLOWED', `use ${expected}`, '方法不允许');
  return true;
}
