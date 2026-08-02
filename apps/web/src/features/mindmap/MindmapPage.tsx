import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useRef } from 'react';
import type { MindMapDoc } from '@openmemo/mindmap';

import { MindmapView } from './MindmapView';
import { MINDMAP_SAVE_SUPPORTED, useMindmapQuery, useSaveMindmapMutation } from './api';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { EmptyState } from '../../components/common/EmptyState';
import { MockNotice } from '../../components/common/MockNotice';

/** F4 全屏编辑页。笔记详情里的 Tab 复用同一个 `MindmapView`。 */
export default function MindmapPage() {
  const { t } = useTranslation();
  const { noteUid } = useParams<{ noteUid: string }>();
  const { data, isLoading, isError, error, refetch } = useMindmapQuery(noteUid);
  const save = useSaveMindmapMutation(noteUid);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 编辑高频（拖一次触发多个 operation）→ 防抖后再落库，
  // 但**乐观更新已经在渲染器内部发生**，用户手感不受影响。
  const onChange = (next: MindMapDoc) => {
    // 服务端还没有保存端点：**不对着不存在的路由发请求**。
    // 编辑在渲染器内即时生效，但不假装已保存（下方有明确提示）。
    if (!MINDMAP_SAVE_SUPPORTED) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save.mutate(next), 600);
  };

  if (isError) return <ErrorBlock error={error} onRetry={() => void refetch()} className="m-6" />;
  if (isLoading) return <div className="p-6 text-sm text-ink-muted">{t('common.loading')}</div>;
  if (!data) return <EmptyState title={t('mindmap.empty')} hint={t('mindmap.emptyHint')} />;

  return (
    <div className="flex h-full flex-col">
      <MockNotice surface="notes" className="m-3" />
      {!MINDMAP_SAVE_SUPPORTED ? (
        <p className="mx-3 mt-3 rounded-md border border-line border-l-4 border-l-warning bg-surface-1 px-3 py-2 text-xs text-ink-secondary">
          ⓘ {t('mindmap.editsNotPersisted')}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        <MindmapView doc={data} onChange={onChange} />
      </div>
    </div>
  );
}
