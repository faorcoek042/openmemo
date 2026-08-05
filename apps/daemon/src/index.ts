/**
 * @openmemo/daemon —— 本地 daemon（T-016, oss-scout）
 *
 * 进程模型见 ADR-003 决策 1：本地 daemon + 浏览器 UI（web-first）。
 * 可执行入口在 `main.ts`（`pnpm --filter @openmemo/daemon start`）。
 *
 * ADR-003 安全硬要求（实现时不可妥协，逐条列在这里防止被遗忘）：
 *   1. 所有监听 **必须绑 127.0.0.1**，绝不 0.0.0.0
 *      （memo.ac 的 whisper-server 犯了这个错，见 R-01）。
 *   2. 启动时生成随机 token，网页调 API 必须带 token
 *      —— 防止其他本地进程 / 恶意网页打我们的端口。
 *   3. 需要沙箱时用 node:worker_threads + 权限白名单，**禁用 vm2**（已废弃 + 已知逃逸漏洞）。
 *   4. 原生组件（ffmpeg / yt-dlp / whisper-cli / probe）一律子进程 spawn，
 *      崩溃隔离 + 许可证隔离 + 可独立升级。
 *      （T-144：`llama-server` 已从这张表里删除 —— ADR-016 决策 3 砍掉内置 llama.cpp，
 *       我们**从不 spawn 它**；档 2 是对用户自己已装的 Ollama / LM Studio / llama-server
 *       **发 HTTP 请求探测**，见 `jobs/runners/mindmap.ts`。ADR-003 的架构图仍是旧版，
 *       但 ADR 是历史记录不回改。）
 *   5. 进度推送只开**一条全局 SSE 流**（ADR-004 决策 5），否则撞 HTTP/1.1 六连接上限；
 *      实时录音转写另开 WebSocket。
 */
export { BIND_HOST, DEFAULT_PORT, MAX_PORT } from './bootstrap/single-instance.js';
export {
  AlreadyRunningError,
  StartupConflictError,
  VERSION,
  startDaemon,
  type RunningDaemon,
  type StartOptions,
} from './main.js';
export { JobQueue, type EnqueueParams, type JobRow, type JobState } from './jobs/queue.js';
export { LANES, LanePool, defaultCapacities, type Lane } from './jobs/lanes.js';
export { SseHub } from './http/sse.js';
export { SessionStore, CSRF_HEADER, SESSION_COOKIE } from './http/auth.js';
export { resolvePaths, type AppPaths } from './config/paths.js';

export const PACKAGE_NAME = '@openmemo/daemon' as const;
