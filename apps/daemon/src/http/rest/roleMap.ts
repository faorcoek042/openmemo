/**
 * `ModelRole`（shared，7 个）→ 落盘桶 / 激活槽位 的两个显式收窄。
 *
 * ## 这个文件的开头曾经写着一句今天是假的话（订正于 T-149，2026-08-06）
 *
 * 原文：「`packages/downloader` 的 `StoreKind` 仍是 3 个（`asr | llm | backend`）」。
 * **实际是 8 个**（`asr llm vad punctuation diarization embedding tts backend`），
 * 从 `9683ae3`「ModelRole 独立桶 + 安装记录带 role」起就是。
 * `store.ts:37-42` 的注释明写那次修复有**两条**：
 *   ① 一个 role 一个桶，让装对的模型落在对的地方；
 *   ② `role` 写进安装记录，让放错地方的记录仍然自描述。
 * `[本机实测]` T-149 当时的真实状态是 **②落地了、①没有**：
 *
 * ```
 * daemon      roleToStoreKind('vad')  = asr     ← 写盘走这条（本文件，T-027 时代）
 * downloader  bucketForRole('vad')    = vad     ← 本该走这条
 * bucketForRole 的调用方数量           = 0
 * ```
 *
 * 于是 VAD / 标点权重一直落在 `by-name/asr/` 下，而 `selfcheck` 只好用
 * 一条按**文件名**打的正则（`/silero|vad|punct|…/i`）把它们剔出去 ——
 * 那条正则会把一个叫 `silero-asr-*` 的**真** ASR 模型判成"不是 ASR"。
 * **一个写好了却没人调用的修法，和没写是一样的。**
 *
 * 现在 `roleToStoreKind` 直接委托给 `bucketForRole`，**本文件不再持有自己的映射表**
 * —— 两处映射必然漂移，上面那段历史就是证据。
 *
 * ## 旧布局怎么办：不迁移，改成"读的时候不看目录"
 *
 * 已经装在 `manifests/asr/` 下的 VAD 记录**原地不动**，因为每一个读取方都已经
 * （或在 T-149 里被改成）扫全部桶、按记录里的 `role` 判断：
 *   - `findInstalledByRole()`（downloader）→ `modelStore.ts` 的流水线解析
 *   - `RestState.listInstalled()`      → `/api/models/installed`
 *   - `RestState.bucketOfInstalled()`  → 删除 / 校验时定位记录**实际**在哪个桶
 *   - `listInstalledNamesByRole()`（runtime）→ 自检
 * **搬文件才需要迁移；不看目录就不需要。**
 */
import { bucketForRole, type StoreKind } from '@openmemo/downloader';
import type { ModelRole } from '@openmemo/shared';

/**
 * 落盘桶。**一个 role 一个桶** —— 直接用 downloader 的那份实现，不再复制一张表。
 *
 * ⚠️ 桶不是 role 的同义词，只是"存到哪个目录"。**任何消费方都不许从目录名反推 role**，
 * role 一律读安装记录里的 `role` 字段（`store.ts` 那两条修正之②）。
 */
export function roleToStoreKind(role: ModelRole): StoreKind {
  return bucketForRole(role);
}

/**
 * 激活槽位。**刻意不再由 `roleToStoreKind` 推导。**
 *
 * 桶变成一个 role 一个之后，`bucketForRole('embedding') === 'embedding'`，
 * 老写法（`roleToStoreKind(role) === 'llm' ? 'llm' : 'asr'`）会把 embedding / tts
 * 从 llm 槽**悄悄挪到 asr 槽**：形状没变、编译不报错、行为反了。所以这里自己穷举。
 */
export function roleToActivationSlot(role: ModelRole): 'asr' | 'llm' {
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
