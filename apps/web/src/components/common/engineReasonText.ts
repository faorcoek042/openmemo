/**
 * 「这个 ASR 引擎为什么用不了」那句话的**措辞总表**（#112，渲染点 8–10）。
 *
 * ## 这个文件存在的理由
 *
 * `/api/health` 的 `pipeline.engines[].reason` 上一版是一格自由文本，而它有
 * **两个产出方，方向相反的两句谎**：
 *
 *   · `apps/daemon/src/pipeline/setup.ts` 的 `unavailableEngines` 发**中文散文**
 *     （「未安装流式中文模型 —— 去「模型」页装 …」）；
 *   · `packages/pipeline/src/asr/selectEngine.ts` 的 `buildCandidates()` 发
 *     **英文散文**（`the streaming recognition component is not installed (…)`）。
 *
 * 三个渲染点都是原样插值 —— `AsrEngineStatus`（录音页那条引擎状态）、
 * `features/models/components/ModelCard.tsx` 的 `EngineFitChip`、
 * `features/notes/RetranscribeButton.tsx` 的「上次用的引擎没了」那一行。
 * 于是**英文界面上是半句中文，中文界面上是半句英文**，同一格两头漏。
 *
 * 契约那一侧已经换成机器可读的 `EngineUnavailableReason`（`shared/api.ts`），
 * 措辞全部搬来这里 + 两份 locale。做法照 `features/components/reasonText.ts`
 * 与 `features/runtime/reasonKeys.ts`（#106），它们是这一族的房规。
 *
 * ## ★★ 为什么是 `Record<全部 kind, string>` 而不是 `KEYS[k] ?? ''`
 *
 * 下面那张表是**总表**：契约里新增一档而没人给它写话，**构建当场就红**。
 * 换成 `?? ''`，新档位会静默渲染成一段空白 —— 而"用不了却一个字的原因都没有"
 * 正是这三个渲染点原本就有的病，不能在修它的时候把它请回来。
 *
 * ## ⚠️ 参数是**结构化字段**，不是拼进 key 里的
 *
 * 已装 id 列表、环境变量名与目录都由 `t()` 插值（`{{ids}}` / `{{envVar}}` /
 * `{{dir}}`），不是一个叫 `installed_but_files_incomplete_2` 的枚举成员。
 */

import type { EngineUnavailableReason } from '@openmemo/shared';

/**
 * 每一种「引擎用不了」该说哪句话。**总表**，四格一个都不许少。
 *
 * ⚠️ `engineProbeText` 那一格说的是「这一段是引擎原话，我们没翻译」——
 * 它是唯一一格**故意不解释内容**的，因为落进来的是
 * `packages/pipeline` 的 `AsrAvailability.reason`：一个我们没有解读过、
 * 也没有边界的集合（它自带 `require()` 抛回来的 message）。
 * 把它写成一句像模像样的解释，等于替一段没看懂的字符串背书。
 * 同 `components.reason.failed.upstreamErrorText` 与
 * `runtime.pack.inapplicable.verbatimDetail` 的待遇。
 */
export const ENGINE_UNAVAILABLE_KEYS: Readonly<Record<EngineUnavailableReason['kind'], string>> = {
  model_not_installed: 'asr.engineUnavailable.modelNotInstalled',
  installed_but_files_incomplete: 'asr.engineUnavailable.installedButFilesIncomplete',
  override_dir_incomplete: 'asr.engineUnavailable.overrideDirIncomplete',
  engine_probe_text: 'asr.engineUnavailable.engineProbeText',
};

/** `t()` 的最小形状 —— 这个模块不引 React，方便直接对它写用例。 */
type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * 一条 `EngineUnavailableReason` → 用户读得懂的那句话（当前语言）。
 *
 * `installedIds` 用 `', '` 连接：它是**数据**（模型 id，两种语言里一模一样），
 * 所以分隔符也不跟着语言变 —— 那样只会让同一份 id 列表在两份截图里长得不一样。
 */
export function engineUnavailableText(t: Translate, r: EngineUnavailableReason): string {
  switch (r.kind) {
    case 'model_not_installed':
      return t(ENGINE_UNAVAILABLE_KEYS[r.kind]);
    case 'installed_but_files_incomplete':
      return t(ENGINE_UNAVAILABLE_KEYS[r.kind], { ids: r.installedIds.join(', ') });
    case 'override_dir_incomplete':
      return t(ENGINE_UNAVAILABLE_KEYS[r.kind], { envVar: r.envVar, dir: r.dir });
    case 'engine_probe_text':
      return t(ENGINE_UNAVAILABLE_KEYS[r.kind], { text: r.text });
    default:
      return assertNeverEngineReason(r);
  }
}

/**
 * 编译期穷尽性检查；**运行期不 throw**。
 *
 * 少写一条腿时 `tsc` 当场红（那是我们要的），但真跑到这一行（产品与 daemon
 * 版本错配）时，让录音页/模型页整块崩掉是更坏的结果。返回空串 ⇒ 这一处少一句解释，
 * 而**上面那张总表保证了这一行在编译得过的代码里不可达**。
 * 同 `features/runtime/reasonKeys.ts` 的 `assertNeverInapplicability`。
 */
function assertNeverEngineReason(x: never): string {
  void x;
  return '';
}

/**
 * 把 `/api/health` 上那一格收成 `EngineUnavailableReason`，**认不出就给 `null`**。
 *
 * ## 为什么要有运行期这一层
 *
 * 上面那张总表是**编译期**的闸，而这一格是从网线上来的 JSON ——
 * 编译期对它一无所知。旧版 daemon（或一次版本错配）发来的是**一句散文字符串**，
 * 直接 `as EngineUnavailableReason` 会让 `switch` 落到 `default` 那条，
 * 或者更糟：`t(undefined)` 把一段 key 名字印到界面上。
 *
 * ## ⚠️ 认不出时为什么是 `null`，而不是包成 `engine_probe_text`
 *
 * 因为那一格的**语义是"引擎自己的英文原话"**。把一句旧 daemon 的中文散文塞进去，
 * 等于在英文界面上重新开一条中文回落路径 —— 而那正是 #112 要堵的洞
 * （同 #106 把 `messageZh` 从帧上删掉那一手：留着回落，总表就形同虚设）。
 * `null` 的后果是这一处少一句解释；包错的后果是这一处又变回半句中文。
 *
 * 收窄的写法照 `features/search/modes.ts` 的 `normalizeModes`：逐格 `typeof`，
 * 不用断言。
 */
export function normalizeEngineReason(raw: unknown): EngineUnavailableReason | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const kind = r['kind'];
  switch (kind) {
    case 'model_not_installed':
      return { kind };
    case 'installed_but_files_incomplete': {
      const ids = r['installedIds'];
      /*
       * 缺 `installedIds` 时**不退回 `model_not_installed`**：那两档要说的下一步
       * 正好相反（"去装一个" vs "你装的那个不全，重装它"），猜错会把一个已经装过的人
       * 送去再装一遍。id 列表本身可以是空的 —— 那只是少列几个名字，句子仍然成立。
       */
      if (!Array.isArray(ids)) return null;
      return { kind, installedIds: ids.filter((x): x is string => typeof x === 'string') };
    }
    case 'override_dir_incomplete': {
      const envVar = r['envVar'];
      const dir = r['dir'];
      // 这一档整句话就是「哪个变量、指向哪里」，两格缺一它就什么都没说。
      if (typeof envVar !== 'string' || typeof dir !== 'string') return null;
      return { kind, envVar, dir };
    }
    case 'engine_probe_text': {
      const text = r['text'];
      if (typeof text !== 'string' || text === '') return null;
      return { kind, text };
    }
    default:
      return null;
  }
}
