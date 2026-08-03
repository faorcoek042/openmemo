import {
  ArrowUpCircle,
  CheckCircle2,
  CircleHelp,
  Download,
  ExternalLink,
  FileDigit,
  GitCommitHorizontal,
  Package,
  RotateCcw,
} from 'lucide-react';
import type { ComponentStatus } from '@openmemo/shared';
import { Button } from '../../../components/common/Button';
import { StatusChip } from '../../../components/common/StatusChip';
import { formatBytes } from '../../../lib/format/bytes';
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

const CHECK_UI: Record<CheckState, { tone: 'warning' | 'good' | 'neutral'; label: string; icon: React.ReactNode }> = {
  update: { tone: 'warning', label: '有新版本', icon: <ArrowUpCircle className="size-3.5" aria-hidden /> },
  current: { tone: 'good', label: '已是最新', icon: <CheckCircle2 className="size-3.5" aria-hidden /> },
  // Deliberately a question mark, not a tick.
  unchecked: { tone: 'neutral', label: '未检测', icon: <CircleHelp className="size-3.5" aria-hidden /> },
};

export interface ComponentCardProps {
  component: ComponentStatus;
  locale: string;
  busy: boolean;
  onUpdate: (c: ComponentStatus) => void;
  onRollback: (c: ComponentStatus) => void;
}

export function ComponentCard({ component: c, locale, busy, onUpdate, onRollback }: ComponentCardProps) {
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
            <h3 className="text-sm font-medium text-ink">{c.displayNameZh}</h3>
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
          {installed && c.updateAvailable ? (
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => onUpdate(c)}
              data-testid={`component-update-${c.id}`}
            >
              <ArrowUpCircle className="size-3.5" aria-hidden />
              {busy ? '更新中…' : `更新到 ${c.latestVersion}`}
            </Button>
          ) : null}
          {c.rollbackVersion ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => onRollback(c)}
              data-testid={`component-rollback-${c.id}`}
            >
              <RotateCcw className="size-3.5" aria-hidden />
              回滚到 {c.rollbackVersion}
            </Button>
          ) : null}
        </div>
      </div>

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
