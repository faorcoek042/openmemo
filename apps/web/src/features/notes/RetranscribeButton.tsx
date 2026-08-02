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
 * ⚠️ **同一个类型在两条通道上形状不同**，所以这里必须同时认两种写法：
 * - `GET /api/notes/:uid/transcript`（REST）发的是 **`edited: boolean`**
 *   （`rest/notes.ts` 里 `edited: s.edited_at !== null`）
 * - 前端 `TranscriptSegmentDto` 声明的是 **`editedAt: number | null`**（SSE 增量走这个形状）
 *
 * 只认其中一个，就会在另一条通道上**恒为"没人编辑过"** ——
 * 而这个判断的下游是"你的修改会不会丢"的警告，静默失效的代价是用户白丢编辑。
 * 契约该统一（已报 Manager），在统一之前**宁可两边都认**。
 */
export function isSegmentEdited(seg: Partial<TranscriptSegmentDto> & { edited?: boolean }): boolean {
  if (typeof seg.edited === 'boolean') return seg.edited;
  return seg.editedAt != null;
}

export function RetranscribeButton({
  noteUid,
  segments,
  currentLanguage,
}: {
  noteUid: string;
  segments: readonly (Partial<TranscriptSegmentDto> & { edited?: boolean })[];
  currentLanguage: string | null;
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
   * 409 `NO_SOURCE_INPUT`：这条笔记没记录原始输入，重跑无从跑起。
   *
   * ⚠️ 本该**事前**就不显示按钮 —— `RetranscribeRequest` 的注释也是这么要求的
   * （"the UI must not offer the button in that case"）。
   * 但 `NoteDetail` **没有任何字段**表达"有没有可重新拉取的源"，前端无从判断。
   * 与其按 `kind` 瞎猜（猜错就是把能用的功能藏了），不如让服务端的拒绝**可见** ——
   * 已报 Manager：`NoteDetail` 需要补一个 `canRetranscribe`。
   */
  const noSource = run.error instanceof ApiError && run.error.code === 'NO_SOURCE_INPUT';

  return (
    <div className="relative">
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-1.5 text-xs"
        data-testid="retranscribe-open"
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
            ★ 编辑会不会丢，必须**在点之前**说清楚。

            ⚠️ 现状是**会丢**：两阶段合并只在 `payload.mergeWithTranscriptId !== undefined`
            时才跑，而**只有录音会话**（`ws/recorder.ts`）传这个键；
            REST 的 retranscribe **不传**，合并分支整段跳过。
            所以这里不能沿用录音页那句"你编辑过的 N 段已保留" —— 那在这条路径上是假的。
            等 daemon 补上（`repos.activeTranscriptOfNote(note.id)?.id` 一行的事），
            这段文案改回"已保留"，徽标逻辑现成。
          */}
          {editedCount > 0 ? (
            <Banner
              tone="warning"
              title={t('detail.retranscribe.editsAtRisk', { count: editedCount })}
              detail={t('detail.retranscribe.editsAtRiskDetail')}
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
