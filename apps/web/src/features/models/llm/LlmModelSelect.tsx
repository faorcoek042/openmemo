import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';

import { Button } from '../../../components/common/Button';
import { useLlmModelsMutation } from './api';
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
 * - **提交可能失败，草稿不能装作没事。**（S-8）`commit='blur'` 这条路径此前失焦
 *   一发就完事——PATCH 失败、或者外部 `value` 后来变了，都没有任何回声，草稿会
 *   永远显示成"已保存"的样子，而同屏别处按服务端真值渲染的地方（比如「按用途分别
 *   配置」的生效值那一行）还是旧值——两边对不上，且用户一个字的提示都看不到。
 *   现在 `onChange` 允许回一个 Promise：失败时**保留草稿**（不吞用户刚打的字，
 *   影子状态本身不是罪）但标红 + 提示"没保存成功"；成功时不在这里手动清，等外部
 *   `value` 追上草稿时自然退出草稿态——不能"`value` 一变就无脑清"，那是把 S-9
 *   （后台重取悄悄抹掉正在编辑的字段）原样搬进这个组件。
 */

/** 「自定义…」这一项的 value。用 `__` 前缀，撞不上任何真实型号名。 */
const CUSTOM_VALUE = '__custom__';

/**
 * 统一"消化"`onChange` 可能回的 Promise —— 调用方现在允许回一个 `mutateAsync(...)`
 * 那样的 Promise（见 S-8），但下拉那条路径（选现成选项）从来没人等过它。
 * 不接住就是 unhandled rejection：换个 provider 失败时控制台会炸一个没人看的红字。
 */
function settle(result: void | Promise<unknown>, onError?: () => void): void {
  if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
    void (result as PromiseLike<unknown>).then(
      () => undefined,
      () => onError?.(),
    );
  }
}

export interface LlmModelSelectProps {
  /** 当前值。空串 = 未选择（`allowEmpty` 时表示"继承全局"）。 */
  value: string;
  /** 候选型号。来自 `useLlmConfig().modelsFor()` —— 两处必须是同一个来源。 */
  models: string[];
  /**
   * 可选地回一个 Promise（例如调用方的 `mutateAsync(...)`）——
   * 这样 `commit='blur'` 那条路径才能在提交失败时知道，见文件头 S-8 那条约束。
   * 不回 Promise 也完全合法（「AI 模型」区块写本地 state，本来就不存在"失败"这回事）。
   */
  onChange: (next: string) => void | Promise<unknown>;
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
  /**
   * 这个下拉是**哪一家**的。给「刷新模型列表」用（D-10 #26）。
   *
   * ⚠️ 不传 = 不渲染刷新按钮。「按用途分别配置」那一处就不传：
   * 它的候选是**已配置服务商的子集**（约束 ②），在那里刷新会让人以为
   * 刷的是那一栏的东西，而实际刷的是整家的清单。
   */
  providerId?: string | null;
  /** 刷新拿到新清单后的回调（调用方决定是并进候选还是替换）。 */
  onModelsRefreshed?: (models: string[]) => void;
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
  providerId,
  onModelsRefreshed,
  disabled,
  testId,
  ariaLabel,
}: LlmModelSelectProps) {
  const { t } = useTranslation();
  const refresh = useLlmModelsMutation();

  /** 用户主动选了「自定义…」。**只有这一个 state 决定模式**，其余全是派生的。 */
  const [forcedCustom, setForcedCustom] = useState(false);
  /** 自定义文本框的草稿。`touched` 之前一律跟随外部值 —— 候选异步到达时不会卡住旧值。 */
  const [draft, setDraft] = useState(value);
  const [touched, setTouched] = useState(false);
  /** ★ S-8：上一次 `commit='blur'` 提交失败了，草稿还没落地——见文件头那条约束。 */
  const [commitError, setCommitError] = useState(false);

  /*
   * 外部 `value` 追上了本地草稿 —— 不管是这次提交自己成功了，还是外部真值本来就是
   * 这个值，影子状态都可以退场了。
   * ⚠️ 不是"`value` 一变就清"——那是把 S-9 搬进这个组件；只有当外部真相已经**等于**
   * 用户手上的草稿时，才没有谁需要让步。
   */
  useEffect(() => {
    if (touched && value === draft) {
      setTouched(false);
      setCommitError(false);
    }
  }, [value, draft, touched]);

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
          settle(onChange(next));
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
        <>
          <input
            value={shown}
            spellCheck={false}
            autoComplete="off"
            aria-label={t('settings.modelPicker.customLabel')}
            aria-invalid={commitError || undefined}
            placeholder={t('settings.modelPicker.customPlaceholder')}
            data-testid={`${testId}-custom`}
            className={
              commitError
                ? 'h-8 rounded-md border border-critical-line bg-surface-0 px-2 font-mono text-sm text-ink'
                : 'h-8 rounded-md border border-line bg-surface-0 px-2 font-mono text-sm text-ink'
            }
            onChange={(e) => {
              setTouched(true);
              setDraft(e.target.value);
              setCommitError(false);
              if (commit === 'change') onChange(e.target.value);
            }}
            onBlur={(e) => {
              if (commit !== 'blur' || e.target.value === value) return;
              // ★ S-8：失败别装没事——草稿留着（`touched` 不动），只标"没保存成功"；
              // 成功不用在这里手动清 touched，上面那条 effect 会在 value 追上 draft 时自己退场。
              setCommitError(false);
              settle(onChange(e.target.value), () => setCommitError(true));
            }}
          />
          {commitError ? (
            <span className="text-xs text-critical" data-testid={`${testId}-custom-error`}>
              {t('settings.modelPicker.commitError')}
            </span>
          ) : null}
        </>
      ) : null}

      {/*
        ★ D-10 #26「刷新分流」——**按钮只给 4 家，措辞三档各说各的真话**。

        📝 **此前这里写着**（保留原文，因为那是一个正确的判断，不是遗漏）：
        > 分的是措辞，不是按钮 …… 撞上一条更硬的事实：**本机根本没有任何端点能替前端去枚举**
        > （daemon 路由表里没有 `/api/llm/models` 一类的东西，全仓 grep 为 0）。
        > 所以那 4 家的按钮同样是按不动的 —— R-P2 想挡的正是这个。

        **T-153 补上了 `POST /api/llm/models`**，那条事实不再成立，于是按钮回到 R-P2 的原样：
        只对 `canRefreshModelList(p) === true` 的 4 家（openrouter / siliconcloud /
        ollama / lmstudio）渲染。**判据一个字没改**，改的是那 4 家现在真的按得动。

        三档措辞（仍然必须互不相同）：
          · 20 家 `official-doc` → 人工转录 + 核对日期，**可能已过期**，且**没有按钮**
          · 4 家 `official-api`/`local-api` → 有按钮，刷完显示刷到了几个
          · 不在目录里 → 没有内置清单，请用「自定义…」
      */}
      {!custom && note?.refreshable && providerId ? (
        <span className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={refresh.isPending || disabled}
            data-testid={`${testId}-refresh`}
            onClick={() => {
              refresh.mutate(providerId, {
                onSuccess: (r) => onModelsRefreshed?.(r.models),
              });
            }}
          >
            <RefreshCw className="mr-1 size-3.5" aria-hidden />
            {refresh.isPending
              ? t('settings.modelPicker.refreshing')
              : t('settings.modelPicker.refresh')}
          </Button>
          {/*
            结果必须说话：刷到了几个、或者为什么没刷到。
            静默成功（下拉悄悄变了）与静默失败（什么都没变）在界面上长得一模一样。
          */}
          <span className="text-xs" data-testid={`${testId}-refresh-result`}>
            {refresh.isError ? (
              <span className="text-critical">
                {refresh.error instanceof Error ? refresh.error.message : String(refresh.error)}
              </span>
            ) : refresh.data ? (
              <span className="text-good">
                {t('settings.modelPicker.refreshed', { n: refresh.data.models.length })}
              </span>
            ) : null}
          </span>
        </span>
      ) : null}

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
