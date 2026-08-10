/**
 * `GET /api/updates/check` —— D-20 §17 的"检测更新"落地。
 *
 * ⚠️ 硬约束（D-20 §11.3 末行）：**只回答"有没有新版本"，不下载、不安装、不改任何本地
 * 状态**。本文件只有一个 GET 路由，不接受任何请求体，`checkForUpdates()`
 * （`@openmemo/downloader`）本身也没有任何写入能力 —— 见该文件头注释。
 *
 * ══ 三条前提（D-20 §11.3）在这里怎么落地 ══════════════════════════════════════════
 *
 * 1. **签名 + 客户端钉死公钥** —— 交给 `checkForUpdates()` 内部的
 *    `resolveConfiguredCatalogPublicKey()` + `verifyCatalogSignatureSafe()`。
 * 2. **验不过回退到包内那份，而不是"没有目录"** —— 本端点**从不重新加载**
 *    `loadModelCatalog()` 已经读出的本地目录；`checkForUpdates()` 的任何失败分支都只
 *    影响它自己返回的 `newOrChanged: []`，本地目录该怎么服务前端、组件页/模型页
 *    还怎么服务，一个字节都不受影响。真正的"没有目录"只可能来自
 *    `local.loadError`（`listManifestFiles()` 读不了 `vendor/manifests` 本身）——
 *    那是另一件事，本端点如实转达而不是把它跟"查更新失败"混成一种结果。
 * 3. **不许改已内置项的 sha256** —— 传入 `BUNDLED_MODEL_IDS` 作为钉死集合。
 *
 * ══ 今天为什么大概率回 `not-configured` ═══════════════════════════════════════════
 *
 * `OPENMEMO_CATALOG_UPDATE_URL` / `OPENMEMO_CATALOG_UPDATE_SIG_URL` 在生产里未设 ——
 * 没有真实的远端目录可问（没有服务器托管一份签过名的 `vendor/manifests`）。
 * 这不是半成品：未设时诚实返回 `source: 'not-configured'`，不假装查过、不报错。
 * 给用户的完整生成/签名/配置命令见 `docs/design/D-20-bundled-deps.md` §17。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import process from 'node:process';

import { checkForUpdates, type CatalogUpdateResult } from '@openmemo/downloader';
import { ALLOWED_DOWNLOAD_HOSTS, BUNDLED_MODEL_IDS, validateModelManifest } from '@openmemo/shared';
import type { ModelEntry } from '@openmemo/shared';

import { sendError, sendJson } from '../respond.js';
import { loadModelCatalog, resolveManifestDir } from './manifests.js';

export interface UpdateRoutesDeps {
  /** 覆盖自动探测的清单目录，测试用；不传则用 `resolveManifestDir()`。 */
  readonly manifestDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

const EMPTY_RESULT_FIELDS = {
  newOrChanged: [] as const,
  rejectedBundledTampering: [] as const,
};

export function createUpdateRoutes(deps: UpdateRoutesDeps = {}): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
} {
  return {
    async handle(_req, res, url, method): Promise<boolean> {
      if (url.pathname !== '/api/updates/check') return false;
      if (method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET', '方法不允许');
        return true;
      }

      const env = deps.env ?? process.env;
      const manifestDir = deps.manifestDir ?? resolveManifestDir();
      const local = await loadModelCatalog(manifestDir);

      // 本地目录自己读不了：这是 loadModelCatalog 的三态错误（T-153），与"有没有更新"
      // 是两件事，不能把两者混成同一种失败——如实转达，不假装查过更新。
      if (local.loadError) {
        const result: CatalogUpdateResult = {
          source: 'not-configured',
          checkedAt: new Date().toISOString(),
          detail: `本地目录都没读到（${local.loadError.code}: ${local.loadError.message}），跳过更新检查`,
          ...EMPTY_RESULT_FIELDS,
        };
        sendJson(res, 200, result);
        return true;
      }

      const result = await checkForUpdates<ModelEntry>({
        catalogUrl: env['OPENMEMO_CATALOG_UPDATE_URL'],
        signatureUrl: env['OPENMEMO_CATALOG_UPDATE_SIG_URL'],
        localEntries: local.models,
        bundledIds: new Set<string>(BUNDLED_MODEL_IDS),
        allowedHosts: ALLOWED_DOWNLOAD_HOSTS,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        parseCatalog: (raw) => {
          const checked = validateModelManifest(raw);
          if (!checked.ok) return null;
          return (raw as { models: ModelEntry[] }).models;
        },
      });

      sendJson(res, 200, result);
      return true;
    },
  };
}
