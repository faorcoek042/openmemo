import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Cpu, Download } from 'lucide-react';

import type { GetInstalledResponse, InstalledModel } from '@openmemo/shared';

import { api } from '../../lib/api/client';
import { qk } from '../../app/query';
import { arr } from '../../lib/safe';
import { Button } from './Button';

/**
 * 语音识别模型选择器 —— **列表来自后端，选择真的生效**。
 *
 * ## 它替换掉了什么
 *
 * 原来 `RecorderPage` 里写死了 `useState<'paraformer' | 'turbo'>`：
 * - 不来自 manifest，装再多模型也不会出现（用户看到的"只有两个可选"就是这么来的）
 * - 选中的值**从不发给后端**，选了等于没选
 * - `'turbo'` 这个字符串在后端根本不存在
 *
 * 三条合起来是同一个病：**UI 假装自己有权决定，实际什么都没决定。**
 *
 * ## 现在的真实边界（重要，不粉饰）
 *
 * 后端的 `ImportNoteRequest` 只接受 `{input, title?, language?}` ——
 * **没有 `engineId` / `modelId`**，也就是说**"单次任务用哪个模型"目前不可指定**。
 * 能改的是**全局激活的模型**（`POST /api/models/activate`）。
 *
 * 所以这里做成"**切换当前使用的模型**"而不是"本次任务用哪个"：
 * 前者是真的、立刻生效；后者会是又一个假选择器。
 * 等后端支持按任务覆盖，再把它升级成 per-task 选择即可 —— 数据源不用改。
 */
export function AsrModelPicker({ className }: { className?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: qk.models.installed,
    queryFn: () => api<GetInstalledResponse>('models', '/models/installed'),
  });

  const activate = useMutation({
    mutationFn: (id: string) =>
      api<unknown>('models', '/models/activate', { method: 'POST', body: { role: 'asr', id } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.models.installed }),
  });

  // 只列真正装好的 ASR 模型 —— 没装的不灰掉塞在列表里，而是给"去安装"
  const models: InstalledModel[] = arr(data?.models).filter(
    (m) => m.role === 'asr' && m.integrity !== 'missing_files',
  ) as InstalledModel[];
  const activeId = data?.active?.asr ?? null;

  if (isLoading) {
    return <span className={className}>{t('common.loading')}</span>;
  }

  // 一个都没装：给出路，而不是一个空下拉框
  if (models.length === 0) {
    return (
      <span className={className}>
        <span className="mr-2 text-xs text-warning">{t('asr.noModel')}</span>
        <Button size="sm" variant="secondary" onClick={() => navigate('/models')}>
          <Download className="size-3.5" />
          {t('asr.goInstall')}
        </Button>
      </span>
    );
  }

  return (
    <label className={className}>
      <span className="mr-2 inline-flex items-center gap-1 text-xs text-ink-secondary">
        <Cpu className="size-3.5" aria-hidden />
        {t('asr.modelLabel')}
      </span>
      <select
        value={activeId ?? ''}
        onChange={(e) => activate.mutate(e.target.value)}
        disabled={activate.isPending}
        aria-label={t('asr.modelLabel')}
        data-testid="asr-model-select"
        className="h-8 rounded-md border border-line bg-surface-0 px-2 text-sm text-ink"
      >
        {activeId === null ? <option value="">{t('asr.notSelected')}</option> : null}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.displayName}
            {m.quantization ? ` (${m.quantization})` : ''}
          </option>
        ))}
      </select>
      {/* 说清楚这是全局切换，不是"本次任务用哪个" —— 免得用户以为可以按任务选 */}
      <span className="ml-2 text-xs text-ink-muted">{t('asr.activeIsGlobal')}</span>
    </label>
  );
}
