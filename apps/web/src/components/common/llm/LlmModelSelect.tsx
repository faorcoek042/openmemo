import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ModelCatalogNote } from './llm-catalog';

/**
 * LLM 模型选择器 —— **「AI 模型」与「按用途分别配置」共用的唯一一个**（T-126）。
 *
 * ## 用户原话
 *
 * > 「模型的下拉框还是能选择也能填写，这个和 memo 里面还是不一样，也要改」
 * > 「该统一和复用的地方要统一复用啊」
 *
 * 两句话是两件事，都得办：**默认必须是真下拉**（memo.ac 是纯 `<select>`），
 * 且**两处必须是同一个组件**（此前两处各写一遍 `<input list=…>`，
 * 连 `data-testid` 都不一样，是"同一件事写两遍"的教科书样本）。
 *
 * ## 前任那条注释我保留了它的实质，但改了它的默认值
 *
 * 原注释：*"厂商上新模型比我们发版快，写死下拉会把新模型挡在外面。"*
 * **这个顾虑是真的**，24 家里 20 家的清单是人工从文档转录的（`official-doc`，
 * 没有端点可调），必然过时。但它把**例外做成了默认**，代价有两条：
 *
 * 1. 与 memo.ac 不一致 —— 用户看过实物，他说的是事实；
 * 2. `<input>` 打错一个字符就是一个不存在的型号，**界面一个字都不会说**，
 *    直到某次生成导图时失败。自由输入把"没有校验"伪装成了"更灵活"。
 *
 * 所以：**下拉是默认路径，"自定义…"是逃生口**。顾虑仍然成立，代价没了。
 *
 * ## 三条实现约束（都是踩过的坑）
 *
 * - **不认识的值绝不吞掉。** `<select>` 遇到不在 options 里的 value 会显示成空 ——
 *   如果用户配的是清单里没有的型号（自定义网关、刚上新的型号），换控件的瞬间
 *   他的配置就"看起来没了"，再点一次保存就真的没了。这里的做法是：
 *   **值不在候选里 ⇒ 自动进自定义模式并把原值填进文本框**，一个字符都不改。
 * - **候选异步到达时要能自愈。** 候选来自 `useSettingsQuery()`，首帧是空数组。
 *   若把"是否自定义"存成 state，首帧算出的 `true` 会永远卡住。
 *   所以它是**派生值**，只有用户显式选了「自定义…」才由 `forcedCustom` 锁定。
 * - **提交时机两处不同。** 「AI 模型」写的是本地 state（每次输入都同步没问题），
 *   「按用途分别配置」每次提交都会 PATCH 一次（必须等失焦）。
 *   → `commit` 参数，而不是复制一份组件。
 */

/** 「自定义…」这一项的 value。用 `__` 前缀，撞不上任何真实型号名。 */
const CUSTOM_VALUE = '__custom__';

export interface LlmModelSelectProps {
  /** 当前值。空串 = 未选择（`allowEmpty` 时表示"继承全局"）。 */
  value: string;
  /** 候选型号。来自 `useLlmConfig().modelsFor()` —— 两处必须是同一个来源。 */
  models: string[];
  onChange: (next: string) => void;
  /**
   * 自定义文本框的提交时机。
   * `change` = 每次按键（调用方写本地 state）；`blur` = 失焦时（调用方会发请求）。
   */
  commit?: 'change' | 'blur';
  /** true = 允许空值，并把空值渲染成一个常驻选项（「继承全局」）。 */
  allowEmpty?: boolean;
  /** 空值那一项的文案。`allowEmpty` 时常驻；否则只在 value 为空时出现。 */
  emptyLabel?: string;
  /** 候选清单的出处与时效。`null` = 这家不在内置目录里。 */
  note?: ModelCatalogNote | null;
  disabled?: boolean;
  /** 下拉用 `${testId}`，自定义输入框用 `${testId}-custom`。 */
  testId: string;
  ariaLabel: string;
}

export function LlmModelSelect({
  value,
  models,
  onChange,
  commit = 'change',
  allowEmpty = false,
  emptyLabel,
  note,
  disabled,
  testId,
  ariaLabel,
}: LlmModelSelectProps) {
  const { t } = useTranslation();

  /** 用户主动选了「自定义…」。**只有这一个 state 决定模式**，其余全是派生的。 */
  const [forcedCustom, setForcedCustom] = useState(false);
  /** 自定义文本框的草稿。`touched` 之前一律跟随外部值 —— 候选异步到达时不会卡住旧值。 */
  const [draft, setDraft] = useState(value);
  const [touched, setTouched] = useState(false);

  const inList = value !== '' && models.includes(value);
  /** 值不在候选里 ⇒ 必须进自定义模式，否则 `<select>` 会把它显示成空（= 悄悄丢配置）。 */
  const custom = forcedCustom || (value !== '' && !inList);
  const shown = touched ? draft : value;

  const emptyText = emptyLabel ?? t('settings.modelPicker.unset');

  const selectValue = custom ? CUSTOM_VALUE : inList ? value : '';

  return (
    <>
      <select
        value={selectValue}
        disabled={disabled}
        aria-label={ariaLabel}
        data-testid={testId}
        className="h-8 rounded-md border border-line bg-surface-0 px-2 text-sm text-ink"
        onChange={(e) => {
          const next = e.target.value;
          if (next === CUSTOM_VALUE) {
            // 只切模式，**不改值** —— 让用户在原值的基础上改，而不是从空白重打一遍
            setForcedCustom(true);
            setDraft(value);
            setTouched(false);
            return;
          }
          setForcedCustom(false);
          setTouched(false);
          onChange(next);
        }}
      >
        {/*
          空值项：`allowEmpty`（分档配置的"继承全局"）时常驻；
          否则只在还没选过时出现 —— 同 `AsrModelPicker` 的做法，选完就不再占一行。
        */}
        {allowEmpty || value === '' ? <option value="">{emptyText}</option> : null}
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        {/* ★ 逃生口。永远在最后一项，永远存在 —— 清单必然会过时（20/24 家是人工转录的） */}
        <option value={CUSTOM_VALUE}>{t('settings.modelPicker.custom')}</option>
      </select>

      {custom ? (
        <input
          value={shown}
          spellCheck={false}
          autoComplete="off"
          aria-label={t('settings.modelPicker.customLabel')}
          placeholder={t('settings.modelPicker.customPlaceholder')}
          data-testid={`${testId}-custom`}
          className="h-8 rounded-md border border-line bg-surface-0 px-2 font-mono text-sm text-ink"
          onChange={(e) => {
            setTouched(true);
            setDraft(e.target.value);
            if (commit === 'change') onChange(e.target.value);
          }}
          onBlur={(e) => {
            if (commit === 'blur' && e.target.value !== value) onChange(e.target.value);
          }}
        />
      ) : null}

      {/*
        ★ D-10 #26「刷新分流」——**分的是措辞，不是按钮**。

        R-P2 的原话是"「刷新模型列表」按钮只对 `canRefreshModelList(p) === true` 的 4 家渲染"。
        实际做的时候撞上一条更硬的事实：**本机根本没有任何端点能替前端去枚举**
        （daemon 路由表里没有 `/api/llm/models` 一类的东西，全仓 grep 为 0）。
        所以那 4 家的按钮同样是按不动的 —— R-P2 想挡的正是这个，
        对 20 家成立的理由对 4 家一样成立。

        于是分流落在文案上，三档各说各的真话：
          · 20 家 `official-doc` → 人工转录 + 核对日期，**可能已过期**
          · 4 家 `official-api`/`local-api` → 协议上刷得了，**只是还没接上**
          · 不在目录里 → 没有内置清单，请用「自定义…」
        把"可能过时"如实写出来，比一个假按钮诚实；也是"自定义…"存在的理由。
      */}
      <span className="text-ink-muted" data-testid={`${testId}-note`}>
        {custom
          ? t('settings.modelPicker.customHint')
          : note && note.count > 0
            ? note.refreshable
              ? t('settings.modelPicker.noteApi', { n: note.count })
              : note.checkedAt
                ? // ⚠️ 占位符刻意不叫 `count` —— i18next 会把它当复数选择器去找 `note_other`
                  t('settings.modelPicker.note', { n: note.count, date: note.checkedAt })
                : t('settings.modelPicker.noteNoDate', { n: note.count })
            : t('settings.modelPicker.noCatalog')}
      </span>
    </>
  );
}
