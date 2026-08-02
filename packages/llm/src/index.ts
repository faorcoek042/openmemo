/**
 * @openmemo/llm —— LLM 适配层（T-023, oss-scout）
 *
 * 三档接入（ADR-003）：
 *   档 1 BYO API Key（默认）  → `OpenAiCompatibleProvider` / `AnthropicProvider`
 *   档 2 复用已装的本地服务   → `detectLocalBackends()`（**真发请求确认身份**，不只看端口）
 *   档 3 内置 llama.cpp       → `llama-server` 也是 OpenAI 兼容，复用档 1 的实现
 *
 * **关键简化：只需要两个 provider 实现**（D-01 §6.2）——
 * OpenAI 兼容那个覆盖 云 + Ollama + LM Studio + llama-server。
 */
export * from './types.js';
export * from './errors.js';
export * from './structured.js';
export * from './detect.js';
export * from './secrets.js';
export { OpenAiCompatibleProvider, isLoopback } from './providers/openai-compatible.js';
export { AnthropicProvider } from './providers/anthropic.js';

export const PACKAGE_NAME = '@openmemo/llm' as const;
