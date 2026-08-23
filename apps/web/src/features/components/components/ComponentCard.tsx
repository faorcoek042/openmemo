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
import { useTranslation } from 'react-i18next';
import type {
  ComponentStatus,
  Sha256Verification,
  UpstreamCheck,
  UpstreamCheckKind,
} from '@openmemo/shared';
import { assertNeverUpstreamCheck, pinRelation } from '@openmemo/shared';
import { Button } from '../../../components/common/Button';
import { Emphasis } from '../../../components/common/Emphasis';
import { StatusChip } from '../../../components/common/StatusChip';
import { formatBytes } from '../../../lib/format/bytes';
import { localizedName } from '../../../lib/format/localized';
import { cn } from '../../../lib/utils';
import {
  INSTALLED_VERSION_UNKNOWN_KEYS,
  NO_UPSTREAM_KEYS,
  indeterminateText,
  upstreamFailureText,
} from '../reasonText';

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

/**
 * 每一态的芯片。**总 `Record`** —— `UpstreamCheck` 加一条腿，这里不加就编译不过。
 *
 * ── ★★ #105 ①：`label` 从**中文字面量**换成 **locale key** ─────────────────────────
 *
 * `[闸门实测 2026-08-12，真浏览器]` 同一个上下文里 `documentElement.lang === 'en'`、
 * 侧栏英文、`/runtime` 英文，而这一格逐字是「未检测 / 已是最新 / 有新版本」。
 * 芯片是这张卡上**信息密度最高**的一格（用户扫一眼只看它），它说中文，
 * 等于这一轮在这一页上做的三件事（`a2c2e28` / `af25cf3` / `23a8471`）
 * 对英文用户**全部不存在**。
 *
 * ⚠️ 为什么仍然是 `Record`，而不是就地把 key 拼成 `components.chip.<u.kind>`：
 * 拼字符串那种写法里，`UpstreamCheck` 新增一条腿会**静默**渲染出原始 key 串
 * （i18next 找不到就把 key 原样吐回来），而这里少一格**编译当场就红**。
 *
 * ⚠️ 上面这句刻意**没有**写成一段可执行样子的代码：`check-locale-ratchet.mjs`
 * 扫的是 `git grep '\bt\([[:space:]]*['"']'`，**它不区分代码和注释** ——
 * 在注释里举一个反例，会被它当成"源码用到了一个不存在的 key"而判红
 * （这条本身是对的：一个静态扫描器不该去解析注释）。`[实测 CI run 31621726113]`
 * 与 `HardwareCard` 的 `UNDETERMINED_REASON_KEYS`（`79cc117`）同一条判据：
 * **契约多一种情况而没人给它写话，必须是构建错误，不能是一句空白。**
 */
const CHECK_UI: Record<
  UpstreamCheckKind,
  { tone: 'warning' | 'good' | 'neutral'; labelKey: string; icon: React.ReactNode }
> = {
  // 没查过 ≠ 查失败。这是首屏的常态，不该长得像出了错。
  'never-checked': {
    tone: 'neutral',
    labelKey: 'components.chip.neverChecked',
    icon: <CircleHelp className="size-3.5" aria-hidden />,
  },
  // 没有上游可问 —— 再点一百次「检查更新」也不会变。
  'no-upstream': {
    tone: 'neutral',
    labelKey: 'components.chip.noUpstream',
    icon: <CircleSlash className="size-3.5" aria-hidden />,
  },
  // 真的问了、真的没问到。**这一档才配说"重试"。**
  failed: {
    tone: 'warning',
    labelKey: 'components.chip.failed',
    icon: <AlertTriangle className="size-3.5" aria-hidden />,
  },
  // ★ 全卡唯一一个绿勾。它要求：问到了 **且** 比出来了 **且** 不比我们的新。
  current: {
    tone: 'good',
    labelKey: 'components.chip.current',
    icon: <CheckCircle2 className="size-3.5" aria-hidden />,
  },
  newer: {
    tone: 'warning',
    labelKey: 'components.chip.newer',
    icon: <ArrowUpCircle className="size-3.5" aria-hidden />,
  },
  // Deliberately a question mark, not a tick. 这一档以前就是被画成绿勾的那一档。
  indeterminate: {
    tone: 'neutral',
    labelKey: 'components.chip.indeterminate',
    icon: <CircleHelp className="size-3.5" aria-hidden />,
  },
};

/**
 * 每一态下面那句解释该用哪条词条。**同样是总表。**
 *
 * `current` / `newer` 写在 `Exclude` 里而不是给它们一个 `null` 值：这两档不需要
 * 额外解释（前者芯片已说完，后者有自己那一整段），而 `Exclude` 让"新增一条腿"
 * 照样落进这张表 —— 少一格编译就红。`Record<所有腿, string | null>` 做不到这一点：
 * 那里 `null` 与"忘了写"长得一模一样。
 */
const NOTE_KEYS: Record<Exclude<UpstreamCheckKind, 'current' | 'newer'>, string> = {
  'never-checked': 'components.note.neverChecked',
  'no-upstream': 'components.note.noUpstream',
  failed: 'components.note.failed',
  indeterminate: 'components.note.indeterminate',
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
 *
 * ★ #105 ①：这四段原来是**穿插着 `<strong>` / `<code>` 的 JSX 字面量**。
 *   那种形状**没法整句翻译** —— 断句、语序、哪一段该重读，每种语言都不一样，
 *   拆成三截各自翻译只会拼出一句谁都不会说的话。所以整句进词条，
 *   强调用 `**…**` + `<Emphasis>`（T-129b 立的那条路），版本号照旧插值进去。
 *   丢掉的只有 `<code>` 的等宽字体，换来的是这四句话在英文界面上真的存在。
 *
 * ⚠️ #106：`u.reason` **不再是 daemon 的原话**。它以前是一整句中文，被插进上面
 *    这四句英文的 `{{reason}}` 里 —— 英文界面上于是长成「We did ask upstream and got
 *    no answer (上游配额已用尽…)」。现在 daemon 只交出**机器可读的原因 + 结构化数字**
 *    （`UpstreamFailure` / `NoUpstreamReason` / `UpstreamIndeterminate`），
 *    措辞在 `../reasonText` 那三张**总表**里 —— 契约新增一种原因而没人写话，
 *    构建当场就红。daemon 仍然是唯一知道"限流还要等多久"的那一方，
 *    只是它现在给的是毫秒数，不是一句中文。
 */
function UpstreamNote({ c }: { c: ComponentStatus }) {
  const { t, i18n } = useTranslation();
  const u = c.upstreamCheck;
  const cls = 'mt-1.5 text-[11px] text-ink-muted';
  switch (u.kind) {
    case 'never-checked':
      return (
        <p className={cls} data-testid="upstream-note-never-checked">
          <Emphasis text={t(NOTE_KEYS[u.kind])} />
        </p>
      );
    case 'no-upstream':
      return (
        <p className={cls} data-testid="upstream-note-no-upstream">
          <Emphasis text={t(NOTE_KEYS[u.kind], { reason: t(NO_UPSTREAM_KEYS[u.reason]) })} />
        </p>
      );
    case 'failed':
      return (
        <p className={cls} data-testid="upstream-note-failed">
          <Emphasis
            text={t(NOTE_KEYS[u.kind], { reason: upstreamFailureText(t, i18n.language, u.reason) })}
          />
        </p>
      );
    case 'indeterminate':
      return (
        <p className={cls} data-testid="upstream-note-indeterminate">
          <Emphasis
            text={t(NOTE_KEYS[u.kind], {
              upstream: u.version,
              pinned: c.pinnedVersion,
              reason: indeterminateText(t, u.reason),
            })}
          />
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
  const { t } = useTranslation();
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
            <StatusChip tone={ui.tone} label={t(ui.labelKey)} icon={ui.icon} />
            <StatusChip
              tone={installed ? 'good' : 'neutral'}
              label={t(installed ? 'components.installedChip' : 'components.notInstalledChip')}
            />
            <span className="rounded bg-surface-0 px-1.5 py-0.5 text-[11px] text-ink-secondary">
              {c.category}
            </span>
          </div>

          {/* 三个版本分开显示：它们可能两两不同，合并成一个数字就丢信息 */}
          <dl className="mt-2 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-ink-muted">{t('components.pinnedLabel')}</dt>
            <dd className="truncate font-mono text-ink" data-testid="pinned-version">
              {c.pinnedVersion}
            </dd>

            <dt className="text-ink-muted">{t('components.installedLabel')}</dt>
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
                <span className="font-sans text-ink-muted">{t('components.notInstalledYet')}</span>
              ) : (
                <span className="font-sans text-ink-muted">
                  {t('components.installedNoVersion', {
                    reason: t(INSTALLED_VERSION_UNKNOWN_KEYS[c.installedVersion.reason]),
                  })}
                </span>
              )}
            </dd>

            <dt className="text-ink-muted">{t('components.upstreamLabel')}</dt>
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
              {busy
                ? t('components.installingBtn')
                : t('components.install', { version: c.pinnedVersion })}
            </Button>
          ) : null}
          {rel === 'not-installed' && !downloadable ? (
            <span
              className="max-w-[12rem] text-right text-[11px] text-ink-muted"
              data-testid={`component-bundled-${c.id}`}
            >
              {t('components.bundledNoDownload')}
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
              {busy
                ? t('components.updatingBtn')
                : t('components.update', { version: c.pinnedVersion })}
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
            <Emphasis
              text={t('components.upstreamNewerMirror', {
                repo: u.binarySource.versionRepo,
                upstream: u.version,
                pinned: c.pinnedVersion,
                binaryRepo: u.binarySource.binaryRepo,
              })}
            />
          ) : (
            <Emphasis
              text={t('components.upstreamNewerPinned', {
                upstream: u.version,
                pinned: c.pinnedVersion,
              })}
            />
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
            <Emphasis
              text={t('components.upstreamNewerUnknowable', {
                reason: t(INSTALLED_VERSION_UNKNOWN_KEYS[c.installedVersion.reason]),
              })}
            />
          ) : null}
          {PATH_RESOLVED_CATEGORIES.has(c.category) ? (
            <Emphasis text={t('components.pathHint')} />
          ) : null}{' '}
          <a
            href={c.provenance.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-accent-ink hover:underline"
            data-testid={`component-upstream-link-${c.id}`}
          >
            <ExternalLink className="size-3" aria-hidden />
            {t('components.upstreamLink')}
          </a>
        </p>
      ) : null}

      {/* ═══ 来源链：源码 commit → 发布页 → 二进制 → sha256 → 许可证 ═══
          用户原话「只要写明从哪里下载对应依赖即可」。全部可点，不只躺在 json 里。 */}
      <div className="mt-3 border-t border-line pt-2.5" data-testid="provenance">
        <p className="mb-1.5 text-[11px] font-medium text-ink-secondary">
          {t('components.provenanceTitle')}
        </p>

        <ol className="space-y-1 text-xs">
          {c.provenance.submodulePath ? (
            <li className="flex flex-wrap items-center gap-1.5">
              <GitCommitHorizontal className="size-3 shrink-0 text-ink-muted" aria-hidden />
              <span className="text-ink-muted">{t('components.sourceLabel')}</span>
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
              {t('components.repoLink')}
            </a>
            <a
              href={c.provenance.releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-accent-ink hover:underline"
              data-testid="release-link"
            >
              <ExternalLink className="size-3" aria-hidden />
              {t('components.releaseLink', { version: c.pinnedVersion })}
            </a>
            <a
              href={c.provenance.licenseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-ink-secondary hover:underline"
            >
              {t('components.licenseLink', { license: c.provenance.license })}
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
                  <ProvenanceNote verification={c.sha256Verification} note={c.sha256Provenance} />
                </div>
              </div>
            </li>
          ) : null}
        </ol>
      </div>
    </article>
  );
}

/**
 * 每一档该说哪句话。**总表** —— `Sha256Verification` 加一档而没人给它写话，
 * `tsc` 当场红。换成 `KEYS[v] ?? ''` 或带万能 `default` 的三元，新档位会静默渲染成
 * 一片空白，而这一格的空白说的是「我们没告诉你这个哈希是谁算的」。
 */
const SHA256_CLAIM_KEYS: Readonly<Record<Sha256Verification, string>> = {
  'local-recomputed': 'components.sha256Local',
  'upstream-provided': 'components.sha256Upstream',
};

/**
 * 这一份摘要是谁算的 —— **一行结论 + 一段可展开的原始记录**。
 *
 * ## ★★ 结论那一行现在读枚举，不再嗅探散文
 *
 * 上一版是 `/API|digest|upstream/i.test(note)`：拿**一段自由散文**去判"证据强不强"。
 * `[实测 2026-08-24]` 27 个组件里 13 个带散文，其中 **5 个被判成警告色，全部误判**，
 * 而且恰好是全仓证据最强的那几条：
 *
 *   · `whispercpp-cpu-win-x64` 散文原话是「**不带任何凭证从 release URL 全量重下后
 *     本机 `sha256sum` 复算**」，命中的 `api` 来自另一句里的 DLL 名 `api-ms-win-crt-*`；
 *   · `media-tools-linux-x64` 原话是「本机下载全部 111,679,252 字节后独立复算，
 *     **并与** GitHub Releases API 的 digest 逐字符比对一致」—— 复算 + 交叉核对，
 *     比两者单独都强，却因为提到了被核对的那一方而被判弱。
 *
 * **我们最用力的那几条，界面正好在叫用户少信它们。** 判据搬到
 * `sha256Verification` 这一格（`Record` 全量映射 ⇒ 契约加一档没人写话就编译红）。
 *
 * ## ★★ 散文折叠，但一个字都不删
 *
 * 那段散文最长 1,761 字（`whispercpp-cpu-win-x64`），13 条合计 11,884 字，
 * 中文写死、不过 i18n、**默认全展开**，而 `/api/components` 不按平台过滤 ⇒ 27 张卡全画。
 * 里面是 commit hash、CI run id、ADR/T 号、仓内源码路径、`env -u … curl` 命令行、
 * 19 个 DLL 文件名，以及写给我们自己的「⚠️ 未验证：…尚未重跑」。
 * **那是交接记录，不是产品文案。**
 *
 * 但它**不删**：对一个要复核供应链的人来说，那是唯一的依据。所以进 `<details>`，
 * 默认收起，标题走 i18n。**能折叠的是解释，不能折叠的是结论** —— 结论就在上面那一行。
 */
function ProvenanceNote({
  verification,
  note,
}: {
  verification: Sha256Verification;
  note?: string | null;
}) {
  const { t } = useTranslation();
  const weak = verification === 'upstream-provided';
  return (
    <>
      <p
        className={cn('mt-0.5 text-[11px]', weak ? 'text-warning' : 'text-ink-muted')}
        data-testid="sha256-provenance"
        data-verification={verification}
      >
        {t(SHA256_CLAIM_KEYS[verification])}
      </p>
      {note ? (
        <details className="mt-0.5" data-testid="sha256-provenance-detail">
          <summary className="cursor-pointer text-[11px] text-ink-muted hover:underline">
            {t('components.provenanceDetail')}
          </summary>
          {/*
            ⚠️ 原样渲染，不改写、不截断 —— 它是清单里关于这一份制品的记录（数据），
            不是我们的文案。等宽 + 可换行让"这一段不是产品在说话"由形式承担。
          */}
          <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-ink-muted">
            {note}
          </p>
        </details>
      ) : null}
    </>
  );
}
