import catalog from '@manifests/llm-providers.json';
import {
  bucketProviders,
  canRefreshModelList,
  type LlmProviderSpec,
  type ProviderBuckets,
  type ProviderKind,
} from '@openmemo/shared';

import { readActiveProviderId, readDefaultModelId, readProviders, useSettingsQuery } from './api';
import type { LlmProviderConfig } from './api';

/**
 * LLM 服务商与模型的**唯一数据源**（T-108 ② → T-150 ② 换成目录驱动）。
 *
 * ## 为什么必须只有一份
 *
 * 用户发现「AI 模型」区块里的模型名，和「按用途分别配置模型」里的模型**不是同一套**：
 * 前者是每个 provider 自带的一个 `model` 字符串，后者是个**自由文本框**，
 * 两边各写各的，必然漂移 —— 那边有、这边没有，反之亦然。
 *
 * 所以两个区块共用 `useLlmConfig()`：provider 列表、当前生效值、
 * 以及"某个 provider 有哪些模型可选"全部从这里出。
 *
 * ## ★ T-150：写死的 11 个预设已作废（D-10 #24 / R-P1）
 *
 * 这里原来有一张手写的 `LLM_PRESETS`（11 家），而 `vendor/manifests/llm-providers.json`
 * 里有 **24 家 / 520 条**。差额不是"少了几家"，是 **13 家 / 237 条用户根本加不进去**
 * —— 他想用的服务商不在列表里，界面上没有任何入口，也没有任何一句话解释。
 * （HANDOFF「+ 添加服务商」那一条记的就是它。）
 *
 * 现在整份清单由目录驱动：`bucketProviders()` 分三桶、`configFieldKeys` 驱动表单、
 * `canRefreshModelList()` 决定清单出处怎么措辞。**前端不再持有第二份服务商事实。**
 *
 * ## 取向：**在线优先**（ADR-016）
 *
 * ADR-016 砍掉了档 3（内置 llama.cpp），保留档 1（BYO API Key，**主路径**）
 * 与档 2（复用已装的 Ollama / LM Studio，**可选便利**）。
 * 目录里的 `MAINSTREAM_PROVIDER_IDS` 置顶六家正好是 memo.ac 那份逐字相同的排序，
 * 本地两家排在其中最后，不会看起来像默认答案。
 */

const CATALOG_PROVIDERS: readonly LlmProviderSpec[] = (catalog.providers ??
  []) as LlmProviderSpec[];

const CATALOG_BY_ID = new Map<string, LlmProviderSpec>(CATALOG_PROVIDERS.map((p) => [p.id, p]));

/**
 * 前端旧 id → 目录 id 的**桥**（只读方向）。
 *
 * 用户库里可能已经存着 `anthropic` / `zhipu` / `dashscope` / `siliconflow` 这几个
 * 旧写法（它们是上一版写死清单里的 id）。目录里对应的是
 * `claude` / `zhipuai` / `qwen` / `siliconcloud`。
 *
 * ⚠️ 这张表**只用于"把老记录认出来"**：查候选模型、查表单字段、
 * 以及在分桶时不要把一家已配置的服务商又当成"未配置"再列一次。
 * **新加的 provider 一律用目录 id**，所以这张表不会再长。
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

/* ───────────────────── 协议族：目录的 `kind` ≠ daemon 分派的 `kind` ───────────────────── */

/**
 * ★ 目录的 `kind`（协议族，6 种）→ **daemon 真正会分派的那个 `kind`**（行为契约，3 种）。
 *
 * 这两个东西**同名不同物**，而且它们之间没有任何编译期联系 ——
 * `llm.providers[i].kind` 是我们写进设置里、daemon 读回去用来 `switch` 的字符串
 * （`apps/daemon/src/llm/resolve.ts` 的 `providerKind()` → `switch (kind)`），
 * 它只认 `'anthropic' | 'gemini' | 'openai-compatible'`；
 * 而目录里写的是 `'anthropic-native' | 'google-native' | 'ollama-native' | …`。
 *
 * **把目录的 kind 原样写进设置，daemon 会认不出来**（`resolve.ts` 的 default 分支：
 * 打一条 error 然后返回 `undefined`，用户看到的是"没配 LLM"）。
 * D-10 §8-D1 记的那颗雷已经被 daemon 侧拆掉了（它现在按 kind 分派、不再按 id），
 * **但那次只拆了一半** —— 前端这一半（谁来把目录的 kind 翻译成行为契约）到今天才补上。
 *
 * 总 `Record`：目录里新增一种协议族而这里没表态 ⇒ **构建就红**。
 * 值为 `null` = 我们**没有**能驱动它的适配器，界面必须明说，而不是拿 OpenAI 兼容去凑
 * （HANDOFF ⑤E：降级的前提必须是"对端确实这么行为"）。
 */
export const WIRE_KIND_BY_CATALOG_KIND: Readonly<
  Record<ProviderKind, LlmProviderConfig['kind'] | null>
> = {
  'openai-compatible': 'openai-compatible',
  /** `AnthropicProvider` 拼 `${baseUrl}/v1/messages`（`packages/llm/src/providers/anthropic.ts:103`）。 */
  'anthropic-native': 'anthropic',
  /** 同上：网关自称"Anthropic 兼容"，走的就是同一套请求形状（如 kimicodingplan）。 */
  'anthropic-compatible': 'anthropic',
  /** `GeminiProvider`（`packages/llm/src/providers/gemini.ts:164`）。 */
  'google-native': 'gemini',
  /** Ollama 的 OpenAI 兼容面在 `/v1` 下 —— 见 `adapterBaseUrl()`。 */
  'ollama-native': 'openai-compatible',
  /**
   * ⛔ **没有适配器**。`packages/llm/src/providers/` 下只有 anthropic / gemini /
   * openai-compatible 三个，没有 mistral。而目录里 `mistralai` 的
   * `baseUrl.default` 是 `null` 且 `editable === false` —— 连"当成 OpenAI 兼容凑合用"
   * 所需要的那个地址都拿不到。**所以这里如实写 `null`，界面上标成"暂不支持"并说明原因，
   * 而不是给一个点下去必然坏掉的按钮。**
   */
  'mistral-native': null,
};

/** 这家我们能不能真的驱动。`false` 时必须在界面上说清楚为什么。 */
export type ProviderSupport =
  | { supported: true }
  /** 目录里的协议族我们没有适配器。 */
  | { supported: false; reason: 'kind' }
  /** 有适配器，但拿不到接口地址（目录没给默认值，且不许用户改）。 */
  | { supported: false; reason: 'noBaseUrl' };

/**
 * 该 provider 在**我们的适配器**下的接口地址。
 *
 * 目录里的 `baseUrl.default` 是**厂商文档上的地址**，不一定就是我们的适配器该收的那个 ——
 * 两处各自会往上拼路径，拼重了或拼漏了都不会报错，只会请求 404 / 格式不对。
 * 所以这里逐条对着适配器源码校正，并把理由写在旁边。
 */
export function adapterBaseUrl(spec: LlmProviderSpec): string {
  const raw = (spec.baseUrl.default ?? '').replace(/\/+$/, '');
  if (!raw) return '';
  if (spec.kind === 'google-native') {
    /*
     * `GeminiProvider` 自己拼 `/${API_VERSION}`（`gemini.ts:30,164`，API_VERSION = 'v1beta'），
     * 而目录给的地址**已经带着 `/v1beta`** → 原样写进去会拼成 `…/v1beta/v1beta/models/…`。
     * 剥掉尾巴上的那一段；不是这个形状就原样留着（用户看得见，也改得动）。
     */
    return raw.replace(/\/v1beta$/, '');
  }
  if (spec.kind === 'ollama-native') {
    /*
     * `OpenAiCompatibleProvider` 拼 `${baseUrl}/chat/completions`（`openai-compatible.ts:119`）。
     * 目录给的是 Ollama 原生 API 的根（`http://127.0.0.1:11434`），
     * 而它的 OpenAI 兼容面在 `/v1` 下 —— 这也是本仓一直在发的那个地址
     * （上一版写死清单里的 ollama 就是 `http://127.0.0.1:11434/v1`）。
     */
    return /\/v\d+(\b|$)/.test(raw) ? raw : `${raw}/v1`;
  }
  return raw;
}

function providerSupport(spec: LlmProviderSpec): ProviderSupport {
  const wire = WIRE_KIND_BY_CATALOG_KIND[spec.kind];
  if (wire === null) return { supported: false, reason: 'kind' };
  /*
   * OpenAI 兼容分支在 daemon 里有一句硬闸：`if (!baseUrl) return undefined`
   * （`resolve.ts`）。anthropic / gemini 两个适配器自带默认地址，空着也能跑。
   */
  if (wire === 'openai-compatible' && adapterBaseUrl(spec) === '' && !spec.baseUrl.editable) {
    return { supported: false, reason: 'noBaseUrl' };
  }
  return { supported: true };
}

/** 回环地址 = 本机服务。用于「本地」徽标，**不**用于决定要不要 Key（那归 `configFieldKeys`）。 */
function isLoopback(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(url);
}

/**
 * 把目录里的一家变成**可以写进 `llm.providers` 的那条记录**。
 *
 * 这是"目录"与"设置"之间唯一的转换点。任何新增字段都该经过它，
 * 免得又长出第二处把目录数据往设置里搬的代码。
 */
export function presetConfigFor(spec: LlmProviderSpec): LlmProviderConfig | null {
  const wire = WIRE_KIND_BY_CATALOG_KIND[spec.kind];
  if (wire === null) return null;
  const baseUrl = adapterBaseUrl(spec);
  return {
    id: spec.id,
    kind: wire,
    label: spec.displayName,
    baseUrl,
    model: spec.defaultModel ?? spec.models[0]?.id ?? '',
    isLocal: isLoopback(baseUrl),
  };
}

export interface CatalogPreset {
  spec: LlmProviderSpec;
  /** 点「+ 添加」时写进设置的那条记录。`null` = 我们驱动不了它。 */
  config: LlmProviderConfig | null;
  support: ProviderSupport;
  /** 这家的表单该渲染哪些字段（R-P3）。逐家不同，不许写死三件套。 */
  fields: readonly LlmProviderSpec['configFieldKeys'][number][];
  /** 「刷新模型列表」在**协议上**做不做得到（R-P2）。 */
  refreshable: boolean;
}

function presetOf(spec: LlmProviderSpec): CatalogPreset {
  return {
    spec,
    config: presetConfigFor(spec),
    support: providerSupport(spec),
    fields: spec.configFieldKeys,
    refreshable: canRefreshModelList(spec),
  };
}

/** 目录里的 24 家，**按目录顺序**。分桶交给 `bucketProviders()`，这里不重排。 */
export const CATALOG_PRESETS: readonly CatalogPreset[] = CATALOG_PROVIDERS.map(presetOf);

/**
 * 接口地址那一栏该长什么样。**抽成纯函数是为了它能被单独测到。**
 *
 * 三档来自两个互相独立的字段，别把它们揉成一个布尔：
 *
 * | `configFieldKeys` 里有 `baseURL`？ | `baseUrl.editable` | 结果 | 为什么 |
 * |---|---|---|---|
 * | 没有 | — | `hidden` | 这家压根不收接口地址（如 `mistralai`），画一栏出来就是个摆设 |
 * | 有 | `false` | `readonly` | 收，但不许改 —— 给可编辑的框 = 一个改了不生效的输入框 |
 * | 有 | `true` | `editable` | 正常 |
 *
 * ⚠️ **`readonly` 这一档在当前目录里没有活体**：唯一 `editable === false` 的
 * `mistralai` 的 `configFieldKeys` 里也没有 `baseURL`，所以它走的是 `hidden`。
 * 这一档留着是因为两个字段本来就正交，将来任何一家"收地址但不许改"都会命中它 ——
 * 而那时如果没有这一档，用户会对着一个改了不生效的框敲半天。
 * 它由本函数的单测覆盖（组件层测不到，因为造不出这样一家）。
 */
export type BaseUrlFieldMode = 'hidden' | 'readonly' | 'editable';

export function baseUrlFieldMode(preset: CatalogPreset | null | undefined): BaseUrlFieldMode {
  // 认不出这家（自定义网关 / 老 id）：**宁可多给一栏也别藏掉**，否则他配不上
  if (!preset) return 'editable';
  if (!preset.fields.includes('baseURL')) return 'hidden';
  return preset.spec.baseUrl.editable ? 'editable' : 'readonly';
}

/* ─────────────────── 候选模型：同一份目录 ─────────────────── */

/**
 * 这份候选清单的**出处与时效**，给下拉旁边那行小字用。
 *
 * 为什么要显示它：24 家里 20 家是 `official-doc`（人工从文档转录，**没有端点可调**），
 * 清单必然会过时。让"可能过时"看得见，比假装它永远新鲜诚实 ——
 * 也正是"自定义…"这个逃生口存在的理由。
 */
export interface ModelCatalogNote {
  /** 目录里这家有多少条模型。0 = 这家不在目录里。 */
  count: number;
  /** 人工转录清单的核对日期（`official-doc` 才有）。 */
  checkedAt: string | null;
  /**
   * 有可枚举端点（`official-api` / `local-api`）。
   *
   * ⚠️ **它不等于"界面上该有一颗刷新按钮"**：24 家里只有 4 家为 true，
   * 而且**本机至今没有任何一个端点能替前端去枚举**（全仓无 `/api/llm/models`）。
   * 所以它现在的作用是**分流措辞**：这 4 家说"可以刷新，只是还没接上"，
   * 另外 20 家说"人工转录于 {{date}}，可能已过期"。
   * 一律给按钮 = 20 个按不动的按钮；给 4 个也按不动的按钮同样是假按钮。
   */
  refreshable: boolean;
}

export function catalogNoteFor(providerId: string | null | undefined): ModelCatalogNote | null {
  const spec = catalogProviderFor(providerId);
  if (!spec) return null;
  return {
    count: spec.models?.length ?? 0,
    checkedAt: spec.modelListSource?.checkedAt ?? null,
    refreshable: canRefreshModelList(spec),
  };
}

/** 目录规模 —— 测试与回执里要报的那几个数字，从数据本身算，不手抄。 */
export const LLM_CATALOG_STATS = {
  version: catalog.catalogVersion,
  providers: CATALOG_PROVIDERS.length,
  models: CATALOG_PROVIDERS.reduce((n, p) => n + (p.models?.length ?? 0), 0),
  /** 我们真的能驱动的家数。与 `providers` 不等时，界面必须逐家说明原因。 */
  supported: CATALOG_PRESETS.filter((p) => p.support.supported).length,
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

  /**
   * 三桶（D-10 §4.2.1）。
   *
   * ⚠️ 已配置的判定要**经过别名桥**：库里存着老 id `anthropic` 时，
   * 目录 id 是 `claude` —— 不映射的话「常用」里会再冒出一颗「+ Claude」，
   * 用户点下去就配出第二份 Anthropic。
   */
  const configuredCatalogIds = providers.map((p) => catalogProviderFor(p.id)?.id ?? p.id);
  const raw: ProviderBuckets = bucketProviders(CATALOG_PROVIDERS, configuredCatalogIds);
  const buckets = {
    mainstreamUnconfigured: raw.mainstreamUnconfigured.map(presetOf),
    more: raw.more.map(presetOf),
  };

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
    /** 目录里对应的那家（表单字段、协议族、支持性都从它出）。 */
    presetFor: (providerId: string | null | undefined): CatalogPreset | null => {
      const spec = catalogProviderFor(providerId);
      return spec ? presetOf(spec) : null;
    },
    /** 未配置的：置顶 6 家 + 其余 18 家。**不再是写死的 11 个**。 */
    buckets,
  };
}
