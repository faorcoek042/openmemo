/**
 * 「这条模型适配的引擎，在本机是什么状态」—— **纯决策**，不碰 DOM、不碰 i18n 文案。
 *
 * ## 它修的是什么（T-191 ④，用户 2026-08-09 在 `:10000` 上问出来的）
 *
 * 卡片上原来那句是 **「适配 sherpa-onnx · 当前用不上」**。
 * 而同一时刻 daemon 自己在 `GET /api/health` 里说的是：
 *
 * ```json
 * { "id": "sherpa-onnx", "available": false,
 *   "reason": "未安装流式中文模型 —— 去「模型」页装 “sherpa 流式中文 zh-14M” 即可启用录音转文字" }
 * ```
 *
 * `[实测 2026-08-09]` 目录里带 `engines:['sherpa-onnx']` 的**只有 4 条**，
 * 其中两条正是 `asr/sherpa-streaming-zh-14m` 与 `asr/paraformer-zh-small` ——
 * **daemon 让他装的那两个模型，卡片上写着「当前用不上」。**
 * 一个页面上，一句说"装这个就能用"，一句说"用不上"。
 *
 * 而那句 tooltip 更糟：「**换引擎后它就能用**」。这里根本不需要换引擎 ——
 * 装上它本身就是启用那个引擎的办法。**它在把用户往反方向推。**
 *
 * ## 判据（Manager 2026-08-09）
 *
 * 这行字要能让人分清三件事：
 *   (a) 是"有更好的替代所以用不上"，还是 (b) "出了问题所以用不上"；(c) 该做什么。
 *
 * 「当前用不上」三件都答不了。所以这里**不自己造话**：daemon 已经把 (b)+(c)
 * 算好放在 `reason` 里了（`AsrEngineStatus.tsx` 立的规矩：
 * 「reason 是 daemon 实测给的，不是我编的文案」），此前这里把它丢了。
 *
 * ## 为什么抽成纯函数
 *
 * 与 `packStatus.ts` / `search/modes.ts` / `asrSections.ts` 同一条：
 * 判据能被单测直接钉住，而不必先渲染一棵 React 树、再去猜文案匹配没匹配上。
 * `components.test.tsx` 有过血的教训 —— 按记忆写「运行自检」，而按钮上只有「自检」，
 * 三条否定断言**全部空转通过**。
 */

import type { EngineUnavailableReason } from '@openmemo/shared';

/**
 * `useAsrEngines()` 给出的每个引擎的状态（只取本模块用得到的三个字段）。
 *
 * ⚠️ #112：`reason` 从 `string` 换成了 {@link EngineUnavailableReason}。
 * 本模块**照旧不碰文案** —— 它只决定"哪几条原因该被念出来"，
 * 把哪一档翻成哪句话是 `components/common/engineReasonText.ts` 的事。
 */
export interface LocalEngine {
  readonly id: string;
  readonly available: boolean;
  readonly reason?: EngineUnavailableReason | undefined;
}

export type EngineFitKind =
  /** 本机当前可用的引擎里有它 —— 装了就能用 */
  | 'fits'
  /**
   * 本机当前没有启用它需要的引擎。
   *
   * ⚠️ 措辞刻意**不叫 `unusable`**：那读起来像"这东西对你没用"（判据里的 (a)），
   * 而真实含义是"那个引擎还没启用"——而下一句 `reason` 正好告诉他怎么启用。
   */
  | 'not-enabled'
  /** 还不知道本机有哪些引擎（health 没回来）⇒ **不下判断** */
  | 'unknown';

export interface EngineFit {
  readonly kind: EngineFitKind;
  /**
   * daemon 给的原因，去重后按 `engines` 的声明顺序排列。
   *
   * 只取**这条模型声明的那些引擎**的原因 —— 一条会对不相干的东西发表意见的提示，
   * 说对的时候也不该被相信。
   */
  readonly reasons: readonly EngineUnavailableReason[];
}

export interface EngineFitInput {
  /** 这条模型声明适配的引擎（`CatalogVariant.engines`）。 */
  readonly engines: readonly string[];
  /** 本机引擎状态（`useAsrEngines().engines`）。 */
  readonly local: readonly LocalEngine[];
  /** health 是否已经回来（`useAsrEngines().ready`）。 */
  readonly ready: boolean;
}

export function engineFit(input: EngineFitInput): EngineFit {
  const { engines, local, ready } = input;

  /*
   * `ready === false` ⇒ 还不知道本机有哪些引擎。
   * **不下"用不上"的判断** —— 那是把"我还不知道"渲染成"我知道它不行"，
   * 与 `inapplicableKind` 缺失时不许替 daemon 说话是同一条。
   */
  if (!ready) return { kind: 'unknown', reasons: [] };

  const usable = new Set(local.filter((e) => e.available).map((e) => e.id));
  if (engines.some((e) => usable.has(e))) return { kind: 'fits', reasons: [] };

  const byId = new Map(local.map((e) => [e.id, e]));
  const reasons: EngineUnavailableReason[] = [];
  const seen = new Set<string>();
  for (const id of engines) {
    const r = byId.get(id)?.reason;
    /*
     * 只收"这个引擎不可用"的原因。**没给就是没给** —— 不许在这里凑一句。
     *
     * 去重按序列化后的整条原因，不是按 `kind`：sherpa 与 Paraformer 可能同时落在
     * `installed_but_files_incomplete`，但 `installedIds` 是**不同的两串 id**，
     * 按 `kind` 去重会把其中一条静默吃掉。上一版按整句字符串去重，
     * 效果与这里一致（同一句话 = 同一条原因）。
     */
    if (r === undefined) continue;
    const key = JSON.stringify(r);
    if (seen.has(key)) continue;
    seen.add(key);
    reasons.push(r);
  }
  return { kind: 'not-enabled', reasons };
}
