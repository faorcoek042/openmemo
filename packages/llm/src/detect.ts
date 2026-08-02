/**
 * 档 2：探测本机已装的 LLM 服务（Ollama / LM Studio / llama-server）。
 *
 * ⚠️ **教训来自 `gpu-runtime`（R-02）：探测不能只看端口开着。**
 * 端口开着可能是别的服务、可能是个僵尸进程、可能是代理。
 * → **必须真发一个请求确认它就是那个服务**，并且**真的能列出模型**。
 *
 * 这与 D-01 §2.2 的单实例探测是同一个原则：绑定失败后要 `GET /api/health`
 * 确认"是我们自己"，而不是看到端口占用就下结论。
 */
import { OpenAiCompatibleProvider } from './providers/openai-compatible.js';
import type { LlmProvider, ProviderConfig } from './types.js';

export interface DetectCandidate {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  /** 用于确认身份的额外端点（相对 origin）。 */
  readonly identityPath?: string;
}

/** 本地常见后端。端口来自各自官方默认值。 */
export const DEFAULT_CANDIDATES: readonly DetectCandidate[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    identityPath: '/api/tags',
  },
  { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { id: 'llama-server', label: '内置 llama.cpp', baseUrl: 'http://127.0.0.1:18080/v1' },
];

export interface DetectedBackend {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly models: readonly string[];
  /** 探测耗时，用于在 UI 里排序（快的排前面）。 */
  readonly latencyMs: number;
}

export interface DetectOptions {
  readonly candidates?: readonly DetectCandidate[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * 探测单个候选。
 *
 * 判定"确实是可用的 LLM 后端"的标准（三者全满足，缺一不可）：
 *   1. `/v1/models` 返回 2xx
 *   2. 响应是合法 JSON 且有 `data` 数组
 *   3. **`data` 里至少有一个模型** —— 装了但没下模型的 Ollama 不算可用
 */
export async function probeCandidate(
  c: DetectCandidate,
  timeoutMs = 2000,
  signal?: AbortSignal,
): Promise<DetectedBackend | undefined> {
  const started = Date.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const res = await fetch(`${c.baseUrl.replace(/\/+$/, '')}/models`, { signal: combined });
    if (!res.ok) return undefined;

    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return undefined;

    const models = body.data
      .map((m) => (m as { id?: unknown }).id)
      .filter((x): x is string => typeof x === 'string' && x.length > 0);

    // 端口开着 + 返回 JSON，但一个模型都没有 → 对用户来说等于不可用
    if (models.length === 0) return undefined;

    return {
      id: c.id,
      label: c.label,
      baseUrl: c.baseUrl,
      models,
      latencyMs: Date.now() - started,
    };
  } catch {
    return undefined;
  }
}

/** 并发探测全部候选，返回真正可用的。 */
export async function detectLocalBackends(opts: DetectOptions = {}): Promise<DetectedBackend[]> {
  const candidates = opts.candidates ?? DEFAULT_CANDIDATES;
  const results = await Promise.all(
    candidates.map((c) => probeCandidate(c, opts.timeoutMs ?? 2000, opts.signal)),
  );
  return results
    .filter((r): r is DetectedBackend => r !== undefined)
    .sort((a, b) => a.latencyMs - b.latencyMs);
}

/** 把探测结果直接变成可用的 provider。 */
export function providerFromDetected(
  d: DetectedBackend,
  overrides: Partial<ProviderConfig> = {},
): LlmProvider {
  const cfg: ProviderConfig = {
    id: d.id,
    label: d.label,
    baseUrl: d.baseUrl,
    model: overrides.model ?? (d.models[0] as string),
    isLocal: true,
    ...overrides,
  };
  return new OpenAiCompatibleProvider(cfg);
}
