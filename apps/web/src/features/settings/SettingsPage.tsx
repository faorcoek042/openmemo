import { useTranslation } from 'react-i18next';
import { CONTRACT_VERSION } from '@openmemo/shared';

import { SUPPORTED_LOCALES, setLocale, type LocaleCode } from '../../app/i18n';
import { useUiStore, type ThemeMode } from '../../lib/stores/ui.store';
import { LlmSettingsSection } from './LlmSettingsSection';
import { DataLocationSection } from './DataLocationSection';
import { PanelBoundary } from '../../components/common/PanelBoundary';

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

      <PanelBoundary name={t('settings.llm')}>
        <LlmSettingsSection />
      </PanelBoundary>

      {/* 数据位置：路径来自 daemon，容量来自 models/storage —— 都不是前端猜的 */}
      <PanelBoundary name={t('settings.dataDir.title')}>
        <DataLocationSection />
      </PanelBoundary>

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
