import { useEffect, useRef } from 'react';
import { subscribePosition } from '../../lib/stores/player.store';
import type { DecodedPeaks } from '../../lib/format/peaks';

/**
 * 波形（D-05 §7.3 + §4.4）。
 *
 * **canvas 直写，完全不进 React。** 播放位置以 ~10Hz 变化，走 React 会拖垮整页。
 *
 * 峰值来自 daemon 预计算的 `.ompk`（D-02 §3.4）——
 * 浏览器 `decodeAudioData` 一个 2 小时的文件会占数百 MB 内存并阻塞主线程。
 *
 * 配色用语义令牌：已播 = accent，未播 = ink-muted，游标 2px accent。
 * 这里读的是 CSS 变量，所以明暗主题切换会自动跟随，无需 JS 参与。
 */
export function Waveform({
  peaks,
  durationMs,
  onSeek,
  className,
}: {
  peaks: DecodedPeaks | null;
  durationMs: number;
  onSeek: (ms: number) => void;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const posRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const styles = getComputedStyle(document.documentElement);
      const accent = styles.getPropertyValue('--accent').trim() || '#2a78d6';
      const muted = styles.getPropertyValue('--ink-muted').trim() || '#898781';

      const data = peaks?.channels[0];
      const progress = durationMs > 0 ? Math.min(1, posRef.current / durationMs) : 0;
      const playedX = w * progress;

      if (data && data.length > 0) {
        const mid = h / 2;
        const step = data.length / w;
        for (let x = 0; x < w; x += 1) {
          const v = Math.abs(data[Math.floor(x * step)] ?? 0);
          const barH = Math.max(1, v * (h - 4));
          ctx.fillStyle = x <= playedX ? accent : muted;
          ctx.globalAlpha = x <= playedX ? 1 : 0.4;
          ctx.fillRect(x, mid - barH / 2, 1, barH);
        }
        ctx.globalAlpha = 1;
      } else {
        // 无峰值数据时画一条基线，而不是留空白装作正常
        ctx.strokeStyle = muted;
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // 游标 2px
      ctx.fillStyle = accent;
      ctx.fillRect(Math.max(0, playedX - 1), 0, 2, h);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    const unsub = subscribePosition((ms) => {
      posRef.current = ms;
    });

    return () => {
      cancelAnimationFrame(raf);
      unsub();
    };
  }, [peaks, durationMs]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role="slider"
      aria-label="waveform"
      aria-valuemin={0}
      aria-valuemax={durationMs}
      tabIndex={0}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        onSeek(Math.max(0, Math.min(durationMs, ratio * durationMs)));
      }}
    />
  );
}
