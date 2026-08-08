/**
 * 枚举某家 provider **现在真正有哪些模型**（D-10 #26 的服务端一半）。
 *
 * ─── 为什么这个文件不在 `http/rest/` 里 ──────────────────────────────────────────
 *
 * 因为它要用 API Key。`SecretStore` **刻意不给路由层用**（`rest/settings.ts` 只调
 * `list()`，拿到的是掩码），理由写在 `components/common/llm/api.ts` 的文件头：
 * 「能回显的」和「永远不该回显的」放进不同的存储与不同的接口。
 * 所以这里与 `resolve.ts` 同层：**明文进得来，出不去** ——
 * 本模块的返回值里只有模型 id 与一个脱敏过的地址，路由层永远看不到 Key。
 *
 * ─── 为什么不接受前端传来的 baseUrl（这条是安全边界，不是懒）─────────────────────
 *
 * 一个"接受任意 URL 然后去 fetch"的端点，就是一个从浏览器可达的 SSRF 原语 ——
 * 而且它还会**带上用户的 API Key**。地址一律从服务端解析：
 *
 *   1. `settings['llm.baseUrl.<id>']`（用户自己配的那个）
 *   2. 目录里这家的 `modelListSource.url` / `baseUrl.default`
 *
 * 两者都是用户已经在界面上确认过的地方。**请求体里的 `baseUrl` 一概不看。**
 * 代价是"还没保存就想刷新"刷不了 —— 那个代价换的是"这个端点不能被用来打内网"。
 *
 * ⚠️ 常规的 SSRF 私网拦截（`argGuard.assertHostNotPrivate`）在这里**用不了**：
 * 能枚举的 4 家里有 2 家（ollama / lmstudio）**本来就在回环地址上**，
 * 那条守卫会把要支持的东西恰好挡掉。所以边界只能立在"地址从哪来"，不在"地址长什么样"。
 */
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { SecretStore } from '@openmemo/llm/secrets';
import type { LlmProviderCatalog, LlmProviderSpec, LlmModelsResponse } from '@openmemo/shared';
import { canRefreshModelList } from '@openmemo/shared';
import type { DatabaseHandle } from '@openmemo/db';

/** 枚举失败的分类。路由层据此选 HTTP 状态码与文案，不自己猜。 */
export type EnumerateFailure =
  /** 目录里没有这家 —— 自定义网关等，我们不知道它的接口形状 */
  | { kind: 'unknown-provider'; providerId: string }
  /** 这家的清单是人工从文档转录的（`official-doc`），**根本没有端点可调** */
  | { kind: 'not-enumerable'; providerId: string; checkedAt: string | null }
  /** 有端点，但我们解析不出一个地址来（目录没给默认值、用户也没配） */
  | { kind: 'no-base-url'; providerId: string }
  /** 真发了请求，但对面不给 —— 原因原样带回去（含 HTTP 状态） */
  | { kind: 'request-failed'; providerId: string; endpoint: string; detail: string };

export type EnumerateResult =
  { ok: true; value: LlmModelsResponse } | { ok: false; failure: EnumerateFailure };

let cachedCatalog: LlmProviderCatalog | null = null;

/**
 * 读 `vendor/manifests/llm-providers.json`。
 *
 * `rest/manifests.ts` 的 `classifyManifest()` 只认 `models` / `packs` 两种顶层数组，
 * 这份是 `providers` —— 它**一直被那个加载器跳过**，所以这里自己读。
 * （不去改那个加载器：它的返回类型是 `ModelCatalog`，硬塞进去会让"模型目录"
 * 里混进 provider，是另一种同名不同物。）
 */
export async function loadProviderCatalog(manifestDir: string): Promise<LlmProviderCatalog | null> {
  if (cachedCatalog) return cachedCatalog;
  try {
    const raw = JSON.parse(
      await readFile(path.join(manifestDir, 'llm-providers.json'), 'utf8'),
    ) as LlmProviderCatalog;
    if (!Array.isArray(raw.providers)) return null;
    cachedCatalog = raw;
    return raw;
  } catch {
    return null;
  }
}

function readSetting(db: DatabaseHandle, key: string): unknown {
  try {
    const row = db
      .prepare<{ value_json: string }>('SELECT value_json FROM settings WHERE key = :k')
      .get({ k: key });
    return row ? JSON.parse(row.value_json) : undefined;
  } catch {
    return undefined;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * 该 provider 的 OpenAI 兼容 `/models` 端点。
 *
 * ⚠️ 与前端 `llm-catalog.ts` 的 `adapterBaseUrl()` 是**同一个问题的两半**：
 * 目录里的 `baseUrl.default` 是厂商文档上的地址，不一定是我们该收的那个。
 * Ollama 给的是原生 API 的根（`:11434`），它的 OpenAI 兼容面在 `/v1` 下。
 */
export function modelsEndpointFor(
  spec: LlmProviderSpec,
  configuredBaseUrl?: string,
): string | null {
  const base = (configuredBaseUrl ?? spec.baseUrl.default ?? '').replace(/\/+$/, '');
  if (!base) return null;
  // Ollama 原生根 → 补 `/v1`（`:11434/api/tags` 也能列，但那是另一套响应形状）
  const normalised =
    spec.kind === 'ollama-native' && !/\/v\d+(\b|$)/.test(base) ? `${base}/v1` : base;
  return `${normalised}/models`;
}

/**
 * 真去枚举一次。
 *
 * @param fetchImpl 注入点 —— 测试用它来断言"我们发出去的到底是什么"，
 *                  而不是靠起一个真服务器。默认是全局 `fetch`。
 */
export async function listProviderModels(
  db: DatabaseHandle,
  dataDir: string,
  manifestDir: string,
  providerId: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<EnumerateResult> {
  const catalog = await loadProviderCatalog(manifestDir);
  const spec = catalog?.providers.find((p) => p.id === providerId);
  if (!spec) return { ok: false, failure: { kind: 'unknown-provider', providerId } };

  /*
   * ★ 判据取 `canRefreshModelList()`，**不在这里自己判 provider 类型**（D-10 R-P2 的原话）。
   * 前端也调同一个函数决定要不要画按钮 —— 两边判据必须是同一份，
   * 否则会出现"按钮在、后端说不支持"或反过来。
   */
  if (!canRefreshModelList(spec)) {
    return {
      ok: false,
      failure: {
        kind: 'not-enumerable',
        providerId,
        checkedAt: spec.modelListSource.checkedAt ?? null,
      },
    };
  }

  const endpoint = modelsEndpointFor(spec, asString(readSetting(db, `llm.baseUrl.${providerId}`)));
  if (!endpoint) return { ok: false, failure: { kind: 'no-base-url', providerId } };

  const apiKey = new SecretStore(dataDir).get(`llm.${providerId}.apiKey`);
  const headers: Record<string, string> = { accept: 'application/json' };
  // 没有 Key 也要试：openrouter 的 /models 是公开的，ollama / lmstudio 不收 Key。
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(endpoint, {
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!res.ok) {
      return {
        ok: false,
        failure: {
          kind: 'request-failed',
          providerId,
          endpoint,
          detail: `HTTP ${String(res.status)}`,
        },
      };
    }
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) {
      return {
        ok: false,
        failure: {
          kind: 'request-failed',
          providerId,
          endpoint,
          detail: '响应里没有 data 数组（不是 OpenAI 兼容的 /models 形状）',
        },
      };
    }
    const models = [
      ...new Set(
        body.data
          .map((m) => (m as { id?: unknown }).id)
          .filter((x): x is string => typeof x === 'string' && x.length > 0),
      ),
    ].sort();

    /*
     * ★ 枚举到 0 个 **不算成功**。
     *
     * 回一个空清单，界面上就是"刷新完模型下拉空了" —— 用户会以为自己的账号没有模型，
     * 而真实原因多半是地址配错或对面换了响应形状。⑤A-2 同族：
     * **空集必须自带解释，不能被读成"一切正常"。**
     */
    if (models.length === 0) {
      return {
        ok: false,
        failure: {
          kind: 'request-failed',
          providerId,
          endpoint,
          detail: '对面返回了 0 个模型 —— 多半是地址或凭据不对，而不是这家真的没有模型',
        },
      };
    }

    return {
      ok: true,
      value: { providerId, endpoint, models, fetchedAt: new Date().toISOString() },
    };
  } catch (err) {
    return {
      ok: false,
      failure: {
        kind: 'request-failed',
        providerId,
        endpoint,
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/** 仅供测试：清掉目录缓存。 */
export function __resetProviderCatalogCache(): void {
  cachedCatalog = null;
}
