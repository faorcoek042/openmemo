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
import type {
  BackendSelfTest,
  Engine,
  GetBackendCatalogResponse,
  InapplicableKind,
} from '@openmemo/shared';

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

/* ────────────────────── 自检结果怎么念（T-166 转达的那条）────────────────────── */

/**
 * 一次自检结果在卡片上该被说成什么。
 *
 * ## 要区分的那两件事
 *
 * `daemon-backlog` T-166 把自检**钉到某一个包**上跑之后，出现了一种以前不存在的状态：
 * 跑的**确实**是 Vulkan 包里的 whisper-cli，而 ggml 在这台机器上没枚举到设备、
 * **优雅退回 CPU 算完了** —— `passed` 为真，**但加速一点没生效**。
 *
 * > 一张 Vulkan 卡片写着「自检通过」、而它其实静默跑的是 CPU ——
 * > 这两种情况在界面上此前**无法区分**。
 *
 * 「这个包能跑」≠「这个包的加速在你机器上真的用上了」。只渲染 `passed:true` 的话，
 * 那句"自检通过"就是一条不成立的证据 —— 与本仓最贵的那一族（静默降级）同形。
 *
 * ## ★ 判据用 `devicesFound`，**不解析 `backendUsed`**
 *
 * 这一条是从 T-166 那个 bug 里直接抄来的教训：
 * `backendUsed` 是 whisper 的**日志文字**（`'CPU'`、`'CPU (ggml-cpu-zen4)'`、
 * GPU 设备名、或 null），**不是 `Backend` 枚举**。T-164 拿它跟 `'cpu'` 比，
 * `'CPU' !== 'cpu'` 在每一台机器上恒真 → 回写恒被拒 → 三条 UI 分支恒不亮，
 * 而它的 6 条用例全绿，因为**用例喂的是产品从不产出的形状**。
 *
 * 所以这里**一个字符串都不比**：判据是 `devicesFound`（枚举不会撒谎，
 * R-02 §A.0；`BackendSelfTest.devicesFound` 的注释也是这么写的），
 * `backendUsed` 只**原样显示**给用户看 —— 显示原文永远是诚实的，解析它才会出错。
 *
 * ## 为什么只对非 CPU 包判
 *
 * CPU 包枚举到 0 个 GPU 设备是**正常**的，对它报"加速没生效"是假红灯，
 * 而假红灯会训练人忽略告警（HANDOFF ⑤B）。
 */
export type SelfTestVerdict =
  /** 没跑过 */
  | 'none'
  /** 跑通了，且这个包该提供的加速确实枚举到了设备 */
  | 'passed'
  /** ★ 跑通了，**但一个设备都没枚举到** —— 加速没生效，只是退回 CPU 算完了 */
  | 'passed-not-accelerated'
  /** 真失败 */
  | 'failed';

export function selfTestVerdict(
  packBackend: string,
  selfTest: BackendSelfTest | null | undefined,
): SelfTestVerdict {
  if (!selfTest) return 'none';
  if (!selfTest.passed) return 'failed';
  if (packBackend === 'cpu') return 'passed';
  return selfTest.devicesFound > 0 ? 'passed' : 'passed-not-accelerated';
}

/* ══════════════════════════════════════════════════════════════════════════════════════
 * T-192：**`pack.backend` 这个轴被当成三个用了。**
 *
 * `[实测 2026-08-10]` 目录 25 个包里 **18 个**（sqlite-ext 11 + yt-dlp 4 + ffmpeg 3）
 * 的 `backend` 都是 `'cpu'` —— 而那个字段的含义是「**用哪块算力跑推理**」，
 * 跟"这个包是不是推理包"毫无关系。于是同一个字符串被三处拿去回答三个不同的问题：
 *
 *   ① 「设为当前后端」按钮 → `select(pack.backend)`：在 libsimple / yt-dlp / ffmpeg 卡上
 *      点一下 = **一键把 whisper 从 GPU 静默降级到 CPU**，并让 `/models` 的显存预算归零
 *      （`shared/fitness.ts:182`）。可达性还正好互补：这 18 个都是 cpu，
 *      所以只有当用户**选了 cuda/vulkan/metal** 时这个按钮才出现。
 *   ② `isActive = selectedBackend === pack.backend && installed` →
 *      一个 SQLite 分词扩展的卡片上写着「CPU ⚡使用中」。
 *   ③ `isLoadBearing = tier==='builtin' || backend==='cpu'` → 这 18 个包
 *      **永远卸载不掉**（清单里没有任何 `builtin`，所以只有后半句在起作用），
 *      而 daemon 那边**照删不误** —— UI 是唯一的门，它挡下的是一个服务端支持的合法动作。
 *      用户想回收 yt-dlp / ffmpeg / libsimple 的磁盘空间，**产品里没有任何路径**。
 *
 * 修法不是"再加一个 if"，是**把三个问题各自交给能回答它的东西**：
 *
 * | 问题 | 由什么回答 |
 * |---|---|
 * | 这个包的 `backend` 是不是"算力"的意思 | `engine` —— {@link BACKEND_IS_COMPUTE_AXIS} |
 * | 这个包是不是当前活动后端 | {@link isActivePack}（先问上面那条，再比 backend） |
 * | 这个包能不能卸载 | {@link isLoadBearingPack}（对准 ggml SIGABRT 那条真实约束） |
 *
 * ⚠️ **没有给 `pack.backend` 增加新含义** —— 共用槽位正是这个 bug 的成因。
 * ══════════════════════════════════════════════════════════════════════════════════════ */

/**
 * 这个 engine 的包，`selectedBackend` 那个偏好**管不管它**。
 *
 * 换句话说：它的 `backend` 字段是不是「用哪块算力跑推理」的意思。
 *
 * ## 为什么是一张穷尽表
 *
 * 与同一个文件里 `SELF_TEST_APPLIES` 用同一个形状（`Record<Engine, boolean>`）：
 * 新加一种 engine 时**在编译期就必须表态**，而不是默默继承一个隐含假设。
 *
 * ⚠️ **它和 `SELF_TEST_APPLIES` 是两张表，不能合并** —— 它们回答的是两个问题，
 * 而且答案不同：`llama.cpp` 的 `backend` 是算力（true），但今天的自检只跑 ASR 推理，
 * 对它没有可执行的检查（false）。合成一张就是又一次共用槽位。
 */
export const BACKEND_IS_COMPUTE_AXIS: Record<Engine, boolean> = {
  /** `selectedBackend` 今天驱动的就是它（`resolveBackendTool` 按它挑 whisper-cli）。 */
  'whisper.cpp': true,
  /** 同为 ggml 推理引擎，`backend` 同义。今天目录里没有它的包。 */
  'llama.cpp': true,
  /**
   * ASR 引擎，但它走 onnxruntime 而不是 ggml，`selectedBackend` **今天不驱动它**，
   * 目录里也没有任何 sherpa 的**后端包**（sherpa 的东西都在模型目录里）。
   * 与 `SELF_TEST_APPLIES` 同一条口径：等它真被支持时再翻成 true，
   * 现在标 true 等于替一件没发生的事下结论。
   */
  'sherpa-onnx': false,
  /** 转码器 —— 不是推理引擎，它的 `backend: 'cpu'` 只是 schema 的填充值。 */
  ffmpeg: false,
  /** 下载器 —— 同上。 */
  'yt-dlp': false,
  /** SQLite 分词扩展 —— 同上。用户在它的卡片上看到「CPU ⚡使用中」。 */
  'sqlite-ext': false,
};

/**
 * 「这个包是不是**当前活动的后端**」。
 *
 * 三个条件缺一不可：它的 `backend` 得真是算力轴、它得装了、而且得正是选中的那个。
 * 少了第一条，18 张非推理包的卡片会集体亮「⚡使用中」（T-192 ②）。
 */
export function isActivePack(
  pack: Pick<CatalogPack, 'engine' | 'backend' | 'installed'>,
  selectedBackend: string | null | undefined,
): boolean {
  if (!BACKEND_IS_COMPUTE_AXIS[pack.engine]) return false;
  return pack.installed && selectedBackend === pack.backend;
}

/**
 * 「这个包**能不能卸载**」—— 判据对准的是真实约束，不是放宽。
 *
 * ## 真实约束只有一条（ADR-003 附录 A.3）
 *
 * 删光 ggml 的 CPU 后端之后，whisper.cpp 在 `ggml_backend_dev_backend_reg()` 里
 * `ggml_abort()`，进程 SIGABRT（实测 exit 134）。**这是推理引擎专属的**：
 * 删掉 yt-dlp 或 libsimple 不可能让 ggml SIGABRT。
 *
 * 所以锁只落在「**推理引擎包 ∧ 它是那个 CPU 兜底**」上。
 * 其余的包 daemon 本来就允许删（`DELETE /api/backends/:id` 照删不误），
 * 而用户明确要求过「组件要能删除、能看到空间回收，且删除不影响程序本体运行」。
 *
 * ⚠️ **不是"什么都能删"**：whisper 的 CPU 包仍然锁着，删了它转写会直接崩。
 * ⚠️ 也**不是**"删了没后果"：删掉 ffmpeg 会让转写停摆 —— 但那是**可恢复**的
 * （重新装回来即可）、daemon 允许的、而且自检里 `tool.ffmpeg` 会立刻出声。
 * 把它锁死换来的不是安全，是"用户拿不回自己的磁盘"。
 */
export function isLoadBearingPack(
  pack: Pick<CatalogPack, 'engine' | 'backend' | 'tier'>,
): boolean {
  if (!BACKEND_IS_COMPUTE_AXIS[pack.engine]) return false;
  return pack.tier === 'builtin' || pack.backend === 'cpu';
}
