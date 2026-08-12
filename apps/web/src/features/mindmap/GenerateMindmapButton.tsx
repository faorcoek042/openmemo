import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';

import { useGenerateMindmapMutation } from './api';
import { useActiveNoteJob } from '../tasks';
import { blockedReasonKey } from '../../lib/jobs/blockedReason';
import { Button } from '../../components/common/Button';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { formatPercent } from '../../lib/format/bytes';

/**
 * F4 的**生成入口**（T-138 ①）。
 *
 * ## 为什么这个按钮此前不存在，以及为什么它必须带进行中状态
 *
 * 后端整条链路早就通了（端点 + runner + 落库 + SSE），前端有查看器、有编辑、有导出，
 * **唯独没有人能触发生成** —— 空态只有一句"还没有思维导图"。
 * F4 是章程点名的五项功能之一，它在产品里到不了。
 *
 * 生成走的是**在线 LLM**，实测 4.3 秒（deepseek）。这几秒里如果按钮还是可点的，
 * 用户必然再点一次 —— 而每一次点击都会真的排一条新任务（端点没有幂等键，
 * 那是刻意的：重新生成是合法操作，不能被 24h 幂等窗口吃掉）。
 * 所以"进行中"不是装饰，是**防重复提交的那道闸**。
 *
 * ## 进行中状态从哪来
 *
 * **不是** mutation 的 `isPending`（那只有 HTTP 往返的几毫秒），
 * 而是 T-130 定下的任务流：`GET /api/jobs` 现在如实列出流水线任务
 * （`PipelineJob` 自带 `noteUid` 与 `kind`），SSE 的 `job.state/progress/blocked` 负责更新。
 * 好处是**刷新页面它还在** —— 生成中途按 F5 回来，按钮仍然是"正在生成"，
 * 而不是变回"生成"骗用户再点一次。
 *
 * `blocked` 单独说话：没配 LLM / 没有转写稿时任务不会失败，而是挂起等条件
 * （D-01 §4.1）。这时按钮**保持禁用**并说明原因 —— 再点一次只会多排一条同样卡住的任务。
 */
export function GenerateMindmapButton({
  noteUid,
  size = 'md',
  className,
}: {
  noteUid: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const generate = useGenerateMindmapMutation(noteUid);
  const job = useActiveNoteJob(noteUid, 'mindmap');

  const blocked = job?.state === 'blocked';
  // 排队中 / 跑着 / 卡住 —— 三种都不该再接受一次点击
  const busy = generate.isPending || Boolean(job);

  const label = blocked
    ? t('mindmap.generateBlocked')
    : busy
      ? job && job.progress > 0
        ? `${t('mindmap.generating')} ${formatPercent(job.progress, i18n.language)}`
        : t('mindmap.generating')
      : t('mindmap.generate');

  /*
   * blocked 的原因用 daemon 给的 `blockedCode` 分派，**不在前端重新判断一次条件**
   * （"有没有转写稿""配没配 LLM"只有 daemon 说了算，前端猜必然有猜错的那天）。
   * 认不出的 code 回落到一句通用的"去任务中心看看"，而不是显示一个空白。
   *
   * ★ 那张 code → 词条的表**搬去了 `lib/jobs/blockedReason.ts`**（Manager 裁决）。
   * 理由：`blocked` 不是导图独有的状态 —— 转写同样会挂起（没装 ASR 模型），
   * 而笔记页那条进度行此前说不出在等什么。在那边再建一张表就是「同一个概念两份」，
   * 今天两张说的话一致，下一个人只会改一张。
   *
   * ⚠️ 这里少掉的那句 `defaultValue` **不是丢了，是挪进了 `blockedReasonKey()`**：
   * 回落归表管，不归每个调用点各写一次 —— 各写一次就一定会漏，
   * 而漏掉的那一处是一块**不会让任何测试变红**的空白。
   */
  const blockedHint = blocked ? t(blockedReasonKey(job?.blockedCode)) : null;

  return (
    <div className={className}>
      <Button
        variant="primary"
        size={size}
        disabled={busy}
        aria-busy={busy}
        data-testid="generate-mindmap"
        onClick={() => generate.mutate()}
      >
        <Sparkles className="size-4" aria-hidden />
        {label}
      </Button>
      {blockedHint ? (
        <p className="mt-2 text-xs text-ink-secondary" data-testid="generate-mindmap-blocked">
          {blockedHint}
        </p>
      ) : null}
      {/* 写操作绝不静默回落 mock（`lib/api/client.ts`），失败必须说出来 */}
      {generate.isError ? <ErrorBlock error={generate.error} className="mt-3" /> : null}
    </div>
  );
}
