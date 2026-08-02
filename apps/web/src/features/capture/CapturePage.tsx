import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Link2, Loader2, Upload } from 'lucide-react';

import { Button } from '../../components/common/Button';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { MockNotice } from '../../components/common/MockNotice';
import { useImportUrlMutation, useProbeMutation } from '../notes';
import { humanDuration } from '../../lib/format/time';
import type { ProbeResult } from '../../lib/api/types';

/**
 * F1 链接导入 + F2 本地文件（D-05 §4.1 / §4.2）。
 *
 * 核心节奏：**probe 先行**。
 * 拿到标题/时长/封面只要秒级，用户立刻知道"认对了没有"；而"需要登录/格式不支持"
 * 这类失败也在此刻暴露，而不是下了 400 MB 之后才说。
 */
export default function CapturePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [opts, setOpts] = useState({ diarize: true, keepVideo: false, structure: true });

  const probeMut = useProbeMutation();
  const importMut = useImportUrlMutation();

  const runProbe = useCallback(() => {
    const trimmed = url.trim();
    if (!trimmed) return;
    probeMut.mutate(trimmed, { onSuccess: setProbe });
  }, [url, probeMut]);

  const start = () => {
    importMut.mutate(
      { url: url.trim(), diarize: opts.diarize, keepVideo: opts.keepVideo, generateStructure: opts.structure },
      // 立刻跳到笔记详情：笔记已建，只是还没内容。用户在那里看进度，
      // 而不是停在捕获页盯着一个转圈（D-05 §4.1）
      { onSuccess: (r) => navigate(`/notes/${r.noteUid}`) },
    );
  };

  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        // F2：分块上传由 uploader 负责；此处仅接文件（当前为 MOCK，未接通）
      }}
    >
      <h1 className="text-xl font-semibold text-ink">{t('capture.title')}</h1>
      <MockNotice surface="import" />

      <div>
        <label htmlFor="capture-url" className="mb-2 block text-sm text-ink-secondary">
          {t('capture.urlLabel')}
        </label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Link2 className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" aria-hidden />
            <input
              id="capture-url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setProbe(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && runProbe()}
              placeholder={t('capture.urlPlaceholder')}
              className="h-10 w-full rounded-md border border-line bg-surface-1 pr-3 pl-9 text-sm text-ink placeholder:text-ink-muted"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <Button variant="primary" onClick={runProbe} disabled={!url.trim() || probeMut.isPending}>
            {probeMut.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {t('capture.probing')}
              </>
            ) : (
              t('capture.start')
            )}
          </Button>
        </div>
        <p className="mt-2 text-xs text-ink-muted">{t('capture.supported')}</p>
      </div>

      {probeMut.isError ? <ErrorBlock error={probeMut.error} onRetry={runProbe} /> : null}

      {/* ── probe 结果卡片：秒级出现，先于下载 ── */}
      {probe ? (
        <section className="rounded-lg border border-line bg-surface-1 p-4" data-testid="capture-probe">
          <div className="flex gap-4">
            <div
              className="flex size-20 shrink-0 items-center justify-center rounded-md bg-surface-0 text-xs text-ink-muted"
              aria-hidden
            >
              {probe.thumbnailUrl ? null : '封面'}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-base font-medium text-ink">{probe.title}</h2>
              <p className="mt-0.5 text-sm text-ink-secondary">
                {[probe.author, probe.durationMs ? humanDuration(probe.durationMs, i18n.language) : null, probe.site]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <p className="mt-1 text-xs text-ink-muted">
                {/* 适配器可见 = 可审计：关掉 yt-dlp 后产品仍能跑（ADR-002 的回滚路径） */}
                adapter: {probe.adapterId}
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-4 border-t border-line pt-4 text-sm">
            {(['diarize', 'keepVideo', 'structure'] as const).map((k) => (
              <label key={k} className="flex items-center gap-2 text-ink-secondary">
                <input
                  type="checkbox"
                  checked={opts[k]}
                  onChange={(e) => setOpts((o) => ({ ...o, [k]: e.target.checked }))}
                  className="size-4 accent-[var(--accent)]"
                />
                {t(`capture.options.${k}`)}
              </label>
            ))}
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setProbe(null)}>
              {t('capture.cancel')}
            </Button>
            <Button variant="primary" onClick={start} disabled={importMut.isPending}>
              {t('capture.confirm')}
            </Button>
          </div>
        </section>
      ) : null}

      {importMut.isError ? <ErrorBlock error={importMut.error} /> : null}

      {/* ── F2 拖拽区 ── */}
      <section
        className={[
          'rounded-lg border-2 border-dashed p-8 text-center transition-colors',
          dragging ? 'border-accent bg-accent-track/30' : 'border-line',
        ].join(' ')}
      >
        <Upload className="mx-auto mb-2 size-6 text-ink-muted" aria-hidden />
        <p className="text-sm text-ink-secondary">{dragging ? t('capture.dropHint') : t('capture.urlLabel')}</p>
        <Button size="sm" variant="secondary" className="mt-3" onClick={() => fileRef.current?.click()}>
          {t('nav.newCapture')}
        </Button>
        <input ref={fileRef} type="file" accept="audio/*,video/*" multiple hidden />
        {/* 不解释的话用户会困惑"我文件就在本机为什么还要传"（D-05 §4.2） */}
        <p className="mt-3 text-xs text-ink-muted">{t('capture.uploadExplain')}</p>
      </section>
    </div>
  );
}
