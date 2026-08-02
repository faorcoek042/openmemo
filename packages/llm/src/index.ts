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
export { OpenAiCompatibleProvider, isLoopback } from './providers/openai-compatible.js';
export { AnthropicProvider } from './providers/anthropic.js';

/*
 * ⚠️ **`./secrets.js` 刻意不在这里导出** —— 它 import 了 `node:fs` / `node:path`。
 *
 * 本包是 web-first 架构下的**共享路径**：`packages/mindmap/src/generate.ts` 从这里
 * 取值（`chatStructured`），而 mindmap 会进浏览器 bundle。只要 index 再导出 secrets，
 * `node:fs` 就被一路拉进浏览器包，**开发服务器下笔记详情页整页崩溃**
 * （生产构建因为 tree-shaking 不复现，所以用户看不到、只有开发时炸 —— 更难查）。
 *
 * 这与之前 `shared` 误引 `node:crypto` 污染浏览器包是**同一形状的错误**：
 * **Node-only API 不能出现在共享包的主入口**。
 * daemon 要用请显式走子路径：`import { SecretStore } from '@openmemo/llm/secrets'`。
 */

export const PACKAGE_NAME = '@openmemo/llm' as const;
