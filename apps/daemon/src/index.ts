/**
 * @openmemo/daemon —— 占位骨架（T-011, oss-scout）
 *
 * ⚠️ 只建骨架，实现归 T-010（架构）落地后的 T-020/T-022。
 *
 * ADR-003 决策 1 的安全硬要求（实现时不可妥协，逐条写在这里防止被遗忘）：
 *   1. 所有监听 **必须绑 127.0.0.1**，绝不 0.0.0.0
 *      （memo.ac 的 whisper-server 犯了这个错，见 R-01）。
 *   2. 启动时生成随机 token，网页调 API 必须带 token
 *      —— 防止其他本地进程 / 恶意网页打我们的端口。
 *   3. 需要沙箱时用 node:worker_threads + 权限白名单，**禁用 vm2**（已废弃 + 已知逃逸漏洞）。
 *   4. 原生组件（ffmpeg / yt-dlp / whisper-cli / llama-server / probe）一律子进程 spawn，
 *      崩溃隔离 + 许可证隔离 + 可独立升级。
 *   5. 进度推送只开**一条全局 SSE 流**（ADR-004 决策 5），否则撞 HTTP/1.1 六连接上限；
 *      实时录音转写另开 WebSocket。
 */

export const PACKAGE_NAME = '@openmemo/daemon' as const;

/** 绑定地址常量。ADR-003 安全硬要求 1：这个值不允许被配置成 0.0.0.0。 */
export const BIND_HOST = '127.0.0.1' as const;
