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
  /**
   * 本机上装着的是哪一版 —— **三态**，见 {@link InstalledVersion}。
   *
   * ⚠️ 这里原来是 `string | null`，而 `null` 只够表达「没装」。第三种情形
   * ——「装了，但这份安装记录里根本没有一个能和 `pinnedVersion` 比较的版本号」——
   * 无处可放，于是被写成了字符串哨兵 `'installed'`，
   * 详见 {@link installedVersionOf} 与 {@link pinRelation}。
   */
  installedVersion: InstalledVersion;
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

/* ══════════════════════════════════════════════════════════════════════════════════════
 * 「本机已装的版本」—— **三态，第三态是「这个概念对这份记录不适用」**
 * ═══════════════════════════════════════════════════════════════════════════════════ */

/**
 * ★★ 为什么这里必须是一个联合，而不是 `string | null`。
 *
 * `packages/downloader/src/components.ts` 的 `readInstalledVersions()` 头上写着规格原话：
 *
 *   > Returns null when absent — "not installed" and "installed at an unknown version"
 *   > must not look the same to the UI.
 *
 * 而紧接着的第一行就是 `r.version ?? r.catalogVersion ?? 'installed'` ——
 * 把「装了，但这份记录里没有可比较的版本号」压成一个**长得像版本号的字符串**，
 * 正是那句规格明令禁止的事。**规格没错，是代码偏离了它。**
 *
 * 代价是具体的、用户机器上正在发生的：卡片那颗主按钮的判据是
 * `installedVersion !== pinnedVersion`，而哨兵 `'installed'` **永远**不等于
 * `autobuild-2026-07-31-14-10` 这种真版本号 ⇒ 判据**恒真** ⇒ 每一个随包出厂的
 * 后端包记录都长期挂着一颗「装上目录钉定的 …」按钮。点 `media-tools-win-x64` 那颗，
 * 白下 145,349,121 字节，装完卡片一个字都不变 —— 于是用户会再点一次。
 *
 * 改法照 {@link VersionOrder}（af25cf3）那一条：**把第三态提成独立的一格**，
 * 让「说不出版本号」在**类型上**就没法再冒充成一个可比较的版本号 ——
 * 而不是再加一句 `!== 'installed'` 的字符串防守（那只是给哨兵换个字面量）。
 */
export interface NotInstalled {
  readonly kind: 'not-installed';
}

/** 装了，而且这份记录里有一个**能和 `pinnedVersion` 放在一起比较**的版本号。 */
export interface KnownInstalledVersion {
  readonly kind: 'known';
  readonly version: string;
}

/**
 * 装了，但**「已安装版本」这个概念对这份记录不适用** —— 不是"还没查"，是"没有这一栏"。
 *
 * `reason` 会原样显示给用户（同 `checkError` 的待遇）：说"不知道"的时候必须一并说清
 * 为什么不知道，否则它在屏幕上和"没装"长得一样。
 */
export interface NotApplicableInstalledVersion {
  readonly kind: 'not-applicable';
  readonly reason: string;
}

export type InstalledVersion = NotInstalled | KnownInstalledVersion | NotApplicableInstalledVersion;

/** 没有安装记录的那一档。单例，省得每个调用点自己拼一个字面量。 */
export const NOT_INSTALLED: NotInstalled = { kind: 'not-installed' };

/**
 * **唯一构造点**：从一份安装记录（`manifests/<桶>/<id>.json`）里读出「本机已装的版本」。
 *
 * 全仓只有两种记录会落到这些桶里，而**它们都没有一个可比较的制品版本号**：
 *
 * | 记录 | 有什么 | 为什么不能拿去和 `pinnedVersion` 比 |
 * |---|---|---|
 * | `InstalledBackendPack` | `engineVersion` | `ComponentStatus.pinnedVersion` 的注释自己写着：两者**不是同义词**，2026-08-09 实测 23 个重叠 id 里 3 个不同（全是 `media-tools-*`）。拿它去比会给这 3 条报出假的「和钉定的不一样」。而随包出厂那份更直白：`engineVersion` 是 `BUNDLED_VERSION_UNKNOWN`（`'unknown'`）—— 又一个哨兵。 |
 * | `InstalledModel` | `catalogVersion` | 它的注释写着 "Set by the catalog build, used for staleness display" —— 是**目录快照**的版本，不是这份权重的版本；`models.ts` 的导入路径干脆写死成字面量 `'imported'`。而目录里那条模型组件的 `pinnedVersion` 是一个 commit sha（`5359861c…`），跟 `2026.08.02` 之间没有"谁更新"这回事。 |
 *
 * 所以今天的诚实答案是 `not-applicable`：**我们没有记过这些制品装的是哪一版。**
 * `known` 那一格不是摆设 —— 哪天安装器真的往记录里写一个 `version`，
 * 它立刻就有值，而在那之前**没有任何东西能伪造出一个可比较的版本号**。
 *
 * ⚠️ 想把 `engineVersion` / `catalogVersion` 接进来的人：那不是补一个字段，
 * 是先要回答"它和 `pinnedVersion` 是不是同一套编号"。上表两行就是答案，都是否。
 */
export function installedVersionOf(record: object): InstalledVersion {
  /*
   * 参数写成 `object` 而不是 `{ version?: string }`，是为了能**原样**接住
   * `InstalledBackendPack` / `InstalledModel` 这两种真记录。
   * 写成后者时 `tsc` 会报 TS2559「has no properties in common」——
   * 那条错误本身就是本次缺陷的证明（这类记录里根本没有 `version` 这一栏），
   * 但它会把真实记录挡在门外，逼调用方去写一个"看起来有版本号"的中间对象。
   */
  const r = record as { version?: unknown };
  /*
   * **只认 `version` 这一栏，而且必须是一个非空字符串。**
   *
   * 没有它就是 `not-applicable` —— 不去 `?? catalogVersion`、更不 `?? 'installed'`：
   * 那两步各自都是在"答不出来"的位置上**编一个答案**，而编出来的东西会一路流到
   * `pinRelation()` 被当成真版本号比较，最后变成屏幕上一句具体承诺了版本号的号召。
   *
   * `reason` 是要显示给用户的（同 `checkError` 的待遇）：说"不知道"的时候必须一并
   * 说清为什么不知道，否则它在屏幕上和"没装"长得一样。
   */
  if (typeof r.version === 'string' && r.version.length > 0) {
    return { kind: 'known', version: r.version };
  }
  return { kind: 'not-applicable', reason: '安装记录里没有记版本号' };
}

/**
 * 已装的那一份和目录钉的那一版是什么关系 —— **四态，第四态是「答不出来」**。
 *
 * 这是「装一次会不会真的改变这台机器上的东西」的唯一判据。四态里两态是"别给按钮"，
 * 而它们的**理由相反**：
 *   - `same-as-pinned`：一模一样，装了也白装；
 *   - `unknowable`：**我们根本不知道机器上那份是什么** —— 不许因此就假设"不一样"。
 *
 * ★ 旧写法 `installedVersion !== pinnedVersion` 把后者塞进了"不一样"那一档
 *   （`'installed' !== 'autobuild-…'` 恒真），于是「不知道」变成了一句
 *   **具体承诺了版本号**的号召 —— 与 af25cf3 里 `> 0` 把 `incomparable` 压成
 *   「没有更新」是同一台机器，只是方向反过来。
 */
export const PIN_RELATIONS = [
  'not-installed',
  'same-as-pinned',
  'differs-from-pinned',
  'unknowable',
] as const;
export type PinRelation = (typeof PIN_RELATIONS)[number];

export function pinRelation(installed: InstalledVersion, pinnedVersion: string): PinRelation {
  switch (installed.kind) {
    case 'not-installed':
      return 'not-installed';
    case 'known':
      return installed.version === pinnedVersion ? 'same-as-pinned' : 'differs-from-pinned';
    case 'not-applicable':
      return 'unknowable';
    default:
      return unrecognizedInstalledArm(installed);
  }
}

/**
 * 编译期穷尽性检查；**运行期不 throw**。
 *
 * 加一格 {@link InstalledVersion} 而忘了在上面处理，这里的参数就不再是 `never`，
 * `tsc` 当场红 —— 那是我们要的。但真跑到这一行（例如产品和 daemon 版本错配）时，
 * 让组件页整块崩掉是更坏的结果，而"没认出来"本来就该归到 `unknowable`：
 * **不给按钮、也不声称一致。**
 */
function unrecognizedInstalledArm(arm: never): PinRelation {
  void arm;
  return 'unknowable';
}
