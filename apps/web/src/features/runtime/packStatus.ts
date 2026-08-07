/**
 * 一个后端包在 `/runtime` 上该被说成什么 —— **纯决策**，不碰 DOM、不碰 i18n 文案。
 *
 * 这一整个模块只为了两件事，两件都属于「界面替 daemon 说了它没说过的话」那一族：
 *
 * ## ① `inapplicableKind` 白做了（`progress-audit §4⑪`）
 *
 * daemon 的 `rest/backends.ts` **精心区分**了三档并真的发出来：
 * `platform`（换台机器也没用）/ `undetermined`（还没探测到）/ `unsupported`（确认不支持）。
 * 它自己的注释写着这条区分要防的是什么：
 *
 * > 用户看到"不可用"会以为自己的机器不支持，然后就不装了。
 *
 * `[实测 :10000]` 这台机器上 `whispercpp-vulkan-linux-x64` 的档位是 **`undetermined`**，
 * 而界面给它渲染的芯片文案是 **「不可用」**（`runtime.chip.notInstalled`）——
 * **它想防的那件事，就是它自己造成的。**
 *
 * 为什么没人发现：契约类型 `GetBackendCatalogResponse` 里**根本没有这个字段**
 * （T-165 已补上）。daemon 发、前端收不到、TypeScript 不吭声 ——
 * 与「写得进读不回」是同一族，只是这次丢在类型上而不是序列化上。
 *
 * ## ② 「推荐」徽章等于零信息量（`progress-audit §4⑩`）
 *
 * daemon 算的是 `recommended = applicable && pack.backend === selectedBackend`。
 * `[实测 :10000]` 目录 23 个包里，本机适用的 6 个**全部** `recommended:true`
 * （whisper.cpp / media-tools / yt-dlp / libsimple / sqlite-vec …）——
 * 因为它们的 `backend` 都是 `cpu`，而选中的后端就是 `cpu`。
 * 于是一页上六个「推荐」徽章 + 六个主按钮，**没有区分任何东西**。
 *
 * 这里**不重算 daemon 的结论**（那会变成第二份"该装哪个"，两份必然漂移）。
 * 做的是一次**收窄**：服务端说不推荐的，这里永远不会说推荐；
 * 服务端说推荐、但用户**根本没得选**时，这个徽章不承载信息，所以不渲染。
 *
 * 「有没有得选」的判据是**同一个引擎下、本机平台上、还有别的后端可选**：
 *   · `engine` —— whisper.cpp 与 ffmpeg 是两件事，拿 ffmpeg 当 whisper 的"备选"是胡说；
 *   · `os/arch` —— 别的平台的包不是这台机器的选项；
 *   · `backend` 不同 —— 同一后端的两个包不构成"选哪个加速方式"的问题。
 * 判据刻意**不看 `applicable`**：probe 结果会随安装状态翻转，徽章跟着忽明忽暗
 * 只会让人以为界面在抖，而"有没有得选"这件事本身并不随之改变。
 */
import type { GetBackendCatalogResponse, InapplicableKind } from '@openmemo/shared';

export type CatalogPack = GetBackendCatalogResponse['packs'][number];

/**
 * 卡片顶端那个芯片该显示哪一档。
 *
 * `BackendChipState` 原来只有 `not-installed` 一档来装"不可用"的全部含义，
 * 而它的文案是「不可用」。现在把"不可用"拆开，各说各的话。
 */
export type PackStatus =
  /** 已装、且正是当前生效的后端 */
  | 'active'
  /** 已装 */
  | 'installed'
  /** 自检真的跑过且没过 —— 比"已安装"更该被看见 */
  | 'self-test-failed'
  /** 没装，但可以装 */
  | 'installable'
  /** os/arch 对不上：这是**别的平台**的包，不是本机的问题 */
  | 'other-platform'
  /** 还没探测到能力 —— **不是**"不支持" */
  | 'undetermined'
  /** 探测完成，确认本机没有可用设备 */
  | 'unsupported'
  /** daemon 没告诉我们是哪一档 —— 那就一个字都别替它说 */
  | 'unavailable-unknown';

export interface PackStatusInput {
  readonly installed: boolean;
  readonly applicable: boolean;
  readonly inapplicableKind?: InapplicableKind | undefined;
  /** 这个包提供的后端就是当前选中的那个，且它已经装了 */
  readonly isActive: boolean;
  /** 自检跑过并且没通过 */
  readonly selfTestFailed: boolean;
}

export function packStatus(p: PackStatusInput): PackStatus {
  if (p.isActive) return 'active';
  if (p.selfTestFailed) return 'self-test-failed';
  if (p.installed) return 'installed';
  if (p.applicable) return 'installable';
  switch (p.inapplicableKind) {
    case 'platform':
      return 'other-platform';
    case 'undetermined':
      return 'undetermined';
    case 'unsupported':
      return 'unsupported';
    default:
      /*
       * `applicable` 是 false，但 daemon 没说（或说了个我们不认识的档）。
       *
       * ★ 这里**刻意不兜底成 `unsupported`**。默认值的选法与
       * `isUsableAsset`「字段缺失 ≠ 不可用」方向相反，判据是同一条：
       * **哪个默认值会让界面说一句不成立的话。**
       * "本机不支持"是一句关于用户硬件的结论；没有证据就说它，
       * 正是 `inapplicableKind` 这个字段当初要防的那件事。
       */
      return 'unavailable-unknown';
  }
}

/** 这一档要不要在卡片上多写一行解释（`platform` 那档已经被折叠区的摘要说过了）。 */
export const STATUS_NEEDS_EXPLANATION: readonly PackStatus[] = ['undetermined', 'unsupported'];

/**
 * 「推荐」徽章 / 主按钮该不该出现。
 *
 * @param pack  要判断的那个包
 * @param all   整份目录（判断"有没有得选"必须看全集，单看一个包看不出来）
 */
export function isMeaningfulRecommendation(
  pack: Pick<CatalogPack, 'id' | 'engine' | 'os' | 'arch' | 'backend' | 'recommended'>,
  all: readonly Pick<CatalogPack, 'id' | 'engine' | 'os' | 'arch' | 'backend'>[],
): boolean {
  // 服务端说不推荐 → 永远不推荐。这个函数只会**减少**推荐，不会增加。
  if (!pack.recommended) return false;
  return all.some(
    (other) =>
      other.id !== pack.id &&
      other.engine === pack.engine &&
      other.os === pack.os &&
      other.arch === pack.arch &&
      other.backend !== pack.backend,
  );
}
