import {
  ArrowUpCircle,
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  CircleSlash,
  Download,
  ExternalLink,
  FileDigit,
  GitCommitHorizontal,
  Package,
} from 'lucide-react';
import type { ComponentStatus, UpstreamCheck, UpstreamCheckKind } from '@openmemo/shared';
import { assertNeverUpstreamCheck, pinRelation } from '@openmemo/shared';
import { Button } from '../../../components/common/Button';
import { StatusChip } from '../../../components/common/StatusChip';
import { formatBytes } from '../../../lib/format/bytes';
import { localizedName } from '../../../lib/format/localized';
import { cn } from '../../../lib/utils';

/**
 * One component: what it is, where it came from, and whether it can be updated.
 *
 * ★ Rule this card exists to enforce: 「不知道」must never look like 「已是最新」.
 * They are different facts — one is "upstream says you are current", the other is "we
 * could not tell". Rendering both as a tick teaches users to stop reading the state,
 * which is exactly how a green light stops meaning anything.
 *
 * ── #66 改了什么（**这一栏原来基本是诚实的，只有两处真会骗人，改的就是那两处**）──
 *
 * ① **`checkState()` 没了。** 它原来从 `updateAvailable` / `latestVersion` 两个字段
 *    **重新推导**一遍服务端已经算过的结论 —— 与 `listComponents()` 里那份是
 *    **两处独立的约定，不是一个结构**。现在直接读 `upstreamCheck.kind`。
 *
 * ② **「未检测」那一格拆成了三格。** 它原来同时装着「从没查过」「查了但失败了」
 *    「结构上没有上游可问」，而写死的措辞是「我们**没能问到**上游 …… 点『检查更新』
 *    **重试**」——一句"试过、失败了"的话。`[实测 2026-08-11]` 首屏 27 条全落在这一格，
 *    **而 daemon 一次都没问过**。对 `no-upstream` 说"重试"更糟：那是对一个结构上
 *    就没有上游可问的东西指一条死路。
 *
 * ③ **`indeterminate` 单独一档，绝不给绿勾。** 它原来落进 `current`
 *    （`!updateAvailable && latestVersion` ⇒ 绿勾「已是最新」）——**UNKNOWN 塌成 PASS**，
 *    本轮最该修的一处。
 */

/** 每一态的芯片。**总 `Record`** —— `UpstreamCheck` 加一条腿，这里不加就编译不过。 */
const CHECK_UI: Record<
  UpstreamCheckKind,
  { tone: 'warning' | 'good' | 'neutral'; label: string; icon: React.ReactNode }
> = {
  // 没查过 ≠ 查失败。这是首屏的常态，不该长得像出了错。
  'never-checked': {
    tone: 'neutral',
    label: '未检测',
    icon: <CircleHelp className="size-3.5" aria-hidden />,
  },
  // 没有上游可问 —— 再点一百次「检查更新」也不会变。
  'no-upstream': {
    tone: 'neutral',
    label: '无上游可查',
    icon: <CircleSlash className="size-3.5" aria-hidden />,
  },
  // 真的问了、真的没问到。**这一档才配说"重试"。**
  failed: {
    tone: 'warning',
    label: '没问到上游',
    icon: <AlertTriangle className="size-3.5" aria-hidden />,
  },
  // ★ 全卡唯一一个绿勾。它要求：问到了 **且** 比出来了 **且** 不比我们的新。
  current: {
    tone: 'good',
    label: '已是最新',
    icon: <CheckCircle2 className="size-3.5" aria-hidden />,
  },
  newer: {
    tone: 'warning',
    label: '有新版本',
    icon: <ArrowUpCircle className="size-3.5" aria-hidden />,
  },
  // Deliberately a question mark, not a tick. 这一档以前就是被画成绿勾的那一档。
  indeterminate: {
    tone: 'neutral',
    label: '无法判断新旧',
    icon: <CircleHelp className="size-3.5" aria-hidden />,
  },
};

/**
 * 「上游最新」那一行显示什么。
 *
 * `never-checked` / `no-upstream` / `failed` 三态都**没有版本号可显示**，
 * 但它们要显示的**破折号含义不同**，所以不共用一句 `??`。
 */
function upstreamVersionCell(u: UpstreamCheck): string | null {
  switch (u.kind) {
    case 'current':
    case 'newer':
    case 'indeterminate':
      return u.version;
    case 'never-checked':
    case 'no-upstream':
    case 'failed':
      return null;
    default:
      return assertNeverUpstreamCheck(u);
  }
}

/**
 * 每一态下面那句解释。**四种"不是有新版本"的情形各说各的话** ——
 * 它们能让用户做的事完全不同：等 / 重试 / 什么都不用做 / 去上游自己看。
 */
function UpstreamNote({ c }: { c: ComponentStatus }) {
  const u = c.upstreamCheck;
  const cls = 'mt-1.5 text-[11px] text-ink-muted';
  switch (u.kind) {
    case 'never-checked':
      return (
        <p className={cls} data-testid="upstream-note-never-checked">
          「未检测」表示<strong className="text-ink-secondary">我们还没问过上游</strong>
          ，不代表已是最新。首屏默认不联网查 —— 点上方「检查更新」就会去问。
          已安装的版本不受影响，照常可用。
        </p>
      );
    case 'no-upstream':
      return (
        <p className={cls} data-testid="upstream-note-no-upstream">
          这个组件<strong className="text-ink-secondary">没有可查的上游发布源</strong>（{u.reason}
          ）。
          <strong className="text-ink"> 点「检查更新」不会有结果</strong>
          —— 这不是失败，是没有这个问题可问。
        </p>
      );
    case 'failed':
      return (
        <p className={cls} data-testid="upstream-note-failed">
          我们<strong className="text-ink-secondary">问了上游但没问到</strong>（{u.reason}
          ），不代表已是最新。点上方「检查更新」重试通常就好。已安装的版本不受影响，照常可用。
        </p>
      );
    case 'indeterminate':
      return (
        <p className={cls} data-testid="upstream-note-indeterminate">
          上游给的是 <code className="font-mono text-ink-secondary">{u.version}</code>，目录钉的是{' '}
          <code className="font-mono text-ink-secondary">{c.pinnedVersion}</code>，
          <strong className="text-ink">这两个号排不出先后</strong>（{u.reason}）。 所以这里
          <strong className="text-ink">既不说有新版本，也不说已是最新</strong> —— 我们不知道。
        </p>
      );
    case 'current':
    case 'newer':
      return null;
    default:
      return assertNeverUpstreamCheck(u);
  }
}

/**
 * 哪些**类别**的组件，"自己装到系统 PATH 上我们会直接用"这句话是**真的**。
 *
 * 判据不是我猜的，是 `packages/pipeline/src/tools.ts` 的 `RESOLUTION_PLANS`：
 * 只有 `ffmpeg` / `ffprobe` / `whisperCli` / `whisperVad` / `ytDlp` 五条的 `order`
 * 里带 `'path'`。对应到 `components.json` 的 `category`，就是 `media-tool`
 * （ffmpeg/ffprobe/yt-dlp）与 `backend-pack`（whisper-cli 那一族）。
 *
 * ⚠️ **`sqlite-ext` 不在里面**：libsimple / sqlite-vec 是 SQLite 扩展，
 *    从 `<dataDir>/bin/ext` 加载，**没有 PATH 这一档** —— 对它们说这句话
 *    就是把用户送上一条走不通的路。`model` 同理（权重只能经我们的目录进来）。
 */
const PATH_RESOLVED_CATEGORIES: ReadonlySet<string> = new Set(['media-tool', 'backend-pack']);

export interface ComponentCardProps {
  component: ComponentStatus;
  locale: string;
  busy: boolean;
  onUpdate: (c: ComponentStatus) => void;
}

export function ComponentCard({ component: c, locale, busy, onUpdate }: ComponentCardProps) {
  const u = c.upstreamCheck;
  const ui = CHECK_UI[u.kind];
  /*
   * ★★ 「装一次会不会真的改变这台机器上的东西」**只从这一个判据出**（`@openmemo/shared`）。
   *
   * 这里原来是 `installed && downloadable && c.installedVersion !== c.pinnedVersion` ——
   * 一条**两态的比较**去读一个其实有三态的事实，第三态（「这份安装记录根本不记版本号」）
   * 被上游写成了字符串哨兵 `'installed'`，于是 `!==` 恒真：随包出厂的
   * `media-tools-win-x64` 长期挂着一颗「装上目录钉定的 autobuild-2026-07-31-14-10」，
   * 点一次白下 145,349,121 字节，装完卡片一个字不变 —— 他会再点一次。
   *
   * 现在第三态在类型里（`InstalledVersion`），`pinRelation()` 在
   * `not-applicable` 那一格上**说不出** `differs-from-pinned` —— 不是多加一句
   * `!== 'installed'` 的字符串防守（那只是给哨兵换个字面量，下一个哨兵照样漏）。
   */
  const rel = pinRelation(c.installedVersion, c.pinnedVersion);
  const installed = rel !== 'not-installed';
  /*
   * 这条组件到底有没有"一份要下载的制品"。
   *
   * 有些登记在册的组件是 **B 类 npm 依赖**（`sherpa-onnx-node` 就是，随
   * `pnpm install` 一起进来），清单里如实写着 `sha256: "n/a"` / `sizeBytes: 0`。
   * 给它们画一个「安装」按钮，点下去只会拿到 409 `NO_INSTALL_CHANNEL` ——
   * 那是把"没有按钮"换成"按了没用的按钮"，比原来更糟。
   */
  const downloadable = c.sha256 !== '' && c.sha256 !== 'n/a' && c.sizeBytes > 0;

  return (
    <article
      className="rounded-lg border border-line bg-surface-1 p-4"
      data-testid={`component-card-${c.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Package className="size-4 shrink-0 text-ink-muted" aria-hidden />
            {/*
              ★ T-135：走 `localizedName()`，不要写死 `displayNameZh`。
              这条属于「第三类混语言」：**数据齐全、契约齐全，只是渲染时挑错了那一份**
              —— `vendor/manifests/components.json` 里 8 条组件**每一条都同时有**
              `displayName` 与 `displayNameZh`，`packages/shared` 的 `ComponentStatus`
              两个字段也都在。所以这不是"缺翻译"，是"有翻译没用上"。
              （同型的 `/models`、`/runtime` 已在 T-129b 接上同一个 helper。）
            */}
            <h3 className="text-sm font-medium text-ink">{localizedName(locale, c)}</h3>
            <StatusChip tone={ui.tone} label={ui.label} icon={ui.icon} />
            <StatusChip
              tone={installed ? 'good' : 'neutral'}
              label={installed ? '已安装' : '未安装'}
            />
            <span className="rounded bg-surface-0 px-1.5 py-0.5 text-[11px] text-ink-secondary">
              {c.category}
            </span>
          </div>

          {/* 三个版本分开显示：它们可能两两不同，合并成一个数字就丢信息 */}
          <dl className="mt-2 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-ink-muted">目录钉定</dt>
            <dd className="truncate font-mono text-ink" data-testid="pinned-version">
              {c.pinnedVersion}
            </dd>

            <dt className="text-ink-muted">本机已装</dt>
            {/*
              三态各说各的话。**「装了但记录里没有版本号」不许长得像「没装」**，
              也不许冒充成一个版本号 —— 那正是哨兵 `'installed'` 当初做的事
              （它会被原样渲染进这一格，看上去像个版本）。
            */}
            <dd
              className="truncate font-mono text-ink-secondary"
              data-testid={`installed-version-${c.id}`}
            >
              {c.installedVersion.kind === 'known' ? (
                c.installedVersion.version
              ) : c.installedVersion.kind === 'not-installed' ? (
                <span className="font-sans text-ink-muted">尚未安装</span>
              ) : (
                <span className="font-sans text-ink-muted">
                  已安装（{c.installedVersion.reason}）
                </span>
              )}
            </dd>

            <dt className="text-ink-muted">上游最新</dt>
            <dd className="truncate font-mono text-ink-secondary" data-testid="latest-version">
              {upstreamVersionCell(c.upstreamCheck) ?? (
                <span className="font-sans text-ink-muted">—</span>
              )}
            </dd>
          </dl>

          {/* 每一种"不是有新版本"都必须解释清楚它到底是哪一种"不知道"或"知道" */}
          <UpstreamNote c={c} />
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {/*
            ★ 未安装 → 必须给得出「安装」这个动作（章程要求 2.1：网页里装，不碰命令行）。
            这张卡以前只有「更新到 X」这一个按钮，而它的显示条件是 `updateAvailable`
            —— 也就是说：一个**从没装过**的组件，卡片老老实实标着「未安装」，
            却连一个能点的东西都没有。用户看得见问题、看得见来源、就是装不上。
            （T-132 实测：yt-dlp 缺失导致 F1 断掉后，这一页正是用户唯一会去的地方。）
            走的是与「更新」完全同一个端点/同一个下载器，不是新开一条安装路径。
          */}
          {rel === 'not-installed' && downloadable ? (
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => onUpdate(c)}
              data-testid={`component-install-${c.id}`}
            >
              <Download className="size-3.5" aria-hidden />
              {busy ? '安装中…' : `安装 ${c.pinnedVersion}`}
            </Button>
          ) : null}
          {rel === 'not-installed' && !downloadable ? (
            <span
              className="max-w-[12rem] text-right text-[11px] text-ink-muted"
              data-testid={`component-bundled-${c.id}`}
            >
              随应用一起安装，不单独下载
            </span>
          ) : null}
          {/*
            ★★ 这颗按钮的判据换了一条轴，**因为它原来钉在了自己做不到的那件事上**。

            原来是 `installed && c.updateAvailable`，按钮上写着「更新到 {latestVersion}」。
            而 `POST /api/components/:id/update` **从不读请求体**，直接
            `startPackInstall(state, pack)` 装**目录里钉死的那一版**，并回
            `toVersion: comp.pinnedVersion`（`rest/components.ts`，那段注释自己写着
            「更新 = 安装清单里钉死的那个版本」；那段注释给的理由是"我们手上没有上游那一版的
            sha256"，⚠️ **那句今天已经不成立**，真正的理由见本文件下方那段 —— 上游给得出摘要，
            但那个摘要与"有新版本"同源）。

            于是两种情形正好各错一半：
              · 已装 = 钉定，上游更新 ⇒ `updateAvailable` 为真 ⇒ **按钮出现，
                上面写着一个它装不到的版本号**，点完什么都没变，用户会再点一次；
              · 已装 < 钉定（旧机器没跟上目录）⇒ `updateAvailable` 为假 ⇒ **没有按钮**，
                而这恰恰是装一次**真的有用**的那一种情形。

            也就是说门控用的是「上游 vs 我们钉的」，动作做的是「装我们钉的」——
            **两个轴共用了一个槽位。** 现在各归各：
              · 按钮 ⇐ `installedVersion !== pinnedVersion`（装一次真会变），文案说钉定那一版；
              · 「上游有更新」⇐ 下面那一段真话 + 真出口，不再伪装成一个可点的动作。

            用户 2026-08-09 的原话：**引导动作的按钮跳转后的逻辑能解决对应问题就补上，
            否则就删掉。** 这颗按钮比一般的死按钮更糟 —— 它**具体地承诺了一个版本号**。

            ── ⚠️ 上面那条「各归各」当时只做对了一半（本次补的就是另一半）──────────
            判据换成 `installedVersion !== pinnedVersion` 之后，它读的那一栏**根本不是
            一个版本号**：`readInstalledVersions()` 对没有版本字段的记录填的是哨兵
            `'installed'`，于是 `!==` 恒真，按钮对每个随包出厂的后端包**长期常亮**。
            现在判据是 `pinRelation()` 的四态，`unknowable` 那一格**给不出按钮**：
            不知道机器上装的是什么，就不许号召人去装一遍。
          */}
          {rel === 'differs-from-pinned' && downloadable ? (
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => onUpdate(c)}
              data-testid={`component-update-${c.id}`}
            >
              <ArrowUpCircle className="size-3.5" aria-hidden />
              {busy ? '更新中…' : `装上目录钉定的 ${c.pinnedVersion}`}
            </Button>
          ) : null}
          {/*
            ⚠️ **这里不要再加「回滚到上一版」按钮。** 产品决定是"不做回滚"，
            整条管道（`stashForRollback` / `rollback` / `rollbackVersion` 契约字段 /
            `POST /api/components/:id/rollback`）已经删干净 —— 它从来没运行过一次。
            为什么不做、以及将来真要做得先补哪一环：`docs/adr/ADR-017-component-rollback-removed.md`。
          */}
        </div>
      </div>

      {/*
        ★★ 「上游有更新」说一句真话 + 给一个真出口，**不是一个可点的承诺**。

        能说的是：上游有 vX，我们目录里钉的是 vY，**这里装不了上游那一版**。
        真出口是上游发布页：他可以自己看变更、自己决定要不要等我们把它钉进目录。

        ── ⚠️ 这一段原来的理由「我们手上没有它的 sha256」**今天已经不成立** ──
        `[实测 2026-08-11]` GitHub releases API **直接给出每个资产的 sha256 digest**
        （`assets[].digest`，形如 `sha256:7e26fa…`），实测三个仓 100% 覆盖：
        ggml-org/whisper.cpp v1.9.2 **9/9**、yt-dlp 2026.07.04 **24/24**、
        我们自己的镜像仓 v0.7.0 **3/3**。而 `packages/downloader/src/upstream.ts`
        的 `toRelease()` **已经在解析它**，只是 `listComponents()` 把整个 release 对象丢掉了。

        但**不能改成相反的假话**（"拿得到，所以能装"）。诚实的说法是：
        **拿得到，但那个校验和跟「有新版本」这句话来自同一个来源** —— 它能证明
        你下到的字节没在路上被改，**不能证明那个来源本身没问题**。
        这正是仓里已有的那个区分：`sha256Provenance` 的「上游 API 提供」
        vs「本机下载后独立复算」（下面 `ProvenanceNote` 还把前者渲染成警告色）。
        用现成的词，不造新词。

        ⚠️ **「装到系统 PATH 上我们会直接用」这句只对有 PATH 那一档的工具说。**
           `packages/pipeline/src/tools.ts` 的 `RESOLUTION_PLANS` 里只有五条
           （ffmpeg / ffprobe / whisperCli / whisperVad / ytDlp）带 `'path'`；
           sqlite-ext（libsimple / sqlite-vec）是 SQLite 扩展，从 `<dataDir>/bin/ext`
           加载，**根本没有 PATH 这一档** —— 对它们说这句就是给一条走不通的路。
        ⚠️ 「装完要重启」是实的，不是客套：热刷新只认**通过产品装**的那条路（#87 查实）。

        ── ★ #66 ①：产品决定已裁（2026-08-11 用户）────────────────────────────────
        `[实测 2026-08-11]` 27 条组件里 **5 条 whisper.cpp** 的「问版本的仓 ≠ 二进制来源的仓」：
        `whispercpp-{cpu,vulkan}-linux-x64` / `whispercpp-{cpu,vulkan}-win-x64` /
        `whispercpp-metal-macos-arm64` 问 `ggml-org/whisper.cpp`，
        而二进制来自我们自己的镜像仓 `faorcoek042/openmemo`（上游在这些平台只发库、
        不发可执行程序，所以是我们自己编的）。

        **裁决：如实说「上游有新版，但我们还没镜像」。** 不新增镜像构建线
        （每次重编三平台、重算 sha256、自己盯 CVE，是一条独立的长期维护线），也不藏起来。

        所以这一段**必须同时说两件事，而且不许混成一句**：
          ① 上游那个项目发到哪一版了 —— 真话，照常报 `newer`；
          ② 你现在能装的仍是清单里钉死的那一版 —— 因为**我们还没跟上**。
        ⚠️ 别塌成「有更新，去点更新吧」——那正是 PR #19 刚删掉的那颗按钮犯的错：
           它承诺的版本，服务端从来装不到。**同一个错不要在同一栏里再犯第二次。**
        ⚠️ 也别塌成 `no-upstream`（「这条没有上游可问」）—— 那是假话，上游明明有，
           而且我们真问到了。

        这个区别落在**数据结构**里（`UpstreamCheck.newer.binarySource`），不在文案里 ——
        文案会被翻译、会被改，结构不会。这里只是把结构读出来。
      */}
      {u.kind === 'newer' ? (
        <p
          className="mt-2.5 rounded border border-line bg-surface-0 p-2 text-xs text-ink-secondary"
          data-testid={`component-upstream-newer-${c.id}`}
        >
          {u.binarySource.kind === 'our-mirror' ? (
            <>
              上游项目 <code className="font-mono text-ink">{u.binarySource.versionRepo}</code>{' '}
              发到了 <code className="font-mono text-ink">{u.version}</code>
              ，我们目录里钉的是 <code className="font-mono text-ink">{c.pinnedVersion}</code>。
              <strong className="text-ink"> 但这里点不了更新，因为我们还没镜像这一版</strong>
              —— 这个组件的二进制不是上游直接发的（上游在这个平台只发库、不发可执行程序），
              是我们自己编译后放在{' '}
              <code className="font-mono text-ink">{u.binarySource.binaryRepo}</code> 的。
              <strong className="text-ink">上游发了新版 ≠ 我们已经镜像了新版。</strong>
            </>
          ) : (
            <>
              上游有 <code className="font-mono text-ink">{u.version}</code>
              ，我们目录里钉的是 <code className="font-mono text-ink">{c.pinnedVersion}</code>。
              <strong className="text-ink"> 这里装不了上游那一版</strong>
              —— 我们只装 sha256 <strong className="text-ink">本机独立复算过</strong>的版本。
              上游确实随 release 给出了新版本的 sha256，但那是
              <strong className="text-ink">上游 API 提供</strong>
              的摘要，和「有新版本」这句话同一个来源：它能证明字节没在路上被改，
              不能证明那个来源本身没问题。
            </>
          )}
          {/*
            ★★ **两个三态在这里碰头，而"各自正确"不等于"拼起来正确"。**

            上游侧说 `newer`（真话），本地侧说 `unknowable`（也是真话，a2c2e28 治的那条）。
            拼起来这张卡会变成：芯片喊「有新版本」、**一颗按钮都没有**、而下面这段
            只解释了上游那一侧 —— 用户读到的是「有新版本，但什么都不给我，也不说为什么」。

            那是刚修掉那个 bug 的**镜像面**：#33 拿掉的是一颗点了没用的按钮，
            这里要防的是**一句召唤了动作却没有动作、也没有解释的话**。
            所以本地那一侧必须在同一段里自己说出来。

            只有 `unknowable` 需要这一句，其余三格本身就自洽：
              · `not-installed`     → 有「安装 {pinnedVersion}」按钮
              · `differs-from-pinned` → 有「装上目录钉定的 …」按钮
              · `same-as-pinned`    → 没按钮是对的（装了也白装），且这段已说清原因
          */}
          {c.installedVersion.kind === 'not-applicable' ? (
            <>
              {' '}
              另外，<strong className="text-ink">我们说不出这台机器上装的是哪一版</strong>（
              {c.installedVersion.reason}）——
              所以这张卡也不会让你「装上目录钉定的那一版」：在不知道你手上是什么的情况下
              号召重装，多半只是白下一遍。
            </>
          ) : null}
          {PATH_RESOLVED_CATEGORIES.has(c.category) ? (
            <> 你可以自己把新版装到系统 PATH 上，我们会直接用它（装完需要重启产品才生效）。</>
          ) : null}{' '}
          <a
            href={c.provenance.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-accent-ink hover:underline"
            data-testid={`component-upstream-link-${c.id}`}
          >
            <ExternalLink className="size-3" aria-hidden />
            去上游看这一版
          </a>
        </p>
      ) : null}

      {/* ═══ 来源链：源码 commit → 发布页 → 二进制 → sha256 → 许可证 ═══
          用户原话「只要写明从哪里下载对应依赖即可」。全部可点，不只躺在 json 里。 */}
      <div className="mt-3 border-t border-line pt-2.5" data-testid="provenance">
        <p className="mb-1.5 text-[11px] font-medium text-ink-secondary">来源</p>

        <ol className="space-y-1 text-xs">
          {c.provenance.submodulePath ? (
            <li className="flex flex-wrap items-center gap-1.5">
              <GitCommitHorizontal className="size-3 shrink-0 text-ink-muted" aria-hidden />
              <span className="text-ink-muted">源码</span>
              <code className="font-mono text-ink-secondary">{c.provenance.submodulePath}</code>
              <span className="text-ink-muted">@</span>
              <code className="font-mono text-ink-secondary">
                {c.provenance.submoduleCommit?.slice(0, 12)}
              </code>
            </li>
          ) : null}

          <li className="flex flex-wrap items-center gap-3">
            <a
              href={c.provenance.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-accent-ink hover:underline"
            >
              <ExternalLink className="size-3" aria-hidden />
              上游仓库
            </a>
            <a
              href={c.provenance.releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-accent-ink hover:underline"
              data-testid="release-link"
            >
              <ExternalLink className="size-3" aria-hidden />
              发布页（{c.pinnedVersion}）
            </a>
            <a
              href={c.provenance.licenseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-ink-secondary hover:underline"
            >
              许可证 {c.provenance.license}
            </a>
            {c.sizeBytes > 0 ? (
              <span className="text-ink-muted">{formatBytes(c.sizeBytes, locale)}</span>
            ) : null}
          </li>

          {c.sha256 && c.sha256 !== 'n/a' ? (
            <li data-testid="sha256-row">
              <div className="flex items-start gap-1.5">
                <FileDigit className="mt-0.5 size-3 shrink-0 text-ink-muted" aria-hidden />
                <div className="min-w-0">
                  <code className="block truncate font-mono text-[11px] text-ink-muted">
                    sha256:{c.sha256}
                  </code>
                  {/*
                    ★ 哈希是谁给的，用户有权知道。
                    "上游 API 提供" 与 "本机独立复算" 是两种不同强度的证据：
                    前者信任上游没被攻破，后者只信任字节本身。混为一谈会高估可信度。
                  */}
                  <ProvenanceNote note={c.sha256Provenance} />
                </div>
              </div>
            </li>
          ) : null}
        </ol>
      </div>
    </article>
  );
}

/** Render where a digest came from, defaulting to the stronger local-verification claim. */
function ProvenanceNote({ note }: { note?: string | null }) {
  const upstreamProvided = note != null && /API|digest|upstream/i.test(note);
  return (
    <p
      className={cn('mt-0.5 text-[11px]', upstreamProvided ? 'text-warning' : 'text-ink-muted')}
      data-testid="sha256-provenance"
    >
      {note ?? '本机下载后独立复算'}
    </p>
  );
}
