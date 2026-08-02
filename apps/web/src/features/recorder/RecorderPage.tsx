import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mic, MicOff, RefreshCw, Square } from 'lucide-react';

import { Button } from '../../components/common/Button';
import { Banner } from '../../components/common/Banner';
import { ProgressMeter } from '../../components/common/ProgressMeter';
import { useConnectionStore } from '../../lib/stores/connection.store';
import { estimateRerunMs, humanDuration, timecode } from '../../lib/format/time';
import { cn } from '../../lib/utils';

type Perm = 'unknown' | 'granted' | 'denied';
type Phase = 'idle' | 'recording' | 'rerunning' | 'done';

interface Caption {
  id: number;
  text: string;
  final: boolean;
}

/**
 * F3 录音转文字（D-05 §4.3）。
 *
 * ★ 本页最重要的不是波形好不好看，而是**把两阶段转写说清楚** ★
 *
 * 设计（D-01 §5 F3）：录音时用流式模型出稿（低延迟、准确率低），
 * 停止后自动用离线大模型重跑并覆盖。如果不说清楚，用户会以为
 * **软件在乱改自己的字** —— 这是产品成败点，不是文案润色。
 *
 * 四道保险：
 * 1. 录音时就**预告**（底部常驻提示），不等事后解释；
 * 2. partial 灰斜体 / final 正常字重，"还没定稿"用通用视觉语义表达，不用动画；
 * 3. 重跑时不遮挡内容，并明说"你现在看到的是初稿，可以先编辑，编辑不会被覆盖"；
 * 4. 完成后给「已更新 N 段 · 你编辑过的 M 段已保留 · [撤销]」。**撤销必须存在** ——
 *    否则"重跑让结果变差了"就无解。
 */
export default function RecorderPage() {
  const { t, i18n } = useTranslation();
  const [perm, setPerm] = useState<Perm>('unknown');
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [rerunProgress, setRerunProgress] = useState(0);
  const [replaced, setReplaced] = useState<{
    updated: number;
    preserved: number;
    /** 编辑过、但重跑结果里找不到对应位置的段数（合并按时间对齐，不保证一一对应） */
    noCounterpart: number;
  } | null>(null);
  const portDrift = useConnectionStore((s) => s.portDrift);
  const levelRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 实测速度比：应当来自已装后端的自检结果（backend_installs.selftest_json）。
  // daemon 未接通 → 用 gpu-runtime 实测的 CPU 值 2.7x，并标明这是 CPU-only 场景。
  // 拿不到实测值时 estimateRerunMs 返回 null，UI 就**不显示预期**（宁可不说也不编）。
  const isCpuOnly = true;
  const speedRatio = 2.7;
  const rerunEtaMs = estimateRerunMs(elapsed || 3_600_000, speedRatio);
  // 用 humanDuration 而不是 approxEta：后者自带"约/about"前缀，
  // 而文案模板里已经有"预计需要/about"，叠加会出现"about about 22 min"。
  const rerunEtaLabel = rerunEtaMs ? humanDuration(rerunEtaMs, i18n.language) : null;
  const rerunRemainLabel = rerunEtaMs
    ? humanDuration((1 - rerunProgress) * rerunEtaMs, i18n.language)
    : null;

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions) return;
    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((s) => setPerm(s.state === 'granted' ? 'granted' : s.state === 'denied' ? 'denied' : 'unknown'))
      .catch(() => setPerm('unknown'));
  }, []);

  const requestMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((tr) => tr.stop());
      setPerm('granted');
    } catch {
      setPerm('denied');
    }
  };

  const start = () => {
    setPhase('recording');
    setCaptions([]);
    setReplaced(null);
    setElapsed(0);
    timerRef.current = setInterval(() => setElapsed((e) => e + 1000), 1000);
    // MOCK：真实实现走 /ws/recorder 的二进制音频帧上行 + partial/final 下行
    let i = 0;
    const feed = setInterval(() => {
      i += 1;
      setCaptions((c) => {
        const next = c.map((x) => ({ ...x, final: true }));
        return [...next, { id: i, text: MOCK_LINES[i % MOCK_LINES.length], final: false }];
      });
      if (i > 6) clearInterval(feed);
    }, 1800);
  };

  const stop = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setCaptions((c) => c.map((x) => ({ ...x, final: true })));
    setPhase('rerunning');
    // 第二阶段：离线大模型重跑
    let p = 0;
    const iv = setInterval(() => {
      p += 0.08;
      setRerunProgress(Math.min(1, p));
      if (p >= 1) {
        clearInterval(iv);
        setPhase('done');
        setReplaced({ updated: 47, preserved: 3, noCounterpart: 1 });
      }
    }, 220);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8">
      <h1 className="text-xl font-semibold text-ink">{t('recorder.title')}</h1>

      {/* 端口漂移会让浏览器把它当新站点 → 麦克风授权作废。必须显式提醒（ADR-006 决策 2） */}
      {portDrift ? (
        <Banner
          tone="warning"
          title={t('banner.portDrift', { expected: portDrift.expected, actual: portDrift.actual })}
        />
      ) : null}

      {/* ── 权限三态 ── */}
      {perm === 'denied' ? (
        <section className="rounded-lg border border-line bg-surface-1 p-4">
          <div className="flex items-start gap-2.5">
            <MicOff className="mt-0.5 size-4 text-critical" aria-hidden />
            <div>
              <div className="text-sm font-medium text-ink">{t('recorder.permDenied')}</div>
              {/* 被拒绝是最容易卡死用户的状态 → 必须给出恢复路径 */}
              <p className="mt-1 text-sm text-ink-secondary">{t('recorder.permDeniedHelp')}</p>
              <Button size="sm" variant="secondary" className="mt-3" onClick={requestMic}>
                <RefreshCw className="size-3.5" />
                {t('recorder.recheck')}
              </Button>
            </div>
          </div>
        </section>
      ) : perm !== 'granted' ? (
        <section className="rounded-lg border border-line bg-surface-1 p-6 text-center">
          <Mic className="mx-auto mb-2 size-6 text-ink-muted" aria-hidden />
          <p className="text-sm text-ink-secondary">{t('recorder.permNeeded')}</p>
          <Button variant="primary" className="mt-3" onClick={requestMic}>
            {t('recorder.permAllow')}
          </Button>
        </section>
      ) : (
        <section className="rounded-lg border border-line bg-surface-1 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              {phase === 'recording' ? (
                <span className="inline-flex items-center gap-1.5 font-medium text-critical">
                  <span className="size-2 rounded-full bg-critical" aria-hidden />
                  {t('recorder.recording')}
                </span>
              ) : (
                <span className="text-ink-secondary">{t('recorder.device')}</span>
              )}
              <span className="tabular-nums text-ink-muted">{timecode(elapsed)}</span>
            </div>
            {phase === 'recording' ? (
              <Button variant="danger" size="sm" onClick={stop}>
                <Square className="size-3.5" />
                {t('recorder.stop')}
              </Button>
            ) : phase === 'idle' ? (
              <Button variant="primary" size="sm" onClick={start}>
                <Mic className="size-3.5" />
                {t('recorder.start')}
              </Button>
            ) : null}
          </div>

          <div ref={levelRef} className="mt-3 h-10 rounded bg-surface-0" aria-hidden>
            {/* 实时波形：真实实现走 AudioWorklet → canvas 直写（不进 React） */}
          </div>
        </section>
      )}

      {/* ── 字幕：partial 与 final 视觉分离 ── */}
      {captions.length > 0 ? (
        <section className="rounded-lg border border-line bg-surface-1 p-4">
          <ul className="flex flex-col gap-1.5" role="list">
            {captions.map((c) => (
              <li
                key={c.id}
                className={cn(
                  'text-transcript',
                  // final：正常字重；partial：灰色斜体 = "还没定稿"的通用语义。
                  // 刻意不用动画/闪烁（干扰阅读，且违反 prefers-reduced-motion 精神）
                  c.final ? 'text-ink' : 'text-ink-muted italic',
                )}
              >
                {c.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ★ 保险 1：录音时就预告，不等事后解释。
          ⚠️ 必须**带时间预期**：gpu-runtime 实测中文用的 large-v3-turbo 在纯 CPU 上
          只有 2.7x 实时 —— 1 小时录音要跑 22 分钟。不给预期，用户会以为卡死然后关窗口。 */}
      {phase === 'recording' || phase === 'idle' ? (
        <div className="text-xs text-ink-muted">
          <p>
            ⓘ{' '}
            {rerunEtaLabel
              ? t('recorder.twoPhaseNoticeWithEta', { eta: rerunEtaLabel })
              : t('recorder.twoPhaseNotice')}
          </p>
          {isCpuOnly ? (
            <p className="mt-1 flex flex-wrap items-center gap-2">
              <span>{t('recorder.twoPhaseNoticeSlowHint')}</span>
              <Button size="sm" variant="ghost" className="h-5 px-1.5 text-xs">
                {t('recorder.installBackend')}
              </Button>
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ★ 保险 3：重跑时不遮挡内容 */}
      {phase === 'rerunning' ? (
        <section className="rounded-lg border border-line bg-surface-1 p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-ink">
              {rerunRemainLabel
                ? t('recorder.rerunningWithEta', { model: 'large-v3-turbo', eta: rerunRemainLabel })
                : t('recorder.rerunning', { model: 'large-v3-turbo' })}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setPhase('done')}>
              {t('recorder.skipRerun')}
            </Button>
          </div>
          <ProgressMeter value={rerunProgress} label={t('recorder.rerunning', { model: '' })} size="md" />
          <p className="mt-2 text-xs text-ink-secondary">{t('recorder.rerunHint')}</p>
        </section>
      ) : null}

      {/* ★ 保险 4：说清楚改了什么、保住了什么，并且**可以撤销** */}
      {replaced ? (
        <Banner
          tone="info"
          title={t('recorder.replaced', { updated: replaced.updated, preserved: replaced.preserved })}
          detail={
            <>
              {/* 合并按**时间轴**对齐而不是按段落序号 —— 两遍模型的断句天然不同，
                  按序号会把别人的句子塞进用户改过的地方（gpu-runtime 实测结论）。
                  因此"编辑过但没有对应新结果"是正常情况，必须能表达出来，
                  而不是让用户以为自己的修改被吞了。 */}
              {replaced.noCounterpart > 0 ? (
                <span>{t('recorder.replacedNoCounterpart', { count: replaced.noCounterpart })}</span>
              ) : null}
              <span className="mt-0.5 block text-ink-muted">{t('recorder.mergeByTimeNote')}</span>
            </>
          }
          action={
            <div className="flex gap-2">
              <Button size="sm" variant="ghost">
                {t('recorder.viewDiff')}
              </Button>
              <Button size="sm" variant="secondary">
                {t('recorder.undoReplace')}
              </Button>
            </div>
          }
        />
      ) : null}
    </div>
  );
}

const MOCK_LINES = [
  '好，我们今天先过一下上周的进度。',
  '第一个是转写流水线，已经能跑通链接导入了。',
  '第二个是模型管理页，还在等后端接口。',
  '那我这边补充一下，运行时检测的部分',
  '已经能在 Linux 上实测出可用后端了。',
  '好，那我们下周同步一次打包的进度。',
  '另外提醒一下，录音这块要注意两阶段的提示。',
];
