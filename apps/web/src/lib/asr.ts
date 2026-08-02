import { type AsrEngineId } from '@openmemo/shared';

/**
 * 转写语言 —— 前端侧的常量与校验。
 *
 * ## 为什么这件事值得单独一个文件
 *
 * whisper.cpp 在**没有 `-l` 参数**时，默认行为不是"自动识别"，而是 `-l en`：
 * 喂给它一段中文，它会**翻译成英文散文**返回。用户从没要求翻译，
 * 却拿到一篇英文，而且原始中文再也拿不回来（转写结果就是那篇英文）。
 * `gpu-runtime` 修掉了这个 bug —— 现在 daemon **无条件**传 `-l`，
 * 值非法时降级为 `auto` 而**绝不落回 `en`**。
 *
 * 但"降级为 auto"意味着：**前端传了个拼错的语言码，是静默生效的**。
 * 用户以为自己选了粤语，实际跑的是自动识别，没有任何提示。
 * 所以这里把 daemon 的正则**逐字复制**过来做前置校验 ——
 * 不是为了替后端把关（后端自己会兜底），而是为了让**错误可见**。
 */

/**
 * 与 `packages/pipeline/src/asr/whisperCpp.ts` 的校验正则逐字一致。
 * 该文件里不匹配的值会被静默改成 `'auto'`，所以这里必须同款，
 * 否则前端认为合法、后端偷偷换掉，两边对不上而没人报错。
 */
const ASR_LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$|^auto$/;

export function isValidAsrLanguage(value: string): boolean {
  return ASR_LANGUAGE_RE.test(value);
}

/** `auto` 是字面量，不是"留空"。后端正则显式放行 `^auto$`。 */
export const ASR_LANGUAGE_AUTO = 'auto';

export interface AsrLanguageOption {
  readonly value: string;
  /** i18n key 后缀，见 locales 的 `asr.lang.*`。 */
  readonly key: string;
}

/**
 * 候选语言。刻意做短 —— 长列表在这里没有价值，
 * 真正要紧的是"中文别被翻译成英文"，其余用自定义输入覆盖。
 */
export const ASR_LANGUAGES: readonly AsrLanguageOption[] = [
  { value: ASR_LANGUAGE_AUTO, key: 'auto' },
  { value: 'zh', key: 'zh' },
  { value: 'yue', key: 'yue' },
  { value: 'en', key: 'en' },
  { value: 'ja', key: 'ja' },
  { value: 'ko', key: 'ko' },
  { value: 'de', key: 'de' },
  { value: 'fr', key: 'fr' },
  { value: 'es', key: 'es' },
  { value: 'ru', key: 'ru' },
];

/**
 * 选 `auto` 时值得提醒用户的一件事（不是警告，是事实）。
 *
 * daemon 的引擎自动选择 (`selectEngine.ts` 的 `isChinese`) 只认
 * `zh*` / `cmn*` / `yue*` 前缀。传 `auto` 时这个判断为假，
 * **Paraformer 选不中，会落到 whisper.cpp**。
 * 也就是说"语言=自动"和"引擎=自动"在后端是耦合的：
 * 明确选 `zh` 反而更快更准。这个因果关系用户看不见，所以要写出来。
 */
export function autoLanguageDowngradesEngine(language: string): boolean {
  return language === ASR_LANGUAGE_AUTO;
}

/** 引擎展示名。键是 `AsrEngineId`，编不出后端不存在的引擎。 */
export const ASR_ENGINE_LABELS: Record<AsrEngineId, string> = {
  'whisper.cpp': 'Whisper.cpp',
  paraformer: 'Paraformer',
  'sherpa-onnx': 'Sherpa-ONNX',
};
