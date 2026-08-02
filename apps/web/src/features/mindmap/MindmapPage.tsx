import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useRef } from 'react';
import type { MindMapDoc } from '@openmemo/mindmap';

import { MindmapView } from './MindmapView';
import { useMindmapQuery, useSaveMindmapMutation } from './api';
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
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save.mutate(next), 600);
  };

  if (isError) return <ErrorBlock error={error} onRetry={() => void refetch()} className="m-6" />;
  if (isLoading) return <div className="p-6 text-sm text-ink-muted">{t('common.loading')}</div>;
  if (!data) return <EmptyState title={t('mindmap.empty')} hint={t('mindmap.emptyHint')} />;

  return (
    <div className="flex h-full flex-col">
      <MockNotice surface="notes" className="m-3" />
      <div className="min-h-0 flex-1">
        <MindmapView doc={data} onChange={onChange} />
      </div>
    </div>
  );
}
