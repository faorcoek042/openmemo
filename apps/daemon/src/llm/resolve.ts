/**
 * 从设置 + 密钥库解析出一个 LLM provider（ADR-003 档 1：BYO API Key）。
 *
 * 读取约定（D-02 §1.2 的 `settings` 键命名空间）：
 *   settings: `llm.defaultProviderId` / `llm.defaultModelId` / `llm.baseUrl.<provider>`
 *   secrets : `llm.<provider>.apiKey`
 *
 * 没配置就返回 `undefined` —— 调用方会退到档 2（本机探测）或把 job 转 `blocked`。
 * **不在这里抛异常**：没配 LLM 是正常状态（F1/F2/F3 都不需要 LLM，只有 F4 需要）。
 */
import {
  AnthropicProvider,
  GeminiProvider,
  OpenAiCompatibleProvider,
  type LlmProvider,
  type LlmPurpose,
  type PurposeBindings,
} from '@openmemo/llm';
import { SecretStore } from '@openmemo/llm/secrets';
import type { DatabaseHandle } from '@openmemo/db';

function readSetting(db: DatabaseHandle, key: string): unknown {
  const row = db
    .prepare<{ value_json: string }>(`SELECT value_json FROM settings WHERE key = :k`)
    .get({ k: key });
  if (!row) return undefined;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return undefined;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * 读某个用途绑定的 provider/model；**缺项逐字段回退到默认配置**。
 *
 * 逐字段而不是整体回退：用户很可能只给"翻译"换了个便宜模型、provider 还用同一个。
 * 整体回退会让"只填了 model"这种最常见的填法直接失效，而且没有任何提示。
 */
function bindingFor(
  db: DatabaseHandle,
  purpose: LlmPurpose | undefined,
): { providerId?: string; model?: string } {
  const defProvider = asString(readSetting(db, 'llm.defaultProviderId'));
  const defModel = asString(readSetting(db, 'llm.defaultModelId'));
  if (!purpose) return { ...(defProvider ? { providerId: defProvider } : {}), ...(defModel ? { model: defModel } : {}) };

  const all = readSetting(db, 'llm.purposes');
  const b = (all && typeof all === 'object' ? (all as PurposeBindings)[purpose] : undefined) ?? {};
  const providerId = asString(b.providerId) ?? defProvider;
  const model = asString(b.model) ?? defModel;
  return { ...(providerId ? { providerId } : {}), ...(model ? { model } : {}) };
}

export function resolveConfiguredProvider(
  db: DatabaseHandle,
  dataDir: string,
  /** 按用途取（chat / summarize / translate）。不传 = 用全局默认，老行为不变。 */
  purpose?: LlmPurpose,
): Promise<LlmProvider | undefined> {
  const bound = bindingFor(db, purpose);
  const providerId = bound.providerId;
  if (!providerId) return Promise.resolve(undefined);

  const model = bound.model;
  if (!model) return Promise.resolve(undefined);

  const baseUrl = asString(readSetting(db, `llm.baseUrl.${providerId}`));
  const store = new SecretStore(dataDir);
  const apiKey = store.get(`llm.${providerId}.apiKey`);

  if (providerId === 'gemini') {
    // Gemini 同样没有本地形态，缺 key 等于没配
    if (!apiKey) return Promise.resolve(undefined);
    return Promise.resolve(
      new GeminiProvider({
        id: providerId,
        label: 'Google Gemini',
        baseUrl: baseUrl ?? 'https://generativelanguage.googleapis.com',
        apiKey,
        model,
        timeoutMs: 300_000,
      }),
    );
  }

  if (providerId === 'anthropic') {
    // Anthropic 没有本地形态，缺 key 就等于没配
    if (!apiKey) return Promise.resolve(undefined);
    return Promise.resolve(
      new AnthropicProvider({
        id: providerId,
        label: 'Anthropic',
        baseUrl: baseUrl ?? 'https://api.anthropic.com',
        apiKey,
        model,
        timeoutMs: 300_000,
      }),
    );
  }

  if (!baseUrl) return Promise.resolve(undefined);

  // 本地后端（回环地址）允许没有 apiKey ——
  // **绝不要求用户为本地服务填一个假 key**（memo.ac 的已知 bug，R-01 §C11 #12）
  return Promise.resolve(
    new OpenAiCompatibleProvider({
      id: providerId,
      label: providerId,
      baseUrl,
      apiKey,
      model,
      timeoutMs: 300_000,
      // Qwen3 等 thinking 模型需要这条才不会把 token 预算烧在 reasoning_content 上
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
    }),
  );
}
