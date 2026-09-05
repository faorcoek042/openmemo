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
export * from './timecode.js';
export * from './audio.js';
export * from './secrets.js';

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
/*
 * ── 3 (#112)：四处「原因」字段从自由文本换成判别式联合 ────────────────────────
 *
 * `pipeline.engines[].reason` / `probes[].detail` / `modes.semanticReason` /
 * `/ws/recorder` error 帧的 `messageZh` —— 前三个 `string → 判别式联合`，
 * 最后一个**整格删掉**换成 `reason: RecorderErrorReason`。
 *
 * ⚠️ **这是线上形状的破坏性变更，不是版本号自增。** 逐条量过旧前端撞上去会渲染出什么：
 *   · `engines[].reason`  → `AsrEngineStatus.tsx` 模板串插值 ⇒ **`（[object Object]）`**
 *   · `probes[].detail`   → `ProxySettingsSection.tsx` ⇒ **`· [object Object]`**
 *   · WS 的 `messageZh`   → `setStreamError(undefined)`，而渲染点是
 *                            `{streamError ? <Banner/> : null}` ⇒ **整条横幅不渲染**。
 *                            录音会话已经死了，界面上**一个字都没有**。
 *   · `semanticReason`    → `modes.ts` 本来就有 `typeof === 'string'` 守卫，
 *                            退成「服务端没说为什么」—— 这一条降级得体面，不构成理由。
 *
 * 前两条尤其不能留：`[object Object]` **不是一句说错了的话，是一段泄漏出来的内部表示** ——
 * 没有任何用户能从它得到任何东西。第三条更坏：**用户根本不知道出了事。**
 *
 * 按 `contract.test.ts` 那条绊线要求的两个确认，**逐条重核过今天还成不成立**
 * （「先例存在」与「先例的前提今天还成立」是两件事）：
 *   ① `apps/daemon` 与 `apps/web` 同包发布 —— 成立（daemon 自己 serve 那份 SPA）；
 *   ② 阻断路径走得通 —— 成立，`connect.ts:115` 比对 `contractVersion` 不等即进阻断页。
 *      而且这条路**真的会被走到**：daemon 重启换 token ⇒ 旧标签页下一个请求 401
 *      ⇒ `client.ts` 的自愈 `resetConnection()` ⇒ `connectToDaemon()` ⇒ 在这里被拦下。
 *
 * ⚠️ **代价是真的：所有旧标签页会停在提示页，需要刷新一次。** 这是故意的，
 * 而且这一次它对**所有从 v0.7.2 升上来的人**都成立 —— 不是只对某台已经跨过版的机器。
 */
export const CONTRACT_VERSION = 3 as const;
