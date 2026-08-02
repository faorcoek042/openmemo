import { useTranslation } from 'react-i18next';
import { CONTRACT_VERSION } from '@openmemo/shared';

import { SUPPORTED_LOCALES, setLocale, type LocaleCode } from '../../app/i18n';
import { useUiStore, type ThemeMode } from '../../lib/stores/ui.store';
import { Banner } from '../../components/common/Banner';

/** 设置（最小可用版）。运行时/模型/存储页归 T-022。 */
export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <h1 className="text-xl font-semibold text-ink">{t('settings.title')}</h1>

      <section className="rounded-lg border border-line bg-surface-1 p-4">
        <h2 className="mb-3 text-sm font-medium text-ink">{t('settings.general')}</h2>

        <label className="mb-3 flex items-center justify-between gap-4 text-sm">
          <span className="text-ink-secondary">{t('app.language')}</span>
          <select
            value={i18n.language}
            onChange={(e) => setLocale(e.target.value as LocaleCode)}
            className="h-8 rounded-md border border-line bg-surface-0 px-2 text-sm text-ink"
          >
            {SUPPORTED_LOCALES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center justify-between gap-4 text-sm">
          <span className="text-ink-secondary">{t('app.theme')}</span>
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as ThemeMode)}
            className="h-8 rounded-md border border-line bg-surface-0 px-2 text-sm text-ink"
          >
            <option value="system">system</option>
            <option value="light">light</option>
            <option value="dark">dark</option>
          </select>
        </label>
      </section>

      <section className="rounded-lg border border-line bg-surface-1 p-4">
        <h2 className="mb-3 text-sm font-medium text-ink">{t('settings.llm')}</h2>
        {/*
          ADR-006 决策 1 的**强制条件**：必须显式告知明文存储，不许含糊。
          这不是可选的免责声明——用户有权知道自己的 Key 放在哪、谁能读到。
        */}
        <Banner
          tone="warning"
          title={t('settings.apiKeyPlaintextWarning', {
            path: '~/.local/share/openmemo/openmemo.db',
          })}
          className="border-b-0"
        />
      </section>

      <section className="rounded-lg border border-line bg-surface-1 p-4 text-sm">
        <h2 className="mb-3 font-medium text-ink">{t('settings.about')}</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ink-secondary">
          <dt>{t('settings.contractVersion')}</dt>
          <dd className="tabular-nums text-ink">{CONTRACT_VERSION}</dd>
        </dl>
        <p className="mt-3 text-xs text-ink-muted">{t('settings.telemetryNote')}</p>
      </section>
    </div>
  );
}
