/**
 * Component provenance and upstream version tracking.
 *
 * Answers two questions the user asked for directly:
 *   1. "这个东西是从哪来的" — every component records its upstream repo, release page and
 *      license, and the UI shows them. Provenance must be visible, not buried in JSON.
 *   2. "检测上游对应版本然后灵活更新各个组件" — every component records HOW to query its
 *      upstream for newer releases, so we can say "you have X, upstream has Y".
 *
 * DESIGN RULE — pinning and updating are not in conflict:
 *   A manifest always pins an exact version + sha256. Update checking never changes what
 *   is installed; it only reports that a newer pin exists. The user clicks to move.
 *   Auto-updating would be actively harmful here: an upstream release can change format
 *   (we already shipped a VAD entry where ONNX vs ggml silently broke whisper.cpp), and a
 *   silent update would make a user's transcripts change for no visible reason.
 */

/** How to ask an upstream project what its latest release is. */
export const UPSTREAM_KINDS = ['github-release', 'github-tag', 'npm', 'huggingface', 'static'] as const;
export type UpstreamKind = (typeof UPSTREAM_KINDS)[number];

export interface UpstreamSource {
  kind: UpstreamKind;
  /** "owner/repo" for GitHub, package name for npm, "org/model" for HF. */
  repo: string;
  /**
   * Only consider releases whose tag matches this pattern.
   *
   * Needed because some projects publish several tag families from one repo — BtbN's
   * FFmpeg-Builds carries both a moving `latest` and immutable `autobuild-<date>` tags,
   * and llama.cpp uses `b<number>`. Without a filter, "latest release" can return a tag
   * we must never pin to.
   */
  tagPattern?: string;
  /** Ignore prereleases when picking the newest. */
  stableOnly?: boolean;
  /**
   * 为什么这一条**可以**不过滤 prerelease —— 放宽一条既有约束时必须写下来的那句话。
   *
   * ★ T-163 加的。起因是 macOS 的 ffmpeg：上游 jellyfin-ffmpeg 把 8.x 全部标成
   * `prerelease=true`，于是 `stableOnly: true` 在那一条上过滤掉的不是「不稳定的版本」，
   * 而是**整个 8.x 世代** —— 它把组件永久钉死在 7.x，而这件事从字段名上完全看不出来。
   *
   * 判据不是"这个布尔值是什么"，是**"改它的人有没有说清楚为什么这一条例外"**。
   * 一个悄悄从 true 翻成 false 的布尔值，和一条写下了代价与对冲的例外，
   * 在 diff 里长得一样 —— 这个字段就是把它们分开的地方。
   * 守卫见 `apps/daemon/src/pipeline/ffmpegStableOnly.test.ts`。
   */
  stableOnlyReason?: string;
}

/** Human-facing provenance. Rendered in the UI — this is the "where is it from" answer. */
export interface Provenance {
  /** Upstream project homepage or repo, e.g. https://github.com/ggml-org/whisper.cpp */
  repoUrl: string;
  /** The exact release page this pin came from. */
  releaseUrl: string;
  license: string;
  licenseUrl: string;
  /**
   * Source submodule commit, when we also vendor the source.
   *
   * ADR-001 keeps `vendor/*` submodules for source traceability even though runtime
   * binaries are downloaded. Surfacing the pinned commit completes the chain on screen:
   * source → release → binary → sha256.
   */
  submodulePath?: string;
  submoduleCommit?: string;
}

/** One updatable component as presented to the UI. */
export interface ComponentStatus {
  id: string;
  displayName: string;
  displayNameZh: string;
  /** "backend-pack" | "model" | "sqlite-ext" | "media-tool" */
  category: string;

  /** Version pinned in the git-committed manifest. Always known. */
  pinnedVersion: string;
  /** Version actually present on this machine; null when not installed. */
  installedVersion: string | null;
  /** Newest upstream version, or null when the check failed or was never run. */
  latestVersion: string | null;

  /**
   * True only when latestVersion is known AND differs from pinnedVersion.
   * Never inferred from a failed lookup — "unknown" must not render as "up to date".
   */
  updateAvailable: boolean;
  /** Why latestVersion is null, shown as a quiet note rather than an error. */
  checkError: string | null;
  checkedAt: string | null;

  provenance: Provenance;
  upstream: UpstreamSource | null;
  sizeBytes: number;
  sha256: string;
  /**
   * Where this digest came from, in plain language.
   *
   * "upstream API said so" and "we downloaded every byte and hashed it ourselves" are
   * different strengths of evidence — the first trusts that the upstream registry has not
   * been compromised, the second trusts only the bytes. Collapsing them into one opaque
   * hash string overstates how much we actually know, so the UI shows this next to it.
   */
  sha256Provenance?: string | null;
  /** Previous version retained on disk, enabling one-click rollback. */
  rollbackVersion: string | null;
}

export interface GetComponentsResponse {
  components: ComponentStatus[];
  /** Whether the last upstream sweep reached the network at all. */
  online: boolean;
  checkedAt: string | null;
}

export interface CheckUpdatesRequest {
  /** Restrict to specific component ids; omit to check all. */
  ids?: string[];
}

export interface UpdateComponentRequest {
  id: string;
  /** Target version; omit to take the newest known. */
  toVersion?: string;
}

/**
 * Compare two upstream version strings.
 *
 * Handles the three shapes our upstreams actually use:
 *   semver-ish   v1.9.1 / 0.1.9
 *   build number b10223            (llama.cpp)
 *   date tag     autobuild-2026-08-02-13-17  (BtbN FFmpeg-Builds)
 *
 * Returns >0 if `a` is newer, <0 if older, 0 if equal/incomparable. Incomparable pairs
 * deliberately return 0 so an unrecognised scheme reports "no update" rather than
 * nagging the user to "upgrade" to something we cannot actually order.
 */
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  const dateA = /(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})-(\d{2}))?/.exec(a);
  const dateB = /(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})-(\d{2}))?/.exec(b);
  if (dateA && dateB) {
    const key = (m: RegExpExecArray) => m.slice(1).map((x) => Number(x ?? 0));
    const ka = key(dateA);
    const kb = key(dateB);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const d = (ka[i] ?? 0) - (kb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  }
  const buildA = /^b(\d+)$/.exec(a);
  const buildB = /^b(\d+)$/.exec(b);
  if (buildA && buildB) return Number(buildA[1]) - Number(buildB[1]);

  const numsA = a.replace(/^v/, '').split(/[.\-+]/).map((x) => Number(x)).filter((x) => Number.isFinite(x));
  const numsB = b.replace(/^v/, '').split(/[.\-+]/).map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (numsA.length && numsB.length) {
    for (let i = 0; i < Math.max(numsA.length, numsB.length); i++) {
      const d = (numsA[i] ?? 0) - (numsB[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  }
  return 0; // incomparable → report no update rather than guess
}
