/**
 * @openmemo/shared — cross-package contracts.
 *
 * Owner: `model-mgmt` (T-013, BOARD file-ownership table).
 * Consumers: apps/daemon, apps/web, packages/downloader, packages/runtime.
 *
 * Everything exported here is either a pure type or a pure function — no I/O, no side
 * effects — so it is safe to import from both the daemon and the browser bundle.
 */

export * from './ulid.js';
export * from './hardware.js';
export * from './artifacts.js';
export * from './models.js';
export * from './bundled.js';
export * from './notes.js';
export * from './components.js';
export * from './backends.js';
export * from './breaker.js';
export * from './toolchain.js';
export * from './fitness.js';
export * from './jobs.js';
export * from './progress.js';
export * from './events.js';
export * from './api.js';
export * from './providers.js';
export * from './proxy.js';
export * from './schemas.js';
export * from './llm.js';
export * from './media-extensions.js';

export const PACKAGE_NAME = '@openmemo/shared' as const;

/**
 * Contract version. Bump on any breaking change to the shapes above; the daemon and web
 * app assert a match at startup so a stale frontend fails loudly instead of silently
 * mis-parsing responses.
 */
/*
 * ── 2 (#90)：`job.progress` 的刻度字段换了形状 ────────────────────────────────
 *
 * `pct: number | null` → `progress: ProgressReading`（判别式联合，见 `progress.ts`）。
 * 这是**线上形状的破坏性变更**，不是版本号自增：旧前端读 `e.pct` 会得到 `undefined`，
 * `?? 0` 之后每条任务恒显示 0%。
 *
 * 按 `contract.test.ts` 那条绊线要求的两个确认：
 *   ① `apps/daemon` 与 `apps/web` 同包发布（同一个 bundle，daemon 自己 serve 那份 SPA）——成立；
 *   ② 老前端撞上新 daemon 时那条阻断路径仍然走得通：`apps/web/src/lib/api/connect.ts`
 *      比对 `/api/health` 的 `contractVersion`，不等就进阻断页。**这正是我们要的**：
 *      与其让他盯着一排静止的 0%，不如直说"刷新一下"。
 */
export const CONTRACT_VERSION = 2 as const;
