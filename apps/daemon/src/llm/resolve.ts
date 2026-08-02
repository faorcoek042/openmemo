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
import { AnthropicProvider, OpenAiCompatibleProvider, SecretStore, type LlmProvider } from '@openmemo/llm';
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

export function resolveConfiguredProvider(
  db: DatabaseHandle,
  dataDir: string,
): Promise<LlmProvider | undefined> {
  const providerId = asString(readSetting(db, 'llm.defaultProviderId'));
  if (!providerId) return Promise.resolve(undefined);

  const model = asString(readSetting(db, 'llm.defaultModelId'));
  if (!model) return Promise.resolve(undefined);

  const baseUrl = asString(readSetting(db, `llm.baseUrl.${providerId}`));
  const store = new SecretStore(dataDir);
  const apiKey = store.get(`llm.${providerId}.apiKey`);

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
