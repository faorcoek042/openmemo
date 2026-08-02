import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Eye, EyeOff, KeyRound, Loader2, ShieldAlert, XCircle } from 'lucide-react';

import { Button } from '../../components/common/Button';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { MockNotice } from '../../components/common/MockNotice';
import {
  useActivateProviderMutation,
  useLlmSettingsQuery,
  useSaveProviderMutation,
  useTestProviderMutation,
  type LlmProviderConfigDto,
  type SaveProviderInput,
} from './api';
import { cn } from '../../lib/utils';

/**
 * B-3：LLM provider 配置 —— **解开 F4 的那一把钥匙**。
 *
 * 在这之前，设置页只有一句"API Key 以明文存储"的警告，却**没有输入框**：
 * 后端整条 F4 链路（38 段 → 12 节点）都跑通了，用户却配不了 Key，等于 F4 不可用。
 *
 * ## 三条设计要点
 *
 * 1. **明文存储必须显式告知**（ADR-006 决策 1 的强制条件，不是免责声明）：
 *    要写出**实际路径**和**文件权限**，不许含糊成"安全地保存在本地"。
 * 2. **本地后端绝不要求填 Key**。竞品 memo.ac 的已知 bug 就是逼用户给 Ollama
 *    编一个假 key 才肯保存 —— 我们在 UI 上直接把 Key 输入框对本地 provider 隐藏。
 * 3. **Key 永不回显明文**。服务端只回 `hasKey` + 尾四位掩码，够用户确认"是不是那把"。
 */

const PRESETS: { id: string; label: string; kind: 'openai-compatible' | 'anthropic'; baseUrl: string; model: string; isLocal: boolean }[] = [
  { id: 'openai', label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', isLocal: false },
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514', isLocal: false },
  { id: 'deepseek', label: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', isLocal: false },
  { id: 'ollama', label: 'Ollama（本地）', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', isLocal: true },
  { id: 'lmstudio', label: 'LM Studio（本地）', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', isLocal: true },
  { id: 'custom', label: '自定义 / OpenAI 兼容', kind: 'openai-compatible', baseUrl: '', model: '', isLocal: false },
];

export function LlmSettingsSection() {
  const { t } = useTranslation();
  const { data, isLoading, isError, error, refetch } = useLlmSettingsQuery();
  const save = useSaveProviderMutation();
  const activate = useActivateProviderMutation();
  const test = useTestProviderMutation();

  const [editing, setEditing] = useState<string | null>(null);

  if (isError) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  return (
    <section className="rounded-lg border border-line bg-surface-1 p-4">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-medium text-ink">
        <KeyRound className="size-4" aria-hidden />
        {t('settings.llm')}
      </h2>
      <p className="mb-3 text-xs text-ink-secondary">{t('settings.llmIntro')}</p>

      <MockNotice surface="settings" className="mb-3" />

      {/* ★ ADR-006 决策 1 的强制条件：路径 + 权限，写清楚 */}
      <div className="mb-4 flex items-start gap-2 rounded-md border border-line border-l-4 border-l-warning bg-surface-0 px-3 py-2">
        <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
        <div className="text-xs">
          <div className="font-medium text-ink">{t('settings.plaintextTitle')}</div>
          <div className="mt-0.5 text-ink-secondary">
            {t('settings.plaintextDetail', {
              path: data?.secretsPath ?? '~/.local/share/openmemo/openmemo.db',
              mode: '0600',
            })}
          </div>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-ink-muted">{t('common.loading')}</p>
      ) : (
        <ul className="flex flex-col gap-2" role="list">
          {(data?.providers ?? []).map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              active={data?.activeProviderId === p.id}
              editing={editing === p.id}
              onEdit={() => setEditing(editing === p.id ? null : p.id)}
              onSave={(input) => save.mutate(input, { onSuccess: () => setEditing(null) })}
              onActivate={() => activate.mutate(p.id)}
              onTest={() => test.mutate(p.id)}
              testing={test.isPending && test.variables === p.id}
              testResult={test.variables === p.id ? test.data : undefined}
              saving={save.isPending}
            />
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {PRESETS.filter((preset) => !(data?.providers ?? []).some((p) => p.id === preset.id)).map(
          (preset) => (
            <Button
              key={preset.id}
              size="sm"
              variant="secondary"
              onClick={() =>
                save.mutate({
                  id: preset.id,
                  kind: preset.kind,
                  label: preset.label,
                  baseUrl: preset.baseUrl,
                  model: preset.model,
                  isLocal: preset.isLocal,
                })
              }
            >
              + {preset.label}
            </Button>
          ),
        )}
      </div>
    </section>
  );
}

function ProviderRow({
  provider,
  active,
  editing,
  editingDisabled,
  onEdit,
  onSave,
  onActivate,
  onTest,
  testing,
  testResult,
  saving,
}: {
  provider: LlmProviderConfigDto;
  active: boolean;
  editing: boolean;
  editingDisabled?: boolean;
  onEdit: () => void;
  onSave: (input: SaveProviderInput) => void;
  onActivate: () => void;
  onTest: () => void;
  testing: boolean;
  testResult?: { ok: boolean; latencyMs: number | null; errorMessage: string | null };
  saving: boolean;
}) {
  const { t } = useTranslation();
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [model, setModel] = useState(provider.model);
  const [apiKey, setApiKey] = useState('');
  const [reveal, setReveal] = useState(false);

  return (
    <li className={cn('rounded-md border p-3', active ? 'border-accent bg-accent-track/20' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">{provider.label}</span>
        {provider.isLocal ? (
          <span className="rounded bg-surface-0 px-1.5 py-0.5 text-xs text-ink-muted">
            {t('settings.localBadge')}
          </span>
        ) : provider.hasKey ? (
          <span className="text-xs text-good">{t('settings.keySet', { mask: provider.keyMask ?? '' })}</span>
        ) : (
          <span className="text-xs text-warning">{t('settings.keyMissing')}</span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {testing ? (
            <Loader2 className="size-3.5 animate-spin text-ink-muted" aria-hidden />
          ) : testResult ? (
            testResult.ok ? (
              <span className="inline-flex items-center gap-1 text-xs text-good">
                <CheckCircle2 className="size-3.5" aria-hidden />
                {testResult.latencyMs != null ? `${testResult.latencyMs} ms` : t('settings.testOk')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-critical" title={testResult.errorMessage ?? ''}>
                <XCircle className="size-3.5" aria-hidden />
                {t('settings.testFailed')}
              </span>
            )
          ) : null}

          <Button size="sm" variant="ghost" onClick={onTest} disabled={testing}>
            {t('settings.test')}
          </Button>
          <Button size="sm" variant={active ? 'ghost' : 'secondary'} onClick={onActivate} disabled={active}>
            {active ? t('settings.active') : t('settings.setActive')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit} disabled={editingDisabled}>
            {editing ? t('common.close') : t('settings.edit')}
          </Button>
        </div>
      </div>

      {editing ? (
        <div className="mt-3 grid gap-2 border-t border-line pt-3">
          <label className="grid gap-1 text-xs text-ink-secondary">
            {t('settings.baseUrl')}
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
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

          {/* ★ 本地 provider 不显示 Key 输入框。
              绝不逼用户为 Ollama/LM Studio 编一个假 key（竞品的已知 bug）。 */}
          {!provider.isLocal ? (
            <label className="grid gap-1 text-xs text-ink-secondary">
              {t('settings.apiKey')}
              <span className="flex gap-1">
                <input
                  type={reveal ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={provider.hasKey ? t('settings.keyKeepPlaceholder') : 'sk-…'}
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

          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={saving}
              onClick={() =>
                onSave({
                  id: provider.id,
                  kind: provider.kind,
                  label: provider.label,
                  baseUrl,
                  model,
                  isLocal: provider.isLocal,
                  ...(apiKey ? { apiKey } : {}),
                })
              }
            >
              {t('common.confirm')}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
