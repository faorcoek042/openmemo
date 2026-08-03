import { useState } from 'react';
import { arr } from '../../../lib/safe';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, KeyRound, ShieldAlert, Trash2 } from 'lucide-react';

import { Button } from '../Button';
import { ErrorBlock } from '../ErrorBlock';
import { MockNotice } from '../MockNotice';
import {
  LLM_ACTIVE_KEY,
  LLM_DEFAULT_MODEL_KEY,
  LLM_PROVIDERS_KEY,
  buildLlmSettingsPatch,
  readActiveProviderId,
  readDefaultModelId,
  secretKeyFor,
  useDeleteSecretMutation,
  usePatchSettingsMutation,
  useSecretsQuery,
  useSetSecretMutation,
  useSettingsQuery,
  type LlmProviderConfig,
} from './api';
import { cn } from '../../../lib/utils';
import { useLlmConfig } from './llm-catalog';

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


export function LlmSettingsSection() {
  const { t, i18n } = useTranslation();
  const settings = useSettingsQuery();
  const secrets = useSecretsQuery();
  const patch = usePatchSettingsMutation();
  const setSecret = useSetSecretMutation();
  const delSecret = useDeleteSecretMutation();
  const [editing, setEditing] = useState<string | null>(null);
  /** 保存成功的时刻。用于给出**明确的成功信号**，而不是靠"表单关了"让用户自己猜。 */
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const { providers, modelsFor, availablePresets } = useLlmConfig();
  const activeId = readActiveProviderId(settings.data);
  /*
   * daemon 解析 provider 需要 `llm.defaultProviderId` **和** `llm.defaultModelId` 都有值，
   * 缺任一就返回 undefined → F4 报 LLM_NOT_CONFIGURED。所以两个都要读出来给用户看。
   */
  const effectiveProviderId = activeId;
  const effectiveModel = readDefaultModelId(settings.data);
  const disclosure = secrets.data?.disclosure;
  const hasKey = (id: string) =>
    arr(secrets.data?.secrets).some((s) => s.key === secretKeyFor(id));
  const maskOf = (id: string) =>
    arr(secrets.data?.secrets).find((s) => s.key === secretKeyFor(id))?.masked ?? null;

  /**
   * 保存 provider —— **同时写 daemon 真正读的那几个键**。
   *
   * 只写 `llm.providers` 是不够的：daemon 的 `resolveConfiguredProvider()` 只看
   * `llm.defaultProviderId` / `llm.defaultModelId` / `llm.baseUrl.<id>`。
   * 少写任何一个，用户就会遇到"界面上配好了、功能说没配"。
   */
  const upsertProvider = (p: LlmProviderConfig) => {
    patch.mutate(buildLlmSettingsPatch({ providers, provider: p, activeId }));
  };

  /** 设为默认。与保存**共用同一个 patch 生成器** —— 两个入口各拼各的就是上次漂移的原因。 */
  const setActive = (p: LlmProviderConfig) => {
    patch.mutate(buildLlmSettingsPatch({ providers, provider: p, activeId, makeActive: true }));
  };

  const removeProvider = (id: string) => {
    patch.mutate({
      [LLM_PROVIDERS_KEY]: providers.filter((x) => x.id !== id),
      // 删掉当前默认 provider 时，模型也要一起清 ——
      // 留着一个指向已删 provider 的模型名，只会让解析失败得更难懂
      ...(activeId === id ? { [LLM_ACTIVE_KEY]: null, [LLM_DEFAULT_MODEL_KEY]: null } : {}),
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

      {/*
        ★ **当前生效** —— 直接读 daemon 会读的那两个键，而不是读 `llm.providers`。
        用户上次踩的坑就是"列表里配得好好的、daemon 却解析不出来"：
        界面若照着自己的清单显示，永远显示正常，**永远发现不了缺键**。
        照着对面读的键显示，缺了就一眼看得见。
      */}
      <p className="mb-3 text-xs" data-testid="llm-effective">
        <span className="text-ink-secondary">{t('settings.effectiveLabel')}: </span>
        {effectiveProviderId && effectiveModel ? (
          <span className="text-ink">
            {providers.find((p) => p.id === effectiveProviderId)?.label ?? effectiveProviderId} ·{' '}
            {effectiveModel}
          </span>
        ) : (
          <span className="text-warning">{t('settings.effectiveNone')}</span>
        )}
      </p>

      {/*
        ★ 保存反馈：成功看得见、失败**绝不静默**。
        这一段之前完全不存在 —— 只有 `settings.isError`（读失败）被渲染，
        三个写 mutation 的错误谁都没接。
      */}
      {patch.isError ? <ErrorBlock error={patch.error} /> : null}
      {setSecret.isError ? <ErrorBlock error={setSecret.error} /> : null}
      {delSecret.isError ? <ErrorBlock error={delSecret.error} /> : null}
      {savedAt !== null && !patch.isError && !setSecret.isError ? (
        <p className="mb-3 text-xs text-good" data-testid="llm-saved">
          {t('settings.saved')}
        </p>
      ) : null}

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
                    onClick={() => setActive(p)}
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
                  models={modelsFor(p.id)}
                  saving={patch.isPending || setSecret.isPending}
                  onSave={(next, apiKey) => {
                    /*
                     * ★ **不再无条件关闭表单**。
                     *
                     * 原来这里直接 `setEditing(null)` —— 无论保存成功还是 403/401 失败，
                     * 表单都会收起来。用户看到的信号只有"表单关了"，
                     * 他会合理地理解为"保存成功了"，然后刷新发现什么都没有。
                     *
                     * 实测：缺 CSRF 头的写请求返回 **403**，而这个界面对此**一个字都不说**。
                     * `client.ts` 那条"写操作永不静默回落 mock"是对的、也生效了 ——
                     * 错误确实被抛出来了，**只是没有任何人把它渲染出来**。
                     * 规则本身没用，得有人接住。
                     */
                    const jobs: Promise<unknown>[] = [
                      // ★ 走同一个生成器：没有默认 provider 时，保存即生效
                      patch.mutateAsync(
                        buildLlmSettingsPatch({ providers, provider: next, activeId }),
                      ),
                    ];
                    if (apiKey !== undefined) {
                      const v = apiKey.trim();
                      jobs.push(
                        v
                          ? setSecret.mutateAsync({ key: secretKeyFor(p.id), value: v })
                          : delSecret.mutateAsync(secretKeyFor(p.id)),
                      );
                    }
                    void Promise.all(jobs)
                      // 只有**全部**成功才收起表单并给出成功反馈
                      .then(() => {
                        setEditing(null);
                        setSavedAt(Date.now());
                      })
                      // 失败：表单保持打开，错误就渲染在下面，用户的输入不会丢
                      .catch(() => undefined);
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        {/*
          ★ 在线在前、本地在后（ADR-016：BYO API Key 是**主路径**，本地探测是可选便利）。
          用户明确要的是"和 memo 一样用在线"，界面就不该让本地看起来是默认答案。
        */}
        {availablePresets
          .filter((x) => x.tier === 'online')
          .map((preset) => (
            <Button key={preset.id} size="sm" variant="secondary" onClick={() => upsertProvider(preset)}>
              + {preset.label}
            </Button>
          ))}
        {availablePresets.some((x) => x.tier === 'local') ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-muted">{t('settings.localOptional')}</span>
            {availablePresets
              .filter((x) => x.tier === 'local')
              .map((preset) => (
                <Button key={preset.id} size="sm" variant="ghost" onClick={() => upsertProvider(preset)}>
                  + {preset.label}
                </Button>
              ))}
          </span>
        ) : null}
      </div>
    </section>
  );
}

function ProviderForm({
  provider,
  hasKey,
  models,
  saving,
  onSave,
}: {
  provider: LlmProviderConfig;
  hasKey: boolean;
  /** 候选模型 —— 与「按用途分别配置」**同一个来源**，不再各画各的。 */
  models: string[];
  saving: boolean;
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
        {/*
          仍是自由输入，但配上 datalist 候选 —— 厂商上新模型比我们发版快，
          写死下拉会把新模型挡在外面。候选与分档配置共用同一份 `modelsFor()`。
        */}
        <input
          value={model}
          list={`models-${provider.id}`}
          onChange={(e) => setModel(e.target.value)}
          spellCheck={false}
          data-testid="llm-model-input"
          className="h-8 rounded-md border border-line bg-surface-0 px-2 text-sm text-ink"
        />
        <datalist id={`models-${provider.id}`}>
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
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
          disabled={saving}
          data-testid="llm-save"
          onClick={() =>
            onSave(
              { ...provider, baseUrl, model },
              provider.isLocal || apiKey === '' ? undefined : apiKey,
            )
          }
        >
          {saving ? t('settings.saving') : t('common.confirm')}
        </Button>
      </div>
    </div>
  );
}
