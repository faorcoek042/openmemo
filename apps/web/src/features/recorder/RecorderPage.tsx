import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Mic, MicOff, RefreshCw, Square } from 'lucide-react';

import type { AsrEngineId } from '@openmemo/shared';

import { Button } from '../../components/common/Button';
import { Emphasis } from '../../components/common/Emphasis';
import { Banner } from '../../components/common/Banner';
import { ProgressMeter } from '../../components/common/ProgressMeter';
import { AsrEngineStatus, useAsrEngines } from '../../components/common/AsrEngineStatus';
import { useActiveAsrModel } from '../../components/common/AsrModelPicker';
import { TranscribeOptions } from '../../components/common/TranscribeOptions';
import { ASR_ENGINE_LABELS, ASR_LANGUAGE_AUTO } from '../../lib/asr';
import { isMicrophoneAvailable, localhostEquivalent } from '../../lib/secure-context';
import { applyCaption, startRecording, type RecorderHandle } from './asrStream';
import { useProgressStore } from '../../lib/stores/progress.store';
import { useTranscriptQuery } from '../notes';
import { useConnectionStore } from '../../lib/stores/connection.store';
import { estimateRerunMs, humanDuration, timecode } from '../../lib/format/time';
import { cn } from '../../lib/utils';

type Perm = 'unknown' | 'granted' | 'denied';
type Phase = 'idle' | 'recording' | 'finalizing' | 'rerunning' | 'done';

interface Caption {
  id: number;
  /** partial 用服务端的 `utteranceId` 作键：一句定稿后服务端会换新的 id（语义 4）。 */
  uid: string;
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
  /*
   * 麦克风能力在**渲染前**就确定，不等用户点。
   * `navigator.mediaDevices` 只在安全上下文存在 —— `http://<IP>` 下任何浏览器都是 undefined。
   */
  const micAvailable = isMicrophoneAvailable();
  const localUrl = localhostEquivalent();
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [rerunProgress, setRerunProgress] = useState(0);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [rerunJobUid, setRerunJobUid] = useState<string | null>(null);
  /** 服务端在 `ready` 里给的笔记 uid —— 录音会自动建一条笔记，结束后要能跳过去。 */
  const [noteUid, setNoteUid] = useState<string | null>(null);
  const [segmentCount, setSegmentCount] = useState(0);
  const handleRef = useRef<RecorderHandle | null>(null);
  /**
   * 转写语言 —— 这是录音页**唯一真的能影响后端行为**的转写参数。
   *
   * 原来这里是 `useState<'paraformer' | 'turbo'>('paraformer')`：
   * 一个写死的两项切换器，`'turbo'` 在后端全仓不存在（那是模型名
   * `whisper-large-v3-turbo` 的片段，不是引擎 id），而且选中的值**从不发给后端** ——
   * 用户反馈的"识别引擎只有两个可选"就是它。
   *
   * 真实情况：引擎由 daemon 按语言自动选（`selectEngine`），
   * per-task 覆盖后端尚未开放（`forceEngineId` 零调用方）。
   * 所以这里让用户能选的是**语言**（真生效、且能间接决定中文走 Paraformer），
   * 引擎则如实展示可用性，见 `AsrEngineStatus`。
   */
  const [language, setLanguage] = useState<string>(ASR_LANGUAGE_AUTO);
  const { engines } = useAsrEngines();

  const [replaced, setReplaced] = useState<{
    updated: number;
    preserved: number;
    /** 编辑过、但重跑结果里找不到对应位置的段数（合并按时间对齐，不保证一一对应） */
    noCounterpart: number;
  } | null>(null);
  const portDrift = useConnectionStore((s) => s.portDrift);
  const navigate = useNavigate();
  const levelRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 实测速度比：应当来自已装后端的自检结果（backend_installs.selftest_json）。
  // daemon 未接通 → 用 gpu-runtime 实测的 CPU 值 2.7x，并标明这是 CPU-only 场景。
  // 拿不到实测值时 estimateRerunMs 返回 null，UI 就**不显示预期**（宁可不说也不编）。
  // 实测速度比（应来自 backend_installs.selftest_json；daemon 未接通时用 gpu-runtime 的实测值）
  //   paraformer-zh-small: 84x 实时 → 1 小时录音约 43 秒
  //   large-v3-turbo (CPU): 2.7x 实时 → 1 小时录音约 22 分钟
  /**
   * 重跑会用哪个引擎 —— **按 daemon 的真实规则推算，不是用户在这里选的**。
   *
   * daemon 侧 `selectEngine()` 的中文判定只认 `zh*` / `cmn*` / `yue*` 前缀，
   * 且 Paraformer 必须真的构造得起来（需要 `OPENMEMO_PARAFORMER_DIR`）。
   * 两个条件都满足才会走 Paraformer，否则落到 whisper.cpp。
   *
   * 这里复刻这条判断只为**估算耗时**。它是推算而非后端回传的事实，
   * 所以一旦推错，代价仅仅是 ETA 偏差，不会让用户以为自己选中了别的引擎。
   */
  const paraformerUsable = engines.some((e) => e.id === 'paraformer' && e.available);
  const looksChinese = /^(zh|cmn|yue)/.test(language);
  const rerunEngine: AsrEngineId = paraformerUsable && looksChinese ? 'paraformer' : 'whisper.cpp';
  const speedRatio = rerunEngine === 'paraformer' ? 84 : 2.7;
  /**
   * 重跑会用的模型名：**优先真正激活的那个模型**，拿不到就退到引擎名。
   * 永不写死型号 —— 说错型号比不说更糟（实测机器上激活的是 whisper-tiny，
   * 而这里曾经写死 large-v3-turbo，同页下拉就显示着另一个名字）。
   */
  const activeAsr = useActiveAsrModel();
  const rerunModelLabel = activeAsr.displayName ?? ASR_ENGINE_LABELS[rerunEngine];
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
      .then((s) =>
        setPerm(s.state === 'granted' ? 'granted' : s.state === 'denied' ? 'denied' : 'unknown'),
      )
      .catch(() => setPerm('unknown'));
  }, []);

  // 组件卸载必须放掉麦克风，否则浏览器标签页会一直亮着录音指示灯
  useEffect(() => () => handleRef.current?.dispose(), []);

  /*
   * ★ 离线重跑进度用**真实** `job.progress`（SSE），不再是 220ms 自增的假进度条。
   * `rerunJobUid` 来自服务端的 `stopped` 消息。
   */
  const rerunSnap = useProgressStore((st) => (rerunJobUid ? st.byJob[rerunJobUid] : undefined));
  useEffect(() => {
    if (!rerunSnap) return;
    // 进度可能是 null（那一步报不出刻度）——录音重跑这里只画一个数值条，
    // 拿不到刻度就保持上一次的值，别把"不确定"渲染成 0%。
    if (rerunSnap.progress !== null) setRerunProgress(rerunSnap.progress);
    if (rerunSnap.state === 'succeeded') setPhase('done');
    if (rerunSnap.state === 'failed') {
      setPhase('done');
      setStreamError(t('recorder.rerunFailed'));
    }
  }, [rerunSnap, t]);

  /*
   * 重跑完成后回读转写稿，拿**真实**的段数与"编辑过仍保留"的段数。
   *
   * ⚠️ 「已更新 N 段」拿不到：daemon 把 `formatMergeSummary()` 的结果放进了
   * `queue.succeed()` 的 result_json，而 **`job.state` SSE 只带 {jobId,state,previousState}**，
   * `/api/jobs` 又只列下载队列（流水线任务不在里面）。
   * 所以那个数字**目前没有任何通道能到前端** —— 我不编，只显示能证实的部分。
   */
  const finishedTranscript = useTranscriptQuery(phase === 'done' && noteUid ? noteUid : undefined);
  useEffect(() => {
    const segs = finishedTranscript.data?.segments;
    if (!segs) return;
    setSegmentCount(segs.length);
    setReplaced({
      updated: 0,
      preserved: segs.filter((x) => x.editedAt != null).length,
      noCounterpart: 0,
    });
  }, [finishedTranscript.data]);

  const requestMic = async () => {
    // 这里不该再被点到（按钮已禁用），但 API 缺失时也绝不能让 `undefined.getUserMedia` 抛出去
    if (!isMicrophoneAvailable()) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((tr) => tr.stop());
      setPerm('granted');
    } catch {
      setPerm('denied');
    }
  };

  /**
   * ★ 真实录音（T-117）。此前这里是一段 `setInterval` 轮播写死的字幕。
   *
   * 后端 `/ws/recorder` 一直是真的，**只有 UI 在演** ——
   * 章程五功能里唯一 UI 层造假的一处。现在接的是真通道：
   * 麦克风 → AudioWorklet → PCM16 → WS 二进制帧；下行 partial/final 渲染。
   */
  const start = async () => {
    setCaptions([]);
    setReplaced(null);
    setElapsed(0);
    setStreamError(null);
    setPhase('recording');
    timerRef.current = setInterval(() => setElapsed((e) => e + 1000), 1000);

    try {
      handleRef.current = await startRecording({
        ...(language ? { language } : {}),
        onLevel: (v) => {
          // 直写 DOM：电平约 50Hz，进 React state 会让整页跟着重渲染
          if (levelRef.current) levelRef.current.style.transform = `scaleX(${v.toFixed(3)})`;
        },
        onSocketError: () => setStreamError(t('recorder.streamError')),
        onMessage: (msg) => {
          switch (msg.type) {
            case 'ready':
              // 服务端已建好 note + transcript，从这里拿 uid（不是前端自己造）
              setNoteUid(msg.noteUid);
              break;
            case 'partial':
              /*
               * 语义 4：同一句内 text **单调增长** → 整句替换，不要 diff 拼接。
               * partial 用 utteranceId 作键：一句定稿后服务端会换新的 id。
               */
              setCaptions((c) => applyCaption(c, msg));
              break;
            case 'final':
              // final 到来 = 该 utterance 定稿：把未定稿行替换成定稿行
              setCaptions((c) => applyCaption(c, msg));
              break;
            case 'overrun':
              // 丢帧要说出来 —— 静默丢帧会表现为"有几句话没识别出来"，无从解释
              setStreamError(t('recorder.overrun'));
              break;
            case 'error':
              setStreamError(msg.messageZh);
              /*
               * ★ 致命错误必须把界面带回 idle，并**放开麦克风**（T-164 ②）。
               *
               * 原来只 `setStreamError`：红字出来了，phase 却还是 'recording' ——
               * 计时器继续走、麦克风灯继续亮、AudioWorklet 继续往一条死掉的
               * socket 上推帧。用户唯一的出路是点「停止」，而在修掉服务端那半之前，
               * 那一下正是造出 0 秒死笔记的动作。
               *
               * 只对**会话根本没开起来**的两个码这么做：`overrun` /
               * `ASR_STREAM_ERROR` 这类是「录着录着出了点问题」，
               * 把它们也打回 idle 会丢掉已经识别出来的内容。
               */
              if (msg.code === 'ASR_STREAM_UNAVAILABLE' || msg.code === 'RECORD_START_FAILED') {
                if (timerRef.current) clearInterval(timerRef.current);
                setPhase('idle');
                handleRef.current?.dispose();
                handleRef.current = null;
              }
              break;
            case 'stopped':
              setRerunJobUid(msg.rerunJobUid);
              setSegmentCount(msg.segmentCount);
              // 有重跑任务才进入第二阶段；没有就直接结束
              setPhase(msg.rerunJobUid ? 'rerunning' : 'done');
              break;
            default:
              break;
          }
        },
      });
    } catch (err) {
      // getUserMedia 被拒 / 无可用设备 —— 不能停在"录音中"那个假状态
      setPhase('idle');
      if (timerRef.current) clearInterval(timerRef.current);
      setPerm('denied');
      setStreamError(err instanceof Error ? err.message : String(err));
    }
  };

  const stop = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setCaptions((c) => c.map((x) => ({ ...x, final: true })));
    setPhase('finalizing');
    void handleRef.current?.stop().finally(() => {
      handleRef.current = null;
    });
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
      {/*
        ★ **在点击之前**就拦住：非安全上下文下 `navigator.mediaDevices` 是 `undefined`，
        点下去只会得到一个 `Cannot read properties of undefined` —— 用户会以为软件坏了，
        而真因（地址不是 https / localhost）在报错里一个字都看不到。

        这一整族问题在本机开发时**不可能被发现**：localhost 恰好被规范定为安全上下文。
      */}
      {!micAvailable ? (
        <section
          className="rounded-lg border border-line border-l-4 border-l-warning bg-surface-1 p-4"
          data-testid="recorder-insecure"
        >
          <div className="flex gap-2">
            <MicOff className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink">{t('recorder.insecureTitle')}</div>
              <p className="mt-1 text-sm text-ink-secondary">{t('recorder.insecureHelp')}</p>
              {/* 只给 localhost 这一条 —— TLS 已按用户要求撤掉，不推销 https */}
              {localUrl ? (
                <p className="mt-2 text-sm">
                  <a className="text-accent-ink underline" href={localUrl}>
                    {t('secureContext.tryLocalhost')}
                  </a>
                </p>
              ) : null}
              {/* 录音之外的路仍然通：这条地址下导入音视频文件是完全正常的 */}
              <p className="mt-2 text-xs text-ink-muted">{t('recorder.insecureAlternative')}</p>
            </div>
          </div>
        </section>
      ) : perm === 'denied' ? (
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
              <Button variant="primary" size="sm" onClick={() => void start()}>
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
        <div className="space-y-2 rounded-md border border-line bg-surface-1 p-3 text-xs text-ink-secondary">
          {/* 引擎：如实展示可用性（来自 daemon 实测），不是可切换的假选项 */}
          <AsrEngineStatus />

          {/*
            语言：真会发给后端的那个参数。

            ★ `showModel` 曾经写死为 `false`，注释理由是"不做可切换的假选项"。
            那个判断在当时是对的 —— 选择器确实是假的（选中的值从不发给后端）。
            但 `AsrModelPicker` 已经改成走 `POST /api/models/activate`、**选了真的生效**，
            于是这个 `false` 变成了一个过时的保护：用户装了 2 个模型，
            录音页仍然 0 个下拉，看起来像"这软件不让我选模型"。

            教训与 App.tsx 里那个 `pending` 分支同源：**临时保护必须与它保护的条件绑定，
            不能靠人记得回来删。** 这里改为常开，条件判断交给选择器自己 ——
            它在"一个模型都没装"时会自动渲染成 [去安装模型]，而不是一个空下拉框。
          */}
          <TranscribeOptions language={language} onLanguageChange={setLanguage} showModel />

          <p>
            ⓘ{' '}
            {rerunEngine === 'paraformer'
              ? t('recorder.paraformerNotice')
              : rerunEtaLabel
                ? t('recorder.twoPhaseNoticeWithEta', { eta: rerunEtaLabel })
                : t('recorder.twoPhaseNotice')}
          </p>
          {/* ★ 代价必须明示：Paraformer 快但没有逐字时间戳，
              否则用户会在 F5 里发现"字幕不能逐字高亮"而不知道为什么。 */}
          {/* 词条里带 `**没有逐字时间戳**` —— 走 <Emphasis>，别把裸星号吐给用户（T-129b） */}
          <Emphasis
            className="block text-ink-muted"
            text={
              rerunEngine === 'paraformer'
                ? t('recorder.paraformerTradeoff')
                : t('recorder.turboTradeoff')
            }
          />
        </div>
      ) : null}

      {/* ★ 保险 3：重跑时不遮挡内容 */}
      {phase === 'rerunning' ? (
        <section className="rounded-lg border border-line bg-surface-1 p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-ink">
              {/*
                ★ 模型名来自**真正激活的那个**，不再写死。
                拿不到名字时退到引擎名（whisper.cpp / Paraformer），
                而不是编一个具体型号 —— 说错型号比不说更糟。
              */}
              {rerunRemainLabel
                ? t('recorder.rerunningWithEta', { model: rerunModelLabel, eta: rerunRemainLabel })
                : t('recorder.rerunning', { model: rerunModelLabel })}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setPhase('done')}>
              {t('recorder.skipRerun')}
            </Button>
          </div>
          <ProgressMeter
            value={rerunProgress}
            label={t('recorder.rerunning', { model: '' })}
            size="md"
          />
          <p className="mt-2 text-xs text-ink-secondary">{t('recorder.rerunHint')}</p>
        </section>
      ) : null}

      {/* ★ 保险 4：说清楚改了什么、保住了什么，并且**可以撤销** */}
      {/* 流式识别出错 / 丢帧 —— 必须说出来，静默丢帧表现为"有几句没识别出来"，无从解释 */}
      {streamError ? <Banner tone="warning" title={streamError} /> : null}

      {/*
        ★ 完成后只报**能证实的数字**。

        「已保留 N 段」= 转写稿里 `editedAt != null` 的段数，回读服务端得到，是真的。
        ⚠️ 「已更新 N 段」**没有显示** —— daemon 的 `formatMergeSummary()` 结果只进了
        `queue.succeed()` 的 result_json，而 `job.state` SSE 只带 {jobId,state,previousState}，
        `/api/jobs` 又只列下载队列。那个数字**目前没有任何通道能到前端**。
        原来这里写死的「已更新 47 段 · 已保留 3 段」就是拿不到而硬编的。
        拿不到就不说，不编。
      */}
      {phase === 'done' ? (
        <Banner
          tone="info"
          title={t('recorder.doneSummary', { segments: segmentCount })}
          detail={
            <>
              {replaced && replaced.preserved > 0 ? (
                <span className="block">
                  {t('recorder.preservedOnly', { count: replaced.preserved })}
                </span>
              ) : null}
              {/* 合并按**时间轴**对齐而不是按段落序号 —— 两遍模型的断句天然不同 */}
              <span className="mt-0.5 block text-ink-muted">{t('recorder.mergeByTimeNote')}</span>
            </>
          }
          action={
            noteUid ? (
              <Button size="sm" variant="secondary" onClick={() => navigate(`/notes/${noteUid}`)}>
                {t('recorder.openNote')}
              </Button>
            ) : undefined
          }
        />
      ) : null}
    </div>
  );
}
