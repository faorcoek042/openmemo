/**
 * `vendor/manifests/*.json` 的类型声明（T-126）。
 *
 * ## 为什么是 ambient 声明而不是直接 import JSON
 *
 * 1. **rootDir**：`apps/web/tsconfig.json` 的 `rootDir` 是 `src`。
 *    `import x from '../../../../vendor/manifests/llm-providers.json'` 会让 tsc 报
 *    TS6059（文件不在 rootDir 下）。声明一个非相对 specifier 就没有这个问题。
 * 2. **类型检查开销**：`resolveJsonModule` 会为 JSON 内容推断字面量类型。
 *    `llm-providers.json` 是 253 KB / 24 家 / 520 条模型，让 tsc 去推它没有任何收益 ——
 *    我们本来就有一份**手写的、带文档的契约**（`packages/shared/src/providers.ts` 的
 *    `LlmProviderCatalog`）。ambient 声明让 tsc 直接用那份契约，**JSON 一个字节都不读**。
 * 3. **单一事实来源**：声明只描述形状，数据仍然只有 `vendor/manifests/` 里那一份。
 *    路径映射在 `vite.config.ts` 的 `resolve.alias`。
 *
 * ⚠️ 代价要说清楚：ambient 声明是**断言**不是校验 —— 如果 manifest 的实际形状与
 * `LlmProviderCatalog` 不符，tsc 不会发现。所以运行时读取处（`llm-catalog.ts`）
 * 对缺字段做了防御，且不假设任何 provider 一定存在。
 */
declare module '@manifests/llm-providers.json' {
  import type { LlmProviderCatalog } from '@openmemo/shared';

  const catalog: LlmProviderCatalog;
  export default catalog;
}
