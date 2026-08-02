/**
 * `ModelRole`（shared，7 个）→ `StoreKind`（downloader，3 个）的显式收窄。
 *
 * ## 为什么需要这个文件
 *
 * 两个包的枚举在 T-033 期间**发生了漂移**：
 * - `packages/shared` 的 `MODEL_ROLES` 被 `model-mgmt` 扩到 7 个
 *   （`asr | llm | vad | punctuation | diarization | embedding | tts`）
 * - `packages/downloader` 的 `StoreKind` 仍是 3 个（`asr | llm | backend`），
 *   它决定的是**磁盘上按类别分目录**的落盘结构
 *
 * 这两者本来就不是一回事：`ModelRole` 描述"模型是干什么的"，
 * `StoreKind` 描述"存到哪个目录"。多个 role 落到同一个 store 目录是合理的。
 *
 * ## 为什么不直接 `as StoreKind` 糊过去
 *
 * 那样 `vad` 会被写进一个**不存在的目录**，而且是运行时才炸。
 * 这里做显式映射，并且**新增 role 时会因为缺 case 而编译失败** —— 逼人做决定，而不是静默错。
 */
import type { StoreKind } from '@openmemo/downloader';
import type { ModelRole } from '@openmemo/shared';

/**
 * 落盘归类。
 *
 * 判断依据：这些辅助模型（VAD / 标点 / 说话人分离）都是**转写流水线**的组成部分，
 * 与 ASR 模型同属一条使用链，放同一个目录便于一起 GC 与一起迁移。
 * `embedding` / `tts` 目前 v1 不用（embedding 已裁决 v1 不做），先归到 llm 侧。
 */
export function roleToStoreKind(role: ModelRole): StoreKind {
  switch (role) {
    case 'asr':
    case 'vad':
    case 'punctuation':
    case 'diarization':
      return 'asr';
    case 'llm':
    case 'embedding':
    case 'tts':
      return 'llm';
    default: {
      // 穷尽性检查：shared 里新增 role 而这里没处理时，这一行会编译失败
      const never: never = role;
      throw new Error(`未处理的 ModelRole: ${String(never)}`);
    }
  }
}

/** 某些旧接口只认 `'asr' | 'llm'`（激活槽位）。同样显式收窄。 */
export function roleToActivationSlot(role: ModelRole): 'asr' | 'llm' {
  return roleToStoreKind(role) === 'llm' ? 'llm' : 'asr';
}
