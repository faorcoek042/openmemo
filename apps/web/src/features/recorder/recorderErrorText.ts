/**
 * 录音页那条 WebSocket 错误横幅的**措辞总表**（#112 第 19 处）。
 *
 * ## 这一处和另外五处不是一个病
 *
 * 其余几处都是「daemon 有中文、前端照抄」——把中文换成 code 就修好了。
 * 这一处**连英文字段都没有**：`/ws/recorder` 的 error 帧上原来只有 `messageZh`，
 * 而 `RecorderPage` 直接 `setStreamError(msg.messageZh)`。也就是说
 * **英文用户那条横幅无论怎么改前端都救不了** —— 帧上没有别的东西可渲染。
 * 所以修法必须从 daemon 那一侧加字段（`RecorderErrorReason`），这个文件是它的另一半。
 *
 * ## ★★ 为什么是 `Record<全部 kind, string>` 而不是 `switch` 或 `?.`
 *
 * 下面那张表是**总表**：契约里新增一种原因而没人给它写话，**构建当场就红**。
 * 换成 `KEYS[k] ?? ''`，新原因会静默渲染成一段空白 —— 而这条横幅的渲染点是
 * `{streamError ? <Banner … /> : null}`：**空串等于整条横幅不渲染**。
 * 一句说错了的话至少让用户知道出了事；一片空白连这个都没有。
 * 做法照 `../components/reasonText.ts` 与 `../runtime/reasonKeys.ts`。
 *
 * ## 🔴 渲染用的联合比契约**多一格**，而且它刻意不在契约里
 *
 * `not_reported`（「对面这一版没说是哪一种」）**不在 `packages/shared`**，
 * 于是 daemon 在**类型上就发不出它** —— 它唯一可能的来路是一个更旧的 daemon
 * 发来的、根本没有 `reason` 字段的帧。这让这个值的出处成为**结构性保证**，
 * 而不是一条靠人遵守的约定。别把它「整理」进共享契约。
 */

import type { RecorderErrorReason } from '@openmemo/shared';

import { unreachable, type Translate } from '../../lib/wording';

/**
 * 界面**真的要渲染**的那个联合 = 契约的六格 + 一格「对面没说」。
 *
 * 见文件抬头：多出来的那一格是给**老 daemon** 用的，不是给新 daemon 用的。
 */
export type RenderableRecorderError = RecorderErrorReason | { readonly kind: 'not_reported' };

/** 每一种错法该说哪句话。**总表**，七格一个都不许少。 */
export const RECORDER_ERROR_KEYS: Readonly<Record<RenderableRecorderError['kind'], string>> = {
  stream_engine_unavailable: 'recorder.wsError.streamEngineUnavailable',
  start_failed: 'recorder.wsError.startFailed',
  engine_error: 'recorder.wsError.engineError',
  finalize_failed: 'recorder.wsError.finalizeFailed',
  control_message_not_json: 'recorder.wsError.controlMessageNotJson',
  asr_worker_not_implemented: 'recorder.wsError.asrWorkerNotImplemented',
  not_reported: 'recorder.wsError.notReported',
};

/** 说不出是哪一种时的那一格。单例，省得每条路径各造一个字面量。 */
const NOT_REPORTED: RenderableRecorderError = { kind: 'not_reported' };

/**
 * 一条 `RenderableRecorderError` → 用户读得懂的那句话（当前语言）。
 *
 * ⚠️ **`detail` 是 daemon 捕到的 `err.message` 原样串，这里不假装它是我们的话。**
 * 三条 `*_failed` / `engine_error` 走的是「**阶段知道、成因不知道**」那个形状：
 * `kind` 说清卡在哪一步（够不够用户判断"我录的东西还在不在"），
 * `detail` 由词条单独包起来（「Recorder output: …」/「录音端原文：…」），
 * 读者一眼看得出哪一段是原文。直接拼在句尾会让一段没有 i18n 的字符串
 * 冒充成产品文案 —— 同 `UpstreamFailure.upstream_error_text` 与
 * `Inapplicability.backend_unavailable.detail` 的纪律。
 */
export function recorderErrorText(t: Translate, r: RenderableRecorderError): string {
  switch (r.kind) {
    case 'stream_engine_unavailable':
    case 'control_message_not_json':
    case 'asr_worker_not_implemented':
    case 'not_reported':
      return t(RECORDER_ERROR_KEYS[r.kind]);
    case 'start_failed':
    case 'engine_error':
    case 'finalize_failed':
      return t(RECORDER_ERROR_KEYS[r.kind], { detail: r.detail });
    /*
     * 兜底取空串；真跑到这一行时让整张录音页崩掉是更坏的结果 —— 用户正在录音。
     *
     * ⚠️ 这里返回空串是安全的，**而且只因为一件事**：进入本模块的每一个值都先过
     * {@link normalizeRecorderError}，它按白名单收口，凡是它不认得的一律变成
     * `not_reported`。也就是说这一行在**运行期同样不可达** ——
     * 上面那张总表守编译期，`normalizeRecorderError` 守运行期，两道一起才够。
     * 谁要是绕开 `normalizeRecorderError` 直接把网线上的东西喂进来，这条保证就没了。
     *
     * ★ 这个模块是这一族里**两条腿都写全了**的样板（`lib/wording.ts` 抬头引的就是它）。
     * 空串兜底本身**不是**可以随手照抄的东西：同族的 `reasonText` / `reasonKeys`
     * 抄了这一行、却没有第二条腿，于是那两处的空白在版本错配时是真会出现的。
     */
    default:
      return unreachable(r, '');
  }
}

/**
 * 网线上那个 `reason` → **一定渲染得出话**的那个联合。
 *
 * ## 它必须存在的理由
 *
 * `RecorderServerMessage` 的类型只是我们对帧的**期望**，WS 不是类型边界。
 * 真会到达这里的东西包括：老 daemon 的帧（**根本没有 `reason`**）、
 * 以及未来某一版新增、而这份前端还不认识的 `kind`。
 *
 * 🔴 **永不返回 null，也永不返回一个会渲染成空白的东西。**
 * 渲染点是 `{streamError ? <Banner tone="warning" title={streamError} /> : null}` ——
 * 假值渲染出来的是**什么都没有**，比一句说错了的话更糟：
 * 会话已经死了，而用户不知道出过事。#112 记的那条「旧前端撞上新 daemon」
 * 的后果（`setStreamError(undefined)` ⇒ 整条横幅不渲染）就是这个形状，
 * 方向反过来一次而已。
 *
 * ## 认得 `kind`、但 `detail` 缺了怎么办
 *
 * **保住 `kind`，把 `detail` 收成空串**，而不是整条塌成 `not_reported`。
 * 因为两半的份量不一样：`kind` 回答的是「我录的东西还在不在」
 * （`start_failed` = 一行都没建，`finalize_failed` = 音频可能已经落盘），
 * 那是用户下一步动作的依据；`detail` 只是给排障用的原文。
 * 塌成 `not_reported` 会让界面说出「这一版没说是哪一种」——
 * 而它明明说了，那是**我们自己编的一句假话**，正是本轮在清的那一族。
 */
export function normalizeRecorderError(raw: unknown): RenderableRecorderError {
  if (typeof raw !== 'object' || raw === null) return NOT_REPORTED;
  const kind: unknown = (raw as { kind?: unknown }).kind;
  switch (kind) {
    case 'stream_engine_unavailable':
    case 'control_message_not_json':
    case 'asr_worker_not_implemented':
      return { kind };
    case 'start_failed':
    case 'engine_error':
    case 'finalize_failed': {
      const detail: unknown = (raw as { detail?: unknown }).detail;
      return { kind, detail: typeof detail === 'string' ? detail : '' };
    }
    default:
      return NOT_REPORTED;
  }
}
