/**
 * LLM provider registry contract.
 *
 * The catalog of providers and their model lists is a SNAPSHOT shipped in git
 * (`vendor/manifests/llm-providers.json`), not something fetched at runtime. Same
 * reasoning as the model catalog: a local-first tool has to work on a machine that
 * cannot reach api.openai.com, and a dropdown that is empty because the network is
 * blocked is worse than one that is slightly out of date.
 *
 * NOTE: no `node:` imports in this file — `shared` is bundled into the browser.
 */

/** How the provider's HTTP API is shaped. Decides which client adapter is used. */
export const PROVIDER_KINDS = [
  'openai-compatible',
  'anthropic-native',
  'anthropic-compatible',
  'google-native',
  'mistral-native',
  'ollama-native',
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** What a provider/model can be used for. Mirrors our purpose bindings. */
export const LLM_CAPABILITIES = ['chat', 'summarize', 'mindmap', 'translate'] as const;
export type LlmCapability = (typeof LLM_CAPABILITIES)[number];

/**
 * Where a provider's model list comes from.
 *
 * This is the field that decides whether a "refresh model list" button can exist at all:
 *
 * - `official-api` / `local-api` — the provider exposes an enumerable endpoint, so the
 *   button is real. Only 4 of 24 providers qualify.
 * - `official-doc` — the list was transcribed by a human from documentation. There is
 *   nothing to call. Showing a refresh button here would be a button that cannot work;
 *   the honest affordance is displaying `checkedAt` so staleness is visible.
 */
export interface ModelListSource {
  type: 'official-api' | 'local-api' | 'official-doc';
  /** Endpoint to enumerate models (api types), or the doc page that was transcribed. */
  url?: string;
  /** When a human last verified a hand-curated list. Surfaced in the UI as "list updated X". */
  checkedAt?: string;
}

export interface LlmModelSpec {
  id: string;
  displayName: string;
  /** Context window in tokens; null when the vendor does not publish one. */
  contextLength: number | null;
  maxTokens: number | null;
  abilities?: {
    functionCall?: boolean;
    reasoning?: boolean;
    search?: boolean;
    structuredOutput?: boolean;
    vision?: boolean;
  };
  /** e.g. "deprecated" / "preview"; null when nothing notable. */
  status?: string | null;
  supportedCapabilities?: LlmCapability[];
}

export interface LlmProviderSpec {
  id: string;
  displayName: string;
  vendor: string;
  /** Icon key; the web app maps this to an asset. */
  icon: string;
  kind: ProviderKind;
  /**
   * True for the six providers pinned to the top of the picker regardless of
   * configuration state (openai / claude / gemini / deepseek / ollama / lmstudio).
   */
  isMainstreamPinned: boolean;
  homepage?: string;
  documentation?: string;
  capabilities: LlmCapability[];
  baseUrl: {
    default: string | null;
    required: boolean;
    /** False for vendors that reject a custom endpoint; the field must then be read-only. */
    editable: boolean;
    placeholder?: string;
  };
  /**
   * Which credential/tuning fields this provider actually needs.
   *
   * Drives the form, so a local provider never shows an API-key box. Making users invent
   * a fake key for Ollama is a real thing competitors do and it teaches them the app does
   * not understand its own configuration.
   */
  configFieldKeys: ('apiKey' | 'baseURL' | 'model' | 'temperature' | 'maxTokens' | 'apiVersion' | 'deploymentId')[];
  modelListSource: ModelListSource;
  defaultModel: string | null;
  models: LlmModelSpec[];
}

/** The shipped snapshot, as stored in `vendor/manifests/llm-providers.json`. */
export interface LlmProviderCatalog {
  schemaVersion: 1;
  catalogVersion: string;
  /** Provenance of the snapshot — never present transcribed data as if we generated it. */
  sourceNote: string;
  providers: LlmProviderSpec[];
}

/** The six providers pinned above the fold, in display order. */
export const MAINSTREAM_PROVIDER_IDS = [
  'openai',
  'claude',
  'gemini',
  'deepseek',
  'ollama',
  'lmstudio',
] as const;

/**
 * Buckets for the provider picker.
 *
 * `configured` is deliberately FIRST and is allowed to be empty. Out of the box this app
 * has no LLM configured at all, and the UI must say so rather than pre-selecting a
 * provider the user never set up. memo.ac ships an initial dropdown highlight
 * (`openai/gpt-5.4-mini`) with no credentials behind it, which reads as "already
 * configured" and turns the first mindmap attempt into an unexplained failure. Copying
 * their list is useful; copying that illusion is not.
 */
export interface ProviderBuckets {
  configured: LlmProviderSpec[];
  mainstreamUnconfigured: LlmProviderSpec[];
  more: LlmProviderSpec[];
}

export function bucketProviders(
  all: readonly LlmProviderSpec[],
  configuredIds: readonly string[],
): ProviderBuckets {
  const isConfigured = new Set(configuredIds);
  const order = new Map<string, number>(MAINSTREAM_PROVIDER_IDS.map((id, i) => [id, i]));

  const configured = all.filter((p) => isConfigured.has(p.id));
  const rest = all.filter((p) => !isConfigured.has(p.id));

  return {
    configured,
    mainstreamUnconfigured: rest
      .filter((p) => order.has(p.id))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
    more: rest
      .filter((p) => !order.has(p.id))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  };
}

/** True when a "refresh model list" action can actually do something for this provider. */
export function canRefreshModelList(p: LlmProviderSpec): boolean {
  return p.modelListSource.type === 'official-api' || p.modelListSource.type === 'local-api';
}
