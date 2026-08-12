import { useEffect, useMemo, useRef, useState } from 'react';
import { arr } from '../../lib/safe';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';

import { useNoteQuery, useTranscriptQuery } from './api';
import { qk } from '../../app/query';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { Button } from '../../components/common/Button';
import { MockNotice } from '../../components/common/MockNotice';
import { PanelBoundary } from '../../components/common/PanelBoundary';
import { WordLevelBadge } from '../transcript';
import { GenerateMindmapButton, MindmapView, useMindmapQuery } from '../mindmap';
import { NoteProgressLine } from './NoteProgressLine';
import { NoteFailureNotice } from './NoteFailureNotice';
import { TagEditor } from './TagEditor';
import { RetranscribeButton } from './RetranscribeButton';
import { NoteEditor } from './NoteEditor';
import { parseSeekParam } from './seekParam';
import { ExportMenu } from './ExportMenu';
import { NoteActionsMenu } from './NoteActionsMenu';
import { TranscriptList } from '../transcript';
import { PlayerBar } from '../player';
import { usePlayerStore } from '../../lib/stores/player.store';
import { useUiStore } from '../../lib/stores/ui.store';
import { decodeOmpk, type DecodedPeaks } from '../../lib/format/peaks';
import { timecode } from '../../lib/format/time';
import { mediaUrl } from '../../lib/api/client';
import { pickAudioAsset, pickPeaksAsset } from './noteAssets';
import { cn } from '../../lib/utils';

type Tab = 'summary' | 'mindmap' | 'notes';

/** F5 笔记详情 —— 产品心脏（D-05 §4.4）。 */
export default function NoteDetailPage() {
  const { t } = useTranslation();
  const { noteUid } = useParams<{ noteUid: string }>();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'summary';

  const note = useNoteQuery(noteUid);
  const transcript = useTranscriptQuery(noteUid);
  const navigate = useNavigate();
  const setSource = usePlayerStore((s) => s.setSource);
  const follow = useUiStore((s) => s.followPlayback);
  const setFollow = useUiStore((s) => s.setFollowPlayback);

  // 摘要走 summary.delta 流式累积（bindings 写进这个 key）
  const { data: streamedSummary } = useQuery({
    queryKey: qk.summary(noteUid ?? ''),
    queryFn: () => '',
    enabled: Boolean(noteUid),
    staleTime: Infinity,
  });

  const audioAsset = pickAudioAsset(note.data);
  const peaksAsset = pickPeaksAsset(note.data);

  useEffect(() => {
    if (!note.data) return;
    setSource(audioAsset?.uid ?? null, note.data.durationMs ?? 0);
  }, [note.data, audioAsset?.uid, setSource]);

  /*
   * 波形：**有真 `.ompk` 才画，没有就不画**（T-139 A3）。
   *
   * 这里原来的逻辑是反的，而且反得很彻底：
   *   有 peaks 资产 → `setPeaks(null)`（带一条 `TODO(T-021)`，也就是**真数据反而被丢掉**）
   *   没有        → `setPeaks(mockPeaks(...))`（**凭空造一条随机波形**）
   * 而 daemon 全仓零处产出 `peaks` 资产 —— 所以**每一位用户看到的每一条波形都是编的**。
   * 同一段注释还写着"并在 UI 上标注（诚实规则：不许把 mock 说成真数据）"，
   * 而那句标注**从来不存在**：一条描述了不存在行为的注释，比没有注释更坏。
   *
   * 现在：没有真峰值就交 `null` 给 `Waveform`，它会画一条基线 + 可点击定位的游标
   * （那个诚实的降级分支本来就写好了，只是从来没被走到过）。
   * 判据是 architect 立的那条：**用户看到的每一个具体东西，要么来自后端，要么根本不提。**
   * 一条编出来的波形不是"占位符"，它是在对用户断言这段音频长这样。
   *
   * ✅ **daemon 现在真的产 peaks 了**（T-151 ③：录音路径 `ws/recorder.ts`，
   * 导入/转写路径 `jobs/runners/transcribe.ts`；后者的接线在 `b97bed6` 之前一直没被提交，
   * 所以有一段时间只有浏览器录音有波形）。此处此前写的是
   * 「daemon 目前不产 peaks，所以这条 fetch 分支在今天的产品里走不到」——
   * **已过期，保留这句是为了让下一个人知道这里改过。**
   * `decodeOmpk` 早就写好了，这里是它第一个调用方，现在它真的会被走到。
   */
  const [peaks, setPeaks] = useState<DecodedPeaks | null>(null);
  const peaksUrl = peaksAsset ? (peaksAsset.url ?? mediaUrl(peaksAsset.uid)) : null;
  useEffect(() => {
    if (!peaksUrl) {
      setPeaks(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // 与 `<audio src>` 同一条通道：同源 + cookie（D-01 §2.4）
        const res = await fetch(peaksUrl, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const decoded = decodeOmpk(await res.arrayBuffer());
        if (!cancelled) setPeaks(decoded);
      } catch (err) {
        // 取不到/解不开就当没有波形 —— 绝不回落成一条编出来的
        console.error('[peaks] 读取 .ompk 失败，按"无波形"处理', err);
        if (!cancelled) setPeaks(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [peaksUrl]);

  /*
   * ★ F5「搜索结果直达时间点」的落点（`SearchPage` 把这叫杀手级体验，而它此前是半条链：
   *   搜索页一直在发 `?t=`，这一页从来不读，点任何命中都从 0:00 开始播）。
   *
   * ## 三个边界怎么处理的
   *
   * ① **媒体还没加载完**：不在这里等。`requestSeek()` 会立刻把 `positionMs` 设成目标值，
   *    转写稿的高亮/滚动当场就位（它们不依赖媒体）；音频那一半由 `PlayerBar` 记成 pending，
   *    等 `<audio>` 挂载 + `loadedmetadata` 再补落。所以**转写稿不必为音频的加载速度买单**。
   *    注意顺序：上面 `setSource` 的 effect 声明在前，先跑 —— 换笔记时它会先把上一条的
   *    待落 seek 作废，本 effect 再为这一条重新排一次。
   *
   * ② **超出时长**：交给 `parseSeekParam` 夹到末尾并回一个 `clamped`，
   *    然后**说出来**（下方那条提示）。悄悄夹到 0 会和"没接线"长得一模一样。
   *    时长未知（转写中的笔记 `durationMs` 为 0）时不夹 —— 用未知上界夹只会夹坏对的值。
   *
   * ③ **地址栏留不留 `?t=`：留。** 这是我做的判断，理由与代价都写在这儿：
   *    · 这个 URL 是**可分享物**。`/notes/X?t=754000` 发给别人、或者自己收藏，
   *      理应还原成"这条笔记的 12:34"。用完就抹掉，等于让地址栏在下一个 tick 开始说假话。
   *    · 与本页既有约定一致 —— `?tab=`、搜索页的 `?q=` / `?mode=` 全都是留在 URL 里的视图状态，
   *      单独给 `?t=` 开一条"用完即焚"的例外，下一个人只会把它当 bug 改回来。
   *    · **代价（我接受并写明）**：刷新会重跳一次。我认为这不是惊吓而是 URL 说到做到 ——
   *      地址栏里明写着 `t=754000`。
   *    · 真正会咬人的不是刷新，是**会话中途被反复拽回去**：切 tab 会 `setParams`，
   *      SSE 会让 `note.data` 换对象，两者都会让这个 effect 再跑。所以用 `(noteUid, t)`
   *      作闩，**一个值只跳一次**；用户跳走之后再切 tab / 后台刷新，播放头一律不动。
   */
  const seekRaw = params.get('t');
  const seek = useMemo(
    () => parseSeekParam(seekRaw, note.data?.durationMs ?? 0),
    [seekRaw, note.data?.durationMs],
  );
  const requestSeek = usePlayerStore((s) => s.requestSeek);
  /** 已经消费过的 `(笔记, t)`。ref 而不是 state：它不该引起渲染，也不该被渲染读到。 */
  const appliedSeekRef = useRef<string | null>(null);

  useEffect(() => {
    // 时长未知就先不跳：`parseSeekParam` 的夹取要靠它，早跳一拍会跳到夹取前的位置
    if (!note.data || seek.ms === null) return;
    const latch = `${noteUid ?? ''}|${seekRaw ?? ''}`;
    if (appliedSeekRef.current === latch) return;
    appliedSeekRef.current = latch;
    requestSeek(seek.ms);
  }, [note.data, seek.ms, seekRaw, noteUid, requestSeek]);

  const mindmap = useMindmapQuery(tab === 'mindmap' ? noteUid : undefined);

  const speakerNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of arr(transcript.data?.speakers)) m[s.label] = s.displayName ?? s.label;
    return m;
  }, [transcript.data]);

  if (note.isError)
    return <ErrorBlock error={note.error} onRetry={() => void note.refetch()} className="m-6" />;
  if (!note.data) return <div className="p-6 text-sm text-ink-muted">{t('common.loading')}</div>;

  const n = note.data;

  return (
    <div className="flex h-full flex-col">
      {/*
        进行中的任务：顶部进度条 + **主动告诉用户可以关页面**。

        ⚠️ 这里原来的条件是 `n.activeJobId ?` —— 一个 daemon 从来没发过的字段，
        所以这一块**在真实环境里一次都没显示过**（T-138 ②）。
        "有没有在跑"现在由组件自己去问任务流（`GET /api/jobs` + 进度事件），
        没有任务时它自己返回 null —— 也就不再需要外面这个包裹条件。
      */}
      <NoteProgressLine
        noteUid={n.uid}
        hint={t('detail.backgroundHint')}
        className="border-b border-line bg-surface-1 px-4 py-2"
      />

      {/*
        ★ 失败告知条（#98）。**这一页此前对一次失败的转写一个字都不显示。**

        用户看到的是：空的转写稿面板 + 不动的播放器 + 零条解释。
        唯一说过话的是右下角那条 toast，而它刷新即无 ——
        也就是说，只要他不是**正好**在失败那一刻盯着屏幕，这件事就从未发生过。

        ⚠️ 它与上面的进度行**不互斥**，这是有意的：转写失败之后用户点了「生成导图」，
        那一刻页面上应该同时有"导图正在生成"和"上次转写失败了"。
        互斥会让其中一句消失，而两句都是真的。
        （`lastFailure` 只认每种任务类型的**最近一条**，所以重跑之后旧的失败会自动翻篇。）
      */}
      <NoteFailureNotice note={n} className="border-b border-line bg-surface-1 px-4 py-2" />

      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h1 className="min-w-0 truncate text-base font-semibold text-ink">{n.title}</h1>
        <span className="flex items-center gap-2">
          <TagEditor noteUid={n.uid} tags={arr(n.tags)} />
          <ExportMenu note={n} />
          {/*
            重命名 / 删除（T-155）。三条 mutation 早就写好了，此前**全仓零调用方** ——
            一条笔记建出来就删不掉、改不了名，而侧栏的文件夹反倒有删除按钮。
          */}
          <NoteActionsMenu note={n} />
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左：转写稿 */}
        <section className="flex min-w-0 flex-1 flex-col border-r border-line">
          <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
            <h2 className="flex items-center gap-2 text-xs font-medium text-ink-secondary">
              {t('detail.transcript')}
              <MockNotice surface="transcript" compact />
              <WordLevelBadge segments={arr(transcript.data?.segments)} />
            </h2>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
                <input
                  type="checkbox"
                  checked={follow}
                  onChange={(e) => setFollow(e.target.checked)}
                  className="size-3.5 accent-[var(--accent)]"
                />
                {t('detail.followPlayback')}
              </label>
              {/*
                ★ 重新转写入口。放在转写稿面板的头上 —— 用户是**看着那篇被翻译成英文的稿子**
                想重跑的，入口就该在他视线所及之处，而不是埋进设置里。

                ★ `retranscribeBlocked` 必须跟着 `canRetranscribe` 一起传（#95）：
                不传的话，按钮变灰时只会显示那句**写死的**「没有记录原始输入」，
                而 daemon 判 `false` 的原因现在不止这一种。显示错的那一种比不显示更糟 ——
                它把人往"只能重新导入"指，而实际多半只是文件被删 / 外置盘没挂，
                把文件接回去就好。
              */}
              <RetranscribeButton
                noteUid={noteUid ?? ''}
                segments={arr(transcript.data?.segments)}
                currentLanguage={transcript.data?.language ?? null}
                canRetranscribe={note.data?.canRetranscribe}
                retranscribeBlocked={note.data?.retranscribeBlocked}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <PanelBoundary name={t('detail.transcript')}>
              <TranscriptList
                segments={arr(transcript.data?.segments)}
                speakerNames={speakerNames}
                noteUid={noteUid}
              />
            </PanelBoundary>
          </div>
        </section>

        {/* 右：Tab */}
        <aside className="hidden w-[420px] shrink-0 flex-col lg:flex">
          <nav className="flex border-b border-line" role="tablist">
            {(['summary', 'mindmap', 'notes'] as Tab[]).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() =>
                  setParams((p) => {
                    p.set('tab', k);
                    return p;
                  })
                }
                className={cn(
                  'flex-1 px-3 py-2 text-sm transition-colors',
                  tab === k
                    ? 'border-b-2 border-b-accent text-ink'
                    : 'text-ink-muted hover:text-ink-secondary',
                )}
              >
                {t(`detail.tabs.${k}`)}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-auto p-4 text-sm text-ink-secondary">
            <PanelBoundary name={t(`detail.tabs.${tab}`)}>
              {tab === 'summary' ? (
                (n.summaryMd ?? streamedSummary) ? (
                  <p className="whitespace-pre-wrap">{n.summaryMd || streamedSummary}</p>
                ) : (
                  <p className="text-ink-muted">{t('detail.summaryEmpty')}</p>
                )
              ) : tab === 'mindmap' ? (
                mindmap.data ? (
                  <div className="-m-4 flex h-[60vh] flex-col">
                    {/*
                    ★ 这个 tab **是只读的**（没传 onChange），此前界面对此一个字都不说 ——
                    用户在这里拖动节点，会以为改动生效了。
                    渲染器内部的乐观更新恰恰让它**看起来像成功了**，这是最坏的一种沉默。
                    要么接上编辑，要么明说 + 给出能编辑的地方；这里选后者（保持详情页轻量）。
                  */}
                    <p className="flex items-center gap-2 px-4 py-1 text-xs text-ink-muted">
                      <span data-testid="mindmap-readonly">{t('detail.mindmapReadonly')}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-5 px-1.5 text-xs text-accent-ink hover:text-accent-ink"
                        onClick={() => navigate(`/notes/${n.uid}/mindmap`)}
                      >
                        {t('detail.mindmapEdit')}
                      </Button>
                    </p>
                    <div className="min-h-0 flex-1">
                      <MindmapView doc={mindmap.data} noteUid={n.uid} />
                    </div>
                  </div>
                ) : (
                  /*
                  ★ F4 的生成入口（T-138 ①）。这里以前只有一句"还没有思维导图"，
                  用户在整个产品里**找不到任何地方**能让 AI 生成一张 ——
                  而后端 `POST /api/notes/:uid/mindmap` 早就通了（实测 4.3 秒出图）。
                  放在这里而不是别处：这是用户"想看导图却没有"的那一刻，
                  和 memo.ac 把生成放在详情页 mindmap tab 里是同一个位置（R-01 §A2.4）。
                */
                  <div className="flex flex-col items-start gap-3">
                    <p className="text-ink-muted">{t('mindmap.empty')}</p>
                    <GenerateMindmapButton noteUid={n.uid} size="sm" />
                  </div>
                )
              ) : (
                <NoteEditor
                  noteUid={n.uid}
                  initialJson={n.bodyJson ?? null}
                  transcriptUid={transcript.data?.uid}
                  quoteAt={(ms) => {
                    // 取该毫秒所在段的原文，作为锚点的重定位依据（D-02 §3.5 第 2 层）
                    const segs = transcript.data?.segments ?? [];
                    const hit = segs.find((sg) => sg.startMs <= ms && ms < sg.endMs);
                    return hit ? hit.text.slice(0, 200) : null;
                  }}
                />
              )}
            </PanelBoundary>
          </div>
        </aside>
      </div>

      {/*
        ★ `?t=` 越界时把话说出来。
        夹到末尾之后播放头停在结尾、转写稿也没有任何一段被高亮 ——
        不说的话用户只会觉得"点搜索结果跳错了"，而这恰恰是本轮要修的那个病的样子。
        只在 `clamped` 时出现；`malformed`（手改坏的 URL）不打扰，那不是产品的失败。
      */}
      {seek.reason === 'clamped' ? (
        <p
          data-testid="seek-clamped"
          className="border-t border-line bg-surface-1 px-4 py-1.5 text-xs text-ink-muted"
        >
          {t('detail.seekClamped', {
            asked: timecode(seek.askedMs ?? 0),
            duration: timecode(n.durationMs ?? 0),
          })}
        </p>
      ) : null}

      <PanelBoundary name={t('detail.transcript')} fallback={() => null}>
        <PlayerBar peaks={peaks} />
      </PanelBoundary>
    </div>
  );
}
