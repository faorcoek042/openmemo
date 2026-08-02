import { useState } from 'react';
import { arr } from '../../lib/safe';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, KeyRound, ShieldAlert, Trash2 } from 'lucide-react';

import { Button } from '../../components/common/Button';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { MockNotice } from '../../components/common/MockNotice';
import {
  LLM_ACTIVE_KEY,
  LLM_PROVIDERS_KEY,
  readActiveProviderId,
  readProviders,
  secretKeyFor,
  useDeleteSecretMutation,
  usePatchSettingsMutation,
  useSecretsQuery,
  useSetSecretMutation,
  useSettingsQuery,
  type LlmProviderConfig,
} from './api';
import { cn } from '../../lib/utils';

/**
 * B-3：LLM provider 配置 —— **解开 F4 的那一把钥匙**（T-041 接真后端）。
 *
 * ## 三条设计要点（与上一版一致，数据源换成真端点）
 *
 * 1. **明文存储告知用服务端下发的原文**，不再前端硬编码 ——
 *    路径随 `OPENMEMO_DATA_DIR` 变，硬编码必然说错（我上一版就说错了：
 *    写死成 `openmemo.db`，实测真实位置是 `<dataDir>/secrets.json`，**连文件都不是同一个**）。
 * 2. **本地后端不显示 Key 输入框**。竞品逼用户给 Ollama 编一个假 key 才肯保存，
 *    我们直接把该字段对 `isLocal` 隐藏。
 * 3. **Key 永不回显明文** —— 服务端的 `SecretStore` 接口**刻意不含 `get()`**，只回掩码。
 */

const PRESETS: LlmProviderConfig[] = [
  { id: 'openai', kind: 'openai-compatible', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', isLocal: false },
  { id: 'anthropic', kind: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514', isLocal: false },
  { id: 'deepseek', kind: 'openai-compatible', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', isLocal: false },
  { id: 'ollama', kind: 'openai-compatible', label: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', isLocal: true },
  { id: 'lmstudio', kind: 'openai-compatible', label: 'LM Studio（本地）', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', isLocal: true },
];

export function LlmSettingsSection() {
  const { t, i18n } = useTranslation();
  const settings = useSettingsQuery();
  const secrets = useSecretsQuery();
  const patch = usePatchSettingsMutation();
  const setSecret = useSetSecretMutation();
  const delSecret = useDeleteSecretMutation();
  const [editing, setEditing] = useState<string | null>(null);

  const providers = readProviders(settings.data);
  const activeId = readActiveProviderId(settings.data);
  const disclosure = secrets.data?.disclosure;
  const hasKey = (id: string) =>
    arr(secrets.data?.secrets).some((s) => s.key === secretKeyFor(id));
  const maskOf = (id: string) =>
    arr(secrets.data?.secrets).find((s) => s.key === secretKeyFor(id))?.masked ?? null;

  const upsertProvider = (p: LlmProviderConfig) => {
    const next = providers.some((x) => x.id === p.id)
      ? providers.map((x) => (x.id === p.id ? p : x))
      : [...providers, p];
    patch.mutate({ [LLM_PROVIDERS_KEY]: next });
  };

  const removeProvider = (id: string) => {
    patch.mutate({
      [LLM_PROVIDERS_KEY]: providers.filter((x) => x.id !== id),
      ...(activeId === id ? { [LLM_ACTIVE_KEY]: null } : {}),
    });
    if (hasKey(id)) delSecret.mutate(secretKeyFor(id));
  };

  if (settings.isError) {
    return <ErrorBlock error={settings.error} onRetry={() => void settings.refetch()} />;
  }

  return (
    <section className="rounded-lg border border-line bg-surface-1 p-4">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-medium text-ink">
        <KeyRound className="size-4" aria-hidden />
        {t('settings.llm')}
      </h2>
      <p className="mb-3 text-xs text-ink-secondary">{t('settings.llmIntro')}</p>

      <MockNotice surface="settings" className="mb-3" />

      {/* ★ ADR-006 决策 1 的强制条件。文案取服务端原文 —— 路径只有 daemon 知道 */}
      {disclosure ? (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-line border-l-4 border-l-warning bg-surface-0 px-3 py-2">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <p className="text-xs text-ink-secondary">
            {i18n.language.startsWith('zh') ? disclosure.messageZh : disclosure.message}
          </p>
        </div>
      ) : null}

      {settings.isLoading ? (
        <p className="text-sm text-ink-muted">{t('common.loading')}</p>
      ) : providers.length === 0 ? (
        <p className="mb-3 text-sm text-ink-muted">{t('settings.noProviders')}</p>
      ) : (
        <ul className="mb-3 flex flex-col gap-2" role="list">
          {providers.map((p) => (
            <li
              key={p.id}
              className={cn(
                'rounded-md border p-3',
                activeId === p.id ? 'border-accent bg-accent-track/20' : 'border-line',
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink">{p.label}</span>
                {p.isLocal ? (
                  <span className="rounded bg-surface-0 px-1.5 py-0.5 text-xs text-ink-muted">
                    {t('settings.localBadge')}
                  </span>
                ) : hasKey(p.id) ? (
                  <span className="text-xs text-good">
                    {t('settings.keySet', { mask: maskOf(p.id) ?? '' })}
                  </span>
                ) : (
                  <span className="text-xs text-warning">{t('settings.keyMissing')}</span>
                )}

                <span className="ml-auto flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant={activeId === p.id ? 'ghost' : 'secondary'}
                    disabled={activeId === p.id}
                    onClick={() => patch.mutate({ [LLM_ACTIVE_KEY]: p.id })}
                  >
                    {activeId === p.id ? t('settings.active') : t('settings.setActive')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(editing === p.id ? null : p.id)}
                  >
                    {editing === p.id ? t('common.close') : t('settings.edit')}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => removeProvider(p.id)}
                    aria-label={t('settings.removeProvider', { name: p.label })}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </span>
              </div>

              {editing === p.id ? (
                <ProviderForm
                  provider={p}
                  hasKey={hasKey(p.id)}
                  onSave={(next, apiKey) => {
                    upsertProvider(next);
                    if (apiKey !== undefined) {
                      const v = apiKey.trim();
                      if (v) setSecret.mutate({ key: secretKeyFor(p.id), value: v });
                      else delSecret.mutate(secretKeyFor(p.id));
                    }
                    setEditing(null);
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        {PRESETS.filter((preset) => !providers.some((p) => p.id === preset.id)).map((preset) => (
          <Button key={preset.id} size="sm" variant="secondary" onClick={() => upsertProvider(preset)}>
            + {preset.label}
          </Button>
        ))}
      </div>
    </section>
  );
}

function ProviderForm({
  provider,
  hasKey,
  onSave,
}: {
  provider: LlmProviderConfig;
  hasKey: boolean;
  onSave: (next: LlmProviderConfig, apiKey?: string) => void;
}) {
  const { t } = useTranslation();
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [model, setModel] = useState(provider.model);
  const [apiKey, setApiKey] = useState('');
  const [reveal, setReveal] = useState(false);

  return (
    <div className="mt-3 grid gap-2 border-t border-line pt-3">
      <label className="grid gap-1 text-xs text-ink-secondary">
        {t('settings.baseUrl')}
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          spellCheck={false}
          className="h-8 rounded-md border border-line bg-surface-0 px-2 text-sm text-ink"
        />
      </label>

      <label className="grid gap-1 text-xs text-ink-secondary">
        {t('settings.model')}
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          spellCheck={false}
          className="h-8 rounded-md border border-line bg-surface-0 px-2 text-sm text-ink"
        />
      </label>

      {/* 本地 provider 不显示 Key 输入框 —— 绝不逼用户为 Ollama 编一个假 key */}
      {!provider.isLocal ? (
        <label className="grid gap-1 text-xs text-ink-secondary">
          {t('settings.apiKey')}
          <span className="flex gap-1">
            <input
              type={reveal ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasKey ? t('settings.keyKeepPlaceholder') : 'sk-…'}
              autoComplete="off"
              spellCheck={false}
              className="h-8 flex-1 rounded-md border border-line bg-surface-0 px-2 font-mono text-sm text-ink"
            />
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setReveal((v) => !v)}
              aria-label={reveal ? t('settings.hideKey') : t('settings.showKey')}
            >
              {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </Button>
          </span>
          <span className="text-ink-muted">{t('settings.keyKeepHint')}</span>
        </label>
      ) : null}

      <div className="flex justify-end">
        <Button
          size="sm"
          variant="primary"
          onClick={() =>
            onSave(
              { ...provider, baseUrl, model },
              provider.isLocal || apiKey === '' ? undefined : apiKey,
            )
          }
        >
          {t('common.confirm')}
        </Button>
      </div>
    </div>
  );
}
