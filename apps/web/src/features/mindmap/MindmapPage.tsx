import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useRef } from 'react';
import type { MindMapDoc } from '@openmemo/mindmap';

import { MindmapView } from './MindmapView';
import { GenerateMindmapButton } from './GenerateMindmapButton';
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
    // 直接发。端点若不存在，写操作会如实抛错（绝不静默回落 mock），
    // 而不是靠一个需要有人记得翻开的常量拦在这里。
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save.mutate(next), 600);
  };

  if (isError) return <ErrorBlock error={error} onRetry={() => void refetch()} className="m-6" />;
  if (isLoading) return <div className="p-6 text-sm text-ink-muted">{t('common.loading')}</div>;
  /*
   * ★ 空态即入口（D-05 §5.4）。这里以前只有"还没有思维导图"这一句话 ——
   * 而 hint 里还写着"可以让 AI 生成"，**界面上却没有任何地方能触发它**（T-138 ①）。
   * 一句描述了不存在功能的文案，比没有文案更糟。
   */
  if (!data)
    return (
      <EmptyState
        title={t('mindmap.empty')}
        hint={t('mindmap.emptyHint')}
        action={<GenerateMindmapButton noteUid={noteUid ?? ''} />}
      />
    );

  return (
    <div className="flex h-full flex-col">
      <MockNotice surface="notes" className="m-3" />
      {/* 保存失败才说话；成功时一个字都不占（顶部横幅刷屏的教训） */}
      {save.isError ? <ErrorBlock error={save.error} className="mx-3 mt-3" /> : null}
      <div className="min-h-0 flex-1">
        <MindmapView doc={data} noteUid={noteUid ?? ''} onChange={onChange} />
      </div>
    </div>
  );
}
