import { SPEED_CLASSES, type CatalogGroupWithFitness, type SpeedClass } from '@openmemo/shared';

import { arr } from '../../lib/safe';

/**
 * 转写 Tab 的分组规则（D-10 #9 / #10 / #29）。
 *
 * ## 为什么是一个纯函数
 *
 * 分组规则是**判断**，渲染是**排版**。混在一起就只能靠"渲染出几张卡"来验，
 * 而那种断言在一张卡都没渲染出来时同样是绿的。抽出来之后，
 * "哪一组该装哪几个"可以被逐条钉死，且与 jsdom 无关。
 *
 * ## 三组的依据是"用户想干的事"，不是引擎、不是体积
 *
 * | 组 | 回答的问题 | 数据判据（**不写死 id**） |
 * |---|---|---|
 * | 推荐 | "我就想转个中文/多语种，装哪个？" | `tags` 含 `recommended-default` / `recommended-default-zh` |
 * | 实时字幕组件 | "为什么我录音时不出字？" | `tags` 含 `required-for-f3`，或 `role ∈ {vad, punctuation}` |
 * | 更多档位 | "我要更快 / 更准 / 复现旧结果" | 其余的，按 `speedClass` 分快 / 均衡 / 高质量 |
 *
 * **实时字幕组件那一组是三个零件，不是三个替代品** —— sherpa 流式没有 VAD 不工作、
 * Paraformer 没有标点会吐一整段无标点文字。它们在目录里一直都有
 * （`role=vad` 2 个变体、`role=punctuation` 1 个），但 `ROLE_TABS` 只有 asr/llm，
 * **今天用户没有任何途径装上它们**（D-10 #10：这不是分类问题，是功能缺件）。
 *
 * ## ★ 两个"速度"必须分开说（D-10 R-M1）
 *
 * 这里用的是 `ModelEntry.speedClass` —— **目录常量**，按模型体积人工分档，
 * **与你的机器无关**。它在 UI 上叫「档位」，只做分组。
 * 另一个 `FitResult.speedTier`（daemon 按本机硬件算的）叫「在你的机器上」，
 * 渲染在卡内一行说明文字里（`FitEta`）。**两个都写"速度"，用户就没法知道
 * 哪个是承诺、哪个是估计** —— 那正是 `installPath` 事故的形状。
 *
 * ## `superseded` 是折叠钩子，不是隐藏（D-10 §4.1.2）
 *
 * `multi × quality` 实测有 4 组（large-v1/v2/v3/v3-turbo），其中 v1/v2 带 `superseded`。
 * 平铺 4 张里有 2 张是不该选的 → 收进一行「已被新版本取代的 N 个」。
 * **不删掉**：复现旧结果、跑对照实验是真实需求，而且我们已经把它们放进过目录 ——
 * 悄悄消失比折叠更让人困惑。折叠 = 我们表态"别选这个"；删除 = 我们替用户做决定。
 */

export interface SpeedBucket {
  speedClass: SpeedClass;
  /** 平铺的那些。 */
  groups: CatalogGroupWithFitness[];
  /** 带 `superseded` 的，收进折叠行。 */
  superseded: CatalogGroupWithFitness[];
}

export interface AsrSections {
  recommended: CatalogGroupWithFitness[];
  realtime: CatalogGroupWithFitness[];
  /** 按 `speedClass` 分档，顺序固定为 快 → 均衡 → 高质量。空档不返回。 */
  more: SpeedBucket[];
}

/** 语言模型的目录条目 ADR-016 已砍，这一页一条都不该出现。 */
const ROLES_ON_ASR_TAB = new Set(['asr', 'vad', 'punctuation']);

const RECOMMENDED_TAGS = ['recommended-default', 'recommended-default-zh'];

/**
 * 组标签 ∪ 变体标签 —— 目录两层都可能挂标签，只看一层会漏。
 *
 * ⚠️ 全程走 `arr()`：服务端少发一个数组字段就 `undefined.flatMap` 崩掉，
 * 而这一页的 `PanelBoundary` 之外还有半屏 —— 一个可选字段能整页塌掉，
 * 是本仓「服务端坏数据的防御」那族用例存在的理由。
 */
function tagsOf(g: CatalogGroupWithFitness): Set<string> {
  return new Set([...arr(g.tags), ...arr(g.variants).flatMap((v) => arr(v.tags))]);
}

/**
 * 该组的档位。
 *
 * 取第一个变体的 `speedClass`：目录里同一组的所有变体共用一个档位
 * （它是按模型体积人工分的，与量化无关）。真出现不一致时**取多数**而不是静默取第一个 ——
 * 静默取第一个会让"目录写歪了"变成"界面上少一组"。
 */
export function speedClassOf(g: CatalogGroupWithFitness): SpeedClass {
  const counts = new Map<SpeedClass, number>();
  for (const v of arr(g.variants)) {
    if (!SPEED_CLASSES.includes(v.speedClass)) continue;
    counts.set(v.speedClass, (counts.get(v.speedClass) ?? 0) + 1);
  }
  let best: SpeedClass | null = null;
  let bestN = 0;
  for (const c of SPEED_CLASSES) {
    const n = counts.get(c) ?? 0;
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }
  /*
   * 一个能识别的档位都没有（老目录 / 服务端少发字段）→ 落到 `balance`。
   * 选中间那一档是因为它**主张最少**：把一个不知道快慢的模型放进"快"或"高质量"，
   * 都是在替目录说一句它没说过的话。
   */
  return best ?? 'balance';
}

/** 整组都被新版本取代了才折叠。**只有一部分变体带 tag 时不折叠** —— 那多半是目录写漏了。 */
export function isSuperseded(g: CatalogGroupWithFitness): boolean {
  const vs = arr(g.variants);
  return vs.length > 0 && vs.every((v) => arr(v.tags).includes('superseded'));
}

export function splitAsrSections(groups: readonly CatalogGroupWithFitness[]): AsrSections {
  const recommended: CatalogGroupWithFitness[] = [];
  const realtime: CatalogGroupWithFitness[] = [];
  const rest: CatalogGroupWithFitness[] = [];

  for (const g of groups) {
    if (!ROLES_ON_ASR_TAB.has(g.role)) continue;
    const tags = tagsOf(g);
    // ★ 一个组只进一个section。顺序即优先级 —— 否则 Paraformer 会同时出现在推荐与更多档位里。
    if (RECOMMENDED_TAGS.some((t) => tags.has(t))) recommended.push(g);
    else if (tags.has('required-for-f3') || g.role === 'vad' || g.role === 'punctuation')
      realtime.push(g);
    else rest.push(g);
  }

  const more: SpeedBucket[] = [];
  for (const c of SPEED_CLASSES) {
    const inClass = rest.filter((g) => speedClassOf(g) === c);
    if (inClass.length === 0) continue;
    more.push({
      speedClass: c,
      groups: inClass.filter((g) => !isSuperseded(g)),
      superseded: inClass.filter((g) => isSuperseded(g)),
    });
  }

  return { recommended, realtime, more };
}
