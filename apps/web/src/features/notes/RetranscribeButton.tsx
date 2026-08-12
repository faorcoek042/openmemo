import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';

import { api, ApiError } from '../../lib/api/client';
import type { RetranscribeBlocked } from '../../lib/api/types';
import { pickLocalized } from '../../lib/format/localized';
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
 * ## 只暴露语言 —— 但理由已经**不是**"后端不收"了（#99 ①）
 *
 * ─── 这段话曾经为真，现在不成立，两边都留着 ────────────────────────────
 * 原文写的是「后端 `retranscribe` 的 body 目前**只解析 `language`**，其余键读都不读」，
 * 结论是"多画一个下拉框就是多一个选了会被丢掉的谎"。**那个前提今天是假的**：
 * `apps/daemon/src/http/rest/content.ts` 的 `retranscribe` 分支
 * （`body: { language?, engineId?, modelId?, prompt? }`）三个键**都在解析并塞进 payload**，
 * `POST /api/notes/import` 同样收这三个，`jobs/runners/transcribe.ts` 也真的在用它们。
 *
 * 于是缺口**翻了个面**：不再是"前端画了后端不认"，而是
 * **后端已经支持的「换引擎重转 / 换模型重转 / 加 prompt 重转」，从 UI 一条路都到不了** ——
 * 下面 `run` 的 body 至今只有 `{ language }`。
 *
 * ⚠️ 补上它**不是加一行 fetch body**，是一个产品决定（列哪些引擎/模型、默认选谁、
 * prompt 露不露），已作为 #99 ① 上报等裁决。**在裁决下来之前这里不许偷偷加下拉框** ——
 * 但也不许再用"后端不收"当理由，那句话会让下一个人不去查 `content.ts`。
 *
 * 模型目前仍可切，走的是**全局激活**（`TranscribeOptions` 里的 `AsrModelPicker`），
 * 那条路是真生效的，只是它改的是"以后所有转写"，不是"这一次重跑"。
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

/**
 * 禁用理由那条横幅的 DOM id。按钮用 `aria-describedby` 指过来。
 *
 * 常量而不是字面量：id 一旦和 `aria-describedby` 对不上，**不会报任何错**，
 * 只会安静地退回"读屏用户什么都听不到"—— 正是本轮要修的那个形状。
 */
export const RETRANSCRIBE_BLOCKED_ID = 'retranscribe-blocked-reason';

/**
 * "为什么不能重跑"的那句话。`null` = 可以重跑，什么都不用说。
 *
 * `tried` 单独返回而不是拼进字符串：横幅要把它排成一列路径给用户逐条核对，
 * 拼成一行加 `\n` 的那种做法只在 `title` 里成立 —— 而 `title` 已经被证明没人读得到。
 */
function useBlockedReason(
  canRetranscribe: boolean | undefined,
  retranscribeBlocked: RetranscribeBlocked | null | undefined,
): { head: string; tried: readonly string[] } | null {
  const { t, i18n } = useTranslation();
  if (canRetranscribe !== false) return null;
  /*
   * 回落那一档不是可有可无：老 daemon 的响应真的没有 `retranscribeBlocked`，
   * 而"没有原因字段"绝不能渲染成一条空横幅（那就退回成无声变灰了）。
   */
  if (!retranscribeBlocked) return { head: t('detail.retranscribe.noSource'), tried: [] };
  return {
    head: pickLocalized(i18n.language, retranscribeBlocked.messageZh, retranscribeBlocked.message),
    tried: retranscribeBlocked.tried,
  };
}

/**
 * ★★ 禁用理由的**真表面**（v0.7.1 已知边界第 4 条）。
 *
 * ## 在它之前，那条理由任何输入方式都拿不到
 *
 * 理由只挂在按钮的 `title` 上，而 `Button` 基类带 `disabled:pointer-events-none`：
 *
 * - **鼠标**：`pointer-events: none` 的元素收不到 `mouseover`，
 *   浏览器的原生 tooltip **根本不会弹** —— 不是"要悬停久一点"，是永远不弹。
 * - **键盘**：`disabled` 把它移出了 tab 序列，聚焦不到，也就没有任何触发方式。
 * - **读屏**：没有 aria-label / aria-describedby，`title` 在多数读屏配置下不播报。
 *
 * 也就是说：daemon 认认真真算出来的那条原因（`retranscribeBlocked`，含
 * `code`/`message`/`messageZh`/`tried`），**到了界面上等于没有**。
 * 用户看到的只是一个说不出话的灰按钮 —— 和"这功能坏了"完全一样。
 *
 * ## 仓库自己的测试没抓到，是因为它断言的是 `title` 属性存在
 *
 * 「文本存在」和「用户读得到」是两件事，而那条断言只证明了前者。
 * 换掉之后钉的是后果：**这句话必须出现在渲染出来的文档里**（见 components.test.tsx）。
 *
 * ## 为什么是横幅而不是"点一下才展开"
 *
 * 它不需要用户先想到去点。而且这条信息本来就不止服务于"重新转写"：
 * 源文件读不到意味着导出原件、重新剪辑同样做不了。
 *
 * ⚠️ 它由 `NoteDetailPage` 渲染在转写稿面板头的正下方，与按钮**分处两个节点**。
 * 忘了渲染它 = 按钮的 `aria-describedby` 指向一个不存在的 id，**不报错、静默失效**。
 * 因此那条回归腿钉在 `NoteDetailPage` 这一层，而不是只渲染按钮。
 */
export function RetranscribeBlockedNotice({
  canRetranscribe,
  retranscribeBlocked,
}: {
  /** 来自 `NoteDetail.canRetranscribe`。`undefined` / `true` 都表示"没被拦住"，渲染 `null`。 */
  canRetranscribe?: boolean;
  /**
   * 来自 `NoteDetail.retranscribeBlocked` —— 不能重跑时**为什么**（#95）。
   *
   * 有它，"变灰"才是一个诚实的状态。在此之前禁用时显示的是一句**写死的**
   * 「这条笔记没有记录原始输入」，而 daemon 判 `false` 的原因已经不止这一种：
   * 源文件读不到（数据目录搬过家、文件被删、外置盘没挂）时照旧显示那句话，
   * 就是**一句新的谎** —— 明明记录了原始输入，只是那个位置现在打不开，
   * 而这两种情况的处置完全不同（前者只能重新导入，后者把文件接回去就好）。
   *
   * 所以理由必须由 daemon 给：**只有它知道找过哪些位置**。
   * 字段缺失（老响应）时回落到那句通用文案 —— 与 `canRetranscribe` 同一条约定。
   */
  retranscribeBlocked?: RetranscribeBlocked | null;
}) {
  const { t } = useTranslation();
  const reason = useBlockedReason(canRetranscribe, retranscribeBlocked);
  if (!reason) return null;

  return (
    <div id={RETRANSCRIBE_BLOCKED_ID} data-testid="retranscribe-blocked">
      <Banner
        tone="warning"
        title={t('detail.retranscribe.blockedTitle')}
        detail={
          <>
            <span className="block">{reason.head}</span>
            {/* 找过的位置必须列出来：只说"读不到"时，用户无从判断到底是文件没了
                还是我们找错了地方 —— 列出来他照着就能自己确认一遍。 */}
            {reason.tried.length > 0 ? (
              <>
                <span className="mt-1 block">{t('detail.retranscribe.triedPaths')}</span>
                <ul className="list-inside list-disc break-all">
                  {reason.tried.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        }
      />
    </div>
  );
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
   * 来自 `NoteDetail.canRetranscribe`。
   *
   * ⚠️ **daemon 侧的判据已经换过（#95）**：它不再是"`input_url` 非空"，而是真的去
   * 解析一次（打不开就退回本笔记的归档原件，两档都落空才 `false`）。这里不需要跟着改
   * 逻辑，但要知道 `false` 的**原因不止一种**了。
   *
   * ⚠️ **理由本身不再由这个组件渲染**：它现在归 `<RetranscribeBlockedNotice/>`。
   * 这不是拆得更好看 —— 理由此前挂在本按钮的 `title` 上，而按钮基类带
   * `disabled:pointer-events-none`，那句话**鼠标、键盘、读屏三条路都到不了**。
   * 这里只保留 `aria-describedby`，把禁用状态指向那条真正读得到的横幅。
   *
   * `undefined` 要当成"可以"：老响应里没有这个键，
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

  /*
   * 禁用的控件必须自己解释为什么，否则用户只会以为坏了 —— 这条规矩本来就在。
   *
   * ⚠️ **那句解释不再放在 `title` 上**（v0.7.1 已知边界第 4 条）。
   * `Button` 基类带 `disabled:pointer-events-none`，而 `pointer-events: none` 的元素
   * **收不到 `mouseover`**，原生 tooltip 对鼠标用户也不会弹；`disabled` 又把它移出了
   * tab 序列。所以那个 `title` 在三种输入方式下**一个都到不了** —— 它看起来像解释，
   * 实际是装饰。留着它只会让下一个人以为这里已经解释过了。
   *
   * 真解释在 `<RetranscribeBlockedNotice/>`（由 `NoteDetailPage` 渲染在下方），
   * 这里只负责把禁用状态和那条横幅**关联起来**。
   */
  const blocked = canRetranscribe === false;

  return (
    <div className="relative">
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-1.5 text-xs"
        data-testid="retranscribe-open"
        disabled={blocked}
        aria-describedby={blocked ? RETRANSCRIBE_BLOCKED_ID : undefined}
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
