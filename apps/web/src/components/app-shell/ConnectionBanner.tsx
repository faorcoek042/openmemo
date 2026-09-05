import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { Banner } from '../common/Banner';
import { Button } from '../common/Button';
import { useConnectionStore } from '../../lib/stores/connection.store';
import { resyncNow } from '../../lib/events/degradedPolling';

/**
 * 连接态横幅（`reconnecting` / `degraded`）。
 *
 * ## 为什么从 `App.tsx` 里抽出来（#101）
 *
 * 它原来是 App 里的两行三元表达式，于是**没有任何一条测试能碰到它** ——
 * 要测就得渲染整个应用外壳（侧栏 + 文件夹树 + 就绪条幅 + Toaster + 路由出口）。
 * 而这条横幅恰恰是那种"说了什么"必须被钉住的东西：它上一版写的是
 * 「实时更新已断开，**正在轮询**」，而那条轮询根本不存在。
 * 一句话如果没人测它说得对不对，它就会一直说下去。
 *
 * ## 「立即刷新」不是装饰
 *
 * 降级之后就算有 15 秒一次的轮询，用户看到的仍然是**最多迟 15 秒**的界面。
 * 横幅只讲状态、不给动作，用户唯一能想到的办法是按 F5 整页重载 ——
 * 那会把正在播的音频、正在编辑的段落、滚动位置全丢掉。
 * 这个按钮只做一次全量重拉（和轮询那一拍完全相同的动作），页面状态一个不丢。
 */
export function ConnectionBanner() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const conn = useConnectionStore((s) => s.state);

  if (conn === 'degraded') {
    return (
      <Banner
        tone="warning"
        title={t('banner.sseDegraded')}
        detail={t('banner.sseDegradedDetail')}
        action={
          <Button
            size="sm"
            variant="secondary"
            data-testid="sse-degraded-refresh"
            onClick={() => resyncNow(qc)}
          >
            {t('banner.refreshNow')}
          </Button>
        }
      />
    );
  }

  if (conn === 'reconnecting') {
    return <Banner tone="info" title={t('banner.sseReconnecting')} />;
  }

  return null;
}
