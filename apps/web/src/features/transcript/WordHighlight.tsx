import { useEffect, useRef, useState } from 'react';

import { getPositionMs } from '../../lib/stores/player.store';
import type { TranscriptSegmentDto } from '../../lib/events/types';

type Word = NonNullable<TranscriptSegmentDto['words']>[number];

/**
 * 找出当前播放位置落在哪个词上。
 *
 * 线性扫描：一段通常十几到几十个词，二分查找的收益还不如它的出错面。
 * 落在词与词之间的静音里时返回 `-1`（不是"就近吸附到上一个词"）——
 * 停顿时不该有词亮着，硬吸附会让高亮在换气处诡异地滞留。
 */
export function findActiveWord(words: readonly Word[], posMs: number): number {
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    if (posMs >= w.s && posMs < w.e) return i;
  }
  return -1;
}

/**
 * 卡拉 OK 式逐字高亮（F5）。
 *
 * ## 这个组件此前**根本不存在**
 *
 * `TranscriptList` 算出过一个 `highlightGranularity`，但它只落到一个
 * `data-highlight` 属性上 —— **没有任何地方按词渲染**。
 * 也就是说逐字高亮从来只有"降级徽标"，没有"不降级"的那一半：
 * 徽标恒亮（因为 `words` 压根没从后端发出来），而即使发了也没人画。
 * 两个 bug 恰好互相掩护，谁也没暴露谁。
 *
 * 现在 `words` 真的有了（whisper 路径实测是数组），补上真正的渲染。
 *
 * ## 为什么用 rAF 而不是 React state 驱动
 *
 * 播放位置每秒变化 60 次。走 state 会让**整个虚拟列表**跟着重渲染，
 * 而真正变的只有一个 `<span>` 的 class。所以只有**当前活跃段**挂这个循环，
 * 且只在它真的有 `words` 时挂 —— 其余段一行 JS 都不跑。
 */
export function WordHighlight({
  words,
  fallbackText,
  className,
}: {
  words: readonly Word[] | null;
  fallbackText: string;
  className?: string;
}) {
  const [idx, setIdx] = useState(-1);
  const raf = useRef(0);

  useEffect(() => {
    if (!words || words.length === 0) return;
    let last = -2;
    const tick = () => {
      const next = findActiveWord(words, getPositionMs());
      // 只有跨词时才 setState —— 同一个词内的 60 次 tick 不该产生 60 次渲染
      if (next !== last) {
        last = next;
        setIdx(next);
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [words]);

  // 没有词级时间戳（中文 Paraformer 路径）→ 整句渲染，由 WordLevelBadge 说明原因
  if (!words || words.length === 0) return <span className={className}>{fallbackText}</span>;

  return (
    <span className={className} data-testid="word-highlight">
      {words.map((w, i) => (
        <span
          key={`${w.s}-${i}`}
          data-active={i === idx ? 'true' : undefined}
          className={i === idx ? 'rounded-sm bg-accent-track text-ink' : undefined}
        >
          {w.w}
        </span>
      ))}
    </span>
  );
}
