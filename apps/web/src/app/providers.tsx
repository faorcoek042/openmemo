import { useEffect, useState, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';

import { createQueryClient } from './query';
import { registerAllSseBindings } from '../lib/events/bindings';
import { startSse } from '../lib/events/source';
import { applyTheme, useUiStore } from '../lib/stores/ui.store';
import { installMockApi } from '../lib/api/mock';
import { connectToDaemon } from '../lib/api/connect';
import { markSurface } from '../lib/api/surfaces';

/**
 * 应用级 Provider 装配。
 *
 * ⚠️ SSE 单例与 mock 注册都在这里做，**绝不在业务组件里**：
 * StrictMode 会双挂载组件，在组件里 `new EventSource` 会开出两条流
 * （D-05 §2.6 硬禁忌 4）。这里靠模块级单例 + 引用计数保证幂等。
 *
 * ## T-029 改动
 * 不再用 `VITE_OPENMEMO_LIVE` 环境变量决定真假 —— 那是个"全有或全无"的开关，
 * 表达不了 daemon 正在逐个端点接通的真实状态。
 * 现在启动时**真的去连 daemon**：连上并鉴权成功就开真 SSE、走真接口；
 * 连不上或某个端点还没实现，就**按面**回落 mock（见 `lib/api/client.ts`）。
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  const theme = useUiStore((s) => s.theme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    let stopSse: (() => void) | null = null;
    let cancelled = false;

    // mock 先注册好（作为**回落**），这样即使 daemon 没起，UI 也立刻可用可评审
    const uninstallMock = installMockApi();
    const unbind = registerAllSseBindings(queryClient);

    void (async () => {
      const result = await connectToDaemon();
      if (cancelled) return;

      if (result.reachable && result.authed && !result.contractMismatch) {
        // 鉴权 cookie 已就位 —— EventSource 带不了 header，只能靠 cookie（D-01 §2.4）
        markSurface('events', 'live');
        stopSse = startSse({ url: '/api/events' });
      } else {
        markSurface('events', result.reachable ? 'mock' : 'offline');
      }
    })();

    return () => {
      cancelled = true;
      stopSse?.();
      unbind();
      uninstallMock();
    };
  }, [queryClient]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
