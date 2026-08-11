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
export const UPSTREAM_KINDS = [
  'github-release',
  'github-tag',
  'npm',
  'huggingface',
  'static',
] as const;
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

  /**
   * Version pinned in the git-committed manifest. Always known.
   *
   * ⚠️ For components that also appear as a backend/sqlite-ext pack, this is NOT
   * guaranteed to equal that pack's `engineVersion` (see the doc comment there for the
   * full explanation and the 2026-08-09 count: 3 of 23 overlapping ids differ, all
   * `media-tools-*`). This field records the release/tag identifier we actually pinned
   * when fetching the artifact; `engineVersion` records what the binary itself reports
   * as its version. Same underlying artifact, two independently-sourced facts about
   * it — not synonyms, despite the similar names.
   */
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

/**
 * `POST /api/components/:id/update`。
 *
 * ⚠️ **只有 `id`。** 这里原来还有一个 `toVersion?: string`（"Target version; omit to
 * take the newest known"）—— 那句注释描述的是一个**服务端从来没有过**的能力：
 * 该路由**不读请求体**（`rest/components.ts` 那 55 行里 `readBody` 出现 0 次），
 * 直接 `startPackInstall()` 装**目录里钉死的那一版**，并回 `toVersion: pinnedVersion`。
 *
 * 它不只是"没人读"这么简单：前端把它编进了 `idempotencyKey`
 * （`component-update:<id>:<toVersion>`），于是「更新到 1.9.2」和「更新到 1.9.3」
 * 被当成**两个不同的请求**，而它们做的是**同一件事**（装钉死那一版）。
 *
 * 「服务端算了没人读」的镜像面：**客户端发了、服务端从不读，而那个字段正好是
 * 界面上那句假话的载体。** 拿掉它，形状上就说不出那句话了。
 */
export interface UpdateComponentRequest {
  id: string;
}

/* ══════════════════════════════════════════════════════════════════════════════════════
 * 版本比较 —— **三态，第三态是「比不了」，不是 0**
 * ═══════════════════════════════════════════════════════════════════════════════════ */

/**
 * 一个版本字符串属于哪一套编号方案。
 *
 * **方案不同就是比不了。** 这不是保守，是事实：`v1.9.1` 是 whisper.cpp 的版本号，
 * `model-mirror-2026.08.06` 是我们镜像仓的日期 tag —— 它们之间没有"谁更新"这回事，
 * 就像问「第 3 章」和「星期二」哪个大。
 */
export const VERSION_SCHEMES = ['semver', 'date', 'build', 'opaque'] as const;
export type VersionScheme = (typeof VERSION_SCHEMES)[number];

/** `b10223` —— llama.cpp 的构建号。**必须排在 hex 判定之前**：`b10223` 六个字符全是合法十六进制。 */
const RE_BUILD = /^b(\d+)$/;
/** `2026-08-02-13-17` / `2026.08.06` —— 带或不带前缀（`autobuild-…` / `model-mirror-…`）。 */
const RE_DATE = /(\d{4})[.-](\d{2})[.-](\d{2})(?:[.-](\d{2})[.-](\d{2}))?/;
/** 裸 commit sha。要求至少一个字母，否则 `1234567` 这种纯数字会被当成 sha。 */
const RE_SHA = /^[0-9a-f]{7,40}$/i;
/** `v1.9.1` / `1.13.5` / `v8.1.2-2` / `v0.1.10-alpha.4`。 */
const RE_SEMVER = /^v?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/;

/** 判断一个版本字符串用的是哪套编号方案。顺序有意义，见各条注释。 */
export function versionScheme(v: string): VersionScheme {
  if (RE_BUILD.test(v)) return 'build';
  if (RE_DATE.test(v)) return 'date';
  if (RE_SHA.test(v) && /[a-f]/i.test(v)) return 'opaque';
  if (RE_SEMVER.test(v)) return 'semver';
  return 'opaque';
}

/**
 * 两个版本的先后关系。
 *
 * `incomparable` 是**独立的一态**，不再和 `same` 挤在 `0` 里。这四种可能里有两种
 * 是坏消息，而它们的坏法**相反**：
 *   - `same` 说「你已经是最新的」→ 可以画绿勾；
 *   - `incomparable` 说「我没能判断」→ **绝不能画绿勾**，它是 UNKNOWN，不是 PASS。
 * 旧的 `number` 返回值把这两件事写成同一个 `0`，于是每个调用点都要靠约定去分辨，
 * 而 `> 0` 这个写法**把两者一起塞进了"没有更新"那一档**。
 */
export const VERSION_ORDERS = ['newer', 'older', 'same', 'incomparable'] as const;
export type VersionOrder = (typeof VERSION_ORDERS)[number];

/**
 * `a` 相对 `b` 是更新、更旧、相同，还是**比不了**。
 *
 * ★★ `[实测 2026-08-11，对 packages/shared/dist 跑的]` 改之前，**两个方向都在出错**：
 *
 * | a vs b | 旧的 `number` | 旧结论 | 现在 |
 * |---|---|---|---|
 * | `model-mirror-2026.08.06` vs `v1.9.1` | **2025** | 假的「有新版本」（线上正在发生） | `incomparable` |
 * | `2024-11-03` vs `v1.9.1` | **2023** | 假的「有新版本」 | `incomparable` |
 * | 两个不同的 commit sha | **0** | 假的「已是最新」（绿勾） | `incomparable` |
 * | `b10223` vs `v1.9.1` | **0** | 假的「已是最新」（绿勾） | `incomparable` |
 * | `v1.9.2` vs `v1.9.1` | 1 | 对照组，正确 | `newer` |
 *
 * 前两行的成因是同一个：日期分支要求**两侧都**匹配日期正则，只有一侧匹配时就
 * 静默掉进数字分支，于是 `2026` 被当成主版本号去和 `1` 比。
 * 后两行的成因也是同一个：走到最后 `return 0`，而调用方读的是 `> 0`。
 *
 * **先分方案，方案不同一律 `incomparable`，方案相同再比** —— 这样"漏配 tagPattern"
 * 之类的配置错误不会再静默地变成一句假话。
 */
export function compareVersions(a: string, b: string): VersionOrder {
  if (a === b) return 'same';

  const sa = versionScheme(a);
  const sb = versionScheme(b);
  if (sa !== sb) return 'incomparable';

  // 不透明字符串（commit sha、`latest` 这种移动 tag）**只有相等可判**，
  // 而 a === b 已经在开头返回了 —— 走到这里就是两个不同的 sha，它们没有先后。
  if (sa === 'opaque') return 'incomparable';

  const key = (v: string): number[] => {
    if (sa === 'build') return [Number(RE_BUILD.exec(v)?.[1] ?? 0)];
    if (sa === 'date') {
      const m = RE_DATE.exec(v);
      return m ? m.slice(1).map((x) => Number(x ?? 0)) : [];
    }
    return v
      .replace(/^v/, '')
      .split(/[.\-+]/)
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x));
  };

  const ka = key(a);
  const kb = key(b);
  // 同方案却一个数字都抠不出来 —— 依旧是"比不了"，不是"相等"。
  if (!ka.length || !kb.length) return 'incomparable';
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d > 0) return 'newer';
    if (d < 0) return 'older';
  }
  return 'same';
}

/**
 * **只用来排序候选列表**的比较器 —— 不许拿它判「有没有更新」。
 *
 * 排序需要一个全序，而"比不了"在全序里没有位置。这里把跨方案的一对压成一个
 * **确定但任意**的次序（按方案名、再按字典序），好让 `sort()` 的结果可复现。
 *
 * ⚠️ 这个任意次序**不构成任何关于新旧的断言**。"跨方案的候选里哪个最新"没有定义 ——
 * 这里挑出来的那个只是排序 tie-break 的产物。真正的保护在 `listComponents()`：
 * 挑出来的版本一旦与我们钉的**比不了**，就当成"没问到"而不是"已是最新"。
 * （把"候选跨了多个 tag 家族"本身变成一条会说话的腿，是 #66 主线那一步的事。）
 */
export function compareVersionsForSort(a: string, b: string): number {
  switch (compareVersions(a, b)) {
    case 'newer':
      return 1;
    case 'older':
      return -1;
    case 'same':
      return 0;
    case 'incomparable': {
      const sa = versionScheme(a);
      const sb = versionScheme(b);
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    }
  }
}
