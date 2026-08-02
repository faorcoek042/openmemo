/**
 * 代理设置（`/api/settings/proxy**`）。
 *
 * 后端能力早就做好了（`model-mgmt` 的 43/43），但**没有端点 = 用户点不到** ——
 * 对中文用户这是刚需：不配代理，Hugging Face / GitHub 根本连不上，
 * 而界面上只会显示"下载失败"，没有任何东西把这两件事联系起来。
 *
 * ## 两个测试是**两个独立动作**，不合并
 * - `POST /test`：我的代理**通不通**（对一个中立目标问一次）
 * - `POST /sources`：**该从哪个镜像拉**（跨源比较，慢但能用也是有用信息）
 * 合成一个按钮会把两个不同的问题压成一个红/绿结论，比较信息全丢。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  activeProxySummary,
  applyProxyConfig,
  measureDownloadSources,
  testProxyConnectivity,
} from '@openmemo/downloader';
import { ffmpegProxySupport } from '@openmemo/pipeline';
import {
  DEFAULT_PROXY_CONFIG,
  PROXY_MODES,
  redactProxyUrl,
  type ProxyConfig,
  type ProxyMode,
} from '@openmemo/shared';

import type { Repos } from '../../db/repos.js';
import { readJsonBody, sendError, sendJson } from '../respond.js';

const SETTING_KEY = 'proxy';

export interface ProxyRoutesDeps {
  readonly repos: Repos;
}

/** 从设置表读代理配置；没配过就是默认（`mode:'system'`，继承环境变量）。 */
export function readProxyConfig(repos: Repos): ProxyConfig {
  const row = repos.listSettings().find((r) => r.key === SETTING_KEY);
  if (!row) return DEFAULT_PROXY_CONFIG;
  try {
    const v = JSON.parse(row.value_json) as Partial<ProxyConfig>;
    return {
      mode: PROXY_MODES.includes(v.mode as ProxyMode) ? (v.mode as ProxyMode) : DEFAULT_PROXY_CONFIG.mode,
      httpProxy: typeof v.httpProxy === 'string' ? v.httpProxy : null,
      httpsProxy: typeof v.httpsProxy === 'string' ? v.httpsProxy : null,
      socks5: typeof v.socks5 === 'string' ? v.socks5 : null,
      noProxy: Array.isArray(v.noProxy) ? v.noProxy.filter((x) => typeof x === 'string') : [],
    };
  } catch {
    return DEFAULT_PROXY_CONFIG;
  }
}

/** 当前实际会用到的那个代理 URL（socks5 优先，与 `proxyUrlFor` 的取舍一致）。 */
function effectiveUrl(cfg: ProxyConfig): string | null {
  if (cfg.mode !== 'manual') return null;
  return cfg.socks5 ?? cfg.httpsProxy ?? cfg.httpProxy ?? null;
}

/**
 * ffmpeg 的代理能力**必须如实透出**。
 *
 * `gpu-runtime` 实测：libavformat 只读 `http_proxy`，**完全不支持 SOCKS**。
 * 所以用户填了 SOCKS5 时，模型下载走代理、但**媒体拉流会直连** ——
 * 不说的话用户会以为"全都走代理了"，然后在一个能上网的机器上遇到只有拉流失败，
 * 且没有任何线索指向代理。这正是要避免的那种沉默错配。
 */
function mediaCaveat(cfg: ProxyConfig): {
  supported: boolean;
  reason: string | null;
  noteZh: string | null;
} {
  const url = effectiveUrl(cfg);
  const s = ffmpegProxySupport(url ? { url } : null);
  return {
    supported: s.supported,
    reason: s.reason,
    noteZh: s.supported
      ? null
      : 'ffmpeg 不支持 SOCKS 代理（libavformat 只识别 http_proxy）。选择 SOCKS 时，模型下载会走代理，但**在线媒体拉流会直连**。如需媒体也走代理，请改填 HTTP 代理地址。',
  };
}

function publicView(cfg: ProxyConfig): Record<string, unknown> {
  return {
    mode: cfg.mode,
    // 凭据可能内嵌在 URL 里，出站一律脱敏 —— 设置页不需要看到密码
    httpProxy: redactProxyUrl(cfg.httpProxy),
    httpsProxy: redactProxyUrl(cfg.httpsProxy),
    socks5: redactProxyUrl(cfg.socks5),
    noProxy: cfg.noProxy,
  };
}

export function createProxyRoutes(deps: ProxyRoutesDeps): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
} {
  const { repos } = deps;

  return {
    async handle(req, res, url, method): Promise<boolean> {
      const p = url.pathname;
      if (!p.startsWith('/api/settings/proxy')) return false;

      // ---- 读 ----
      if (p === '/api/settings/proxy' && method === 'GET') {
        const cfg = readProxyConfig(repos);
        sendJson(res, 200, {
          config: publicView(cfg),
          /** 进程里**实际生效**的那一份（可能与配置不同：改完没应用就会不一致）。 */
          active: activeProxySummary(),
          media: mediaCaveat(cfg),
          modes: PROXY_MODES,
          defaultModeZh: '默认「跟随系统」：不填也会继承系统/环境变量里的代理设置。',
        });
        return true;
      }

      // ---- 写 ----
      if (p === '/api/settings/proxy' && method === 'PATCH') {
        const body = (await readJsonBody(req).catch(() => undefined)) as
          | Partial<ProxyConfig>
          | undefined;
        if (!body || typeof body !== 'object') {
          sendError(res, 400, 'BAD_REQUEST', 'body required', '请求体不能为空');
          return true;
        }
        const current = readProxyConfig(repos);
        const mode = body.mode ?? current.mode;
        if (!PROXY_MODES.includes(mode as ProxyMode)) {
          sendError(
            res,
            400,
            'INVALID_MODE',
            `mode must be one of ${PROXY_MODES.join(', ')}`,
            `代理模式必须是 ${PROXY_MODES.join(' / ')} 之一`,
          );
          return true;
        }
        const next: ProxyConfig = {
          mode: mode as ProxyMode,
          httpProxy: body.httpProxy !== undefined ? (body.httpProxy ?? null) : current.httpProxy,
          httpsProxy: body.httpsProxy !== undefined ? (body.httpsProxy ?? null) : current.httpsProxy,
          socks5: body.socks5 !== undefined ? (body.socks5 ?? null) : current.socks5,
          noProxy: Array.isArray(body.noProxy) ? body.noProxy : current.noProxy,
        };

        repos.upsertSettings([{ key: SETTING_KEY, valueJson: JSON.stringify(next) }]);
        /*
         * 立刻应用，**不要求重启**：`setGlobalDispatcher` 是一处接全局的，
         * 改完马上生效。让用户改个代理还要重启，等于把问题又推回命令行那一侧。
         */
        applyProxyConfig(next);

        sendJson(res, 200, {
          config: publicView(next),
          active: activeProxySummary(),
          media: mediaCaveat(next),
          appliedImmediately: true,
        });
        return true;
      }

      // ---- 测试 1：代理本身通不通 ----
      if (p === '/api/settings/proxy/test' && method === 'POST') {
        const cfg = readProxyConfig(repos);
        const report = await testProxyConnectivity(cfg);
        // 报告"不通"不是 HTTP 错误 —— 200 + ok:false，让前端渲染每一行探针
        sendJson(res, 200, { ...report, media: mediaCaveat(cfg) });
        return true;
      }

      // ---- 测试 2：该从哪个源拉（独立动作）----
      if (p === '/api/settings/proxy/sources' && method === 'POST') {
        const cfg = readProxyConfig(repos);
        sendJson(res, 200, await measureDownloadSources(cfg));
        return true;
      }

      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'unsupported method', '方法不允许');
      return true;
    },
  };
}
