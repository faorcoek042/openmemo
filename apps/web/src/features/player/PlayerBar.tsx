import { useCallback, useEffect, useRef } from 'react';
import { Pause, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getPositionMs, setPositionMs, usePlayerStore } from '../../lib/stores/player.store';
import { mediaUrl } from '../../lib/api/client';
import { timecode } from '../../lib/format/time';
import { Waveform } from './Waveform';
import { Button } from '../../components/common/Button';
import type { DecodedPeaks } from '../../lib/format/peaks';

/**
 * F5 播放器（D-05 §4.4）。
 *
 * 用**原生 `<audio>`** 而不是让波形库自建媒体元素：
 * - Range 请求、cookie 鉴权、缓存策略全部仍由我们掌握（`/media/asset/<uid>`）；
 * - 原生元素本身就是无障碍回退（D-05 §6.3）。
 *
 * 播放位置以 ~10Hz 写进 transient 通道（`setPositionMs`），**不进 React state** ——
 * 否则每次 tick 都会重渲染 3000 行的转写稿（D-05 §2.4）。
 */
/**
 * `HTMLMediaElement.HAVE_METADATA`，**写成本地常量而不是读那个全局构造函数**。
 *
 * 组件测试跑在 jsdom 里，全局作用域上**没有** `HTMLMediaElement` 这个名字
 * （DOM 全局是逐个装上去的）。`HTMLMediaElement.HAVE_METADATA` 会抛 ReferenceError，
 * 而 `PlayerBar` 外面包着 `<PanelBoundary fallback={() => null}>` ——
 * 于是**整条播放器连同 `<audio>` 一起从 DOM 里消失，一个字都不报**。
 * 第一版就是这么写的，症状是"seek 的用例说找不到 audio 元素"，
 * 看起来像 seek 没接上，实际上是播放器整块被边界吞了。
 *
 * 判据与本仓其它几处同族：**别在渲染路径上依赖一个可能不存在的全局名字**。
 */
const HAVE_METADATA = 1;

export function PlayerBar({ peaks }: { peaks: DecodedPeaks | null }) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const assetUid = usePlayerStore((s) => s.assetUid);
  const durationMs = usePlayerStore((s) => s.durationMs);
  const playing = usePlayerStore((s) => s.playing);
  const setPlaying = usePlayerStore((s) => s.setPlaying);
  const seekRequest = usePlayerStore((s) => s.seekRequest);
  const requestSeek = usePlayerStore((s) => s.requestSeek);
  const labelRef = useRef<HTMLSpanElement>(null);

  /**
   * ★ 待落的 seek —— 「搜索结果直达时间点」在**媒体还没准备好**时的那一半。
   *
   * 原来这里是一句 `if (!seekRequest || !audioRef.current) return;`，依赖只有 `[seekRequest]`：
   * 元素不在就**直接丢弃**这次 seek，而 `seekRequest` 不会再变，于是没有第二次机会。
   *
   * ── 两个时机各补一次，但两者的把握程度**不一样，别混为一谈** ──────────────────
   *
   * ① `loadedmetadata`（`onLoadedMetadata`）—— **这一档是有实测支撑的必要项**。
   *    `readyState === HAVE_NOTHING` 时给 `currentTime` 赋值，规范说的是记成
   *    *default playback start position*、等加载开始后再应用；**各家实现是否都照做，
   *    本机没有浏览器、我没验证过**（见回执的诚实声明）。所以这里不赌：
   *    元数据到达前一律**保留** pending 并再落一次，落到位（`readyState >= HAVE_METADATA`）
   *    或元数据事件到达才清掉。多赋一次 `currentTime` 是幂等的，赌错了则是这条链静默断掉。
   *
   * ② 依赖里的 `assetUid`（元素刚挂载）—— **这一档是防御性的，我没能构造出它的红灯**。
   *    反向验证实测：把整段还原成上面那句旧写法，组件测试**照样全绿**。
   *    原因是 `NoteDetailPage` 里 `setSource` 与 `requestSeek` 两个 effect 在**同一次**
   *    passive effect flush 里跑，React 把两次 store 更新批成一次重渲染 ——
   *    `<audio>` 挂载与 `seekRequest` 变化落在同一个 commit，ref 早就接上了。
   *    留着它是因为它确实覆盖一个真实但更窄的场景：**笔记打开时还没有 `audio16k`**
   *    （录音刚停、归档 job 没跑完，见 `notes/noteAssets.ts` 文件头），
   *    音源要等一次重取才出现 —— 那时元素才第一次挂载。代价是一个依赖项，留着。
   */
  const pendingSeekRef = useRef<{ ms: number; nonce: number } | null>(null);

  const applyPendingSeek = useCallback((opts: { metadataReady: boolean }) => {
    const el = audioRef.current;
    const p = pendingSeekRef.current;
    if (!el || !p) return;
    el.currentTime = p.ms / 1000;
    if (opts.metadataReady || el.readyState >= HAVE_METADATA) {
      pendingSeekRef.current = null;
    }
  }, []);

  // 外部 seek 请求 → 作用到 <audio>（元素还没出现就先记着，见上）
  useEffect(() => {
    pendingSeekRef.current = seekRequest;
    applyPendingSeek({ metadataReady: false });
  }, [seekRequest, assetUid, applyPendingSeek]);

  // 位置推送：rAF + 节流到 ~10Hz。时间码文本直接改 DOM，不走 React。
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = () => {
      const el = audioRef.current;
      /*
       * ★ 有待落的 seek 时**不要**把媒体的当前位置播出去。
       *
       * `requestSeek()` 已经立刻把 `positionMs` 设成了目标值（转写稿的高亮与滚动
       * 靠的就是它，不依赖媒体），而此刻媒体多半还停在 0。这个循环每帧都跑，
       * 只要发一次就会把目标值盖回 0 —— 表现是「转写稿闪一下命中段，然后弹回第一段」，
       * 比完全不跳更像"产品坏了"。等 seek 真的落到媒体上（pending 清空）再恢复推送。
       */
      if (el && !pendingSeekRef.current) {
        /*
         * ★ **每帧**写入位置值（不再在这里节流）。
         *
         * 节流已经下沉到 `setPositionMs` 内部，且只作用于"通知订阅者"这一半。
         * 在这里节流会让**值本身**只有 100ms 分辨率，而逐字高亮是按帧拉取的 ——
         * 比 100ms 短的词（实测 `' for'` 只有 60ms）会被整个跳过，一次都不亮。
         */
        const ms = el.currentTime * 1000;
        setPositionMs(ms);

        // 时间码是给人读的文本，60Hz 刷新纯属浪费，这里仍按 ~10Hz 更新
        const now = performance.now();
        if (now - last > 100) {
          last = now;
          if (labelRef.current) labelRef.current.textContent = timecode(ms);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 键盘手势（视频编辑通用）：空格播放/暂停，←→ ±5s
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const el = audioRef.current;
      if (!el) return;
      if (e.code === 'Space') {
        e.preventDefault();
        void (el.paused ? el.play() : el.pause());
      } else if (e.code === 'ArrowLeft') {
        el.currentTime = Math.max(0, el.currentTime - 5);
      } else if (e.code === 'ArrowRight') {
        el.currentTime += 5;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    void (el.paused ? el.play() : el.pause());
  };

  return (
    <div className="flex items-center gap-3 border-t border-line bg-surface-1 px-4 py-2">
      <Button
        size="icon"
        variant="primary"
        onClick={toggle}
        aria-label={playing ? t('recorder.pause') : t('capture.start')}
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </Button>

      <span className="shrink-0 tabular-nums text-xs text-ink-secondary">
        <span ref={labelRef}>{timecode(getPositionMs())}</span>
        <span className="text-ink-muted"> / {timecode(durationMs)}</span>
      </span>

      <Waveform peaks={peaks} durationMs={durationMs} onSeek={requestSeek} className="h-10 flex-1" />

      {assetUid ? (
        <audio
          ref={audioRef}
          src={mediaUrl(assetUid)}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          // 元数据到了才是"这次 seek 一定落得住"的时刻 —— 见 applyPendingSeek 的注释
          onLoadedMetadata={() => applyPendingSeek({ metadataReady: true })}
          className="hidden"
        />
      ) : null}
    </div>
  );
}
