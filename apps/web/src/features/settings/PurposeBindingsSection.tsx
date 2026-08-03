import { useTranslation } from 'react-i18next';
import { SlidersHorizontal } from 'lucide-react';

import {
  LLM_PURPOSES,
  resolvePurpose,
  type LlmPurpose,
  type PurposeBindings,
} from '@openmemo/shared';

import { Button } from '../../components/common/Button';
import {
  LLM_PURPOSES_KEY,
  readPurposeBindings,
  usePatchSettingsMutation,
  useSettingsQuery,
} from './api';
import { useLlmConfig } from './llm-catalog';

/**
 * 按用途分别配置模型（chat / 摘要+导图 / 翻译）。
 *
 * ## 为什么值得分
 *
 * 强行共用一个模型，用户只能按**最贵的那个需求**配，然后为翻译多花十倍钱。
 * 翻译要的是便宜快速的小模型，导图要的是能稳定吐结构化 JSON 的，对话要的是上下文长的。
 * （摘要与导图**不拆** —— 两者都是"读全文吐结构"，能力要求同类，
 * 拆开只会让设置页多一栏没人知道怎么填的东西。）
 *
 * ## 这一屏最要紧的事：把"继承"和"覆盖"分开显示
 *
 * daemon 的回退是**逐字段**的：`providerId` 和 `model` 各自独立回退到全局默认。
 * 而用户最常见的填法恰恰是**只换 model、不换 provider**（同一家换个便宜型号）。
 *
 * 如果 UI 只显示"用户填了什么"，就会有两种看不见的坑：
 * 1. 只填了 model 的人不知道 provider 继承的是哪一个 —— 换了全局 provider 后行为静默改变；
 * 2. 全局默认为空时，只填 model **凑不出可用配置**（daemon 要求 provider 与 model 都有值
 *    才返回 provider），而界面上那一栏看起来是填好的。
 *
 * 所以每一栏都显式标注**继承 / 已覆盖**，并把**最终生效值**写出来。
 */

/**
 * 合并一次编辑到绑定表 —— **纯函数，单独导出以便直接测规则**。
 *
 * 抽出来不是为了复用，是因为组件测试宿主里**文本输入到不了 React**
 * （vite 打包会 hoist import，dom-env 的全局装配跑在 react-dom 模块初始化之后，
 * React 于是走 IE 的 `attachEvent` polyfill 路径）。
 * 与其把断言挂在跑不通的 DOM 交互上、或者干脆不测，不如把**规则本身**测死 ——
 * 真正容易写错的是合并规则，不是 `onBlur` 有没有接上。
 *
 * 规则：
 * - 空白值 = **恢复继承**，不写空串。设置里留一个空串，下次读回来分不清
 *   "没填"和"填了空"，而 daemon 的 `asString()` 对两者行为相同 —— 存下去只会误导人。
 * - 整档都空就**删掉这一档**，不留 `{}`：留着会让"有没有覆盖"的判断多一种等价形态。
 * - 只动传进来的字段，另一个字段保持原样 —— 逐字段覆盖，与 daemon 的逐字段回退对称。
 */
export function mergePurposeBinding(
  bindings: PurposeBindings,
  purpose: LlmPurpose,
  next: { providerId?: string; model?: string },
): PurposeBindings {
  const merged: PurposeBindings = { ...bindings };
  const entry = { ...(merged[purpose] ?? {}), ...next };

  const cleaned: { providerId?: string; model?: string } = {};
  if (entry.providerId?.trim()) cleaned.providerId = entry.providerId.trim();
  if (entry.model?.trim()) cleaned.model = entry.model.trim();

  if (Object.keys(cleaned).length === 0) delete merged[purpose];
  else merged[purpose] = cleaned;

  return merged;
}

export function PurposeBindingsSection() {
  const { t } = useTranslation();
  const settings = useSettingsQuery();
  const patch = usePatchSettingsMutation();

  /*
   * ★ 与「AI 模型」区块**共用同一个数据源**（T-108 ②）。
   * 之前这里的模型是个自由文本框，和上面那份 provider 清单毫无关系 ——
   * 两处各维护一份，必然出现"那边有、这边没有"。
   */
  const { providers, activeProviderId: defaultProviderId, defaultModel, modelsFor } = useLlmConfig();
  const bindings = readPurposeBindings(settings.data);

  const write = (purpose: LlmPurpose, next: { providerId?: string; model?: string }) => {
    patch.mutate({ [LLM_PURPOSES_KEY]: mergePurposeBinding(bindings, purpose, next) });
  };

  const anyOverride = LLM_PURPOSES.some((p) => bindings[p] !== undefined);

  return (
    <section className="rounded-lg border border-line bg-surface-1 p-4">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-medium text-ink">
        <SlidersHorizontal className="size-4" aria-hidden />
        {t('settings.purposes.title')}
      </h2>
      <p className="mb-3 text-xs text-ink-secondary">{t('settings.purposes.intro')}</p>

      {/* 全局默认拿不出来时先说清楚 —— 否则下面每一栏的"继承"都指向一个空值 */}
      {!defaultProviderId || !defaultModel ? (
        <p className="mb-3 text-xs text-warning" data-testid="purposes-no-default">
          {t('settings.purposes.noDefault')}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        {LLM_PURPOSES.map((purpose) => {
          const eff = resolvePurpose(bindings, purpose, {
            providerId: defaultProviderId,
            model: defaultModel,
          });
          return (
            <div key={purpose} className="rounded-md border border-line p-3" data-testid={`purpose-${purpose}`}>
              <p className="mb-2 text-sm font-medium text-ink">{t(`settings.purposes.names.${purpose}`)}</p>
              <p className="mb-2 text-xs text-ink-secondary">{t(`settings.purposes.hints.${purpose}`)}</p>

              <div className="flex flex-col gap-2 sm:flex-row">
                {/* provider：选"继承全局"或某个已配置的 provider */}
                <label className="flex flex-1 flex-col gap-1 text-xs text-ink-secondary">
                  <span className="flex items-center gap-1.5">
                    {t('settings.purposes.provider')}
                    <InheritTag inherited={eff.inherited.providerId} />
                  </span>
                  <select
                    value={bindings[purpose]?.providerId ?? ''}
                    onChange={(e) => write(purpose, { providerId: e.target.value })}
                    data-testid={`purpose-${purpose}-provider`}
                    className="h-8 rounded-md border border-line bg-surface-0 px-2 text-sm text-ink"
                  >
                    <option value="">{t('settings.purposes.inheritOption')}</option>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>

                {/* model：留空 = 继承。这是最常被单独填的一项 */}
                <label className="flex flex-1 flex-col gap-1 text-xs text-ink-secondary">
                  <span className="flex items-center gap-1.5">
                    {t('settings.purposes.model')}
                    <InheritTag inherited={eff.inherited.model} />
                  </span>
                  {/*
                    候选来自 `modelsFor(该档实际生效的 provider)` —— 与「AI 模型」区块同一份。
                    仍保留自由输入（datalist 而非 select）：厂商上新模型比我们发版快。
                  */}
                  <input
                    defaultValue={bindings[purpose]?.model ?? ''}
                    list={`purpose-models-${purpose}`}
                    onBlur={(e) => write(purpose, { model: e.target.value })}
                    placeholder={defaultModel ?? t('settings.purposes.inheritOption')}
                    spellCheck={false}
                    autoComplete="off"
                    data-testid={`purpose-${purpose}-model`}
                    className="h-8 rounded-md border border-line bg-surface-0 px-2 font-mono text-sm text-ink"
                  />
                  <datalist id={`purpose-models-${purpose}`}>
                    {modelsFor(eff.providerId).map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </label>
              </div>

              {/*
                ★ 最终生效值。这一行是整屏的重点：
                逐字段回退意味着"你填的"和"实际用的"可以是两码事。
              */}
              <p className="mt-2 text-xs text-ink-muted" data-testid={`purpose-${purpose}-effective`}>
                {eff.providerId && eff.model
                  ? t('settings.purposes.effective', {
                      provider: providers.find((p) => p.id === eff.providerId)?.label ?? eff.providerId,
                      model: eff.model,
                    })
                  : t('settings.purposes.incomplete')}
              </p>
            </div>
          );
        })}
      </div>

      {anyOverride ? (
        <Button
          size="sm"
          variant="ghost"
          className="mt-3"
          data-testid="purposes-reset"
          onClick={() => patch.mutate({ [LLM_PURPOSES_KEY]: {} })}
        >
          {t('settings.purposes.resetAll')}
        </Button>
      ) : null}
    </section>
  );
}

/** 继承 / 已覆盖 —— 逐字段，因为 daemon 的回退就是逐字段的。 */
function InheritTag({ inherited }: { inherited: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      className={
        inherited
          ? 'rounded bg-surface-0 px-1 py-0.5 text-[10px] text-ink-muted'
          : 'rounded bg-accent-track px-1 py-0.5 text-[10px] text-accent'
      }
      data-inherited={inherited ? 'true' : 'false'}
    >
      {inherited ? t('settings.purposes.inherited') : t('settings.purposes.overridden')}
    </span>
  );
}
