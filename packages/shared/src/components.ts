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

  /**
   * 上游检查此刻的结论 —— **一个判别联合，不是四个互相依赖的字段**。
   *
   * 这里原来是四个字段：`latestVersion: string|null` + `updateAvailable: boolean` +
   * `checkError: string|null` + `checkedAt: string|null`。名义上 16 种组合，
   * 合法的只有 3 种；不变量在 `listComponents()` 里建立，然后在 UI 层
   * **被重新推导一遍**（`ComponentCard.checkState()` 读 `updateAvailable || latestVersion`，
   * `ComponentsPage` 读 `!updateAvailable && !latestVersion`）。
   * 那是**两处独立的约定，不是一个结构** —— 它们今天恰好推导得一致，
   * 而"恰好一致"不是任何人能依赖的东西。
   *
   * 同族的先例：{@link ../toolchain.ts ToolchainVerdict}（`unknown` 结构上放不下
   * `missing`）、{@link ../models.ts SpeedEvidence}（`unmeasured` 结构上放不下 `rtf`）。
   * 判据一样：**让错误的写法不可表达，好过用纪律要求别人别那么写。**
   */
  upstreamCheck: UpstreamCheck;

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

/**
 * 这一次 `GET /api/components` **有没有去问上游**，问到了多少。
 *
 * 原形状是 `{ online: boolean; checkedAt: string | null }` —— 与 `ComponentStatus`
 * 那四个字段同病：`online: false` 同时表示「没查」和「查了但一个都没答」，
 * 靠 `checkedAt` 是不是 null 去二次推断。页面上真的这么写着：
 * `{data?.checkedAt && !data.online ? …}` —— 一个由两个字段拼出来的第三态。
 */
export type UpstreamSweep =
  | {
      /** 这次请求根本没去问上游（`?check` 没带，或带了但没被识别）。 */
      readonly kind: 'not-attempted';
    }
  | {
      readonly kind: 'attempted';
      readonly at: string;
      /** 问到了几个（拿到版本号的）。0 表示一个都没问到，**不表示都最新**。 */
      readonly reached: number;
      /** 这次一共问了几个。 */
      readonly total: number;
    };

export interface GetComponentsResponse {
  components: ComponentStatus[];
  sweep: UpstreamSweep;
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
 * ⚠️ 这个任意次序**不构成任何关于新旧的断言**。跨方案时它挑出来的那个"最新"
 * 只是字典序的产物 —— 所以 `checkUpstream` 除了这个 `version` 之外，还必须上报
 * `newestByScheme`（每族各自的最新）与 `candidates`（全部候选），
 * 让 `listComponents()` 按我们钉的那一族去挑，并且能看出"我们钉的那一版
 * 压根不在这个仓的命名空间里"。
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

/* ══════════════════════════════════════════════════════════════════════════════════════
 * 上游检查的结论 —— 判别联合
 *
 * ★★ **它和上面那个 {@link InstalledVersion} 是一对，要一起读。**
 *
 * 「该不该给这张卡一颗按钮」这个判断有**两条腿**，各自都是三/四态，各自都有
 * "答不出来"的那一格：
 *
 * | 问的是 | 联合 | 判据 |
 * |---|---|---|
 * | **本地**：这台机器上装的是哪一版 | {@link InstalledVersion} | {@link pinRelation} |
 * | **上游**：外面有没有更新的 | {@link UpstreamCheck} | {@link upstreamHasNewer} |
 *
 * 两侧"答不出来"的那些格子**对得上，但故意不同名**，对照如下：
 *
 * | 情形 | 上游侧 | 本地侧 |
 * |---|---|---|
 * | **这个概念对它不适用** | `no-upstream` | `not-applicable` |
 * | 有数据，但和我们的排不出先后 | `indeterminate` | —（见下） |
 * | 还没做这件事 | `never-checked` | —（读本地清单没有"还没读"这一态） |
 * | 做了但失败了 | `failed` | —（同上） |
 *
 * **为什么不统一命名成一个词**（这是刻意的，不是漏掉的）：
 *   1. `no-upstream` **点出了缺的是什么**（没有上游发布源）。上游侧只有这一种"不适用"，
 *      所以名字可以具体。本地侧的 `not-applicable` 得同时装下两种成因
 *      （后端包只有 `engineVersion`、模型只有 `catalogVersion`，两者都不是同一套编号），
 *      名字只能泛，具体的话交给它的 `reason`。**把具体的改泛，是丢信息。**
 *   2. 真正要一致的**不是名字，是契约**，而那一条两边确实一致：
 *      **凡是"答不出来"的腿，都强制带一个会原样显示给用户的 `reason`。**
 *      说"不知道"的时候必须同时说清为什么不知道 —— 否则它在屏幕上和"没有问题"长得一样。
 *   3. 本地侧没有 `indeterminate` 的对应物，**这也是刻意的**：`pinRelation()` 问的是
 *      「装一次会不会真的改变这台机器上的东西」，那是**字符串同一性**，不是版本先后。
 *      所以它用 `===` 而不是 {@link compareVersions} —— 别"顺手"把比较器接进去，
 *      那会把「两个都认识、只是排不出先后」错判成「一样」。
 * ═══════════════════════════════════════════════════════════════════════════════════ */

export const UPSTREAM_CHECK_KINDS = [
  'never-checked',
  'no-upstream',
  'failed',
  'current',
  'newer',
  'indeterminate',
] as const;
export type UpstreamCheckKind = (typeof UPSTREAM_CHECK_KINDS)[number];

/**
 * 我们装的那个二进制**是谁发的** —— 与「我们问版本问的是谁」不一定是同一个仓。
 *
 * `[实测 2026-08-11]` 27 条组件里 **5 条**是 `our-mirror`，全是 whisper.cpp：
 * `whispercpp-{cpu,vulkan}-linux-x64` / `whispercpp-{cpu,vulkan}-win-x64` /
 * `whispercpp-metal-macos-arm64`。它们问 `ggml-org/whisper.cpp`，
 * 而二进制来自 `faorcoek042/openmemo`（我们自己编的 —— 上游在这些平台
 * 只发库 / 不发可执行程序）。
 *
 * ⚠️ **不要一刀切成"provenance.repoUrl 与 upstream.repo 不同就是镜像"。**
 * 判据是 `provenance.releaseUrl` 的 GitHub owner/repo，而且**只对 GitHub 那两种 kind 生效**：
 *   · `npm`（`sherpa-onnx-node`）—— npm registry **既是版本来源也是制品来源**，
 *     `provenance.repoUrl` 指向 GitHub 只是"项目主页"，不是镜像关系；
 *   · `huggingface`（`asr/whisper-large-v3-turbo-q5_0`）—— 同理，HF 两者皆是。
 * 这两条**不是** `our-mirror`。
 *
 * `[实测]` 这个判据不需要给 manifest 加新字段：`provenance.releaseUrl` 与
 * `backends.json` 里真正的下载 URL **14/14 个包完全一致**，事实本来就在数据里，
 * 只是从来没人把它读出来。
 */
export type BinarySource =
  | {
      /** 问版本的地方就是发二进制的地方。 */
      readonly kind: 'same-source';
      readonly repo: string;
    }
  | {
      /**
       * **问版本的仓 ≠ 二进制来源的仓。**
       *
       * 「上游有 vX」是关于**项目**的真话，但它**没有回答**用户真正在问的那句：
       * 「存在一个我们能装的 vX 二进制包吗？」——那要等我们自己重编并镜像。
       * 产品决定（2026-08-11 用户裁决）：**如实说「上游有新版，但我们还没镜像」**，
       * 不新增镜像构建线，也不藏起来。
       */
      readonly kind: 'our-mirror';
      /** 我们问版本的那个上游项目仓。 */
      readonly versionRepo: string;
      /** 二进制实际来自的那个仓（我们自己的）。 */
      readonly binaryRepo: string;
    };

/**
 * 「上游有没有更新的版本」此刻的结论。
 *
 * ⚠️ 这六条腿里有**三条**在旧形状里挤在同一格（`latestVersion === null`），
 * 而界面对那一格说的是「我们**没能问到**上游 …… 点『检查更新』**重试**」——
 * 一句**试过、失败了**的话。首屏 27 条全落在这一格，而 daemon 一次都没问过。
 * 对 `no-upstream` 说"重试"更糟：那是对一个**结构上就没有上游可问**的东西
 * 指一条死路。
 *
 * 各腿的字段是**按"这一态真的知道什么"给的**，不是给全再填 null：
 * `never-checked` 连 `checkedAt` 都没有（没查过哪来的时刻），
 * `no-upstream` 也没有（不需要问，也就没有"问的时刻"）。
 */
export type UpstreamCheck =
  | {
      /** 从来没查过。**这是首屏的常态**，不是错误，不该说"没能问到"。 */
      readonly kind: 'never-checked';
    }
  | {
      /**
       * 这个组件**结构上就没有上游可问**（`upstream: null`，或 `kind: 'static'`）。
       * 对它说"重试"是把人送上死路 —— 再点一百次也还是没有上游。
       */
      readonly kind: 'no-upstream';
      readonly reason: string;
    }
  | {
      /** 问了，但没问到（超时 / 限流 / 仓库改名 / 断网）。**重试是真的有意义的那一档。** */
      readonly kind: 'failed';
      readonly checkedAt: string;
      readonly reason: string;
    }
  | {
      /** 问到了，而且上游没有比我们钉的更新的。这一档**才**配绿勾。 */
      readonly kind: 'current';
      readonly checkedAt: string;
      readonly version: string;
    }
  | {
      /** 问到了，上游确实更新。 */
      readonly kind: 'newer';
      readonly checkedAt: string;
      /** 上游那个**项目**发到了哪一版。这是真话，照实说。 */
      readonly version: string;
      /**
       * ★★ **上游发了新版 ≠ 存在一个我们能装的新版二进制包。**
       *
       * 这条腿**结构上**必须同时带上后者。理由不是洁癖：PR #19 刚删掉的那颗骗人按钮，
       * 犯的正是"只说前半句"这个错 —— 它承诺了一个版本号，而服务端从来装不到。
       * **同一个错不要在同一栏里再犯第二次。** 把它放进结构而不是文案里，
       * 是因为文案会被翻译、会被改，结构不会。
       */
      readonly binarySource: BinarySource;
    }
  | {
      /**
       * 问到了一个版本号，但**没法和我们钉的那个比**。
       *
       * ⚠️ 这一档在旧形状里被渲染成**绿勾「已是最新」**（`updateAvailable === false`
       * 且 `latestVersion !== null` ⇒ `checkState() === 'current'`）——
       * **UNKNOWN 塌成 PASS**，本轮最该修的一处。
       */
      readonly kind: 'indeterminate';
      readonly checkedAt: string;
      /** 我们确实问到的那个版本号（照实显示），只是**排不出先后**。 */
      readonly version: string;
      /** 为什么排不出先后 —— 必填，跟 `ToolchainVerdict.unknown` 同一条纪律。 */
      readonly reason: string;
    };

/**
 * 新增腿时让所有消费点变红的陷阱。
 *
 * 抄的是 `models.ts` 的 `assertNeverSpeed`：`switch` 少写一条腿，`default` 收到的
 * 就不再是 `never`，**构建直接红**，而不是新腿悄悄走进某个运行时兜底分支。
 */
export function assertNeverUpstreamCheck(x: never, what = 'UpstreamCheck'): never {
  throw new Error(`unhandled ${what}: ${JSON.stringify(x)}`);
}

/**
 * **唯一**允许用来回答「要不要提示用户有新版本」的入口。
 *
 * 只有 `newer` 是 true。`indeterminate` 是 false —— 但那**不代表已是最新**，
 * 所以任何要画绿勾的地方都不许用 `!upstreamHasNewer(u)` 当判据，
 * 必须显式判 `kind === 'current'`。
 */
export function upstreamHasNewer(u: UpstreamCheck): boolean {
  return u.kind === 'newer';
}

/**
 * 我们**确实问到**的那个上游版本号；没问到时是 `null`。
 *
 * **故意不叫 `version`。** `u.version === null` 读起来太像"已是最新"了；
 * `upstreamKnownVersion(u) === null` 读起来是它真正的意思：**我们不知道**。
 * 同一条纪律见 `toolchain.ts` 的 `toolchainMissing`（它也故意不叫 `missing`）。
 */
export function upstreamKnownVersion(u: UpstreamCheck): string | null {
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

/*
 * ⚠️ 这里原本还有一个 `upstreamCheckedAt(u): string | null`。**删掉了，因为零调用方** ——
 * CI 的 orphan-exports 门禁把它逮住了，而它说得对：那不是死代码，是**功能只做了一半**。
 * 真实需求是页面顶部那一句"什么时候查的"，而那一句读的是
 * `GetComponentsResponse.sweep.at`（一次扫描一个时刻），不是每条组件各自的 `checkedAt`。
 * 单条组件的 `checkedAt` 今天没有渲染点；真要显示时，直接判 `kind` 取即可 ——
 * 那正是判别联合的用法，不需要一个绕过 `kind` 的取值器。
 */

/**
 * 由「上游给的版本」+「我们钉的版本」推出结论。
 *
 * **全仓唯一的 `UpstreamCheck` 构造点在 `packages/downloader/src/components.ts` 的
 * `listComponents()`**，这里只提供算法，不要在别处再拼一个。
 *
 * 注意 `older` 也映射成 `current`：上游最新的比我们钉的还旧，确实"没有更新可拿"。
 */
export function upstreamVerdict(args: {
  pinnedVersion: string;
  upstreamVersion: string;
  checkedAt: string;
  /** 必填 —— 见 `UpstreamCheck` 的 `newer` 腿：不说清二进制来自哪，就报不出"有新版本"。 */
  binarySource: BinarySource;
}): UpstreamCheck {
  const { pinnedVersion, upstreamVersion, checkedAt, binarySource } = args;
  switch (compareVersions(upstreamVersion, pinnedVersion)) {
    case 'newer':
      return { kind: 'newer', checkedAt, version: upstreamVersion, binarySource };
    case 'older':
    case 'same':
      return { kind: 'current', checkedAt, version: upstreamVersion };
    case 'incomparable':
      return {
        kind: 'indeterminate',
        checkedAt,
        version: upstreamVersion,
        reason:
          `上游给的 ${upstreamVersion}（${versionScheme(upstreamVersion)} 方案）与目录钉的 ` +
          `${pinnedVersion}（${versionScheme(pinnedVersion)} 方案）不是同一套编号，排不出先后`,
      };
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════
 * `GET /api/components?check=…` 的参数 —— **只有一份定义**
 * ═══════════════════════════════════════════════════════════════════════════════════ */

/**
 * ★ 这一对函数存在的唯一理由：**同一个参数曾经有三份互不相同的定义。**
 *
 * `[实测 2026-08-11]`
 *   - 前端发的是 `?check=true`（`apps/web/src/features/components/api.ts`）
 *   - 真 daemon 认的是 `=== '1'`（`apps/daemon/src/http/rest/components.ts`）
 *   - 参考服务器认的是 `=== 'true'`（`packages/downloader/scripts/reference-server.mjs`）
 *
 * 于是前端对上了**参考服务器**，没对上真 daemon：真 daemon 收到 `check=true`
 * 会返回 **200 + 完整清单 + 一次上游都没问**，静默地什么都没做。
 *
 * ⚠️ 口径要准：`useComponentsQuery(true)` **今天全仓没有调用方**，
 * 所以这是**休眠的雷，不是正在害人的 bug**。但只要有人按直觉打开自动检查，
 * 第一脚就踩上，而且症状是"页面看起来正常，只是永远说未检测"——最难查的那一种。
 *
 * 修法不是把三处改成同一个字面量（那还会再漂一次），是**让它没有第二份**：
 * 拼参数与解参数都只能走这里。
 */
export const COMPONENTS_CHECK_PARAM = 'check';

/** 前端拼 query string 的唯一入口。 */
export function componentsQueryString(check: boolean): string {
  return check ? `?${COMPONENTS_CHECK_PARAM}=1` : '';
}

/**
 * 服务端解这个参数的唯一入口。
 *
 * 宽进严出：`1` / `true` / `yes` / 空串（`?check`）都算真 —— 因为**收紧它救不了任何人**，
 * 只会让另一个手拼 URL 的调用方再踩一次同样的静默失败。其余一律假。
 */
export function parseComponentsCheckParam(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === '';
}
