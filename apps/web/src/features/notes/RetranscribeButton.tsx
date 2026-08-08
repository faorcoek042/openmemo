import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';

import { api, ApiError } from '../../lib/api/client';
import { qk } from '../../app/query';
import { Button } from '../../components/common/Button';
import { Banner } from '../../components/common/Banner';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { TranscribeOptions } from '../../components/common/TranscribeOptions';
import { ASR_LANGUAGE_AUTO } from '../../lib/asr';
import type { TranscriptSegmentDto } from '../../lib/events/types';

/**
 * 「重新转写」—— 补上那个**唯一的补救通道**。
 *
 * ## 为什么这个入口是必须的
 *
 * whisper.cpp 拿不到 `-l` 时会把中文**翻译成英文**返回。转写稿里存的就是那篇英文，
 * 原始中文**不在库里任何地方** —— 唯一的找回办法是拿着原始音频、指定语言重跑一遍。
 * `POST /api/notes/:uid/retranscribe` 早就接受 `language` 了，
 * 但产品里没有任何地方能调到它：**端点有了，路没有**。
 *
 * ## 只暴露语言，不画引擎/模型选择器
 *
 * 后端 `retranscribe` 的 body 目前**只解析 `language`**（`content.ts` 里
 * `typeof body?.language === 'string'`，其余键读都不读）。
 * 在 `oss-scout` 把 `engineId` / `modelId` / `prompt` 加上之前，
 * 多画一个下拉框就是多一个"选了会被丢掉"的谎 —— 上一轮刚拆掉两个，不再造第三个。
 * 模型仍可切，但走的是**全局激活**（`TranscribeOptions` 里的 `AsrModelPicker`），那是真生效的。
 */

/**
 * 判断一段是否被用户编辑过。
 *
 * 契约**已统一**：daemon 现在以 `editedAt` 为权威、并附带 `edited` 布尔投影，
 * 两条通道不再分裂。这里仍然两个都认，是**刻意的向后兼容**而非遗留：
 * SSE 增量与 REST 全量由不同代码路径构造，缓存里也可能残留旧形状的段。
 *
 * 优先读 `editedAt` —— 它同时是 `mergeTranscripts` 判"要不要保留"的依据，
 * 前后端用同一个事实，不必各自推导。
 *
 * ⚠️ 判据必须是 `editedAt` 而不是"文本看起来没变"：
 * `editedAt` 丢了但文本还在时，**第一次重跑看着完全正常，第二次才把编辑覆盖掉**。
 */
export function isSegmentEdited(
  seg: Partial<TranscriptSegmentDto> & { edited?: boolean },
): boolean {
  if (seg.editedAt != null) return true;
  return seg.edited === true;
}

export function RetranscribeButton({
  noteUid,
  segments,
  currentLanguage,
  canRetranscribe,
}: {
  noteUid: string;
  segments: readonly (Partial<TranscriptSegmentDto> & { edited?: boolean })[];
  currentLanguage: string | null;
  /**
   * 来自 `NoteDetail.canRetranscribe`（daemon 按 `input_url` 非空判定）。
   *
   * 之前没有这个字段，前端无从判断，只能让 409 事后暴露。现在能**事前**禁用了 ——
   * 但 `undefined` 要当成"可以"：老响应里没有这个键，
   * 把"字段缺失"读成"不能重跑"会把功能对所有旧数据藏起来。
   * 宁可点下去吃一个说人话的 409，也不要静默隐藏一个本来能用的入口。
   */
  canRetranscribe?: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  // 默认填**当前转写稿实际用的语言**，而不是 auto：
  // 用户来这里多半是因为语言判错了，让他看见"上次是按什么跑的"才好改
  const [language, setLanguage] = useState<string>(currentLanguage ?? ASR_LANGUAGE_AUTO);

  // 不用 arr()：入参已声明为只读数组，这里只需防 undefined
  const editedCount = (segments ?? []).filter(isSegmentEdited).length;

  const run = useMutation({
    mutationFn: () =>
      api<{ jobUid: string; noteUid: string }>('notes', `/notes/${noteUid}/retranscribe`, {
        method: 'POST',
        // 只发后端会读的键。空语言不发 —— 后端会回落到 note.language，那是正确的默认
        body: language ? { language } : {},
      }),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: qk.notes.detail(noteUid) });
      void qc.invalidateQueries({ queryKey: qk.transcript(noteUid) });
      void qc.invalidateQueries({ queryKey: qk.jobs.all });
    },
  });

  /**
   * 409 `NO_SOURCE_INPUT` 的兜底。
   *
   * 现在 `NoteDetail.canRetranscribe` 已经能**事前**禁用按钮，
   * 但这条分支要留着：`canRetranscribe` 是**打开页面那一刻**的快照，
   * 而源文件可能在此之后被删。事前判断与事后拒绝防的不是同一件事。
   */
  const noSource = run.error instanceof ApiError && run.error.code === 'NO_SOURCE_INPUT';

  return (
    <div className="relative">
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-1.5 text-xs"
        data-testid="retranscribe-open"
        disabled={canRetranscribe === false}
        // 禁用的控件必须自己解释为什么，否则用户只会以为坏了
        title={canRetranscribe === false ? t('detail.retranscribe.noSource') : ''}
        onClick={() => setOpen((v) => !v)}
      >
        <RefreshCw className="size-3.5" aria-hidden />
        {t('detail.retranscribe.open')}
      </Button>

      {open ? (
        <div
          className="absolute top-full right-0 z-20 mt-1 w-80 space-y-3 rounded-lg border border-line bg-surface-1 p-3 shadow-lg"
          data-testid="retranscribe-panel"
        >
          <p className="text-xs text-ink-secondary">
            {currentLanguage
              ? t('detail.retranscribe.currentLang', { lang: currentLanguage })
              : t('detail.retranscribe.currentLangUnknown')}
          </p>

          <TranscribeOptions language={language} onLanguageChange={setLanguage} />

          {/*
            ★ 换回「已保留」—— 这句话现在是**真的**了。
            `oss-scout` 把 `mergeWithTranscriptId` 接上（并加了 `!== transcript.id` 守卫
            防止复用同一份稿时自己跟自己合并），实测连跑两次 `editedAt` 都还在。

            为什么强调"连跑两次"：修完之后测一次是会通过的 —— 文本还在，看起来已经好了。
            但 `editedAt` 若没跟着保留，**第二次重跑就会把它当没编辑过覆盖掉**。
            「测一次通过、测两次才暴露」正是这个项目反复栽跟头的那一类，
            所以这里的判据用 `editedAt` 而不是"文本看起来没变"。
          */}
          {editedCount > 0 ? (
            <Banner
              tone="info"
              title={t('detail.retranscribe.editsPreserved', { count: editedCount })}
              detail={
                <>
                  {/* 合并按**时间轴**对齐而非段落序号：两遍模型的断句天然不同，
                      按序号会把别人的句子塞进用户改过的地方。
                      因此"编辑过但没有对应新结果"是正常情况，必须能表达出来，
                      而不是让用户以为自己的修改被吞了。 */}
                  <span className="block">{t('recorder.mergeByTimeNote')}</span>
                </>
              }
            />
          ) : null}

          {noSource ? (
            <p className="text-xs text-warning" data-testid="retranscribe-no-source">
              {t('detail.retranscribe.noSource')}
            </p>
          ) : run.isError ? (
            <ErrorBlock error={run.error} />
          ) : null}

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t('capture.cancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={run.isPending}
              data-testid="retranscribe-submit"
              onClick={() => run.mutate()}
            >
              {run.isPending ? t('detail.retranscribe.starting') : t('detail.retranscribe.confirm')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
