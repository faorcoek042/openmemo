/**
 * `POST /api/llm/detect` 与 `POST /api/llm/models`（T-153，D-10 #23 / #26）。
 *
 * ─── 为什么这两条端点非有不可 ────────────────────────────────────────────────────
 *
 * **① `/api/llm/detect`** —— ADR-003 档 2「复用用户已经装好的本地 LLM」。
 * 探测逻辑 `detectLocalBackends()` **两年前就写好了**，但它只在
 * `jobs/runners/mindmap.ts` 与 `rest/selfcheck.ts` 内部被调用 —— **前端够不着**。
 * 后果不是"少一个功能"，是**档 2 在界面上等于没做**：
 * 用户装了 Ollama，产品自己在后台探得到，却要他去设置页手填一个 IP 和端口，
 * 而他多半不知道那两个数字是什么。`frontend-truth` T-150 因为这条端点不存在，
 * D-10 六项里第 6 项（#3 探测式本地模型）**整条卡死**，做出来只能是个假按钮。
 *
 * **② `/api/llm/models`** —— D-10 #26「刷新模型列表」的另一半。
 * 目录里 24 家有 4 家（openrouter / siliconcloud / ollama / lmstudio）声明了
 * 可枚举端点，但**本机没有任何东西能替前端去调它**（跨域 + 要 Key）。
 * 所以 T-150 把 #26 做成了"措辞三档、一个按钮都不给"，并如实标为
 * **本轮唯一一处偏离规格**。那个诚实是对的 —— 现在把缺的那一半补上，
 * 按钮才有资格存在。
 *
 * ─── 判据：**真发请求确认，不是端口开着** ────────────────────────────────────────
 *
 * `mindmap.ts:9` 与 `packages/llm/src/detect.ts` 的文件头都写着这一条，它来自 R-02：
 * 端口开着可能是别的服务、可能是僵尸进程、可能是代理。所以每个候选要过三关：
 * `/models` 返回 2xx → 是合法 JSON 且有 `data` 数组 → **`data` 里至少有一个模型**。
 * 判据在 `packages/llm/src/detect.ts` 里，本文件**一条判据都不复制** ——
 * 与 `rest/selfcheck.ts` 的做法一致（一份实现，多个出口）。
 *
 * ─── 为什么是 POST 而不是 GET ───────────────────────────────────────────────────
 *
 * 两条都会**真的发网络请求**（探测三个本机端口 / 打一次厂商 API）。
 * GET 会被浏览器与各种中间层当成可缓存、可预取、可重放的东西 ——
 * 一个"被预取就会去敲三个端口"的端点不是 GET。
 * 同理它们**不设 `refetchInterval`**（T-150 ① 已经为自检定过同一条：
 * 每 15 秒替用户跑一遍，是拿他的 CPU 换一个他没在看的数字）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { DEFAULT_CANDIDATES, detectLocalBackends } from '@openmemo/llm';
import type { LlmDetectResponse } from '@openmemo/shared';
import type { DatabaseHandle } from '@openmemo/db';

import { listProviderModels } from '../../llm/enumerate.js';
import { readJsonBody, sendError, sendJson } from '../respond.js';

export interface LlmRoutesDeps {
  readonly db: DatabaseHandle;
  /** `AppPaths.dataDir` —— `SecretStore` 的根。**明文永不出 `llm/` 那一层。** */
  readonly dataDir: string;
  /** `vendor/manifests` —— provider 目录（`llm-providers.json`）在这里。 */
  readonly manifestDir: string;
}

/**
 * 单个候选的探测超时。
 *
 * D-10 §4.2 的线框上写的是「各 2 秒超时」，这里就是那 2 秒 ——
 * 它会随响应发回前端，让界面**照着实际值**说，而不是把 "2 秒" 抄进文案里。
 * （抄进文案 = 又一处"两边各写一份，改一边不改另一边"。）
 */
const DETECT_TIMEOUT_MS = 2000;

export function createLlmRoutes(deps: LlmRoutesDeps): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
} {
  return {
    async handle(req, res, url, method): Promise<boolean> {
      const p = url.pathname;
      if (p !== '/api/llm/detect' && p !== '/api/llm/models') return false;
      if (method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use POST', '方法不允许');
        return true;
      }

      if (p === '/api/llm/detect') {
        const detected = await detectLocalBackends({ timeoutMs: DETECT_TIMEOUT_MS });
        /*
         * ★ `probed` 必须一起回。只回 `detected: []` 的话，界面只能说"没探到"，
         * 而用户真正需要知道的是**我们去敲了哪几个门** —— 那才判断得出
         * "我的 Ollama 改过端口"还是"我压根没装"。空结果必须自带它的量程。
         */
        const body: LlmDetectResponse = {
          probed: DEFAULT_CANDIDATES.map((c) => ({
            id: c.id,
            label: c.label,
            baseUrl: c.baseUrl,
          })),
          detected: detected.map((d) => ({
            id: d.id,
            label: d.label,
            baseUrl: d.baseUrl,
            models: [...d.models],
            latencyMs: d.latencyMs,
          })),
          timeoutMs: DETECT_TIMEOUT_MS,
          probedAt: new Date().toISOString(),
        };
        // 一个都没探到**不是 HTTP 错误** —— "这台机器上没装本地 LLM" 是完全正常的状态。
        sendJson(res, 200, body);
        return true;
      }

      // ---- POST /api/llm/models ----
      const raw = (await readJsonBody(req).catch(() => undefined)) as
        { providerId?: unknown } | undefined;
      const providerId = typeof raw?.providerId === 'string' ? raw.providerId.trim() : '';
      if (!providerId) {
        sendError(res, 400, 'BAD_REQUEST', 'providerId is required', '缺少 providerId');
        return true;
      }

      const out = await listProviderModels(deps.db, deps.dataDir, deps.manifestDir, providerId);
      if (out.ok) {
        sendJson(res, 200, out.value);
        return true;
      }

      /*
       * 每一档都要说清**下一步能做什么**（ADR-007 决策 2）。
       * 尤其是 `not-enumerable`：那不是故障，是"这家的清单本来就是人工转录的"——
       * 把它报成一个笼统的失败，用户会去反复点刷新。
       */
      const f = out.failure;
      switch (f.kind) {
        case 'unknown-provider':
          sendError(
            res,
            404,
            'PROVIDER_UNKNOWN',
            `no provider ${f.providerId} in the bundled catalog`,
            `内置目录里没有「${f.providerId}」这家 —— 自定义网关的模型清单只能手填（下拉里的「自定义…」）。`,
          );
          return true;
        case 'not-enumerable':
          sendError(
            res,
            400,
            'PROVIDER_NOT_ENUMERABLE',
            `provider ${f.providerId} publishes no model-list endpoint`,
            `「${f.providerId}」没有可枚举的模型列表接口 —— 内置清单是人工从官方文档转录的` +
              `${f.checkedAt ? `（核对于 ${f.checkedAt}）` : ''}，只能等我们更新，或用「自定义…」直接填型号。`,
          );
          return true;
        case 'no-base-url':
          sendError(
            res,
            400,
            'PROVIDER_NO_BASE_URL',
            `no base URL configured for ${f.providerId}`,
            `还不知道「${f.providerId}」的接口地址。请先在这家的表单里填好地址并保存 —— ` +
              `刷新用的是**已保存的**地址，不是输入框里还没保存的那个。`,
          );
          return true;
        case 'request-failed':
          /*
           * 502 而不是 500：坏的是上游，不是我们。`retryable: true` ——
           * 这一类多半是网络/限流，前端该给"重试"而不是让用户去改配置。
           */
          sendError(
            res,
            502,
            'PROVIDER_REQUEST_FAILED',
            `${f.endpoint}: ${f.detail}`,
            `向「${f.providerId}」要模型列表失败：${f.detail}（地址 ${f.endpoint}）`,
            { retryable: true },
          );
          return true;
      }
    },
  };
}
