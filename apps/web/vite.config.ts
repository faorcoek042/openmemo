import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * daemon 的地址。
 *
 * 默认 17650（ADR-006 决策 2 定的固定端口）；端口漂移或多实例调试时用
 * `OPENMEMO_DAEMON=http://127.0.0.1:17699 pnpm dev` 覆盖。
 */
const DAEMON = process.env['OPENMEMO_DAEMON'] ?? 'http://127.0.0.1:17650';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // ADR-003 安全硬要求：开发服务器同样只绑回环地址，绝不 0.0.0.0
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,

    /**
     * ★ 开发期反向代理 —— 补上一条**谁都没记的根本缺口**。
     *
     * 在这之前：Vite 在 5173 提供页面，daemon 在 17650 提供 API，而
     * **daemon 不托管静态文件、Vite 也没有代理** →
     * 页面里的 `fetch('/api/...')` 打到 Vite 自己 → 404。
     * 也就是说**浏览器从来就够不到 daemon**，
     * "在真浏览器里点一点"这件事在仓库里根本没有一种可行配置。
     *
     * 这条缺口不属于任何一份交付报告的责任范围（前端做了页面、后端做了接口，
     * 中间这一段没人认领），所以它一直没被发现。
     *
     * 为什么代理而不是让前端直连 `http://127.0.0.1:17650`：
     * - **同源**才能让 HttpOnly cookie 生效（D-01 §2.4：SSE / WS / `<audio src>`
     *   三类通道都带不了 Authorization header，只能靠 cookie）；
     * - daemon 的 `Host`/`Origin` 白名单校验（DNS rebinding 防护）会拒绝跨源请求；
     * - 跨源还要额外开 CORS，而 D-01 §8.1 明确"CORS 全部拒绝"是我们的安全姿态之一。
     *
     * 生产环境不靠它：daemon 自己托管 SPA（同源，零 CORS 面）。**这一段目前尚未实现**。
     *
     * ⚠️ `changeOrigin: true` 是**必需的**，不是可选优化。
     * daemon 的 DNS rebinding 防护会校验 `Host` 的端口必须是它自己的
     * （D-01 §8.2 第 2 道防线）。不改写的话 Host 是 `127.0.0.1:5173`，
     * 实测被拒：`403 FORBIDDEN_ORIGIN / Host 端口不匹配: 5173`。
     * 开着它，代理会把 Host 改写成 target 的 host:port，校验才通得过。
     * **这条防护本身是对的，不该为了开发方便去削弱服务端** —— 改代理侧才是正解。
     */
    proxy: {
      '/api': { target: DAEMON, changeOrigin: true, ws: false },
      '/media': { target: DAEMON, changeOrigin: true },
      '/ws': { target: DAEMON, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
