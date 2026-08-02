import { useEffect, useRef } from 'react';
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

  // 外部 seek 请求 → 作用到 <audio>
  useEffect(() => {
    if (!seekRequest || !audioRef.current) return;
    audioRef.current.currentTime = seekRequest.ms / 1000;
  }, [seekRequest]);

  // 位置推送：rAF + 节流到 ~10Hz。时间码文本直接改 DOM，不走 React。
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = () => {
      const el = audioRef.current;
      if (el) {
        const now = performance.now();
        if (now - last > 100) {
          last = now;
          const ms = el.currentTime * 1000;
          setPositionMs(ms);
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
          className="hidden"
        />
      ) : null}
    </div>
  );
}
