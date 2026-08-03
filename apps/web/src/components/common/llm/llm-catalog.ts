import catalog from '@manifests/llm-providers.json';
import type { LlmProviderSpec } from '@openmemo/shared';

import { readActiveProviderId, readDefaultModelId, readProviders, useSettingsQuery } from './api';
import type { LlmProviderConfig } from './api';

/**
 * LLM 服务商与模型的**唯一数据源**（T-108 ②）。
 *
 * ## 为什么必须只有一份
 *
 * 用户发现「AI 模型」区块里的模型名，和「按用途分别配置模型」里的模型**不是同一套**：
 * 前者是每个 provider 自带的一个 `model` 字符串，后者是个**自由文本框**，
 * 两边各写各的，必然漂移 —— 那边有、这边没有，反之亦然。
 *
 * 这和我删 `HealthBanner` / `SecureContextBanner` 时说的是同一件事：
 * **留着两处迟早各自漂移**，只不过那次漂的是文案，这次漂的是数据。
 *
 * 所以两个区块现在共用 `useLlmConfig()`：provider 列表、当前生效值、
 * 以及"某个 provider 有哪些模型可选"全部从这里出。
 *
 * ## 取向：**在线优先**（ADR-016）
 *
 * ADR-016 砍掉了档 3（内置 llama.cpp），保留档 1（BYO API Key，**主路径**）
 * 与档 2（探测已装的 Ollama / LM Studio，**可选便利**）。
 * 所以预设清单里在线服务排在前面且占多数，本地两项排在最后并明确标注为"可选"。
 * 用户要的是"和 memo 一样用在线"，界面就不该让本地看起来是默认答案。
 */

export interface LlmPreset extends LlmProviderConfig {
  /** `online` 排在前面。`local` 是可选便利，不是默认取向。 */
  tier: 'online' | 'local';
}

/**
 * 预设服务商。
 *
 * 除 Anthropic 用原生协议外，其余都是 OpenAI 兼容 —— 这也是 memo.ac 的做法
 * （取证：24 家里 22 家可编辑 base URL）。**base URL 一律可改**，
 * 因为国内用户常走中转/代理网关，写死会直接把人挡在门外。
 */
export const LLM_PRESETS: LlmPreset[] = [
  { tier: 'online', id: 'deepseek', kind: 'openai-compatible', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', isLocal: false },
  { tier: 'online', id: 'openai', kind: 'openai-compatible', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', isLocal: false },
  { tier: 'online', id: 'anthropic', kind: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514', isLocal: false },
  { tier: 'online', id: 'gemini', kind: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash', isLocal: false },
  { tier: 'online', id: 'moonshot', kind: 'openai-compatible', label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', isLocal: false },
  { tier: 'online', id: 'zhipu', kind: 'openai-compatible', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', isLocal: false },
  { tier: 'online', id: 'dashscope', kind: 'openai-compatible', label: '阿里云百炼（通义）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', isLocal: false },
  { tier: 'online', id: 'siliconflow', kind: 'openai-compatible', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', isLocal: false },
  { tier: 'online', id: 'openrouter', kind: 'openai-compatible', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', isLocal: false },
  // ── 本地：可选便利，排在最后 ──
  { tier: 'local', id: 'ollama', kind: 'openai-compatible', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', isLocal: true },
  { tier: 'local', id: 'lmstudio', kind: 'openai-compatible', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', isLocal: true },
];

/* ─────────────────── 候选模型：吃 `vendor/manifests/llm-providers.json` ─────────────────── */

/**
 * ★ T-126：候选模型不再由前端手写（原来是 11 家 × 2～3 个的 `MODELS_BY_PROVIDER`），
 * 改吃仓库里那份目录快照 —— **24 家 / 520 条**，与「按用途分别配置」共用同一份。
 *
 * 手写清单的问题不是"少"，是**它是第二份事实**：目录里 deepseek 的默认型号早已是
 * `deepseek-v4-flash`，而前端手写的那份只有 `deepseek-chat` / `deepseek-reasoner` ——
 * 用户配的那个型号在下拉里**根本不存在**。两份清单必然漂移，这次漂的是型号名。
 */
const CATALOG_BY_ID = new Map<string, LlmProviderSpec>(
  (catalog.providers ?? []).map((p) => [p.id, p]),
);

/**
 * 前端预设 id → 目录 id 的**桥**。
 *
 * D-10 §8-D1 记的就是这件事：目录里 Anthropic 的 id 是 `claude` 而我们写的是 `anthropic`
 * （另有 `zhipuai`≠`zhipu`、`qwen`≠`dashscope`、`siliconcloud`≠`siliconflow`）。
 * 那条雷真正危险的地方在 **daemon 按 id 分派协议**，不在这里；
 * 但如果这里不桥接，用户给 Anthropic 打开下拉会看到**空清单**，看起来像"我们不支持它"。
 *
 * ⚠️ 这是一层**临时桥**，不是终局。终局是 D-10 #24（`LLM_PRESETS` 整体换成目录的 24 家，
 * 归 `architect`）。到那时 id 直接对齐，这张表就该删掉 —— 别让它长成第三份事实。
 */
const CATALOG_ID_ALIASES: Readonly<Record<string, string>> = {
  anthropic: 'claude',
  zhipu: 'zhipuai',
  dashscope: 'qwen',
  siliconflow: 'siliconcloud',
};

/** 目录里对应的那家 provider；不在目录里（自定义网关等）就是 `undefined`，不编。 */
export function catalogProviderFor(
  providerId: string | null | undefined,
): LlmProviderSpec | undefined {
  if (!providerId) return undefined;
  const aliased = CATALOG_ID_ALIASES[providerId];
  return CATALOG_BY_ID.get(providerId) ?? (aliased ? CATALOG_BY_ID.get(aliased) : undefined);
}

/**
 * 这份候选清单的**出处与时效**，给下拉旁边那行小字用。
 *
 * 为什么要显示它：24 家里 20 家是 `official-doc`（人工从文档转录，**没有端点可调**），
 * 清单必然会过时。让"可能过时"看得见，比假装它永远新鲜诚实 ——
 * 也正是"自定义…"这个逃生口存在的理由。（D-10 §4.2.1 R-P2；
 * 「刷新模型列表」按钮属 D-10 #26，归 `architect`，本轮不做。）
 */
export interface ModelCatalogNote {
  /** 目录里这家有多少条模型。0 = 这家不在目录里。 */
  count: number;
  /** 人工转录清单的核对日期（`official-doc` 才有）。 */
  checkedAt: string | null;
  /** 有可枚举端点（`official-api` / `local-api`）—— 将来「刷新」按钮的判据。 */
  refreshable: boolean;
}

export function catalogNoteFor(providerId: string | null | undefined): ModelCatalogNote | null {
  const spec = catalogProviderFor(providerId);
  if (!spec) return null;
  return {
    count: spec.models?.length ?? 0,
    checkedAt: spec.modelListSource?.checkedAt ?? null,
    refreshable:
      spec.modelListSource?.type === 'official-api' || spec.modelListSource?.type === 'local-api',
  };
}

/** 目录规模 —— 测试与回执里要报的那两个数字，从数据本身算，不手抄。 */
export const LLM_CATALOG_STATS = {
  version: catalog.catalogVersion,
  providers: (catalog.providers ?? []).length,
  models: (catalog.providers ?? []).reduce((n, p) => n + (p.models?.length ?? 0), 0),
} as const;

/**
 * 两个设置区块共用的配置视图。
 *
 * 关键点：`modelsFor()` **一定把用户自己配的那个模型名并进候选**。
 * 否则用户在「AI 模型」里填了一个我们清单里没有的模型，
 * 到「按用途分别配置」的下拉里就找不到它 —— 那正是他这次投诉的"两处不统一"。
 */
export function useLlmConfig() {
  const settings = useSettingsQuery();
  const providers = readProviders(settings.data);
  const activeProviderId = readActiveProviderId(settings.data);
  const defaultModel = readDefaultModelId(settings.data);

  function modelsFor(providerId: string | null | undefined): string[] {
    if (!providerId) return [];
    const known = (catalogProviderFor(providerId)?.models ?? []).map((m) => m.id);
    /*
     * 两个"用户侧的值"必须进候选，顺序 = 权威性从高到低：
     *
     * 1. `llm.defaultModelId` —— **daemon 真正在用的那个型号**，只有这家正生效时才算数。
     *    它必须能在自己的下拉里被选中，否则界面会说"当前生效 X"却在下拉里找不到 X。
     * 2. `llm.providers[i].model` —— 这家上次选的型号（daemon 不读，只是记忆）。
     *
     * 少任何一个，换成真下拉之后那个值就会在打开下拉的瞬间"消失"。
     */
    const authoritative = providerId === activeProviderId ? defaultModel : null;
    const remembered = providers.find((p) => p.id === providerId)?.model;
    return [...new Set([authoritative, remembered, ...known].filter(Boolean) as string[])];
  }

  return {
    isLoading: settings.isLoading,
    isError: settings.isError,
    error: settings.error,
    refetch: settings.refetch,
    providers,
    activeProviderId,
    defaultModel,
    modelsFor,
    /** 候选清单的出处与时效（同一份目录）。给下拉旁那行小字。 */
    catalogNoteFor,
    /** 未配置的预设，供"+ 添加"按钮用。在线的排前面。 */
    availablePresets: LLM_PRESETS.filter((p) => !providers.some((x) => x.id === p.id)),
  };
}
