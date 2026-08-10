/**
 * 一个阶段 key（`resolving` / `downloading` / `unpacking` …）→ 用户看得懂的中文。
 *
 * ## 为什么要有这一处
 *
 * 同一件事此前有**三份实现**，而且三份的兜底各不相同：
 *
 * | 渲染点 | 缺词条时回退成 |
 * | --- | --- |
 * | `features/tasks/JobList.tsx` | **原样渲染 step key**（`unpacking` 这种英文机器枚举值） |
 * | `components/common/JobToaster.tsx` | **`progress.queued`「排队中」** —— 从「正在校验完整性」**倒退回流程起点** |
 * | `components/common/DownloadRow.tsx` | 另一套 `models.download.*` 词条，缺了也回「排队中」 |
 *
 * `[实测 2026-08-09]` `progress.unpacking` 在两个 locale 里都不存在，于是解包那几秒：
 * 任务中心显示英文 `unpacking`、Toast 副行显示「排队中」（阶段倒退）——
 * **同一时刻同一件事，两处说法互相矛盾。**
 *
 * 这正是用户点名要治的那类：「能复用的都复用，不要同一个用途的东西分成多个不同实现，
 * 结果出现互相矛盾的情况」。所以收敛到这一个函数。
 *
 * ## 兜底规则（三份实现里唯一站得住的那一种）
 *
 * 缺词条时**不回退到「排队中」**：那是在说一件**假的事**（阶段倒退回起点），
 * 比显示英文更坏 —— 用户会以为进度倒回去了。
 * 也**不原样渲染 key**：那是把机器枚举值摆给用户看。
 * 回退成一句中性的「处理中」：它不精确，但**不说谎**。
 *
 * ⚠️ 真正的修法始终是把词条补齐；这个兜底只是让"漏了一条"的后果
 * 从"显示错的东西"降级成"显示不够具体的东西"。
 */
export type StepTranslator = (key: string, opts?: Record<string, unknown>) => string;

/** i18n 里存在与否的判定交给调用方传进来的 `exists`（`i18n.exists`）。 */
export function stepLabel(
  step: string | null | undefined,
  t: StepTranslator,
  exists?: (key: string) => boolean,
): string {
  if (!step) return '';
  const key = `progress.${step}`;
  if (exists && !exists(key)) return t('progress.generic', { defaultValue: '处理中' });
  const v = t(key, { defaultValue: '' });
  return v === '' ? t('progress.generic', { defaultValue: '处理中' }) : v;
}
