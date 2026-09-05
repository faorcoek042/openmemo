import { useState } from 'react';
import { arr } from '../../../lib/safe';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  KeyRound,
  ShieldAlert,
  Trash2,
} from 'lucide-react';

import { Button } from '../../../components/common/Button';
import { Emphasis } from '../../../components/common/Emphasis';
import { ErrorBlock } from '../../../components/common/ErrorBlock';
import { MockNotice } from '../../../components/common/MockNotice';
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
import { LlmModelSelect } from './LlmModelSelect';
import { LocalLlmSection } from './LocalLlmSection';
import {
  baseUrlFieldMode,
  useLlmConfig,
  type CatalogPreset,
  type ModelCatalogNote,
} from './llm-catalog';

/**
 * B-3：LLM provider 配置 —— **解开 F4 的那一把钥匙**（T-041 接真后端）。
 *
 * ## 三条设计要点（与上一版一致，数据源换成真端点）
 *
 * 1. **明文存储告知用服务端下发的原文**，不再前端硬编码 ——
 *    路径随 `OPENMEMO_DATA_DIR` 变，硬编码必然说错（我上一版就说错了：
 *    写死成 `openmemo.db`，实测真实位置是 `<dataDir>/secrets.json`，**连文件都不是同一个**）。
 * 2. **本地后端不显示 Key 输入框**。竞品逼用户给 Ollama 编一个假 key 才肯保存。
 *    → T-150 把判据换成了目录里的 `configFieldKeys`（D-10 R-P3）：
 *    不是"我觉得本地不用 Key"，而是**这家自己声明了它要哪几个字段**。
 * 3. **Key 永不回显明文** —— 服务端的 `SecretStore` 接口**刻意不含 `get()`**，只回掩码。
 *
 * ## ★ T-150（D-10 #24 / #26 / #27 / #28）
 *
 * | # | 之前 | 现在 |
 * |---|---|---|
 * | #24 | 「+ 添加」只有**写死的 11 个**预设 → 13 家 / 237 条模型**用户加不进去** | 吃 `vendor/manifests/llm-providers.json` 的 **24 家**，`bucketProviders()` 分三桶 |
 * | #27 | 每家都固定渲染 baseUrl + model + apiKey 三件套 | 由 `configFieldKeys` 逐家渲染；`baseUrl.editable === false` 时只读 |
 * | #26 | 模型下拉旁只有一句"清单更新于…" | 按 `canRefreshModelList()` **分流措辞**（详见 `LlmModelSelect`） |
 * | #28 | 出厂只有一句 `settings.noProviders` | 完整空状态：说清为什么空 + 六个按钮就在眼前 + 不预选任何一家 |
 *
 * ## ★ T-153：上面那两条"不做"，现在做了 —— 因为缺的那两个端点补上了
 *
 * 📝 **此前这里写着**（保留原文，因为它记录的是一个真实的判断，不是遗漏）：
 * > 「刷新模型列表」**没有按钮**。全仓没有任何端点能替前端枚举某家的模型
 * > （daemon 路由表里无 `/api/llm/models`）。给按钮 = 24 个按不动的按钮。
 * > 「本地模型」还不是 D-10 §4.2 那个折叠的 **[探测本机]** 组…… 那条卡在 D-10 #23 的
 * > `POST /api/llm/detect` 上 —— **端点至今不存在**，做出来只能是个假按钮。
 *
 * 那个判断是对的：**没有端点就不该有按钮。** T-153 把两个端点都补上了，
 * 于是这两条的前提消失了：
 *
 * | # | 现在 |
 * |---|---|
 * | #3 | `<LocalLlmSection>` —— 折叠的「本地模型」组，`POST /api/llm/detect` 真去敲三个本机端口 |
 * | #26 | `LlmModelSelect` 对 `canRefreshModelList()===true` 的 **4 家**渲染「刷新」，其余 20 家仍然只显示 `checkedAt`。**判据没变，变的是那 4 家的按钮现在真的按得动** |
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
  /** 「更多服务商」默认折叠 —— 18 家平铺会把置顶六家淹掉（D-10 §4.2 采纳 memo.ac 的折叠组）。 */
  const [showMore, setShowMore] = useState(false);

  const { providers, modelsFor, catalogNoteFor, presetFor, buckets } = useLlmConfig();
  const activeId = readActiveProviderId(settings.data);
  /*
   * daemon 解析 provider 需要 `llm.defaultProviderId` **和** `llm.defaultModelId` 都有值，
   * 缺任一就返回 undefined → F4 报 LLM_NOT_CONFIGURED。所以两个都要读出来给用户看。
   */
  const effectiveProviderId = activeId;
  const effectiveModel = readDefaultModelId(settings.data);
  const disclosure = secrets.data?.disclosure;
  const hasKey = (id: string) => arr(secrets.data?.secrets).some((s) => s.key === secretKeyFor(id));
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

  const empty = providers.length === 0;

  return (
    <section className="rounded-lg border border-line bg-surface-1 p-4">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-medium text-ink">
        <KeyRound className="size-4" aria-hidden />
        {t('settings.llm')}
      </h2>
      {/*
        ★ 文案里的 `**推荐用在线 API**` 此前是**原样渲染**的 —— 用户在页面上真的看到
        两颗星号。同一屏还有第二处：下面 disclosure 的 `以**明文**保存`。
        两处都用 `<Emphasis>` 渲染成 `<strong>`。
      */}
      <Emphasis className="mb-3 block text-xs text-ink-secondary" text={t('settings.llmIntro')} />

      <MockNotice surface="settings" className="mb-3" />

      {/*
        ★ **当前生效** —— 直接读 daemon 会读的那两个键，而不是读 `llm.providers`。
        用户上次踩的坑就是"列表里配得好好的、daemon 却解析不出来"：
        界面若照着自己的清单显示，永远显示正常，**永远发现不了缺键**。
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
        三个写 mutation 的错误此前谁都没接。
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
          <Emphasis
            className="text-xs text-ink-secondary"
            text={i18n.language.startsWith('zh') ? disclosure.messageZh : disclosure.message}
          />
        </div>
      ) : null}

      {settings.isLoading ? (
        <p className="text-sm text-ink-muted">{t('common.loading')}</p>
      ) : empty ? (
        /*
         * ★ D-10 #28 出厂空状态。三条判据：
         *   ① 说清**为什么空**（不是加载失败）；
         *   ② 给**下一步点哪**（六个按钮就在眼前，在下面那块「常用」里）；
         *   ③ **不预选、不假装** —— memo.ac 出厂高亮一个没凭据的 `openai/gpt-5.4-mini`，
         *      读起来像"已经配好了"，把第一次生成导图变成一次没头没脑的失败。
         */
        <div
          className="mb-3 rounded-md border border-dashed border-line px-3 py-3"
          data-testid="llm-empty"
        >
          <p className="text-sm text-ink">{t('settings.empty.title')}</p>
          <p className="mt-1 text-xs text-ink-secondary">{t('settings.empty.why')}</p>
          <p className="mt-1 text-xs text-ink-muted">{t('settings.empty.local')}</p>
        </div>
      ) : (
        <ul className="mb-3 flex flex-col gap-2" role="list">
          {providers.map((p) => {
            const preset = presetFor(p.id);
            return (
              <li
                key={p.id}
                data-testid={`llm-provider-${p.id}`}
                className={cn(
                  'rounded-md border p-3',
                  activeId === p.id ? 'border-accent bg-accent-tint/20' : 'border-line',
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">{p.label}</span>
                  {p.isLocal ? (
                    <span className="rounded bg-surface-0 px-1.5 py-0.5 text-xs text-ink-muted">
                      {t('settings.localBadge')}
                    </span>
                  ) : null}
                  {/*
                    ★ D-10 R-P3：**Key 的状态只对"这家真的要 Key"的服务商说。**
                    给 Ollama 写「未设置 Key」是撒谎 —— 它压根不收 Key。
                    判据是目录里这家自己声明的 `configFieldKeys`，不是我们猜的 `isLocal`。
                  */}
                  {!preset || preset.fields.includes('apiKey') ? (
                    hasKey(p.id) ? (
                      <span className="text-xs text-good">
                        {t('settings.keySet', { mask: maskOf(p.id) ?? '' })}
                      </span>
                    ) : (
                      <span className="text-xs text-warning">{t('settings.keyMissing')}</span>
                    )
                  ) : (
                    <span className="text-xs text-ink-muted">{t('settings.noKeyNeeded')}</span>
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
                    preset={preset}
                    hasKey={hasKey(p.id)}
                    /*
                     * ★ **型号的初值取权威值，不取 `llm.providers[i].model`**（T-126 追加修复）。
                     *
                     *   `llm.defaultModelId`      → **daemon 唯一认的"现在用哪个型号"** = 权威
                     *   `llm.providers[i].model`  → **daemon 从不读**，只是"这家上次选的型号"
                     *
                     * 原来表单从**记忆**里取初值，于是同一屏自相矛盾，
                     * 而且**只要点一次「确定」，权威值就被记忆值静默覆盖**。
                     */
                    initialModel={(activeId === p.id ? effectiveModel : null) || p.model}
                    models={modelsFor(p.id)}
                    note={catalogNoteFor(p.id)}
                    saving={patch.isPending || setSecret.isPending}
                    onSave={(next, apiKey) => {
                      /*
                       * ★ **不再无条件关闭表单**。原来无论保存成功还是 403/401 失败表单都收起来，
                       * 用户看到的信号只有"表单关了"，他会合理地理解为"保存成功了"。
                       */
                      const jobs: Promise<unknown>[] = [
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
            );
          })}
        </ul>
      )}

      {/*
        ★ D-10 #24：「+ 添加服务商」= 目录的三桶，不再是写死的 11 个。

        置顶六家（`MAINSTREAM_PROVIDER_IDS`，与 memo.ac 那份数组逐字相同）常驻；
        其余 18 家折叠 —— 平铺 24 个按钮会把"填个 Key 就能用"这件事淹掉。
      */}
      <div className="flex flex-col gap-2" data-testid="llm-provider-buckets">
        <p className="text-xs font-medium text-ink-secondary">{t('settings.bucket.mainstream')}</p>
        <AddRow presets={buckets.mainstreamUnconfigured} onAdd={upsertProvider} />

        {buckets.more.length > 0 ? (
          <>
            <button
              type="button"
              className="flex w-fit items-center gap-1 text-xs text-accent-ink hover:underline"
              onClick={() => setShowMore((v) => !v)}
              aria-expanded={showMore}
              data-testid="llm-more-toggle"
            >
              {showMore ? (
                <ChevronDown className="size-3.5" aria-hidden />
              ) : (
                <ChevronRight className="size-3.5" aria-hidden />
              )}
              {t('settings.bucket.more', { n: buckets.more.length })}
            </button>
            {showMore ? (
              <div data-testid="llm-more">
                <AddRow presets={buckets.more} onAdd={upsertProvider} />
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {/*
        ★ D-10 §4.2 / #3「本地模型」折叠组。**默认折叠**，与线框一致：
        档 2 是"可选便利"，不是主路径（ADR-016 保留档 1 为主路径）。
        它与上面的「常用」不重复：Ollama / LM Studio 在「常用」里是**照目录预填地址**，
        这里是**真去本机问过**——后者能回答"我到底装没装、装了几个模型"。
      */}
      <LocalLlmSection configuredIds={providers.map((p) => p.id)} onAdd={upsertProvider} />
    </section>
  );
}

/**
 * 一桶服务商的「+ 添加」按钮。
 *
 * **驱动不了的那几家照样列出来，但点不动，并且当场说明原因** ——
 * 悄悄从清单里抹掉会让用户以为"这个产品不支持它"，
 * 而事实是"我们还没写它的适配器"。两句话不一样，用户的下一步也不一样。
 */
function AddRow({
  presets,
  onAdd,
}: {
  presets: readonly CatalogPreset[];
  onAdd: (p: LlmProviderConfig) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {presets.map((preset) =>
        preset.support.supported && preset.config ? (
          <Button
            key={preset.spec.id}
            size="sm"
            variant={preset.config.isLocal ? 'ghost' : 'secondary'}
            data-testid={`llm-add-${preset.spec.id}`}
            onClick={() => onAdd(preset.config!)}
          >
            + {preset.spec.displayName}
          </Button>
        ) : (
          <span
            key={preset.spec.id}
            className="inline-flex items-center gap-1 rounded-md border border-dashed border-line px-2 py-1 text-xs text-ink-muted"
            data-testid={`llm-unsupported-${preset.spec.id}`}
            title={t(
              preset.support.supported
                ? 'settings.unsupported.kind'
                : `settings.unsupported.${preset.support.reason}`,
              { kind: preset.spec.kind },
            )}
          >
            {preset.spec.displayName}
            <span className="text-warning">
              {t(
                preset.support.supported
                  ? 'settings.unsupported.kind'
                  : `settings.unsupported.${preset.support.reason}`,
                { kind: preset.spec.kind },
              )}
            </span>
          </span>
        ),
      )}
    </div>
  );
}

/**
 * 服务商表单 —— **字段由目录里的 `configFieldKeys` 决定**（D-10 R-P3）。
 *
 * 实测反例（就是这条约束的由来）：
 *   · `ollama` 的 `configFieldKeys` 是 `['baseURL','model','temperature']` —— **没有 apiKey**；
 *   · `mistralai` 的 `baseUrl.editable === false` —— 地址栏必须只读。
 * 让用户给 Ollama 编一个假 key，是竞品真在做的事，
 * 而它教会用户"这个程序不理解自己的配置"。
 */
function ProviderForm({
  provider,
  preset,
  hasKey,
  initialModel,
  models,
  note,
  saving,
  onSave,
}: {
  provider: LlmProviderConfig;
  /** 目录里对应的那家。`null` = 用户自己加的/老 id 认不出来 ⇒ 退回三件套全给。 */
  preset: CatalogPreset | null;
  hasKey: boolean;
  /**
   * 型号初值。**这家正生效时 = `llm.defaultModelId`（权威），否则 = 这家记住的型号。**
   * 刻意不默认成 `provider.model`：那正是"点一次确定就静默换掉用户型号"的来源。
   */
  initialModel: string;
  /** 候选模型 —— 与「按用途分别配置」**同一个来源**，不再各画各的。 */
  models: string[];
  /** 候选清单的出处与时效（同一份目录）。 */
  note: ModelCatalogNote | null;
  saving: boolean;
  onSave: (next: LlmProviderConfig, apiKey?: string) => void;
}) {
  const { t } = useTranslation();
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [model, setModel] = useState(initialModel);
  const [apiKey, setApiKey] = useState('');
  const [reveal, setReveal] = useState(false);
  /**
   * 「刷新模型列表」刚从对面问回来的清单（D-10 #26，T-153）。
   *
   * **并进候选，不替换掉内置清单** —— 用户当前选的那个型号可能不在刷新结果里
   * （下架了、或者是自定义网关的别名），替换会让它在下拉里**当场消失**，
   * 而那正是 `LlmModelSelect` 文件头第一条约束在防的事。
   */
  const [refreshed, setRefreshed] = useState<string[]>([]);

  /*
   * 认不出这家（自定义网关 / 老 id）时退回三件套：**宁可多给一个字段，
   * 也不要因为"目录里没有"就把用户的 Key 输入框藏掉** —— 那会让他配不上。
   */
  const fields = preset?.fields ?? (['baseURL', 'model', 'apiKey'] as const);
  const baseUrlMode = baseUrlFieldMode(preset);
  const showModel = fields.includes('model');
  const showApiKey = fields.includes('apiKey');

  /*
   * 目录声明了、但**我们存不下也不会发出去**的那些字段（temperature / maxTokens /
   * apiVersion / deploymentId）：`llm.providers` 的记录里没有它们，
   * `resolveConfiguredProvider()` 也一个都不读。
   * → **不给控件**（一个改了不生效的输入框是假控件）。
   *
   * ## ⚠️ 那句 `settings.unwiredFields` 删掉了，连同它的计算
   *
   * 原话是「目录里这家还声明了 X —— 本地服务现在不读这几个字段，所以这里不给控件
   * （给了也不会生效）」。它对用户是**纯内部状态**：读完他既做不了什么，我们也
   * 没承诺以后会接。判据是那条 —— **什么都做不了就明说然后闭嘴**，而这一句
   * 连"明说"都不是，它说的是我们的实现进度。
   *
   * 原注释里"要说出来，否则下一个人会以为 `configFieldKeys` 已经吃全了"——
   * 那个担心是真的，但**它的读者是下一个改这个文件的人，不是用户**。
   * 所以它留在这里（注释），不留在屏幕上。
   */

  return (
    <div className="mt-3 grid gap-2 border-t border-line pt-3">
      {baseUrlMode !== 'hidden' ? (
        <label className="grid gap-1 text-xs text-ink-secondary">
          {t('settings.baseUrl')}
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            readOnly={baseUrlMode === 'readonly'}
            spellCheck={false}
            data-testid="llm-field-baseURL"
            className={cn(
              'h-8 rounded-md border border-line px-2 text-sm text-ink',
              baseUrlMode === 'editable' ? 'bg-surface-0' : 'bg-surface-2 text-ink-muted',
            )}
          />
          {baseUrlMode === 'readonly' ? (
            <span className="text-ink-muted">{t('settings.baseUrlLocked')}</span>
          ) : null}
        </label>
      ) : null}

      {showModel ? (
        <label className="grid gap-1 text-xs text-ink-secondary">
          {t('settings.model')}
          {/*
            ★ T-126：真下拉，候选来自 `vendor/manifests/llm-providers.json`，
            与「按用途分别配置」**是同一个组件、同一份数据**（`modelsFor()`）。
          */}
          <LlmModelSelect
            value={model}
            models={[...new Set([...models, ...refreshed])]}
            onChange={setModel}
            note={note}
            providerId={provider.id}
            onModelsRefreshed={setRefreshed}
            testId="llm-model-select"
            ariaLabel={t('settings.model')}
          />
        </label>
      ) : null}

      {/* ★ 由 `configFieldKeys` 决定 —— 绝不逼用户为 Ollama 编一个假 key */}
      {showApiKey ? (
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
              data-testid="llm-field-apiKey"
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
              !showApiKey || apiKey === '' ? undefined : apiKey,
            )
          }
        >
          {saving ? t('settings.saving') : t('common.confirm')}
        </Button>
      </div>
    </div>
  );
}
