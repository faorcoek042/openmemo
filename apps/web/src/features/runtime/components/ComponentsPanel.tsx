import { ArrowUpCircle, ExternalLink, GitCommitHorizontal, RotateCcw, ShieldCheck } from 'lucide-react';
import type { ComponentStatus } from '@openmemo/shared';
import { Button } from '../../../components/common/Button';
import { StatusChip } from '../../../components/common/StatusChip';
import { formatBytes } from '../../../lib/format/bytes';

/**
 * Component inventory — "where did this come from" and "is there a newer version".
 *
 * Both halves are explicit user requests:
 *   「只要写明从哪里下载对应依赖即可」 → provenance is rendered on screen, with clickable
 *     links to the upstream repo and the exact release, not buried in a JSON file.
 *   「检测上游组件对应版本然后灵活更新各个组件」 → each row shows pinned vs upstream and
 *     offers a per-component update button.
 *
 * ★ Updating is never automatic. An upstream release can change format outright — we
 * already shipped a VAD entry where ONNX vs ggml silently broke whisper.cpp — and a silent
 * update would make a user's transcription results change with no visible cause. So a new
 * version is only ever an offer.
 */

/** Version-check outcome. `unknown` must never render like `latest`. */
function versionState(c: ComponentStatus): { tone: 'good' | 'warning' | 'neutral'; label: string } {
  if (c.updateAvailable) return { tone: 'warning', label: '有新版本' };
  if (c.latestVersion) return { tone: 'good', label: '已是最新' };
  return { tone: 'neutral', label: '未检测' };
}

export interface ComponentsPanelProps {
  components: ComponentStatus[];
  online: boolean;
  checkedAt: string | null;
  locale: string;
  checking: boolean;
  updatingId: string | null;
  onCheck: () => void;
  onUpdate: (c: ComponentStatus) => void;
  onRollback: (c: ComponentStatus) => void;
}

export function ComponentsPanel({
  components,
  online,
  checkedAt,
  locale,
  checking,
  updatingId,
  onCheck,
  onUpdate,
  onRollback,
}: ComponentsPanelProps) {
  const updatable = components.filter((c) => c.updateAvailable).length;

  return (
    <section
      className="rounded-lg border border-line bg-surface-1 p-4"
      data-testid="components-panel"
      aria-label="组件与来源"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-ink">组件与来源</h2>
          <p className="mt-0.5 text-xs text-ink-secondary">
            每个组件从哪里下载、钉在哪个版本、上游有没有新版本。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {checkedAt ? (
            <span className="text-[11px] text-ink-muted">
              {new Date(checkedAt).toLocaleString(locale)} 检查
            </span>
          ) : null}
          <Button size="sm" variant="secondary" onClick={onCheck} disabled={checking}>
            {checking ? '检查中…' : '检查更新'}
          </Button>
        </div>
      </div>

      {!online && checkedAt ? (
        // Distinguish "checked and everything is current" from "could not ask".
        <p className="mt-2 rounded border border-line bg-surface-0 px-2.5 py-1.5 text-xs text-ink-secondary">
          没能连上任何上游，下面的「未检测」表示<strong>不知道</strong>，不代表已是最新。
          已安装的组件不受影响，照常可用。
        </p>
      ) : null}

      {updatable > 0 ? (
        <p className="mt-2 text-xs text-warning">
          {updatable} 个组件有新版本。更新不会自动进行 —— 上游换版本可能改变行为，由你决定何时更新。
        </p>
      ) : null}

      <ul className="mt-3 space-y-3">
        {components.map((c) => {
          const vs = versionState(c);
          const busy = updatingId === c.id;
          return (
            <li
              key={c.id}
              className="rounded border border-line bg-surface-0 p-3"
              data-testid={`component-${c.id}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{c.displayNameZh}</span>
                    <StatusChip tone={vs.tone} label={vs.label} />
                    {c.installedVersion ? (
                      <StatusChip tone="good" label="已安装" />
                    ) : (
                      <StatusChip tone="neutral" label="未安装" />
                    )}
                  </div>

                  {/* 版本三元组：钉的 / 装的 / 上游 —— 三者可能都不同，分开显示 */}
                  <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                    <dt className="text-ink-muted">目录钉定</dt>
                    <dd className="font-mono text-ink">{c.pinnedVersion}</dd>
                    <dt className="text-ink-muted">本机已装</dt>
                    <dd className="font-mono text-ink-secondary">{c.installedVersion ?? '—'}</dd>
                    <dt className="text-ink-muted">上游最新</dt>
                    <dd className="font-mono text-ink-secondary">
                      {c.latestVersion ?? (c.checkError ? `未知（${c.checkError}）` : '未检测')}
                    </dd>
                  </dl>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  {c.updateAvailable ? (
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
                    <Button size="sm" variant="ghost" onClick={() => onRollback(c)} disabled={busy}>
                      <RotateCcw className="size-3.5" aria-hidden />
                      回滚到 {c.rollbackVersion}
                    </Button>
                  ) : null}
                </div>
              </div>

              {/* ★ 来源：用户明确要求"写明从哪里下载" —— 放在页面上，不是只躺在 json 里 */}
              <div className="mt-2.5 border-t border-line pt-2 text-xs">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <a
                    href={c.provenance.repoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-accent hover:underline"
                  >
                    <ExternalLink className="size-3" aria-hidden />
                    上游仓库
                  </a>
                  <a
                    href={c.provenance.releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-accent hover:underline"
                  >
                    <ExternalLink className="size-3" aria-hidden />
                    发布页
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
                </div>

                {c.provenance.submodulePath ? (
                  // Completes the chain on screen: source → release → binary → digest.
                  <p className="mt-1 flex items-center gap-1 text-[11px] text-ink-muted">
                    <GitCommitHorizontal className="size-3" aria-hidden />
                    源码 submodule {c.provenance.submodulePath} @{' '}
                    <code className="font-mono">{c.provenance.submoduleCommit?.slice(0, 12)}</code>
                  </p>
                ) : null}

                {c.sha256 && c.sha256 !== 'n/a' ? (
                  <p className="mt-1 flex items-center gap-1 text-[11px] text-ink-muted">
                    <ShieldCheck className="size-3" aria-hidden />
                    <code className="truncate font-mono">sha256:{c.sha256}</code>
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
