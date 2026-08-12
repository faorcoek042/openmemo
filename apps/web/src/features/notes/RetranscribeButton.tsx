import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Cpu, RefreshCw } from 'lucide-react';

import type { AsrEngineId, RetranscribeRequest } from '@openmemo/shared';

import { api, ApiError } from '../../lib/api/client';
import type { RetranscribeBlocked } from '../../lib/api/types';
import { pickLocalized } from '../../lib/format/localized';
import { qk } from '../../app/query';
import { Button } from '../../components/common/Button';
import { Banner } from '../../components/common/Banner';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { TranscribeOptions } from '../../components/common/TranscribeOptions';
import { useAsrEngines } from '../../components/common/AsrEngineStatus';
import { useActiveAsrModel } from '../../components/common/AsrModelPicker';
import { ASR_ENGINE_LABELS, ASR_LANGUAGE_AUTO, toAsrEngineId } from '../../lib/asr';
import type { TranscriptSegmentDto } from '../../lib/events/types';

/**
 * 「重新转写」—— 补上那个**唯一的补救通道**。
 *
 * ## 为什么这个入口是必须的
 *
 * whisper.cpp 拿不到 `-l` 时会把中文**翻译成英文**返回。转写稿里存的就是那篇英文，
 * 原始中文**不在库里任何地方** —— 唯一的找回办法是拿着原始音频、指定语言重跑一遍。
 * `POST /api/notes/:uid/retranscribe` 早就接受 `language` 了，
 * 但产品里没有任何地方能调到它：**端点有了，路没有**。
 *
 * ## 现在发的是 `{ language, engineId? }`（#99 ① 已裁决，方案 A）
 *
 * ─── 这一段的前两版都已经不成立，按本仓规矩把历史留着 ──────────────────
 * · **第一版**说「后端 `retranscribe` 的 body 只解析 `language`，其余键读都不读」，
 *   结论是"多画一个下拉框就是多一个选了会被丢掉的谎"。**那个前提早就假了**。
 * · **第二版**（`e590e06`）改成「后端收了，前端没接，等 #99 ① 裁决，
 *   在裁决下来之前不许偷偷加下拉框」。**裁决已经下来了，就是本次改动**。
 *
 * 今天的事实：`apps/daemon/src/http/rest/content.ts` 的 `retranscribe` 分支
 * （`body: { language?, engineId?, modelId?, prompt? }`）三个键都在解析并塞进 payload，
 * `jobs/runners/transcribe.ts` 真的在按它们挑引擎和模型 —— 而**下面 `run` 的 body
 * 现在真的带上了 `engineId`**，类型是共享契约的 `RetranscribeRequest`（不是随手拼的对象）。
 *
 * ## 三个键为什么只接了一个 —— 逐条是判断，不是没做完
 *
 * | 键 | 处置 | 理由（都实测过） |
 * |---|---|---|
 * | `engineId` | **下拉框，默认=这条上次实际用的** | `transcripts.engine_id` 与 `ASR_ENGINE_IDS` 逐字同域，可比、可当默认值，也可当事后凭据 |
 * | `modelId` | **只读并列一行，不预选** | `transcripts.model_id` 存的是权重**文件名**（`ggml-base.en.bin`），`activate` 用的是目录 id（`asr/whisper-base-q5_1`）—— **两个命名空间**。模糊匹配能写，但那是一条没人测得到的猜测逻辑，指错时用户会以为自己换了模型而实际重跑同一个 |
 * | `prompt` | **不露** | 只对 whisper.cpp 生效（`packages/pipeline/src/asr/whisperCpp.ts` 走 `--prompt`；paraformer / sherpa 收到后**静默丢弃**）；且**不落库**（`transcripts.params_json` 全仓只有 DDL，从没被写过）⇒ 第二次重跑说不出上次用了什么 |
 *
 * ## 🔴 引擎候选**必须自己按 `available` 过滤**
 *
 * 给一个不可用 / 不认识的 `engineId`，daemon **不报错**：
 * `pipeline/setup.ts` 里 `candidates.find(c => c.engine.id === … && c.available)` 落空后
 * 直接走 `pickEngine(language)` 自动选，那个 `reason` 谁都不读、不落库、不上 SSE。
 * 所以"我选了 paraformer、实际跑的是 whisper"**在响应里完全看不出来** ——
 * 唯一能拦住它的是前端自己先过滤，后端那道闸不存在。
 *
 * ## 🔴 用户怎么确认这一次真的用了他选的那个
 *
 * **不是靠 SSE**：`TranscribeStartedEvent`（`packages/shared/src/events.ts`）只有
 * `modelId`，**没有 `engineId`** —— `d9e1182` 修好的是 `modelId` 那一半，
 * 别把它当成引擎也能验。
 *
 * 凭据是面板顶上那一行只读事实（`retranscribe-last-run`）：它读的是
 * `transcript.engineId`，也就是 `transcripts.engine_id` —— **runner 写进去的是
 * `chosen.engineId`，实际选中的那个**，不是请求里的那个。
 * 跑完之后 `transcribe.done` 会失效 `qk.transcript`（`features/notes/sse.ts`），
 * 这一行随即刷新成真实结果。真发生了静默回落，这里就会与他选的不一致。
 *
 * ## ⚠️ 引擎和模型现在**作用域不同**，面板里必须说清哪个是哪个
 *
 * 引擎 = **只这一次重跑**（per-job）；模型 = **之后所有转写**（全局激活，
 * `TranscribeOptions` 里的 `AsrModelPicker`，它自己底下那句 `asr.activeIsGlobal` 说的就是这个）。
 * 两句话缺任何一句，用户都会以为两个下拉是同一种作用域。
 */

/**
 * 判断一段是否被用户编辑过。
 *
 * 契约**已统一**：daemon 现在以 `editedAt` 为权威、并附带 `edited` 布尔投影，
 * 两条通道不再分裂。这里仍然两个都认，是**刻意的向后兼容**而非遗留：
 * SSE 增量与 REST 全量由不同代码路径构造，缓存里也可能残留旧形状的段。
 *
 * 优先读 `editedAt` —— 它同时是 `mergeTranscripts` 判"要不要保留"的依据，
 * 前后端用同一个事实，不必各自推导。
 *
 * ⚠️ 判据必须是 `editedAt` 而不是"文本看起来没变"：
 * `editedAt` 丢了但文本还在时，**第一次重跑看着完全正常，第二次才把编辑覆盖掉**。
 */
export function isSegmentEdited(
  seg: Partial<TranscriptSegmentDto> & { edited?: boolean },
): boolean {
  if (seg.editedAt != null) return true;
  return seg.edited === true;
}

/**
 * 禁用理由那条横幅的 DOM id。按钮用 `aria-describedby` 指过来。
 *
 * 常量而不是字面量：id 一旦和 `aria-describedby` 对不上，**不会报任何错**，
 * 只会安静地退回"读屏用户什么都听不到"—— 正是本轮要修的那个形状。
 */
export const RETRANSCRIBE_BLOCKED_ID = 'retranscribe-blocked-reason';

/**
 * 引擎下拉里的「自动」档 —— 它**不是**一个引擎 id。
 *
 * 选中它时请求体里**一个 `engineId` 键都不发**，也就是本次改动之前的行为逐字节不变：
 * 后端按语言自己挑（中文走 Paraformer，见 `lib/asr.ts` 的 `autoLanguageDowngradesEngine`）。
 *
 * 用一个不可能与 `AsrEngineId` 相撞的字面量，而不是空串：空串在 `<select>` 里
 * 与"没有选中项"同形，判 `engine === ''` 到底是"用户选了自动"还是"状态还没初始化"
 * 分不出来 —— 而这两者要发的请求体不一样。
 */
const ENGINE_AUTO = '__auto__';

/**
 * "为什么不能重跑"的那句话。`null` = 可以重跑，什么都不用说。
 *
 * `tried` 单独返回而不是拼进字符串：横幅要把它排成一列路径给用户逐条核对，
 * 拼成一行加 `\n` 的那种做法只在 `title` 里成立 —— 而 `title` 已经被证明没人读得到。
 */
function useBlockedReason(
  canRetranscribe: boolean | undefined,
  retranscribeBlocked: RetranscribeBlocked | null | undefined,
): { head: string; tried: readonly string[] } | null {
  const { t, i18n } = useTranslation();
  if (canRetranscribe !== false) return null;
  /*
   * 回落那一档不是可有可无：老 daemon 的响应真的没有 `retranscribeBlocked`，
   * 而"没有原因字段"绝不能渲染成一条空横幅（那就退回成无声变灰了）。
   */
  if (!retranscribeBlocked) return { head: t('detail.retranscribe.noSource'), tried: [] };
  return {
    head: pickLocalized(i18n.language, retranscribeBlocked.messageZh, retranscribeBlocked.message),
    tried: retranscribeBlocked.tried,
  };
}

/**
 * ★★ 禁用理由的**真表面**（v0.7.1 已知边界第 4 条）。
 *
 * ## 在它之前，那条理由任何输入方式都拿不到
 *
 * 理由只挂在按钮的 `title` 上，而 `Button` 基类带 `disabled:pointer-events-none`：
 *
 * - **鼠标**：`pointer-events: none` 的元素收不到 `mouseover`，
 *   浏览器的原生 tooltip **根本不会弹** —— 不是"要悬停久一点"，是永远不弹。
 * - **键盘**：`disabled` 把它移出了 tab 序列，聚焦不到，也就没有任何触发方式。
 * - **读屏**：没有 aria-label / aria-describedby，`title` 在多数读屏配置下不播报。
 *
 * 也就是说：daemon 认认真真算出来的那条原因（`retranscribeBlocked`，含
 * `code`/`message`/`messageZh`/`tried`），**到了界面上等于没有**。
 * 用户看到的只是一个说不出话的灰按钮 —— 和"这功能坏了"完全一样。
 *
 * ## 仓库自己的测试没抓到，是因为它断言的是 `title` 属性存在
 *
 * 「文本存在」和「用户读得到」是两件事，而那条断言只证明了前者。
 * 换掉之后钉的是后果：**这句话必须出现在渲染出来的文档里**（见 components.test.tsx）。
 *
 * ## 为什么是横幅而不是"点一下才展开"
 *
 * 它不需要用户先想到去点。而且这条信息本来就不止服务于"重新转写"：
 * 源文件读不到意味着导出原件、重新剪辑同样做不了。
 *
 * ⚠️ 它由 `NoteDetailPage` 渲染在转写稿面板头的正下方，与按钮**分处两个节点**。
 * 忘了渲染它 = 按钮的 `aria-describedby` 指向一个不存在的 id，**不报错、静默失效**。
 * 因此那条回归腿钉在 `NoteDetailPage` 这一层，而不是只渲染按钮。
 */
export function RetranscribeBlockedNotice({
  canRetranscribe,
  retranscribeBlocked,
}: {
  /** 来自 `NoteDetail.canRetranscribe`。`undefined` / `true` 都表示"没被拦住"，渲染 `null`。 */
  canRetranscribe?: boolean;
  /**
   * 来自 `NoteDetail.retranscribeBlocked` —— 不能重跑时**为什么**（#95）。
   *
   * 有它，"变灰"才是一个诚实的状态。在此之前禁用时显示的是一句**写死的**
   * 「这条笔记没有记录原始输入」，而 daemon 判 `false` 的原因已经不止这一种：
   * 源文件读不到（数据目录搬过家、文件被删、外置盘没挂）时照旧显示那句话，
   * 就是**一句新的谎** —— 明明记录了原始输入，只是那个位置现在打不开，
   * 而这两种情况的处置完全不同（前者只能重新导入，后者把文件接回去就好）。
   *
   * 所以理由必须由 daemon 给：**只有它知道找过哪些位置**。
   * 字段缺失（老响应）时回落到那句通用文案 —— 与 `canRetranscribe` 同一条约定。
   */
  retranscribeBlocked?: RetranscribeBlocked | null;
}) {
  const { t } = useTranslation();
  const reason = useBlockedReason(canRetranscribe, retranscribeBlocked);
  if (!reason) return null;

  return (
    <div id={RETRANSCRIBE_BLOCKED_ID} data-testid="retranscribe-blocked">
      <Banner
        tone="warning"
        title={t('detail.retranscribe.blockedTitle')}
        detail={
          <>
            <span className="block">{reason.head}</span>
            {/* 找过的位置必须列出来：只说"读不到"时，用户无从判断到底是文件没了
                还是我们找错了地方 —— 列出来他照着就能自己确认一遍。 */}
            {reason.tried.length > 0 ? (
              <>
                <span className="mt-1 block">{t('detail.retranscribe.triedPaths')}</span>
                <ul className="list-inside list-disc break-all">
                  {reason.tried.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        }
      />
    </div>
  );
}

export function RetranscribeButton({
  noteUid,
  segments,
  currentLanguage,
  currentEngineId,
  currentModelId,
  canRetranscribe,
}: {
  noteUid: string;
  segments: readonly (Partial<TranscriptSegmentDto> & { edited?: boolean })[];
  currentLanguage: string | null;
  /**
   * `transcript.engineId` —— **这条笔记上次转写实际用的引擎**（`transcripts.engine_id`）。
   *
   * ⚠️ 强调"实际"：runner 落库的是 `chosen.engineId`，也就是选完之后真正跑的那个，
   * 不是上次请求里写的那个。所以它同时是**默认值**和**上一次的事后凭据** ——
   * 用户这次选了 paraformer、跑完回来这里却写着 whisper.cpp，
   * 就是 daemon 静默回落了（`pipeline/setup.ts` 的 `forced === undefined` 分支）。
   *
   * 类型是 `string` 而不是 `AsrEngineId`：库里那一列没有 CHECK 约束，
   * 夹具/老数据里出现过 `'fixture'` 这类值。收窄一律走 `toAsrEngineId()`。
   *
   * `NoteDetailPage` 已经在拉 `useTranscriptQuery(uid)`，**零额外请求**。
   */
  currentEngineId?: string | null;
  /**
   * `transcript.modelId` —— 上次实际用的模型**名字**。
   *
   * 🔴 **只用来显示，不要拿它去预选模型下拉**。它存的是权重文件名 / 目录名
   * （`ggml-base.en.bin`、`paraformer-zh-small`），而 `AsrModelPicker` 的 `value`
   * 是安装目录 id（`asr/whisper-base-q5_1`）—— **两个命名空间，不可比**。
   * 硬做模糊匹配就是给产品加一条没人测得到的猜测逻辑。
   */
  currentModelId?: string | null;
  /**
   * 来自 `NoteDetail.canRetranscribe`。
   *
   * ⚠️ **daemon 侧的判据已经换过（#95）**：它不再是"`input_url` 非空"，而是真的去
   * 解析一次（打不开就退回本笔记的归档原件，两档都落空才 `false`）。这里不需要跟着改
   * 逻辑，但要知道 `false` 的**原因不止一种**了。
   *
   * ⚠️ **理由本身不再由这个组件渲染**：它现在归 `<RetranscribeBlockedNotice/>`。
   * 这不是拆得更好看 —— 理由此前挂在本按钮的 `title` 上，而按钮基类带
   * `disabled:pointer-events-none`，那句话**鼠标、键盘、读屏三条路都到不了**。
   * 这里只保留 `aria-describedby`，把禁用状态指向那条真正读得到的横幅。
   *
   * `undefined` 要当成"可以"：老响应里没有这个键，
   * 把"字段缺失"读成"不能重跑"会把功能对所有旧数据藏起来。
   * 宁可点下去吃一个说人话的 409，也不要静默隐藏一个本来能用的入口。
   */
  canRetranscribe?: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  // 默认填**当前转写稿实际用的语言**，而不是 auto：
  // 用户来这里多半是因为语言判错了，让他看见"上次是按什么跑的"才好改
  const [language, setLanguage] = useState<string>(currentLanguage ?? ASR_LANGUAGE_AUTO);

  /*
   * ★ 两个查询都**只在面板展开时**才发（`enabled: open`）。
   *
   * hook 不能写在 `if` 里，所以只能用 `enabled` 关掉：这个组件挂在**每一条笔记的
   * 详情页头上**，无条件拉的话，用户只是打开一条笔记看看，就白白多两个请求
   * （`/health` + `/models/installed`，后者要列出全部已装模型）。
   *
   * ⚠️ `enabled:false` 时 `useAsrEngines()` 返回的是"三个引擎全部不可用"，
   * 与"真的一个都没装"**长得一模一样** —— 所以关着的时候一个字都不许渲染。
   * 下面所有基于 `engines` 的判断都在 `open` 为真的分支里。
   */
  const { engines, isLoading: enginesLoading } = useAsrEngines(open);
  const activeModel = useActiveAsrModel(open);

  // 不用 arr()：入参已声明为只读数组，这里只需防 undefined
  const editedCount = (segments ?? []).filter(isSegmentEdited).length;

  /*
   * ★ 只把**这台机器上真的能用**的引擎放进下拉。
   *
   * 🔴 这不是"顺手做个前端校验"，它是这条链路上**唯一**的校验：
   * daemon 收到一个不可用/不认识的 `engineId` 时不报错、不警告，直接静默回落到
   * 自动选择（`pipeline/setup.ts` 的 `forced === undefined` 分支），
   * 而那个 `reason` 谁都不读、不落库、不上 SSE。把校验交给后端 = 没有校验。
   */
  const selectable = engines.filter((e) => e.available);

  /*
   * ★ 默认值 = **这条笔记上次实际用的那个引擎**（前提是它现在还能用）。
   *
   * ⚠️ 为什么是"派生"而不是 `useState(currentEngineId ?? …)`：
   * `useState` 的初值**只在挂载那一帧取一次**。本组件由 `NoteDetailPage` 在
   * `note.data` 一到就渲染，而 `transcript` 与 `engines` 是**另外两个还在飞的请求** ——
   * 挂载那一帧它们基本都还是 `undefined`。用 `useState` 捕获的话，默认值会**永远**
   * 停在回落值，"默认=上次用的"整条就是个空转：而且在测试里（props 一开始就给全）
   * 它是**绿的**，只有真实环境里失效。所以这里让它随数据到达重算，
   * 用户一旦亲手选过（`enginePick !== null`）就以他的选择为准。
   *
   * ⚠️ **这个默认值有代价，说清楚**：它是"和上次一样，除了我改的那一项"，
   * 也就是说**语言不再间接决定引擎了**。改动之前把语言改成中文会让后端自动挑
   * Paraformer；现在默认把上次那个引擎钉住，除非用户自己选「自动」。
   * 取这一边是因为**可复现**优先：用户来这儿是因为上次结果不对，
   * 他要的是"只变我改的那一样"。而且引擎现在**明明白白显示在他眼前**，
   * 不是背着他决定的 —— 想回到旧行为，下拉第一项就是「自动」。
   */
  const lastEngine = toAsrEngineId(currentEngineId);
  const lastEngineState = lastEngine ? engines.find((e) => e.id === lastEngine) : undefined;
  const lastEngineUsable = lastEngineState?.available === true;
  const [enginePick, setEnginePick] = useState<AsrEngineId | typeof ENGINE_AUTO | null>(null);
  const engine = enginePick ?? (lastEngineUsable && lastEngine ? lastEngine : ENGINE_AUTO);

  /*
   * "上次用的那个引擎现在用不了了" —— 必须说出来。
   *
   * 不说的话，用户看到的是下拉**自己跳到了「自动」**，而上一次明明跑的是 Paraformer；
   * 与"这个下拉坏了"完全同形。`reason` 来自 daemon 实测（`GET /api/health` 的
   * `pipeline.engines[].reason`），不是我们编的文案。
   *
   * ⚠️ `enginesLoading` 时不下结论：还没拿到 health 就说"用不了"是纯误报。
   */
  const lastEngineGone = !enginesLoading && lastEngine !== null && !lastEngineUsable;

  const run = useMutation({
    mutationFn: () => {
      /*
       * ★ 请求体走**共享契约**的类型，不是随手拼一个对象字面量。
       *
       * 这不是洁癖：本仓刚为"类型系统替谎言背书"付过账（`ImportUrlRequest` 里那四个
       * 后端从不解析的键，UI 照着长出一排勾选框，勾了什么都不会发生）。
       * 反过来也一样 —— 请求体绕开契约去发一个契约里没有的键，
       * 契约文件就继续说"这个端点只收 language"的假话。所以先扩 `RetranscribeRequest`，
       * 再让这里指着它。`engineId` 因此还拿到一层编译期保护：**拼错的引擎 id 过不去**，
       * 而后端对拼错的 id 是静默回落的。
       */
      const body: RetranscribeRequest = {
        // 空语言不发 —— 后端会回落到 note.language，那是正确的默认
        ...(language ? { language } : {}),
        // 「自动」= 一个键都不发，与本次改动之前逐字节相同（后端按语言自己选）
        ...(engine === ENGINE_AUTO ? {} : { engineId: engine }),
      };
      return api<{ jobUid: string; noteUid: string }>('notes', `/notes/${noteUid}/retranscribe`, {
        method: 'POST',
        body,
      });
    },
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: qk.notes.detail(noteUid) });
      void qc.invalidateQueries({ queryKey: qk.transcript(noteUid) });
      void qc.invalidateQueries({ queryKey: qk.jobs.all });
    },
  });

  /**
   * 409 `NO_SOURCE_INPUT` 的兜底。
   *
   * 现在 `NoteDetail.canRetranscribe` 已经能**事前**禁用按钮，
   * 但这条分支要留着：`canRetranscribe` 是**打开页面那一刻**的快照，
   * 而源文件可能在此之后被删。事前判断与事后拒绝防的不是同一件事。
   */
  const noSource = run.error instanceof ApiError && run.error.code === 'NO_SOURCE_INPUT';

  /*
   * 禁用的控件必须自己解释为什么，否则用户只会以为坏了 —— 这条规矩本来就在。
   *
   * ⚠️ **那句解释不再放在 `title` 上**（v0.7.1 已知边界第 4 条）。
   * `Button` 基类带 `disabled:pointer-events-none`，而 `pointer-events: none` 的元素
   * **收不到 `mouseover`**，原生 tooltip 对鼠标用户也不会弹；`disabled` 又把它移出了
   * tab 序列。所以那个 `title` 在三种输入方式下**一个都到不了** —— 它看起来像解释，
   * 实际是装饰。留着它只会让下一个人以为这里已经解释过了。
   *
   * 真解释在 `<RetranscribeBlockedNotice/>`（由 `NoteDetailPage` 渲染在下方），
   * 这里只负责把禁用状态和那条横幅**关联起来**。
   */
  const blocked = canRetranscribe === false;

  return (
    <div className="relative">
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-1.5 text-xs"
        data-testid="retranscribe-open"
        disabled={blocked}
        aria-describedby={blocked ? RETRANSCRIBE_BLOCKED_ID : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <RefreshCw className="size-3.5" aria-hidden />
        {t('detail.retranscribe.open')}
      </Button>

      {open ? (
        <div
          className="absolute top-full right-0 z-20 mt-1 w-80 space-y-3 rounded-lg border border-line bg-surface-1 p-3 shadow-lg"
          data-testid="retranscribe-panel"
        >
          <p className="text-xs text-ink-secondary">
            {currentLanguage
              ? t('detail.retranscribe.currentLang', { lang: currentLanguage })
              : t('detail.retranscribe.currentLangUnknown')}
          </p>

          {/*
            ★★ **上一次这条笔记实际用了什么** —— 只读，三行并列。

            ## 它是本功能的判据本身，不是装饰

            #99 ① 的验收线是「用户改完引擎点下去之后，能**确认**这一次真的用了他选的
            那个」。SSE 给不了这个答案：`TranscribeStartedEvent` 只有 `modelId`，
            **没有 `engineId`**。所以凭据只能是这里 —— `transcript.engineId` 读的是
            `transcripts.engine_id`，而 runner 往那一列写的是 `chosen.engineId`，
            **实际选中的引擎**。跑完之后 `transcribe.done` 失效 `qk.transcript`
            （`features/notes/sse.ts`），这一行自动刷新成真实结果。
            选了 paraformer、回来这里写着 Whisper.cpp = daemon 静默回落了。

            ## 模型为什么只读、不给下拉

            上次用的模型（`transcripts.model_id`）是权重**文件名**，
            全局激活的模型（`/models/installed` 的 `active.asr`）是安装**目录 id** ——
            两个命名空间，不可比。所以这里**并列摆着让用户自己看**，不替他猜。
            **它不可能指错；一个会指错的默认值比没有默认值坏得多** ——
            用户会以为自己换了模型，而实际重跑的是同一个。

            要真的换模型，走下面 `AsrModelPicker` 那条**全局**路（它自己会说明
            "对之后所有转写生效"）；`f0b0ad3` 之后 runner 是**起任务时现读
            `active.json`** 的，所以"在这儿换掉全局模型 → 立刻提交"跑的就是新的。
          */}
          <div className="space-y-0.5 text-xs text-ink-muted" data-testid="retranscribe-last-run">
            <p>
              {t('detail.retranscribe.lastEngine', {
                engine: lastEngine
                  ? ASR_ENGINE_LABELS[lastEngine]
                  : t('detail.retranscribe.unrecorded'),
              })}
            </p>
            <p>
              {t('detail.retranscribe.lastModel', {
                model: currentModelId ?? t('detail.retranscribe.unrecorded'),
              })}
            </p>
            <p>
              {t('detail.retranscribe.activeModel', {
                model: activeModel.displayName ?? activeModel.id ?? t('asr.notSelected'),
              })}
            </p>
          </div>

          {/*
            ★ 引擎 —— **只影响这一次重跑**（后端的 per-job `engineId`）。

            与紧接着下面那个模型下拉（全局激活）作用域**不同**，所以两边各自把自己的
            作用域写在旁边。少任何一句，用户都会以为两个是同一种。

            候选只有 `available` 的：daemon 对不可用/不认识的 id 是静默回落，
            列出来就是让用户选一个"选了也不算数"的选项。
          */}
          <label className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex items-center gap-1 text-xs text-ink-secondary">
              <Cpu className="size-3.5" aria-hidden />
              {t('detail.retranscribe.engineLabel')}
            </span>
            <select
              value={engine}
              onChange={(e) => setEnginePick(e.target.value as AsrEngineId | typeof ENGINE_AUTO)}
              aria-label={t('detail.retranscribe.engineLabel')}
              data-testid="retranscribe-engine-select"
              className="h-8 rounded-md border border-line bg-surface-0 px-2 text-sm text-ink"
            >
              <option value={ENGINE_AUTO}>{t('detail.retranscribe.engineAuto')}</option>
              {selectable.map((e) => (
                <option key={e.id} value={e.id}>
                  {ASR_ENGINE_LABELS[e.id]}
                </option>
              ))}
            </select>
            <span className="text-xs text-ink-muted">
              {t('detail.retranscribe.engineThisRunOnly')}
            </span>
          </label>

          {/*
            上次用的引擎现在装不了/没配好时，下拉会**自己回到「自动」** ——
            不解释的话，那与"下拉坏了"完全同形。reason 是 daemon 给的实测原因。
          */}
          {lastEngineGone && lastEngine ? (
            <p className="text-xs text-warning" data-testid="retranscribe-engine-unavailable">
              {t('detail.retranscribe.lastEngineUnavailable', {
                engine: ASR_ENGINE_LABELS[lastEngine],
              })}
              {lastEngineState?.reason ? `（${lastEngineState.reason}）` : ''}
            </p>
          ) : null}

          <TranscribeOptions
            language={language}
            onLanguageChange={setLanguage}
            /* 强制了引擎，后端就不看语言前缀了 —— 那条"自动识别下不会启用 Paraformer"
               的提示必须闭掉，否则它会当场否认用户刚选的那个引擎 */
            engineForced={engine !== ENGINE_AUTO}
          />

          {/*
            ★ 换回「已保留」—— 这句话现在是**真的**了。
            `oss-scout` 把 `mergeWithTranscriptId` 接上（并加了 `!== transcript.id` 守卫
            防止复用同一份稿时自己跟自己合并），实测连跑两次 `editedAt` 都还在。

            为什么强调"连跑两次"：修完之后测一次是会通过的 —— 文本还在，看起来已经好了。
            但 `editedAt` 若没跟着保留，**第二次重跑就会把它当没编辑过覆盖掉**。
            「测一次通过、测两次才暴露」正是这个项目反复栽跟头的那一类，
            所以这里的判据用 `editedAt` 而不是"文本看起来没变"。
          */}
          {editedCount > 0 ? (
            <Banner
              tone="info"
              title={t('detail.retranscribe.editsPreserved', { count: editedCount })}
              detail={
                <>
                  {/* 合并按**时间轴**对齐而非段落序号：两遍模型的断句天然不同，
                      按序号会把别人的句子塞进用户改过的地方。
                      因此"编辑过但没有对应新结果"是正常情况，必须能表达出来，
                      而不是让用户以为自己的修改被吞了。 */}
                  <span className="block">{t('recorder.mergeByTimeNote')}</span>
                </>
              }
            />
          ) : null}

          {noSource ? (
            <p className="text-xs text-warning" data-testid="retranscribe-no-source">
              {t('detail.retranscribe.noSource')}
            </p>
          ) : run.isError ? (
            <ErrorBlock error={run.error} />
          ) : null}

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t('capture.cancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={run.isPending}
              data-testid="retranscribe-submit"
              onClick={() => run.mutate()}
            >
              {run.isPending ? t('detail.retranscribe.starting') : t('detail.retranscribe.confirm')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
