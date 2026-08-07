/**
 * 自检检查项的**语言选择**（T-173）。
 *
 * ## 为什么这三行值得一个文件
 *
 * `CheckResult` 的字段是历史上长歪的：`label`/`labelZh` 是「英/中」一对，
 * 而 `detail`/`remediation` **一直是中文原文**（daemon 侧写死的中文句子）。
 * T-173 起新写的检查项额外给一份 `detailEn`/`remediationEn`，但**旧的 24 条没有**。
 *
 * 所以这里唯一要钉死的是**回退方向**：
 *
 * > 英文界面拿不到英文版时，回退到**中文原文**，绝不回退到空字符串。
 *
 * 回退成中文只是难看；回退成空白会让一条**真实的告警在英文界面上直接消失** ——
 * 而那正是本次修复要消灭的东西（"坏了不吭声"）。一个把告警吞掉的 i18n 回退，
 * 比没做 i18n 严重得多，且在中文界面上永远看不出来。
 */
export function pickCheckText(zh: boolean, zhText: string, enText?: string): string {
  if (zh) return zhText;
  return enText !== undefined && enText !== '' ? enText : zhText;
}

/** 同上，但用于可为 null 的 `remediation`（null = 没什么要做的，不该渲染那一行）。 */
export function pickCheckRemediation(
  zh: boolean,
  zhText: string | null,
  enText?: string | null,
): string | null {
  if (zhText === null) return null;
  if (zh) return zhText;
  return enText !== undefined && enText !== null && enText !== '' ? enText : zhText;
}
