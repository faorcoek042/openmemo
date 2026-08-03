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

/**
 * 各服务商的常用模型。**只作候选提示，永远允许自己填** ——
 * 厂商上新模型的速度比我们发版快，写死清单会把新模型挡在外面。
 */
const MODELS_BY_PROVIDER: Record<string, string[]> = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openai: ['gpt-4o-mini', 'gpt-4o', 'o4-mini'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-5-haiku-20241022'],
  gemini: ['gemini-2.0-flash', 'gemini-2.0-pro'],
  moonshot: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  zhipu: ['glm-4-flash', 'glm-4-plus'],
  dashscope: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
  siliconflow: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3'],
  openrouter: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4', 'deepseek/deepseek-chat'],
  ollama: ['qwen3:8b', 'llama3.1:8b', 'gemma3:12b'],
  lmstudio: ['local-model'],
};

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
    const known = MODELS_BY_PROVIDER[providerId] ?? [];
    const configured = providers.find((p) => p.id === providerId)?.model;
    // 用户配的排最前：他刚填过，最可能就是想用的那个
    const all = configured ? [configured, ...known] : known;
    return [...new Set(all.filter(Boolean))];
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
    /** 未配置的预设，供"+ 添加"按钮用。在线的排前面。 */
    availablePresets: LLM_PRESETS.filter((p) => !providers.some((x) => x.id === p.id)),
  };
}
