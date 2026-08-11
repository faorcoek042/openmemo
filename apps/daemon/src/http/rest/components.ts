/**
 * 组件清单与更新（`/api/components**`）。
 *
 * 回答用户直接问过的两件事：
 *   1.「这个东西是从哪来的」→ 每个组件都带 provenance（上游仓库 / release 页 / 许可证 /
 *      vendor 子模块 commit），UI 直接显示，不埋在 JSON 里。
 *   2.「检测上游对应版本然后灵活更新各个组件」→ 每个组件记录了怎么查它的上游。
 *
 * ## 钉版本与可更新并不矛盾
 * manifest 永远钉死 version + sha256；**检查更新只报告"上游有更新的钉"，绝不自己动**。
 * 自动更新在这里是有害的：上游一次发布就可能换格式
 * （我们已经踩过 VAD 条目 ONNX 换 ggml 静默搞坏 whisper.cpp），
 * 静默更新会让用户的转写结果无缘无故变样。所以**必须由用户点一下**。
 *
 * ## 诚实边界
 * `latestVersion` 查不到时是 `null` 且带 `checkError`，**绝不退化成"已是最新"** ——
 * "不知道"和"最新"是两件事，混在一起就是又一个假绿灯。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { listComponents } from '@openmemo/downloader';
import type { GetComponentsResponse } from '@openmemo/shared';

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sendError, sendJson } from '../respond.js';
import { startPackInstall } from './backends.js';
import { decodePathSegment, readBody } from './request.js';
import type { RestState } from './state.js';

export interface ComponentRoutesDeps {
  /** 组件清单（git 里钉死的那份）。 */
  readonly registryPath: string;
}

/**
 * 找到 `vendor/manifests/components.json`。
 *
 * 允许用 `OPENMEMO_COMPONENTS_MANIFEST` 覆盖（打包后布局会变）。
 * 找不到时**不抛** —— 组件页面拿不到清单只是少一块信息，
 * 不该因此让整个 /api/models 路由挂掉。
 */
export function resolveComponentRegistryPath(): string {
  const override = process.env['OPENMEMO_COMPONENTS_MANIFEST'];
  if (override) return override;
  // dist/http/rest/ → 上溯 5 层到仓库根
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(
    join(here, '..', '..', '..', '..', '..', 'vendor', 'manifests', 'components.json'),
  );
}

/** 上游查询的超时。查不到不是错误，只是 latestVersion 为 null。 */
const UPSTREAM_TIMEOUT_MS = 8000;

export function createComponentRoutes(deps: ComponentRoutesDeps): {
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    state: RestState,
  ): Promise<boolean>;
} {
  const load = (state: RestState, checkUpstream: boolean): Promise<GetComponentsResponse> =>
    listComponents({
      registryPath: deps.registryPath,
      store: state.store,
      checkUpstream,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      ...(process.env['GITHUB_TOKEN'] ? { token: process.env['GITHUB_TOKEN'] } : {}),
    });

  return {
    async handle(req, res, url, method, state): Promise<boolean> {
      const path = url.pathname;
      if (!path.startsWith('/api/components')) return false;

      // ---- 1. 列表：默认不查网络，秒回 ----
      if (path === '/api/components' && method === 'GET') {
        // ?check=1 时顺带查上游（会慢，取决于网络）
        const check = url.searchParams.get('check') === '1';
        sendJson(res, 200, await load(state, check));
        return true;
      }

      // ---- 2. 检查更新：显式查上游 ----
      if (path === '/api/components/check' && method === 'POST') {
        const body = (await readBody(req).catch(() => undefined)) as { ids?: unknown } | undefined;
        const all = await load(state, true);
        const ids = Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === 'string') : null;
        sendJson(res, 200, {
          ...all,
          components: ids ? all.components.filter((c) => ids.includes(c.id)) : all.components,
        });
        return true;
      }

      const m = /^\/api\/components\/([^/]+)\/update$/.exec(path);
      if (m && method === 'POST') {
        const id = decodePathSegment(m[1] ?? '');
        const current = await load(state, false);
        const comp = current.components.find((c) => c.id === id);
        if (!comp) {
          sendError(res, 404, 'NOT_FOUND', `unknown component: ${id}`, '找不到该组件');
          return true;
        }

        /*
         * ---- 3. 更新 ----
         *
         * ★ 诚实边界：**更新 = 安装清单里钉死的那个版本**。
         *
         * `ComponentRecord` 只有 sha256，**没有下载 URL** —— URL 在后端包/模型目录里。
         *
         * ⚠️ 这里原来还写着"上游报了个更新的 tag，并不等于我们手上有它的 sha256"。
         * **那句今天已经不成立**：`[实测 2026-08-11]` GitHub releases API 直接给出每个
         * 资产的 sha256 digest（`assets[].digest`），实测 whisper.cpp v1.9.2 **9/9**、
         * yt-dlp 2026.07.04 **24/24**、我们自己的镜像仓 v0.7.0 **3/3** 全覆盖，
         * 而 `packages/downloader/src/upstream.ts` 的 `toRelease()` 已经在解析它。
         *
         * 真正站得住的理由是另一条：**那个摘要与"上游有新版本"这句话来自同一个来源** ——
         * 它能证明你下到的字节没在路上被改，**不能证明那个来源本身没问题**；
         * 而目录里钉的那一版，其 sha256 是我们本机下载后独立复算过的
         * （仓里已有的词：`sha256Provenance` 的「上游 API 提供」vs「本机独立复算」）。
         * 外加上面那条：我们手上根本没有上游那一版的下载 URL 与资产命名映射。
         * 所以**不假装能一键升到任意上游版本**。
         *
         * 能做的是真的：把组件 id 映射回后端包目录，走与
         * `POST /api/backends/:id/install` **完全同一条**安装通道
         * （同样的 SHA-256 校验、断点续传、镜像切换），并复用同一个下载队列。
         */
        const pack = state.findCatalogPack(id);
        if (pack) {
          const { job, deduplicated } = startPackInstall(state, pack);
          sendJson(res, 202, {
            ok: true,
            id,
            toVersion: comp.pinnedVersion,
            jobId: job.jobId,
            deduplicated,
          });
          return true;
        }

        /*
         * 映射不到安装通道（例如 model 类组件走的是模型目录）。
         * 这里**明确回 409 并说清原因**，而不是回一个假的 202 让 UI 转圈等一个
         * 永远不会来的完成事件 —— 那正是"看起来在工作"的假绿灯。
         */
        sendError(
          res,
          409,
          'NO_INSTALL_CHANNEL',
          `component ${id} (category=${comp.category}) has no pack in the backend catalog; ` +
            `install it from its own catalog endpoint`,
          comp.category === 'model'
            ? '模型组件请从模型库安装（/api/models），此处不重复实现'
            : '该组件在后端目录里没有对应的包，无法从这里安装',
        );
        return true;
      }

      return false;
    },
  };
}
