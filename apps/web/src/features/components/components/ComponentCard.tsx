import {
  ArrowUpCircle,
  CheckCircle2,
  CircleHelp,
  Download,
  ExternalLink,
  FileDigit,
  GitCommitHorizontal,
  Package,
} from 'lucide-react';
import type { ComponentStatus } from '@openmemo/shared';
import { Button } from '../../../components/common/Button';
import { StatusChip } from '../../../components/common/StatusChip';
import { formatBytes } from '../../../lib/format/bytes';
import { localizedName } from '../../../lib/format/localized';
import { cn } from '../../../lib/utils';

/**
 * One component: what it is, where it came from, and whether it can be updated.
 *
 * ★ Rule this card exists to enforce: 「未检测」must never look like 「已是最新」.
 * They are different facts — one is "upstream says you are current", the other is "we
 * could not ask". Rendering both as a grey tick teaches users to stop reading the state,
 * which is exactly how a green light stops meaning anything.
 * So: different icon (CircleHelp vs CheckCircle2), different colour, and an explicit
 * sentence saying it means "unknown".
 */

type CheckState = 'update' | 'current' | 'unchecked';

function checkState(c: ComponentStatus): CheckState {
  if (c.updateAvailable) return 'update';
  if (c.latestVersion) return 'current';
  return 'unchecked';
}

const CHECK_UI: Record<
  CheckState,
  { tone: 'warning' | 'good' | 'neutral'; label: string; icon: React.ReactNode }
> = {
  update: {
    tone: 'warning',
    label: '有新版本',
    icon: <ArrowUpCircle className="size-3.5" aria-hidden />,
  },
  current: {
    tone: 'good',
    label: '已是最新',
    icon: <CheckCircle2 className="size-3.5" aria-hidden />,
  },
  // Deliberately a question mark, not a tick.
  unchecked: {
    tone: 'neutral',
    label: '未检测',
    icon: <CircleHelp className="size-3.5" aria-hidden />,
  },
};

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
  const st = checkState(c);
  const ui = CHECK_UI[st];
  const installed = c.installedVersion != null;
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
            <dd className="truncate font-mono text-ink-secondary">
              {c.installedVersion ?? <span className="font-sans text-ink-muted">尚未安装</span>}
            </dd>

            <dt className="text-ink-muted">上游最新</dt>
            <dd className="truncate font-mono text-ink-secondary" data-testid="latest-version">
              {c.latestVersion ?? <span className="font-sans text-ink-muted">—</span>}
            </dd>
          </dl>

          {/* "未检测" 必须解释清楚它是"不知道"，不是"没有新版本" */}
          {st === 'unchecked' ? (
            <p className="mt-1.5 text-[11px] text-ink-muted" data-testid="unchecked-note">
              「未检测」表示<strong className="text-ink-secondary">我们没能问到上游</strong>
              ，不代表已是最新。
              {c.checkError ? `（${c.checkError}）` : '点上方「检查更新」重试。'}
              已安装的版本不受影响，照常可用。
            </p>
          ) : null}
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
          {!installed && downloadable ? (
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
          {!installed && !downloadable ? (
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
            「更新 = 安装清单里钉死的那个版本」，理由是我们手上没有上游那一版的 sha256）。

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
          */}
          {installed && downloadable && c.installedVersion !== c.pinnedVersion ? (
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
        ★★ 「上游有更新」现在说一句真话 + 给一个真出口，**不再是一个可点的承诺**。

        能说的是：上游有 vX，我们目录里钉的是 vY，**这里装不了上游那一版** ——
        因为我们手上没有它的 sha256，而"没有校验和就下载安装"会放弃
        「每个制品都校验」这条底线（服务端 `rest/components.ts` 里那段注释的原话）。
        真出口是上游发布页：他可以自己看变更、自己决定要不要等我们把它钉进目录。

        ⚠️ **「装到系统 PATH 上我们会直接用」这句只对有 PATH 那一档的工具说。**
           `packages/pipeline/src/tools.ts` 的 `RESOLUTION_PLANS` 里只有五条
           （ffmpeg / ffprobe / whisperCli / whisperVad / ytDlp）带 `'path'`；
           sqlite-ext（libsimple / sqlite-vec）是 SQLite 扩展，从 `<dataDir>/bin/ext`
           加载，**根本没有 PATH 这一档** —— 对它们说这句就是给一条走不通的路。
        ⚠️ 「装完要重启」是实的，不是客套：热刷新只认**通过产品装**的那条路（#87 查实）。
      */}
      {c.updateAvailable && c.latestVersion ? (
        <p
          className="mt-2.5 rounded border border-line bg-surface-0 p-2 text-xs text-ink-secondary"
          data-testid={`component-upstream-newer-${c.id}`}
        >
          上游有 <code className="font-mono text-ink">{c.latestVersion}</code>，我们目录里钉的是{' '}
          <code className="font-mono text-ink">{c.pinnedVersion}</code>。
          <strong className="text-ink"> 这里装不了上游那一版</strong>
          —— 我们手上没有它的 sha256，没有校验和就下载安装会放弃「每个制品都校验」这条底线。
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
