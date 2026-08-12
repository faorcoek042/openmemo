/**
 * 「这条笔记现在到底是什么状态」—— **读的时候算，不写库**（#98）。
 *
 * ## 被修的那个缺陷
 *
 * `notes.status` 的 CHECK 约束里从第一天就有 `'failed'`，`NotesListPage.tsx` 也一直
 * 在渲染它（红色的「失败」chip）。但**全仓没有任何一处写过这个值** ——
 * `updateNote()` 只有三四个调用点，取值只有 `processing` / `ready` / `partial`。
 * **接收端早就建好了，发送端从来没接上。**
 *
 * 后果是一条转写失败的笔记在列表里**永远**写着「处理中」：右下角那条 toast
 * 刷新即无，详情页一个字不说，列表说它还在跑。三个界面对同一件已经结束的事
 * 给出三种说法，没有一种是真的。
 *
 * ## 为什么是读时自愈，而不是在失败路径上补一句写入
 *
 * 1. **补写入只救得了以后的数据。** `:10000` 上那个库里此刻就卡着这样的笔记，
 *    用户机器上同样。要救它们就得再写一次性迁移 —— 而迁移是不可逆的猜测：
 *    它得替一条几个月前的笔记判断"当年那次到底算不算失败"。
 * 2. **「失败」本来就不是笔记自己的事实，是从 job 状态推出来的结论。**
 *    存一份就等于建立第二个真相，两者迟早分叉（本仓已经为这个形状付过多次账：
 *    `note.activeJobId`、`starred` 的前端过滤、两张 remediation 路由表…）。
 *
 * 同一条路子在 #29 的「重新转写」判据上已经用过一次并且成立：`canRetranscribe`
 * 也是**读时真解析一次**，不写库，而且顺带救了修复之前就坏掉的数据。
 *
 * ## 本文件不碰 DB、不碰 HTTP
 *
 * 输入是 `queue.noteJobDigests()` 的结果（纯数据），输出是契约里的两个值。
 * 这样这条判据可以被单独喂真实形状验证，而不是只能靠起一个 daemon 点一遍 ——
 * 上一次同类判据（toast 能不能显示）正是因为埋在组件的 useEffect 里，
 * 才让「blocked 到不了屏幕上」活了那么久。
 */
import { PIPELINE_JOB_KINDS, type NoteFailure, type NoteStatus } from '@openmemo/shared';

import { jobErrorTextOf } from './errorText.js';
import type { NoteJobRecord } from './queue.js';

/** `queue.noteJobDigests()` 里单条笔记那一格：job type → 该类型最近一条任务。 */
export type NoteJobDigest = ReadonlyMap<string, NoteJobRecord>;

/**
 * 库里存的状态 + 这条笔记的 job 快照 → **如实的**状态。
 *
 * 规则只有一条，刻意写得很窄：
 *
 * > 库里说 `processing`，而**最近一条转写任务已经终态失败** ⇒ 报 `'failed'`。
 *
 * ### 为什么只从 `processing` 升上来
 *
 * 一条已经 `ready` 的笔记重跑失败时仍然是 `ready` —— 它的稿子确实还在、读得了。
 * 把它标红是另一句假话（"这条笔记坏了"），而且是更贵的那种：用户会以为数据没了。
 * 那次失败由 `NoteDetail.lastFailure` 单独说，两件事分开表达。
 *
 * ### 为什么只看 `transcribe`
 *
 * **判据要和写入方对齐。** `notes.status` 的三个写入点全都在转写路径上
 * （`runners/transcribe.ts` 收尾、`ws/recorder.ts` 录音结束）。导图任务失败
 * 不该让一条转写好的笔记显示"处理失败" —— 那是任务中心与 `lastFailure` 的事。
 *
 * ### 为什么 `blocked` 不算失败（这是判断，不是遗漏）
 *
 * `blocked` = 缺前置条件（没装 ASR 模型、没配 LLM），**条件满足后会自动继续**，
 * 而且它带着可点击的 remediation。把它报成 `'failed'` 会把一个可修复的等待态
 * 说成终局。⚠️ 但今天它落在 `processing` 这一档，也就是列表上仍写着「处理中」——
 * 那句话对一个"在等你装模型"的任务同样不准确。`NOTE_STATUSES` 里没有对应的档，
 * 补一档要动建表约束 + 契约 + 三处渲染，**本轮刻意没做，记在这里**。
 * 在补上之前，这类笔记的出口是任务中心那条带按钮的 `blocked` 记录。
 *
 * ### 为什么"可重试的中间失败"不会被误判
 *
 * `queue.fail()` 在可重试时把 state 置回 **`queued`**（留着 error_code，退避后再跑），
 * 只有真的没救了才写 `state='failed'`。所以这里判 `state === 'failed'`
 * 恰好就是"终态失败"，**一次网络抖动不会把笔记永久标红**。
 */
export function effectiveNoteStatus(
  stored: NoteStatus,
  digest: NoteJobDigest | undefined,
): NoteStatus {
  if (stored !== 'processing') return stored;
  return digest?.get('transcribe')?.state === 'failed' ? 'failed' : stored;
}

/**
 * 这条笔记上**最近一次终态失败**的流水线任务；没有就是 `null`。
 *
 * 与 `effectiveNoteStatus` 用的是同一份快照，所以「状态说失败、底下却没有原因」
 * 这种自相矛盾在结构上就不可能出现。
 *
 * 覆盖**所有**流水线类型（转写 + 导图），比 `status` 那条宽：
 * 一条笔记转写好了但导图生成失败，`status` 仍是 `ready`（对的），
 * 而用户点了「生成思维导图」之后确实需要知道那次点击的下场（也是对的）。
 *
 * 只认**每种类型的最近一条**：重跑一次就翻篇，旧的失败不该一直挂在页面上。
 */
export function noteFailureOf(digest: NoteJobDigest | undefined): NoteFailure | null {
  if (!digest) return null;

  let latest: NoteJobRecord | undefined;
  for (const record of digest.values()) {
    if (record.state !== 'failed') continue;
    if (!(PIPELINE_JOB_KINDS as readonly string[]).includes(record.type)) continue;
    if (!latest || record.updatedAt > latest.updatedAt) latest = record;
  }
  if (!latest) return null;

  const text = jobErrorTextOf(latest.errorCode, latest.errorDetail);
  return {
    jobUid: latest.uid,
    // 上面的过滤已经保证它是 PIPELINE_JOB_KINDS 里的一个
    kind: latest.type as NoteFailure['kind'],
    /*
     * 终态 `failed` 却没有 error_code 的行是可能的（例如老数据、或将来某条
     * 只改 state 不写码的路径）。这里**不编一个具体的码**，如实报 `UNKNOWN` ——
     * 消费方只拿它做展示与分档，一个假的 `RUNNER_ERROR` 只会让排查走岔。
     */
    code: latest.errorCode ?? 'UNKNOWN',
    message: text.message,
    messageZh: text.messageZh,
    at: new Date(latest.updatedAt).toISOString(),
  };
}
