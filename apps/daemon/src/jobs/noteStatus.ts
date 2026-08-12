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
import {
  PIPELINE_JOB_KINDS,
  type NoteFailure,
  type NoteStatus,
  type NoteViewStatus,
} from '@openmemo/shared';

import { jobErrorTextOf } from './errorText.js';
import type { NoteJobRecord } from './queue.js';

/** `queue.noteJobDigests()` 里单条笔记那一格：job type → 该类型最近一条任务。 */
export type NoteJobDigest = ReadonlyMap<string, NoteJobRecord>;

/**
 * 库里存的状态 + 这条笔记的 job 快照 → **如实的**状态。
 *
 * 规则：库里说 `processing` 时，**用最近一条转写任务此刻的真实状态**来说话；
 * 其余情况原样返回。
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
 * ### 为什么"可重试的中间失败"不会被误判
 *
 * `queue.fail()` 在可重试时把 state 置回 **`queued`**（留着 error_code，退避后再跑），
 * 只有真的没救了才写 `state='failed'`。所以判 `state === 'failed'`
 * 恰好就是"终态失败"，**一次网络抖动不会把笔记永久标红**。
 *
 * ### ★ 为什么是**穷尽 switch**，而不是「等于 failed 就报 failed，其余算处理中」
 *
 * 上一版就是那么写的，于是 `cancelled` / `paused` / `blocked` 三种"任务已经不在跑了"
 * 全都静默落进「处理中」。三条一模一样的谎话，只是没人撞见过前两条。
 *
 * `[实测]` 后两条更难看，因为**同一行里就自相矛盾**：列表行既渲染这个状态芯片，
 * 又渲染 `NoteProgressLine`（它按 job 状态说话）。于是芯片写「处理中」、
 * 紧挨着的那行写「暂时无法继续」/「已暂停」。而 `cancelled` 连进度行都没有
 * （终态不渲染），**整行零解释**。
 *
 * 写成对 `JobState` 的穷尽 switch 之后，将来加一个 job 状态**必须**在这里显式回答
 * 「这条笔记该怎么说」，编译器不让它悄悄落进 default。
 */
export function effectiveNoteStatus(
  stored: NoteStatus,
  digest: NoteJobDigest | undefined,
): NoteViewStatus {
  if (stored !== 'processing') return stored;
  const state = digest?.get('transcribe')?.state;
  if (state === undefined) return stored;

  switch (state) {
    // 还在流程里 —— 「处理中」是真话
    case 'queued':
    case 'leased':
    case 'running':
      return stored;

    /*
     * 终态失败。⚠️ 只有真没救了才会是这个状态（可重试时 `queue.fail()` 置回 queued），
     * 所以这里不会把一次网络抖动说成永久失败。
     */
    case 'failed':
      return 'failed';

    /*
     * ★ 用户自己取消的。**刻意不并进 `failed`** —— 「我自己取消的」和「它失败了」
     * 对用户是两件事：前者不需要「重试」当主按钮，需要的是「重新转写」。
     * 并档能少改几处，代价是产品对用户刚做过的动作说错话。
     *
     * ⚠️ 取消可能留下**半截稿子**（已落库的段落按设计保留）。这里仍报 `cancelled`
     * 而不是 `partial`：`partial` 的既有含义是"跑完了但结果不全"（`result.yielded`），
     * 而这条的成因是"被你停下了"。用户要知道的是**为什么停的**。
     */
    case 'cancelled':
      return 'cancelled';

    /*
     * ★ 在等一个**可修复的前置条件**（没装 ASR 模型 / 没配 LLM / 磁盘不足）。
     * 条件满足会自动继续，所以**不是**失败 —— 报成 `failed` 是把等待态说成终局。
     * 但它同样不是「处理中」：此刻什么都没在跑，而且它不会自己好。
     */
    case 'blocked':
      return 'blocked';

    /* ★ 用户暂停的，可 resume。同样：没在跑，但也没结束。 */
    case 'paused':
      return 'paused';

    /*
     * 任务成功了、笔记却还写着 `processing` —— 这是个**真异常**
     * （runner 在 `updateNote(ready)` 与 `queue.succeed()` 之间死了）。
     * 这里**不编**一个结论：如实回落到库里存的那个值，让它继续显示「处理中」，
     * 排查时能看出"有一条成功的 job 配着一条没收尾的笔记"。
     * 猜成 `ready` 会掩盖掉这个信号，而且那条笔记多半真的没有稿子。
     */
    case 'succeeded':
      return stored;
  }
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
