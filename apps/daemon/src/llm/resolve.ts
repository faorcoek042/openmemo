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

/** 行为契约。与 `LlmProvider['kind']` 保持一致 —— 新增一种必须两边同时改。 */
type LlmProviderKind = LlmProvider['kind'];
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
  if (!purpose)
    return {
      ...(defProvider ? { providerId: defProvider } : {}),
      ...(defModel ? { model: defModel } : {}),
    };

  const all = readSetting(db, 'llm.purposes');
  const b = (all && typeof all === 'object' ? (all as PurposeBindings)[purpose] : undefined) ?? {};
  const providerId = asString(b.providerId) ?? defProvider;
  const model = asString(b.model) ?? defModel;
  return { ...(providerId ? { providerId } : {}), ...(model ? { model } : {}) };
}

/**
 * 取某个 provider 的 `kind`（行为契约）。
 *
 * 权威来源是设置里的 `llm.providers` 记录 —— 它是前端写入、目录同步的那一份。
 * 记录里没有该 provider 时**才**退到按 id 猜，并打一条 warn：
 * 猜测能让老配置继续工作，但它正是这次 bug 的成因，所以必须留痕、不能静默。
 */
function providerKind(db: DatabaseHandle, providerId: string): LlmProviderKind {
  const raw = readSetting(db, 'llm.providers');
  if (Array.isArray(raw)) {
    const rec = (raw as Array<{ id?: unknown; kind?: unknown }>).find((x) => x.id === providerId);
    const k = typeof rec?.kind === 'string' ? rec.kind : undefined;
    if (k === 'anthropic' || k === 'gemini' || k === 'openai-compatible') return k;
    if (k !== undefined) {
      console.warn(`[llm] provider ${providerId} 的 kind='${k}' 无法识别，按未实现处理`);
      return k as LlmProviderKind;
    }
  }
  // 兜底：老配置里没有 kind 字段
  const guessed: LlmProviderKind =
    providerId === 'anthropic' || providerId === 'claude'
      ? 'anthropic'
      : providerId === 'gemini' || providerId === 'google'
        ? 'gemini'
        : 'openai-compatible';
  console.warn(
    `[llm] provider ${providerId} 在 llm.providers 里没有 kind 字段，按 id 猜为 '${guessed}'。` +
      `请在设置里重新保存一次该 provider 以写入 kind。`,
  );
  return guessed;
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

  /*
   * ★ **按 `kind` 分派，绝不按 id 字面量。**
   *
   * 这里原来是 `providerId === 'anthropic'` / `=== 'gemini'`。而 `model-mgmt` 采用的
   * memo.ac 目录里，Anthropic 那家的 id 是 **`claude`** —— 一切到新目录，
   * 它就会**静默掉进 OpenAI 兼容分支**，请求格式对不上。
   * "静默"是要命的地方：不报错，只是回来的东西不对；
   * 而 Anthropic 原生适配器至今**没有真 Key 验证过**（只跑过本地 mock），
   * 这条坏了不会有人立刻发现。
   *
   * **id 是目录里的标识，`kind` 才是行为契约。** 目录随时会加新家（24 家 520 模型），
   * id 会变、会重名、会本地化，`kind` 不会。
   */
  const kind = providerKind(db, providerId);

  switch (kind) {
    case 'anthropic': {
      // 没有本地形态，缺 key 就等于没配
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
    case 'gemini': {
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
    case 'openai-compatible':
      break; // 往下走通用分支
    default: {
      /*
       * ★ 穷尽性断言：**目录里新增一个 kind 而这里没实现，构建就红。**
       *
       * 这比修好眼下这一处重要得多 —— 没有它，下一次加原生厂商时
       * 又会安静地落进 OpenAI 兼容分支，重演同一个 bug。
       */
      const exhaustive: never = kind;
      /*
       * 运行时也要**明确回错**，不能悄悄回落到 OpenAI 兼容：
       * 用户选了原生厂商，我们没实现，就该说"没实现"，
       * 而不是用一个格式对不上的请求去假装支持。
       */
      console.error(
        `[llm] provider ${providerId} 的 kind=${String(exhaustive)} 没有对应实现 —— ` +
          `拒绝回落到 OpenAI 兼容（那会静默发出格式错误的请求）`,
      );
      return Promise.resolve(undefined);
    }
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
