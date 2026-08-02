import { useEffect, useState, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';

import { createQueryClient } from './query';
import { registerAllSseBindings } from '../lib/events/bindings';
import { startSse } from '../lib/events/source';
import { applyTheme, useUiStore } from '../lib/stores/ui.store';
import { consumeHandoffToken, setCsrf } from '../lib/api/client';
import { installMockApi } from '../lib/api/mock';

/**
 * 应用级 Provider 装配。
 *
 * ⚠️ SSE 单例与 mock 安装都在这里做，**绝不在业务组件里**：
 * StrictMode 会双挂载组件，在组件里 `new EventSource` 会开出两条流
 * （D-05 §2.6 硬禁忌 4）。这里用 `useState(() => …)` + 引用计数的单例保证幂等。
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  const theme = useUiStore((s) => s.theme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    // daemon 把 token 放在 URL fragment（#t=…），拿到后立刻抹掉 URL
    const token = consumeHandoffToken();
    if (token) {
      // 真实实现：POST /api/auth/session 用 Bearer 换 HttpOnly cookie + CSRF token。
      // daemon 未实现前先把它当 CSRF 占位，避免此处静默吞掉 token。
      setCsrf(token);
    }

    // daemon 尚未实现转写流水线 → 启用 MOCK。UI 顶部会常驻 MOCK 条幅。
    const uninstallMock = installMockApi();

    const unbind = registerAllSseBindings(queryClient);
    // MOCK 模式下没有真实 /api/events；mock 直接往 bus 发事件，因此这里不建连接。
    const stopSse = import.meta.env.VITE_OPENMEMO_LIVE === '1'
      ? startSse({ url: '/api/events' })
      : () => {};

    return () => {
      stopSse();
      unbind();
      uninstallMock();
    };
  }, [queryClient]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
