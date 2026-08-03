import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Link2, Loader2, Upload } from 'lucide-react';

import { Button } from '../../components/common/Button';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { MockNotice } from '../../components/common/MockNotice';
import { useImportUrlMutation, useProbeMutation } from '../notes';
import { humanDuration } from '../../lib/format/time';
import { formatBytes, formatPercent } from '../../lib/format/bytes';
import { looksLikeMedia, uploadMediaFile, type UploadProgress } from './upload';
import { ProgressMeter } from '../../components/common/ProgressMeter';
import { TranscribeOptions } from '../../components/common/TranscribeOptions';
import { ASR_LANGUAGE_AUTO } from '../../lib/asr';
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

  /**
   * 转写语言。默认 `auto` —— 与 daemon 的降级值一致，不制造"前端默认"与"后端默认"两个真相。
   *
   * 这是 memo.ac 有而我们完全没有的一项。它不是锦上添花：
   * whisper.cpp 缺 `-l` 会把中文**翻译成英文**返回，`gpu-runtime` 为此修过一次事故。
   * 现在后端兜底成 `auto` 了，但"用户想明确指定 zh"依然无处可说 —— 补上的就是这个口子。
   */
  const [language, setLanguage] = useState<string>(ASR_LANGUAGE_AUTO);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);

  /**
   * M-2：把死掉的拖拽区接上。
   *
   * 之前 `onDrop` 是个空函数 —— 拖文件进去什么都不会发生，
   * 而 F2「本地媒体导入」是章程功能之一，它的主入口就是这个拖拽区。
   */
  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList) return;
      const files = Array.from(fileList).filter(looksLikeMedia);
      if (files.length === 0) return;

      setUploads((prev) => [
        ...prev,
        ...files.map((f) => ({ file: f, progress: 0, phase: 'uploading' as const })),
      ]);

      for (const file of files) {
        void uploadMediaFile(
          file,
          (p) => setUploads((prev) => prev.map((u) => (u.file === file ? p : u))),
          undefined,
          // 本地文件与链接导入走同一个语言设置 —— 两条路径给出不同结果会很难解释
          language,
        )
          .then((r) => navigate(`/notes/${r.noteUid}`))
          .catch((err) =>
            setUploads((prev) =>
              prev.map((u) => (u.file === file ? { ...u, phase: 'failed', error: err } : u)),
            ),
          );
      }
    },
    // language 必须进依赖数组：漏了它，改语言后拖进来的文件仍会用旧值上传，
    // 而这种"闭包捕获了过期状态"的 bug 在 UI 上完全看不出来
    [navigate, language],
  );

  const probeMut = useProbeMutation();
  const importMut = useImportUrlMutation();

  const runProbe = useCallback(() => {
    const trimmed = url.trim();
    if (!trimmed) return;
    probeMut.mutate(trimmed, { onSuccess: setProbe });
  }, [url, probeMut]);

  const start = () => {
    importMut.mutate(
      { url: url.trim(), language },
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
        handleFiles(e.dataTransfer.files);
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
              // 显式 aria-label + testid：此前只靠 <label> 关联，而拖拽区用了**同一句**文案，
              // 按文本定位会命中拖拽区的 <p> 而不是这个输入框 —— 真浏览器实测就卡在这里。
              aria-label={t('capture.urlLabel')}
              data-testid="capture-url-input"
              name="url"
              inputMode="url"
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

      {/*
        转写选项：**页面级**，链接导入与拖拽上传共用同一份设置。
        两条路径给出不同的语言结果是没法向用户解释的。
      */}
      <section
        className="rounded-lg border border-line bg-surface-1 p-4"
        data-testid="capture-options"
        aria-label={t('capture.optionsTitle')}
      >
        <h2 className="mb-3 text-sm font-medium text-ink">{t('capture.optionsTitle')}</h2>
        <TranscribeOptions language={language} onLanguageChange={setLanguage} />
      </section>

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

          {/*
            这里原来是 diarize / keepVideo / structure 三个勾选框。
            它们从未进入过请求体（mutation 只发 `{input}`），后端也无对应入参 —— 纯装饰，已删。
            真正生效的转写选项上移到了页面级（见下方 `capture-options`），
            因为它对**链接导入和拖拽上传两条路径都生效**，放在 probe 卡片里会让人以为只管链接。
          */}

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
          dragging ? 'border-accent bg-accent-tint/30' : 'border-line',
        ].join(' ')}
      >
        <Upload className="mx-auto mb-2 size-6 text-ink-muted" aria-hidden />
        <p className="text-sm text-ink-secondary">
          {dragging ? t('capture.dropHint') : t('capture.dropZoneIdle')}
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="mt-3"
          data-testid="capture-pick-file"
          onClick={() => fileRef.current?.click()}
        >
          {t('capture.pickFile')}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,video/*"
          multiple
          hidden
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = ''; // 允许重复选同一个文件
          }}
        />
        {/* 不解释的话用户会困惑"我文件就在本机为什么还要传"（D-05 §4.2） */}
        <p className="mt-3 text-xs text-ink-muted">{t('capture.uploadExplain')}</p>
      </section>

      {uploads.length > 0 ? (
        <ul className="flex flex-col gap-2" role="list">
          {uploads.map((u, i) => (
            <li key={`${u.file.name}-${i}`} className="rounded-lg border border-line bg-surface-1 p-3">
              <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-ink">{u.file.name}</span>
                <span className="shrink-0 text-xs text-ink-muted">
                  {formatBytes(u.file.size, i18n.language)}
                </span>
              </div>
              {u.phase === 'failed' ? (
                <ErrorBlock error={u.error} />
              ) : (
                <>
                  <ProgressMeter
                    value={u.progress}
                    label={t('capture.uploading', { percent: formatPercent(u.progress, i18n.language) })}
                  />
                  <p className="mt-1 text-xs text-ink-muted">
                    {t(`capture.uploadPhase.${u.phase}`, { defaultValue: u.phase })}
                  </p>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
