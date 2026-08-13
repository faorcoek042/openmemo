import { useTranslation } from 'react-i18next';
import { Download, Lock, Play, Trash2 } from 'lucide-react';
import type {
  Backend,
  BackendSelfTest,
  DownloadJob,
  Engine,
  GetBackendCatalogResponse,
} from '@openmemo/shared';
/*
 * 复用模型页那一份 —— 它刚从四份收敛成一份（`d145aa8`），
 * 后端包与模型下载走的是同一个 `DownloadQueue` / 同一份 `DownloadJob`。
 * 再写一份就是第五份，而四份各自漂正是上一次要修的病。
 */
import { DownloadRow } from '../../../components/common/DownloadRow';
import { Button } from '../../../components/common/Button';
import { StatusChip } from '../../../components/common/StatusChip';
import { Emphasis, stripEmphasis } from '../../../components/common/Emphasis';
import { BackendChip, type BackendChipState } from '../../../components/common/BackendChip';
import { formatBytes } from '../../../lib/format/bytes';
import { localizedName } from '../../../lib/format/localized';
import {
  BACKEND_IS_COMPUTE_AXIS,
  isLoadBearingPack,
  packStatus,
  selfTestVerdict,
  STATUS_NEEDS_EXPLANATION,
  type PackStatus,
} from '../packStatus';
import { inapplicabilityText } from '../reasonKeys';

type Pack = GetBackendCatalogResponse['packs'][number];

/**
 * 状态 → 芯片档。**一一对应，不做合并** —— 合并回去就是把 T-165 拆开的那三档又粘上。
 * `unavailable-unknown` 落回 `not-installed`（"不可用"），因为那时我们确实只知道这么多。
 */
const CHIP_STATE: Record<PackStatus, BackendChipState> = {
  active: 'active',
  installed: 'installed',
  'self-test-failed': 'failed',
  installable: 'available',
  /*
   * ★ T-196：落回 `not-installed`（文案「未安装」）而**不是** `available`（「可安装」）。
   * 「未安装」是真的，而且与按钮那句「尚未发布，暂不可安装」不矛盾 —— 这正是要修的东西。
   * ⚠️ 刻意**不新加一档芯片文案**：那需要往 `runtime.chip.*` 加两条 i18n，
   * 而两份 locale 文件此刻正被别的 agent 改着。等那边落地后可以再给它一档专属文案，
   * **但那是锦上添花；现在这一步已经把"两句话打架"消掉了。**
   */
  'not-published': 'not-installed',
  'other-platform': 'other-platform',
  undetermined: 'undetermined',
  unsupported: 'unsupported',
  'unavailable-unknown': 'not-installed',
};

/**
 * 一个加速后端包（章程要求 2.1 的"下载对应预编译二进制 → 安装 → 自检 → 显示状态"）。
 *
 * ★ **L1 内置 CPU 包不可删除**（ADR-003 附录 A.3）：ggml 在没有任何可用后端时会 SIGABRT，
 * CPU 包是承重墙。这里从 UI 上就禁用删除并说明原因，而不是等用户删完崩溃再解释。
 */

export interface BackendPackCardProps {
  pack: Pack;
  locale: string;
  isActive: boolean;
  selfTest: BackendSelfTest | null;
  installing: boolean;
  /**
   * 这张卡上「推荐」到底承不承载信息（T-165 / `progress-audit §4⑩`）。
   *
   * **必须由外面传进来**：判据是"同一引擎下本机还有没有别的后端可选"，
   * 那要看整份目录，一张卡自己看不出来。
   * 不传时按 `pack.recommended` 原样处理 —— 也就是回到缺陷行为，
   * 所以调用方只有 `RuntimePage` 一处，并且有用例钉住它真的算了这一步。
   */
  recommended?: boolean;
  onInstall: (id: string) => void;
  onRemove: (id: string) => void;
  /**
   * 选中某个**算力后端**。
   *
   * ⚠️ T-192：参数从 `pack` 换成了 `backend`。原来传 pack、由调用方去取
   * `pack.backend`，正是"把这个包和这个包的算力后端混为一谈"那个 bug 的载体
   * —— 「改用 CPU」那个按钮传的是自己那张卡，于是它切到的是刚刚失败的那个后端。
   * 现在类型上就只能传"要选哪个"。
   */
  onSelect: (backend: Backend) => void;
  onSelfTest: (id: string) => void;
  /**
   * 这个包**当前正在进行的下载任务**（没有就是 null）。
   *
   * ★ T-195：此前这张卡只有一个 `installing` 布尔 —— 按下去按钮变灰，
   * 然后除了等什么都没有。而数据一直是齐的（`DownloadQueue` 与模型下载共用一条通道，
   * `job.progress` / `speedBps` / 阶段都在），**缺的只是这一侧没接**。
   * 一个 678 MB 的 CUDA 包尤其明显：用户只能猜它是不是卡住了。
   *
   * ⚠️ 可选：老调用方不传就什么都不渲染，与既有行为一字不差。
   */
  job?: DownloadJob | null;
  onCancelJob?: (jobId: string) => void;
  onRetryJob?: (jobId: string) => void;
}

/**
 * 这个引擎的包，「运行自检」对它**有没有意义**。
 *
 * ## 为什么是一张穷尽表，而不是 `engine === 'whisper.cpp'`
 *
 * 自检的定义是「跑一次真实推理」（ADR-003 决策 3）。对一个 SQLite 分词扩展
 * 或一个下载器来说，这件事**在范畴上就不适用** —— 不是"暂时缺前提"。
 *
 * `[用户实测 2026-08-09]` 他点了 `libsimple-linux-x64`（`engine: sqlite-ext`）卡片上的
 * 「运行自检」，得到「自检无法运行，缺少 whisper-cli」，然后合理地怀疑
 * 「是不是配置改错了导致找不到 whisper」。**什么都没坏** ——
 * whisper 在盘上、指着它跑 `passed:true`。**坏的是这张卡片上不该有这个按钮。**
 *
 * 写成 `Record<Engine, …>` 而不是等值比较：清单里今天有 4 种 engine
 * （`[实测数过]` sqlite-ext 11 / whisper.cpp 7 / yt-dlp 4 / ffmpeg 3），
 * 而 **schema 允许 6 种**（多 `llama.cpp` / `sherpa-onnx`，今天没有包用）。
 * 穷尽表让"新加一种 engine"**在编译期就必须表态**，
 * 而不是默默继承一个"whisper 才行"的隐含假设。
 */
const SELF_TEST_APPLIES: Record<Engine, boolean> = {
  /** 自检本身就是跑一次 whisper 推理。 */
  'whisper.cpp': true,
  /** LLM 引擎：今天的自检只会跑 ASR 推理，对它没有可执行的检查。 */
  'llama.cpp': false,
  /** ASR 引擎，但自检链只认 whisper-cli；等它真被支持时再翻成 true。 */
  'sherpa-onnx': false,
  /** 转码器 —— 不是推理引擎。 */
  ffmpeg: false,
  /** 下载器 —— 不是推理引擎。 */
  'yt-dlp': false,
  /** SQLite 分词扩展 —— 不是推理引擎。用户撞到的就是这一格。 */
  'sqlite-ext': false,
};

export function BackendPackCard({
  pack,
  locale,
  isActive,
  selfTest,
  installing,
  recommended,
  onInstall,
  onRemove,
  onSelect,
  onSelfTest,
  job = null,
  onCancelJob,
  onRetryJob,
}: BackendPackCardProps) {
  const { t } = useTranslation();
  /*
   * 承重墙：**推理引擎的 CPU 兜底**不允许卸载（ADR-003 附录 A.3 的 ggml SIGABRT）。
   * T-192：此前写的是 `tier==='builtin' || backend==='cpu'`，而目录里 25 个包
   * 没有一个是 `builtin`，于是只有后半句在起作用 —— 18 个非推理包（sqlite-ext /
   * yt-dlp / ffmpeg，它们的 `backend` 也都是 `'cpu'`）跟着被锁死，**永远删不掉**，
   * 而 daemon 照删不误。判据现在对准真实约束，见 `isLoadBearingPack()`。
   */
  const isLoadBearing = isLoadBearingPack(pack);
  /**
   * 「这个包为什么装不了」那一行的文字 —— **在这一侧组装**（#106）。
   *
   * daemon 现在只交出 `Inapplicability`（机器可读 + 结构化参数），措辞在
   * `../reasonKeys` 那张总表 + 两份 locale 里。上一版这里读的是
   * `pack.inapplicableReason`：daemon 拼好的一整句中文，英文界面上原样渲染。
   *
   * `null` 时**一个字都不说** —— 不替 daemon 编一句"不支持"，
   * 判据与 `inapplicableKind` / `updateAvailable` 缺失时同源。
   */
  const inapplicableText = pack.inapplicability
    ? inapplicabilityText(t, pack.inapplicability)
    : null;
  /**
   * ★★ **随应用出厂的那一档卸不掉** —— 与承重墙是两条轴，不许合并。
   *
   * 承重墙说的是「删了推理进程会 SIGABRT」；这一条说的是
   * **「这些字节根本不在你的数据目录里」**：它们在**程序自己的安装目录**
   * （`runtime/probe/ffmpeg` 那一族），删掉等于删掉产品自身的一部分，
   * 真机上 ~230 MB，只能重装应用才拿得回来。理由不同 ⇒ 说给用户的话也不同。
   *
   * daemon 那侧已经故障关闭（409 `BUNDLED_NOT_REMOVABLE`）。这里做的是另一半：
   * **别让用户点了才知道**。与 `pendingCi` / `other-platform` 同一条判据 ——
   * 一颗点了必然失败的按钮，要在按下之前就说清楚。
   *
   * ⚠️ `=== true`：字段**可选**，老 daemon 不发。缺失是"我不知道"，
   * 不许当成"可以卸载"，也不许当成"不能卸载"——保持老样子，由服务端兜底。
   */
  const bundledWithApp = pack.bundledWithApp === true;
  /** 「设为当前后端」只对**算力轴上**的包有意义 —— 见 `BACKEND_IS_COMPUTE_AXIS`。 */
  const onComputeAxis = BACKEND_IS_COMPUTE_AXIS[pack.engine];
  /**
   * 已构建、摘要已核实，但**还没有发布地址**（仓库无 git remote，CI 从未跑过）。
   * 必须在按钮上就说清楚，而不是让用户点下去等一个必然失败的下载 ——
   * 失败要在看得见的地方发生，不要推迟到点击之后。
   */
  const selfTestFailed = selfTest != null && !selfTest.passed;
  const showRecommended = recommended ?? pack.recommended;
  const verdict = selfTestVerdict(pack.backend, selfTest);
  const status = packStatus({
    installed: pack.installed,
    applicable: pack.applicable,
    inapplicableKind: pack.inapplicableKind,
    isActive,
    selfTestFailed,
    availability: (pack as { availability?: string }).availability,
  });
  /**
   * ★ T-196：**从 `status` 读，不再自己判一次。**
   *
   * 这一行以前是 `const pendingCi = pack.availability === 'pending-ci'`，
   * 而顶上的芯片走 `packStatus()`（它当时根本不看这个字段）——
   * 于是芯片写「可安装」、按钮写「尚未发布，暂不可安装」，**同一张卡两句话打架**。
   * 一个事实两处判断，两处就一定会漂移；现在只剩一处。
   */
  const pendingCi = status === 'not-published';

  const actions = pack.installed ? (
    <>
      {/*
        ★★ T-191：**「更新」—— 已安装分支此前没有任何"再装一次"的出口。**

        `[用户真机实测 2026-08-09，:10000]` 他看到的是一条死路：
          · 自检说「安装后端包后会带上 openmemo-probe」；
          · 这张卡片说它**已安装**，而已安装分支只有 设为活动 / 自测 / 卸载；
          · 卸载又 `disabled={isLoadBearing}`，而 `isLoadBearing` 对 `backend==='cpu'`
            恒真 —— 也就是说**这个包他既不能更新也不能卸**。
        产品在教他做一件他在界面上根本做不到的事。

        成因不在这张卡片：目录里 `whispercpp-cpu-linux-x64` 在 T-167 换成了带探针的
        自建包，而他 08-02 装的是当时那份上游归档（**不含探针**），
        `installed` 按 **id** 算 ⇒ 恒为 true ⇒ 没有任何地方说他手里那份是旧的。

        daemon 现在把这件事发出来了（`updateAvailable`，T-191 ② 新开的一个轴：
        它按**内容**算，与 `installed` 正交，也与上面 `CHIP_STATE` 那一轴正交 ——
        芯片说"这个包处于什么状态"，这里说"该做什么"，两件事不共用槽位）。
        这里只做一件事：**让它变成一个真能点、点了那个报错真的会消失的按钮。**

        ⚠️ 字段**可选**，缺失时（老 daemon）什么都不渲染 —— 不替它说
        "你装的就是最新版"，那是它没说过的话。判据与 `inapplicableKind` 同源。
      */}
      {pack.updateAvailable === true ? (
        <Button
          size="sm"
          variant="primary"
          disabled={installing}
          title={t('runtime.pack.updateTitle')}
          onClick={() => onInstall(pack.id)}
          data-testid={`backend-update-${pack.id}`}
        >
          <Download className="size-3.5" aria-hidden />
          {installing ? t('runtime.pack.installing') : t('runtime.pack.update')}
        </Button>
      ) : null}
      {/*
        ★★ T-192 ①：**非算力轴的包不渲染这个按钮**，而不是渲染完再让它做错事。

        `[实测]` 它调 `select(pack.backend)` → 落盘 `selectedBackend`。在 libsimple /
        yt-dlp / ffmpeg 卡上按下去，不是"启用 libsimple"，是**把 whisper 的算力后端
        改成 cpu**，并让 `/models` 的显存预算归零（`shared/fitness.ts:182`）——
        **而且不作声**。可达性正好互补：这 18 个包的 backend 都是 cpu，
        所以它恰恰只在用户选了 cuda/vulkan/metal 时才出现。
      */}
      {onComputeAxis && !isActive ? (
        <Button size="sm" variant="secondary" onClick={() => onSelect(pack.backend)}>
          {t('runtime.pack.setActive')}
        </Button>
      ) : null}
      {/*
        ★ 非推理包**不渲染**这个按钮，而不是渲染完再 blocked。
          判据与上一轮那条一致：一个点了必然失败的按钮就该不存在。
      */}
      {SELF_TEST_APPLIES[pack.engine] ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onSelfTest(pack.id)}
          data-testid={`backend-selftest-${pack.id}`}
        >
          <Play className="size-3.5" aria-hidden />
          {t('runtime.pack.selfTest')}
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        disabled={isLoadBearing || bundledWithApp}
        /*
         * ★ #105 ④ 那条判据在这里同样成立：**灰掉的按钮也得说得出自己为什么灰。**
         * `title` 在 disabled 元素上仍然提供可访问名（tooltip 因 `pointer-events:none`
         * 弹不出来，但读屏拿得到），所以这是兜底而不是装饰。
         * 承重墙优先：它更严重（点了会崩），而两者同时成立时只能说一句话。
         */
        title={
          isLoadBearing
            ? t('runtime.pack.loadBearingTitle')
            : bundledWithApp
              ? t('runtime.pack.bundledTitle')
              : undefined
        }
        onClick={() => onRemove(pack.id)}
        data-testid={`backend-remove-${pack.id}`}
      >
        <Trash2 className="size-3.5" aria-hidden />
        {t('runtime.pack.uninstall')}
      </Button>
    </>
  ) : status === 'other-platform' ? (
    /*
     * ★★ #105 ④：**这一档一颗按钮都不渲染。**
     *
     * `[闸门实测 2026-08-12，真浏览器]` 折叠区那 20 颗按钮逐颗量出来是：
     * `innerText` 空（里面只有一个 `<svg>`）、`title === null`、`aria-label === null`、
     * `disabled`、`pointer-events: none` —— **鼠标、键盘、读屏三条路都拿不到它是什么。**
     * 一个既说不出自己是谁、又永远点不动的控件，唯一的作用是占位和制造疑惑。
     *
     * 而 D-21 §6 对这一档写得很死：
     *   | 本平台不适用 | 什么都不用做，也没有任何东西可装 | **不该引导安装。不许报体积** |
     * 它当时的行文却是「安装 5.3 MB」「安装 678 MB」——**两条都违反**：
     * 「安装」是引导，「678 MB」是体积。（唯一的缓解是按钮确实 disabled、整段默认折叠。）
     *
     * 所以给的是一句**说得出话的正文**，不是一颗说不出话的按钮：
     * 「适用于 darwin/arm64，与本机不符 —— 装不了，你也不需要做任何事。」
     * 它同时答了本轮的总判据：用户读完知道下一步是什么（**什么都不用做**），
     * 而且那句"什么都不用做"是**明说出来的**，不是靠"没有按钮"去暗示。
     *
     * ⚠️ 措辞从 `pack.os` / `pack.arch` **两个结构字段**拼。
     * #105 当时的理由是「不复用 daemon 那句 `inapplicableReason`，它在英文界面上是中文」；
     * #106 之后 daemon 那一格已经不是中文了（`Inapplicability.platform_mismatch`
     * 只交 os/arch 两个字段），**这一行照旧从结构字段拼**：它想说的话
     * （「装不了，你也不需要做任何事」）比那一档的通用措辞更具体。
     */
    <p
      className="max-w-[16rem] text-right text-[11px] text-ink-muted"
      data-testid={`backend-other-platform-${pack.id}`}
    >
      {t('runtime.pack.otherPlatformNote', { os: pack.os, arch: pack.arch })}
    </p>
  ) : (
    <Button
      size="sm"
      variant={showRecommended ? 'primary' : 'secondary'}
      disabled={installing || !pack.applicable || pendingCi}
      /*
       * ★ #105 ④：**灰掉的按钮也得说得出自己是什么。**
       * 这里原来只有 `pendingCi` 那一档给 `title`，其余禁用档一律 `undefined` ——
       * 而按钮的可见文字在 `disabled` + 默认折叠的 `<details>` 里，读屏与
       * `innerText` 都拿不到。`title` 在 disabled 元素上仍然提供可访问名
       * （tooltip 因 `pointer-events:none` 弹不出来，但 AT 读得到），所以这一格是
       * **兜底，不是装饰**。落点仍然是 daemon 的原话优先、档位文案兜底。
       */
      title={
        pendingCi
          ? t('runtime.pack.pendingCiTitle')
          : !pack.applicable
            ? /*
               * ⚠️ `stripEmphasis`：`title` 是**纯文本**属性，`<Emphasis>` 在这里用不上。
               * `inapplicabilityText()` 的 `backend_unavailable` 那一档转给了
               * `runtime.hw.reason*`，而那七条里有六条带 `**…**`（硬件卡是走
               * `<Emphasis>` 渲染的）—— 原样塞进 `title` 会让读屏念出裸星号。
               */
              stripEmphasis(inapplicableText ?? '') ||
              t(`runtime.kind.${status}`, { defaultValue: '' })
            : undefined
      }
      onClick={() => onInstall(pack.id)}
      data-testid={`backend-install-${pack.id}`}
    >
      <Download className="size-3.5" aria-hidden />
      {pendingCi
        ? t('runtime.pack.pendingCi')
        : installing
          ? t('runtime.pack.installing')
          : t('runtime.pack.install', { size: formatBytes(pack.totalSizeBytes, locale) })}
    </Button>
  );

  return (
    <article
      className="rounded-lg border border-line bg-surface-1 p-3.5"
      data-testid={`backend-pack-${pack.id}`}
    >
      {/*
        ★ 动作按钮从"卡片底部自成一行"挪到了标题行右侧。

        原来的结构是：标题行（右半边完全空着）→ 元信息 → **一整行只放一个按钮**。
        实测每张卡因此多出约 40px 纯空白，而这一页要渲染 14 张卡 ——
        光这一处就在页面上白白撑开约 560px。卡片本身没有更多信息要放，
        右上角却空着，这是典型的"布局没用上，高度却付了钱"。

        自检结果块仍然留在下面独占区域：它是**多行的诊断信息**，
        塞进标题行会把行高撑乱，而且它出现的频率远低于按钮。
      */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <BackendChip backend={pack.backend} state={CHIP_STATE[status]} />
            <h3 className="text-sm font-medium text-ink">{localizedName(locale, pack)}</h3>
            {showRecommended ? (
              <StatusChip tone="good" label={t('runtime.pack.recommended')} />
            ) : null}
            {isLoadBearing ? (
              <StatusChip
                tone="neutral"
                label={t('runtime.pack.loadBearing')}
                icon={<Lock className="size-3.5" />}
              />
            ) : null}
          </div>
          {/*
            ★★ T-193 ③：**这一行说的必须是"机器上那一份"，不是"目录说的那一份"。**

            `[用户真机实测 2026-08-09，:10000]` 更新之前这里写着
            `已安装 · ffmpeg n8.1.2-… · 112 MB`，**而机器上跑的是 n7.1.5** ——
            目录在 T-167/T-191 被换了新版，而这一行渲染的一直是 `pack.engineVersion`
            （目录的）。「已安装」+ 一个它并不拥有的版本号，连起来读就是一句假话；
            唯一的提示只有旁边多出来的那个「更新」按钮，可那要求用户先想到
            "这个版本号说的不是我这台"——屏幕上没有任何东西这么说过。

            与 `updateAvailable` 是同一个根的两半：那个回答"要不要动"，
            这里回答"**我现在手里是哪一份**"。少了后者，前者是一条没有主语的建议。

            三档，各说各的真话：
              · 没装        → 目录的版本与体积（那正是你点下去会拿到的东西）
              · 装了且是最新 → 机器上那一份（与目录同值，读起来无差别）
              · 装了但有更新 → **两个都说**：你手里的 + 目录里的
            `installedEngineVersion` 缺失（老 daemon）时退回老行为，
            **不替它说"你装的就是最新版"** —— 与 `updateAvailable` 同一条判据。
          */}
          <p className="mt-1 text-xs text-ink-secondary" data-testid={`backend-version-${pack.id}`}>
            {pack.engine}{' '}
            {pack.installed && pack.installedEngineVersion != null
              ? pack.installedEngineVersion
              : pack.engineVersion}{' '}
            · {pack.os}/{pack.arch}
            {/*
              ★ #105 ④：**「本平台不适用」这一档不报体积。**
              D-21 §6 那一行写得很死（「不该引导安装。**不许报体积**」），
              而这里此前是无条件渲染的 —— 于是即使按钮已经拿掉，
              一个永远装不上的包仍然在报「678 MB」。一个数字**本身**就是一句邀请：
              读到它的人会去找那颗按钮，而这一档根本没有下一步。
              `os/arch` 留着，那是这一档**唯一**有信息量的东西（它说明这包是给谁的）。
            */}
            {status === 'other-platform'
              ? null
              : ` · ${formatBytes(
                  pack.installed && pack.installedSizeBytes != null
                    ? pack.installedSizeBytes
                    : pack.totalSizeBytes,
                  locale,
                )}`}
            {pack.installed &&
            pack.updateAvailable === true &&
            pack.installedEngineVersion != null ? (
              <span className="text-warning" data-testid={`backend-catalog-version-${pack.id}`}>
                {' · '}
                {t('runtime.pack.catalogHas', {
                  version: pack.engineVersion,
                  size: formatBytes(pack.totalSizeBytes, locale),
                })}
              </span>
            ) : null}
          </p>
          {/*
            ★ T-165：先说**这是哪一档**，再照抄 daemon 给的原因。

            两句话是分工的，不是重复：
              · 档位（"还没探测到" vs "本机不支持"）回答的是**"我要不要放弃"**；
              · `inapplicableReason` 是 daemon 的原话，回答的是**"具体卡在哪"**。
            此前只渲染后者，而后者不含档位信息 —— 于是"还没测出来"和"确认没有这块卡"
            在屏幕上长得一模一样，用户只能按最坏的那个理解。
          */}
          {STATUS_NEEDS_EXPLANATION.includes(status) ? (
            <p className="mt-1 text-xs text-ink-secondary" data-testid={`backend-kind-${status}`}>
              {t(`runtime.kind.${status}`)}
            </p>
          ) : null}
          {/*
            ⚠️ #105 ④：`other-platform` 这一档**不再渲染 daemon 那句原话**。
            同一句事实已经由右侧 `otherPlatformNote` 从 `pack.os` / `pack.arch` 说了，
            两份语言都有，而这一档它是**唯一**的正文。

            ★★ #106：其余档位原来是**原样透传 daemon 那句中文**
            （`applicability.ts` 里的「尚未探测到硬件能力 —— …」「该后端在本机不可用」），
            于是英文界面上「具体卡在哪」这一整行是中文。当时那段注释写的是
            「那些是技术原话，不是我们能替它翻译的东西」—— **只有一半成立**：
            探针路径、驱动版本确实是原话，但外面包着的那句解释是我们自己写的。
            现在两者分开了：`Inapplicability` 说是哪一种成因（措辞在 `../reasonKeys`
            那张总表 + 两份 locale），daemon 那句英文原话作为 `detail` 跟着走，
            并被明确标成「探针原话，未翻译」。
          */}
          {!pack.applicable && status !== 'other-platform' && inapplicableText ? (
            /*
              ⚠️ 必须走 `<Emphasis>`：这段文字有一档（`backend_unavailable`）转给了
              `runtime.hw.reason*`，那六条词条带 `**…**`。原样 `{text}` 渲染的话，
              两种语言下用户都会看到裸星号 —— T-129b 立的正是这条。
            */
            <p className="mt-1 text-xs text-ink-muted">
              <Emphasis text={inapplicableText} />
            </p>
          ) : null}
          {/*
            ★★ T-197：**这一格是「安装 119 MB」那句话唯一的解药。**

            `[用户真机实测，:10000]` 同一时刻 `/api/selfcheck` 的 `tool.ffmpeg` 是绿的、
            流水线正拿它转码，而这张卡写着「安装 119 MB」。成因不在这张卡：盘上那份是
            **7.1.5**、目录已升到 **8.1.2**，**归档文件名都不同** —— 对账按目录声明的
            名字去 stat 连痕迹都找不到，于是它既不在 `installed` 里、也不在 skipped 里。
            屏幕上没有任何东西说过"你已经有一份了"。

            daemon 现在把这件事发出来了（`installedOnDiskButUnrecorded`），
            证据是**解析器当下解析到的那个路径**，不是我们的推断。这里只负责说出来。

            ⚠️ 与 `installed` **不共用槽位**：`installed` 仍然只回答"有没有安装记录"，
            按钮也照旧可点 —— 装一次是有意义的（拿到目录这一版并让它被记录接管）。
            这里改的只有一件事：**用户点之前知道自己已经有一份在跑。**

            ⚠️ 字段可选，缺失（老 daemon / 解析器失败）时**一个字不说** ——
            不替它说"你别处没有副本"，那是它没说过的话。判据与 `updateAvailable`、
            `inapplicableKind` 同源。
          */}
          {!pack.installed && pack.installedOnDiskButUnrecorded ? (
            <p
              className="mt-1 text-xs text-warning"
              data-testid={`backend-unrecorded-${pack.id}`}
              title={pack.installedOnDiskButUnrecorded.path}
            >
              {t('runtime.pack.servedFromUnrecorded', {
                file: pack.installedOnDiskButUnrecorded.file,
                path: pack.installedOnDiskButUnrecorded.path,
              })}
            </p>
          ) : null}
          {/*
            ★ #87 / 轴1③：**系统里已经有一份**（借宿主 PATH 的那一档）。

            解析器（A 侧）有三档 `pack | bundle | path`，`path` 那一档是活的：
            用户按 v0.7.0 发布说明自己 `brew install ffmpeg` 之后，流水线**真的在用**
            `/usr/bin/ffmpeg`，`ReadinessBanner` 读的 `pipeline.missing` 因此是空的、
            不报警。而这张卡读的是 B 侧（安装记录），于是写着「可安装 · 145 MB」——
            **请用户把已经有的东西再下一遍。**

            ⚠️ 与 `installedOnDiskButUnrecorded` **不是同一件事**，所以不共用这一格：
            那一格说的是"**我们自己 store 里**有一份没登记的"，这一格说的是
            "**那根本不是我们的东西**"。系统 ffmpeg 我们没装、也无权删。

            ⚠️ 按钮照旧可点、`installed` 一个字没动：装一次仍然有意义
            （拿到产品自己那一份，不再依赖宿主上那个不受控的版本）。
            这里改的只有一件事：**用户点之前知道自己已经有一份能用的。**

            ⚠️ 字段可选，缺失（老 daemon / 解析器失败）时**一个字不说** ——
            「我问不出来」不等于「系统里没有」。
          */}
          {!pack.installed && pack.servedFromSystemPath ? (
            <p
              className="mt-1 text-xs text-ink-secondary"
              data-testid={`backend-system-path-${pack.id}`}
              title={pack.servedFromSystemPath.path}
            >
              {t('runtime.pack.servedFromSystemPath', {
                file: pack.servedFromSystemPath.file,
                path: pack.servedFromSystemPath.path,
              })}
            </p>
          ) : null}
          {pack.requiresDriver ? (
            <p className="mt-1 text-[11px] text-ink-muted">
              {t('runtime.pack.requiresDriver')}
              {[
                pack.requiresDriver.nvidiaDriver && `NVIDIA ${pack.requiresDriver.nvidiaDriver}+`,
                pack.requiresDriver.vulkanApi && `Vulkan ${pack.requiresDriver.vulkanApi}+`,
                pack.requiresDriver.rocmVersion && `ROCm ${pack.requiresDriver.rocmVersion}+`,
                pack.requiresDriver.macosVersion && `macOS ${pack.requiresDriver.macosVersion}+`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{actions}</div>
      </div>

      {/*
        ★★ T-195：正在下载时给出**真的进度**，而不是一个变灰的按钮。

        复用模型页那一份 `DownloadRow`（百分比 / 速度 / 阶段 / ETA / 取消 / 重试
        全都在里面，且进度只从 transient store 读，不会因为别的任务刷新而重渲染）。
        `onCancelJob` / `onRetryJob` 没传时退化成 no-op —— 老调用方行为不变。
      */}
      {job ? (
        <div className="mt-2" data-testid={`backend-progress-${pack.id}`}>
          <DownloadRow
            job={job}
            locale={locale}
            onCancel={(id) => onCancelJob?.(id)}
            onRetry={(id) => onRetryJob?.(id)}
          />
        </div>
      ) : null}

      {/* 自检结果 —— 失败必须给真实原因，不能只说"自检失败" */}
      {selfTest ? (
        <div className="mt-3 rounded border border-line bg-surface-0 p-2.5 text-xs">
          {selfTest.passed ? (
            <>
              {/*
                ★ T-165b / T-166：「跑通了」与「加速真的用上了」**必须分开说**。

                自检钉到某一个包上跑之后，出现了一种以前不存在的状态：跑的确实是
                Vulkan 包里的 whisper-cli，而 ggml 没枚举到设备、**优雅退回 CPU 算完了**
                —— `passed` 为真，加速一点没生效。
                > 一张 Vulkan 卡片写着「自检通过」、而它其实静默跑的是 CPU，
                > 这两种情况在界面上此前**无法区分**。
                判据是 `devicesFound`（枚举不会撒谎），**不解析 `backendUsed`** ——
                后者是日志文字，T-164 拿它跟 `Backend` 枚举比，恒不相等、恒拒绝回写，
                而用例全绿。规则与依据写在 `packStatus.ts` 的 `selfTestVerdict`。
              */}
              {verdict === 'passed-not-accelerated' ? (
                <StatusChip tone="warning" label={t('runtime.pack.selfTestNoAccel')} />
              ) : (
                <StatusChip tone="good" label={t('runtime.pack.selfTestPassed')} />
              )}
              <p className="mt-1 text-ink-secondary">
                {t('runtime.pack.devicesFound', { n: selfTest.devicesFound })}
                {selfTest.rtf != null
                  ? t('runtime.pack.rtfMeasured', {
                      rtf: selfTest.rtf.toFixed(2),
                      minutes: Math.round(selfTest.rtf * 60),
                    })
                  : ''}
              </p>
              {verdict === 'passed-not-accelerated' ? (
                <p className="mt-1 text-warning" data-testid={`selftest-no-accel-${pack.id}`}>
                  {t('runtime.pack.selfTestNoAccelDetail')}
                </p>
              ) : null}
              {/*
                实际用上的后端：**原样显示**。
                它是 whisper 自己的日志文字（`CPU`、`CPU (ggml-cpu-zen4)`、GPU 设备名），
                显示原文永远诚实，解析它才会出错 —— 那正是 T-166 修掉的那个 bug。
                字段可选（T-166 之前写下的记录没有它），没有就一个字不说，不编。
              */}
              {selfTest.backendUsed ? (
                <p className="mt-0.5 text-[11px] text-ink-secondary">
                  {t('runtime.pack.backendUsed', { backend: selfTest.backendUsed })}
                </p>
              ) : null}
              <p className="mt-0.5 text-[11px] text-ink-muted">
                {t('runtime.pack.selfTestProvenance', {
                  at: new Date(selfTest.ranAt).toLocaleString(locale),
                })}
              </p>
            </>
          ) : (
            <>
              <StatusChip tone="critical" label={t('runtime.pack.selfTestFailed')} />
              {/* 透传服务端已知的具体原因（架构不兼容 / 驱动过旧 / 二进制损坏），
                  绝不用笼统的"出错了"把已知信息藏回黑箱 */}
              <p className="mt-1 text-critical">
                {selfTest.errorMessage ?? t('runtime.pack.unknownReason')}
              </p>
              <div className="mt-2 flex gap-2">
                {/*
                  ★ 同一张 `SELF_TEST_APPLIES` 表。
                    「重试自检」调的是 `onSelfTest()` —— **和上面那个被门控掉的按钮是同一个调用**。
                    只门控其中一个，就是把同一个必然失败的动作留了第二个入口。
                    今天走不到这里（非推理包拿不到 selfTest 记录：daemon 侧 blocked 只回 409、
                    不落记录，`recordSelfTest` 还会拒绝 `requestedId !== packId`），
                    但那是**别人的规则在替这里挡**，不是这里判对了。
                */}
                {SELF_TEST_APPLIES[pack.engine] ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onSelfTest(pack.id)}
                    data-testid={`backend-selftest-retry-${pack.id}`}
                  >
                    {t('runtime.pack.retrySelfTest')}
                  </Button>
                ) : null}
                {/*
                  ★★ T-192 ④：这里原来是 `onSelect(pack)` = `select(pack.backend)`，
                  而它唯一出现的场合是**一个非 cpu 的包自检失败**时 ——
                  于是「改用 CPU」**重新选中了那个刚刚失败的后端**。
                  标签承诺的和处理器做的正好相反。现在它真的切到 cpu。
                */}
                <Button size="sm" variant="ghost" onClick={() => onSelect('cpu')}>
                  {t('runtime.pack.switchToCpu')}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {isLoadBearing && pack.installed ? (
        <p className="mt-1.5 text-right text-[11px] text-ink-muted">
          {t('runtime.pack.loadBearingNote')}
        </p>
      ) : null}
    </article>
  );
}
