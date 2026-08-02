import { useTranslation } from 'react-i18next';
import { Languages } from 'lucide-react';

import { ASR_LANGUAGES, autoLanguageDowngradesEngine, isValidAsrLanguage } from '../../lib/asr';
import { AsrModelPicker } from './AsrModelPicker';

/**
 * 转写选项 —— **捕获页与录音页共用**（D-05 §3.4 的提升规则：第二个使用方出现即上移）。
 *
 * 只放**真的会被后端消费**的选项。目前就一个半：
 * - `language` —— 全通：import / upload / retranscribe 三个入口都收，一路到 whisper 的 `-l`
 * - 模型 —— 半通：能切**全局激活**的模型，但不能"本次任务用这个"（后端无此入参）
 *
 * 曾经放在这里的 `diarize` / `keepVideo` / `structure` 三个勾选框已删除：
 * 它们连 HTTP 请求体都没进过（`api.ts` 只发 `{input}`），
 * 勾了不生效、不勾也不生效。留着比没有更糟 —— 用户会以为自己关掉了说话人分离。
 * 要恢复得先有后端入参，见交付报告的"后端不接受"清单。
 */
export function TranscribeOptions({
  language,
  onLanguageChange,
  showModel = true,
}: {
  language: string;
  onLanguageChange: (v: string) => void;
  showModel?: boolean;
}) {
  const { t } = useTranslation();
  // 后端对非法值是静默降级成 auto 的，所以校验只为把错误显示出来
  const invalid = language.length > 0 && !isValidAsrLanguage(language);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center">
          <span className="mr-2 inline-flex items-center gap-1 text-xs text-ink-secondary">
            <Languages className="size-3.5" aria-hidden />
            {t('asr.languageLabel')}
          </span>
          <select
            value={ASR_LANGUAGES.some((l) => l.value === language) ? language : '__custom'}
            onChange={(e) => onLanguageChange(e.target.value === '__custom' ? '' : e.target.value)}
            aria-label={t('asr.languageLabel')}
            data-testid="asr-language-select"
            className="h-8 rounded-md border border-line bg-surface-0 px-2 text-sm text-ink"
          >
            {ASR_LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {t(`asr.lang.${l.key}`)}
              </option>
            ))}
            <option value="__custom">{t('asr.lang.custom')}</option>
          </select>
        </label>

        {/* 列表外的 BCP-47 码（如 pt-BR）走这里，而不是逼用户去改设置 */}
        {!ASR_LANGUAGES.some((l) => l.value === language) ? (
          <input
            value={language}
            onChange={(e) => onLanguageChange(e.target.value.trim())}
            aria-label={t('asr.lang.custom')}
            data-testid="asr-language-custom"
            placeholder="pt-BR"
            spellCheck={false}
            autoComplete="off"
            className="h-8 w-28 rounded-md border border-line bg-surface-0 px-2 text-sm text-ink"
          />
        ) : null}

        {showModel ? <AsrModelPicker className="flex items-center" /> : null}
      </div>

      {invalid ? (
        <p className="text-xs text-danger" data-testid="asr-language-invalid">
          {t('asr.languageInvalid')}
        </p>
      ) : null}

      {/*
        auto 会让 Paraformer 落选 —— 后端的引擎自动选择只认 zh*/cmn*/yue* 前缀。
        这是用户完全看不见的因果链，不写出来他只会觉得"有时候快有时候慢"。
      */}
      {autoLanguageDowngradesEngine(language) ? (
        <p className="text-xs text-ink-muted" data-testid="asr-language-auto-hint">
          {t('asr.autoHint')}
        </p>
      ) : null}
    </div>
  );
}
