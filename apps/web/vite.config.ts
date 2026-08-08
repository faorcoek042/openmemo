import { fileURLToPath } from 'node:url';

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

/**
 * 把 `Origin` 头也改写成 daemon 自己的源。
 *
 * `changeOrigin: true` 只改写 `Host`，**不改 `Origin`**。而 daemon 的 CSRF 防护
 * 会单独校验 Origin（D-01 §8.2 第 3 道防线），实测：
 * `403 FORBIDDEN_ORIGIN / Origin 端口不匹配: 5173`。
 *
 * 正确做法是在**代理侧**把它对齐，而不是让服务端把 5173 加进白名单 ——
 * 那等于为了开发方便在产品里留一个永久的信任缺口。
 */
function rewriteOrigin(proxy: {
  on: (e: string, cb: (p: { setHeader: (k: string, v: string) => void }) => void) => void;
}): void {
  proxy.on('proxyReq', (proxyReq) => {
    proxyReq.setHeader('origin', DAEMON);
  });
}

export default defineConfig({
  plugins: [react(), tailwindcss()],

  /**
   * ★ `@manifests/*` → `vendor/manifests/*`（T-126）。
   *
   * LLM 服务商目录（24 家 / 520 个模型）是**随仓库分发的静态快照**，
   * `packages/shared/src/providers.ts` 的文件头已经把这条定死了：
   * *"not something fetched at runtime … a dropdown that is empty because the network
   * is blocked is worse than one that is slightly out of date."*
   * 所以它该**进包**，而不是再开一个可能失败的端点。
   *
   * 为什么必须是 alias 而不是相对路径 `../../../vendor/…`：
   * `apps/web/tsconfig.json` 的 `rootDir` 是 `src`，任何 `src/` 之外的文件都会让
   * tsc 报 TS6059。配一个别名 + 一份 `src/types/manifests.d.ts` 的 ambient 声明后：
   * - **tsc 根本不去读那个 253 KB 的 JSON**（ambient 声明对该 specifier 优先），
   *   既绕开 rootDir，也不用为 520 条模型推断字面量类型（那会明显拖慢类型检查）；
   * - Vite（dev / build / `--ssr` 那条测试道）按 alias 解析到真文件，**只有一份数据**。
   */
  resolve: {
    alias: {
      '@manifests': fileURLToPath(new URL('../../vendor/manifests', import.meta.url)),
    },
  },

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
     * 生产环境不靠它：daemon 自己托管 SPA（同源，零 CORS 面）——
     * **已实现**，见 `apps/daemon/src/http/server.ts` 的 `serveStatic(webDist, …)`
     * （`/api/**` 与 `/ws/**` 在其中被显式排除）。这个 proxy 只服务 `vite dev`。
     *
     * ⚠️ `changeOrigin: true` 是**必需的**，不是可选优化。
     * daemon 的 DNS rebinding 防护会校验 `Host` 的端口必须是它自己的
     * （D-01 §8.2 第 2 道防线）。不改写的话 Host 是 `127.0.0.1:5173`，
     * 实测被拒：`403 FORBIDDEN_ORIGIN / Host 端口不匹配: 5173`。
     * 开着它，代理会把 Host 改写成 target 的 host:port，校验才通得过。
     * **这条防护本身是对的，不该为了开发方便去削弱服务端** —— 改代理侧才是正解。
     */
    proxy: {
      '/api': { target: DAEMON, changeOrigin: true, ws: false, configure: rewriteOrigin },
      '/media': { target: DAEMON, changeOrigin: true, configure: rewriteOrigin },
      '/ws': { target: DAEMON, ws: true, changeOrigin: true, configure: rewriteOrigin },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
