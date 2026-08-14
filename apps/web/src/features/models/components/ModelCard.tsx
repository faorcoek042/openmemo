import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Download, Info, Star, Trash2, Zap } from 'lucide-react';
import { Link } from 'react-router';
import type { ActiveSlotUnusable, CatalogGroupWithFitness, CatalogVariant } from '@openmemo/shared';
import { Button } from '../../../components/common/Button';
import { Emphasis } from '../../../components/common/Emphasis';
import { StatusChip } from '../../../components/common/StatusChip';
import { FitBadge, FitEta, FitGpuLayers } from '../../../components/common/FitBadge';
import { formatBytes } from '../../../lib/format/bytes';
import { localizedDescription, localizedName, pickLocalized } from '../../../lib/format/localized';
import { useAsrEngines } from '../../../components/common/AsrEngineStatus';
import { engineUnavailableText } from '../../../components/common/engineReasonText';
import { useIsAppleSilicon } from '../../../lib/api/hardware';
import { QuantSelector } from './QuantSelector';
import { engineFit } from '../engineFit';

/**
 * 目录里的一张模型卡（R-04 §9.1 线框）。
 *
 * 信息架构是两层：**模型**（折叠）→ **量化档**（展开选）。这是 LM Studio 的做法，
 * 也是唯一合理的组织方式 —— 同一个 Whisper large-v3-turbo 有 q5_0/q8_0/f16 三个变体，
 * 平铺成三张卡会让列表长三倍且难以比较。
 */

/**
 * 「这个条目适配哪个推理引擎」——**用户在点之前就该知道的那件事**。
 *
 * ## 它修的是什么
 *
 * `[用户真机 2026-08-09, Windows]` 用户装了 `vad/silero-vad-onnx`
 * （`engines: ['sherpa-onnx']`），而他的引擎是 whisper.cpp，需要的是
 * `vad/silero-vad-ggml`（`engines: ['whisper.cpp']`）。装完之后 daemon 每次装配
 * 都警告一次「已安装的 VAD 权重 whisper.cpp 加载不了」——
 * **但从没说过"你该装的是另一个"，而目录里 `engines` 字段一直写着答案。**
 *
 * `[实测 2026-08-09]` 在此之前 `engines` 在 `features/models/**` 里**零引用** ——
 * 也就是说这个字段**从来没有被显示给用户看过**（是"确定不存在"，不是"没找到"）。
 *
 * ## 判据：标注，**不过滤**（Manager 2026-08-09 裁定）
 *
 * > 不是"过滤掉不匹配的" —— 用户可能会换引擎，把另一个藏起来会制造新的困惑。
 * > 判据是"**用户在点之前就知道这个适用不适用于他现在的引擎**"。
 *
 * 所以这里只做**标注**：永远把 `engines` 显示出来；当它与本机**当前可用**的引擎
 * 不相交时，额外标一句「该引擎尚未启用」并**照抄 daemon 给的原因**（T-191 ④：原文是
 * "当前用不上"，而它与 daemon 自己那句「装这个就能启用」直接打架）。
 * **什么都不隐藏**，换引擎的人照样找得到另一个。
 * 这与 `ModelsPage` 对语言不匹配变体的既有做法同源（默认折叠 + 明说藏了几个，
 * 而不是删掉）。
 *
 * ⚠️ 空数组**不渲染**：`shared/models.ts:495` 明说空 `engines` 的语义是
 * "nothing can load this"，那是清单缺陷，不该在卡片上冒充成一句结论。
 */
/**
 * ★★ T-191 ④：「当前用不上」这句话在用户机器上**与 daemon 自己的话直接打架**。
 *
 * `[用户真机实测 2026-08-09，:10000]` `GET /api/health` 的原文是：
 *
 * ```json
 * { "id": "sherpa-onnx", "available": false,
 *   "reason": "未安装流式中文模型 —— 去「模型」页装 “sherpa 流式中文 zh-14M” 即可启用录音转文字" }
 * ```
 *
 * 而目录里带 `engines:['sherpa-onnx']` 的**只有 4 条**，其中两条正是
 * `asr/sherpa-streaming-zh-14m` 与 `asr/paraformer-zh-small` ——
 * **daemon 让他装的那两个模型，卡片上写着「当前用不上」。**
 * 同一个页面上，一句说"装这个就能用"，一句说"用不上"。
 *
 * 更糟的是那句 tooltip：「**换引擎后它就能用**」。这里根本不需要换引擎 ——
 * 装上它本身就是启用那个引擎的办法。**它在把用户往反方向推。**
 *
 * ── 判据（Manager 2026-08-09）：这行字要能让人分清三件事 ────────────────────────
 *
 *   (a) 是"有更好的替代所以用不上"，还是 (b) "出了问题所以用不上"；(c) 该做什么。
 *
 * 原文三件都答不了：「当前用不上」既不说是哪一种，也不给下一步。
 *
 * ── 修法：**不自己判断为什么，念 daemon 实测出来的那一档** ─────────────────────
 *
 * `useAsrEngines()` 一直带着每个引擎的 `reason`（`AsrEngineStatus.tsx` 里
 * 「reason 是 daemon 实测给的，不是我编的文案」那条规矩），而这里此前把它丢了。
 * 现在：
 *   · 引擎不可用但 daemon 给了原因 ⇒ **照它说的那一档渲染**（它自带 (b) 与 (c)）；
 *   · daemon 没给原因 ⇒ 退回一句不发明因果的中性说明，**不再说"换引擎"**。
 *
 * ⚠️ **#112：「daemon 给的」现在指的是一个机器可读的档位，不是一句现成的话。**
 * 那句话原来是 daemon 拼好的**中文散文**，被这里原样插进
 * `models.engineFit.notEnabledWithReason` 的 `{{reason}}` 里 —— 英文界面上于是
 * 半句中文。判据（是哪一档、已装哪几个 id）仍然**只由 daemon 出**，我们一个字
 * 都没有替它判断；变的只是措辞的归属：它现在住在两份 locale 里，由
 * `components/common/engineReasonText.ts` 那张总表取出。
 *
 * 措辞也从"用不上"改成"**引擎未启用**"：前者听起来像"这东西对你没用"（(a)），
 * 后者说的是事实 —— 引擎还没启用，而下一句正好告诉他怎么启用。
 */
function EngineFitChip({ engines }: { engines: readonly string[] }) {
  const { t } = useTranslation();
  const { engines: local, ready } = useAsrEngines();
  if (!engines || engines.length === 0) return null;

  // 判据抽在 `../engineFit`（纯函数，单测直接钉）—— 这里只负责怎么把它画出来。
  const { kind, reasons } = engineFit({ engines, local, ready });
  const mismatch = kind === 'not-enabled';
  // 措辞抽在 `engineReasonText.ts`（总表 + 两份 locale）—— 见本组件顶上的 #112 那段。
  const sentences = reasons.map((r) => engineUnavailableText(t, r));

  return (
    <span
      data-testid="model-engine-fit"
      className={
        mismatch
          ? 'rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning'
          : 'rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-secondary'
      }
      title={
        mismatch
          ? sentences.length > 0
            ? sentences.join('\n')
            : t('models.engineFit.mismatchHint')
          : undefined
      }
    >
      {mismatch
        ? sentences.length > 0
          ? t('models.engineFit.notEnabledWithReason', {
              engines: engines.join(' / '),
              reason: sentences[0],
            })
          : t('models.engineFit.notEnabled', { engines: engines.join(' / ') })
        : t('models.engineFit.fits', { engines: engines.join(' / ') })}
    </span>
  );
}

export interface ModelCardProps {
  group: CatalogGroupWithFitness;
  locale: string;
  installedIds: Set<string>;
  activeId: string | null;
  /**
   * @param includeOptional 用户勾选的可选文件 role（今天只有 `coreml-encoder`）。
   *   **必须显式传出去**：daemon 的 `selectFiles()` 只有收到
   *   `includeOptional:['coreml-encoder']` 才会下载它（`installer.ts:129`），
   *   而 T-153 之前**全仓没有任何地方传过这个值** —— 也就是说
   *   「用户在界面上根本没有办法装 CoreML encoder」，ANE 那条链在这里断掉。
   */
  onPull: (variant: CatalogVariant, includeOptional: string[]) => void;
  onDelete: (id: string) => void;
  onActivate: (id: string) => void;
  pendingId: string | null;
  /**
   * 这一组里那个**被记为使用中、但本机的引擎加载不了**的变体（A-4）。
   *
   * ⚠️ 可选，`null`/缺失 = **什么都不说**，不是"都能用"。
   *    老 daemon 不发 `activeUnusable`，那时我们确实不知道，
   *    替它说一句"没问题"就是编 —— 与 `updateAvailable` 同一条判据。
   * ⚠️ 由 `ModelsPage` **只传给包含那个 id 的那一组**：判据是整份已装清单，
   *    一张卡自己看不出来（与 `recommended` 那个 prop 同源）。
   */
  unusableActive?: ActiveSlotUnusable | null;
}

export function ModelCard({
  group,
  locale,
  installedIds,
  activeId,
  onPull,
  onDelete,
  onActivate,
  pendingId,
  unusableActive = null,
}: ModelCardProps) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState(
    () =>
      group.variants.find((v) => v.fitness.tier === 'recommended')?.id ??
      group.variants[0]?.id ??
      '',
  );
  /**
   * 勾选"同时下载 CoreML encoder"。
   *
   * **默认不勾**：它是另外 ~1.1 GB，而且不装也能正常转写（只是走 Metal/CPU 慢一些）。
   * 默认勾上等于替用户决定花掉一个多 GB 的流量与磁盘。
   */
  const [wantCoreMl, setWantCoreMl] = useState(false);
  /** 三态：`null` = 硬件还没探回来（此时什么都不渲染，不先当成"不是 Mac"）。 */
  const appleSilicon = useIsAppleSilicon();

  const variant = group.variants.find((v) => v.id === selectedId) ?? group.variants[0];
  if (!variant) return null;

  const installed = installedIds.has(variant.id);
  const isActive = activeId === variant.id;
  const isDefault = group.tags.includes('recommended-default');
  const pending = pendingId === variant.id;

  // 只有磁盘不足才真正禁用 —— 那是确定性事实。
  // 其余档位（含 unsupported）都可点，弹二次确认：估算必然有误差，
  // 硬禁用会把"估算可能错"变成"功能缺失"，用户没法自救（R-04 §9.6 第 7 条）。
  const hardBlocked = variant.fitness.tier === 'blocked_disk';

  /*
   * 这个变体到底有没有 CoreML encoder，**问清单，不猜**。
   * `role === 'coreml-encoder'` 是契约里的枚举值（`FILE_ROLES`），
   * 按文件名匹配 `.mlmodelc` 会在上游换命名时静默失效。
   */
  const coreMlFile = variant.files.find((f) => f.role === 'coreml-encoder');
  const offerCoreMl = appleSilicon === true && coreMlFile !== undefined && !installed;

  return (
    <article
      className="rounded-lg border border-line bg-surface-1 p-4"
      data-testid={`model-card-${group.groupId}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <FitBadge fitness={variant.fitness} />
            <h3 className="text-sm font-medium text-ink">{localizedName(locale, group)}</h3>
            <EngineFitChip engines={variant.engines} />
            {isDefault ? (
              <StatusChip
                tone="neutral"
                label={t('models.card.officialDefault')}
                icon={<Star className="size-3.5" />}
              />
            ) : null}
            {installed ? <StatusChip tone="good" label={t('models.card.installed')} /> : null}
            {/* 「使用中」与「已安装」同为 good：区分交给 ⚡ 图标与文字，不靠颜色（statusTone.ts） */}
            {isActive ? (
              <StatusChip
                tone="good"
                label={t('models.card.inUse')}
                icon={<Zap className="size-3.5" />}
              />
            ) : null}
          </div>
          {/*
            ★ T-150：目录里的描述**带 Markdown 强调记号**，必须渲染成 `<strong>`。
            实测：`vad/silero-vad` 的 `descriptionZh` 是
            「语音活动检测，**sherpa-onnx 引擎专用格式**。…whisper.cpp 用不了这个文件」——
            照直渲染，用户在页面上看到的是两颗裸星号（与 T-129 修掉的
            `settings.llmIntro` / disclosure 是同一族，只是这次的文字来自 manifest 而不是 i18n）。
            `EMPHASIS_REGISTRY` 那条护栏只扫 locale 文件，**扫不到 manifest**，
            所以这一处只能在渲染侧接住。
          */}
          <Emphasis
            className="mt-1 block text-xs text-ink-secondary"
            text={localizedDescription(locale, group)}
          />
          {/*
            ★★ A-4：**「记为使用中」与「真的用得上」是两件事，这里把后者说出来。**

            `vad/silero-vad` 这一张卡下面躺着两个**互相加载不了**的变体
            （ONNX 给 sherpa-onnx / ggml 给 whisper.cpp）。自动激活是"先装的赢"、
            目录里 onnx 在前，于是 `[用户真机 2026-08-09, Windows]` 上激活态说
            "这个 VAD 在用"，而流水线装配同一时刻说"whisper.cpp 加载不了，
            切分降级为固定窗口"，那条警告**一次启动出现 3 遍**。

            ⚠️ **三态分岔，措辞跟着动作走**（裁定原话：分不出来就说 UNKNOWN，别猜一个动作）：
              · `usableInstalled` 是 id  → 能用的**已经装了** ⇒ 给一个真按钮：改用它（零下载）；
              · `usableInstalled === null` → 逐个验过**确知没有** ⇒ 让他装一个标着该引擎的变体
                （这一页每张卡上就有 `EngineFitChip`，照着找得到）；
              · **字段缺失**（说不出）→ 只报事实，**一个动作都不给** ——
                猜错的那句话会把已经装好的人送去重下一遍，或让没装的人去找一个不存在的东西。

            ⚠️ 判据不在这里算：服务端按**文件内容**验过（`canEngineLoad`），
               前端一个字都不推导 —— 再算一遍就是第二份真相，而这一轮修的正是那族。
          */}
          {unusableActive ? (
            <p
              className="mt-1.5 text-xs text-warning"
              data-testid={`model-unusable-${group.groupId}`}
            >
              {t('models.card.unusableActive', {
                engine: unusableActive.engine,
                model: unusableActive.modelId,
              })}{' '}
              {unusableActive.usableInstalled != null
                ? t('models.card.unusableSwitch')
                : 'usableInstalled' in unusableActive
                  ? t('models.card.unusableInstall', { engine: unusableActive.engine })
                  : t('models.card.unusableUnknown')}
              {unusableActive.usableInstalled != null ? (
                <button
                  type="button"
                  className="ml-1.5 underline underline-offset-2"
                  data-testid={`model-unusable-switch-${group.groupId}`}
                  onClick={() => onActivate(unusableActive.usableInstalled as string)}
                >
                  {t('models.card.unusableSwitchAction')}
                </button>
              ) : null}
            </p>
          ) : null}
        </div>
        <Link
          to={`/models/${encodeURIComponent(variant.id)}`}
          className="shrink-0 text-xs text-accent-ink hover:underline"
        >
          <span className="inline-flex items-center gap-1">
            <Info className="size-3.5" aria-hidden />
            {t('models.card.details')}
          </span>
        </Link>
      </div>

      {/*
        ★ 能力取舍**逐字**显示，且必须在**下载之前**。

        契约（`shared/models.ts:433-441`）写着 `shown verbatim in the UI (ADR-013 decision 1)`，
        理由也写着：「A user who picks it for speed and later needs word-level alignment
        must be able to learn that BEFORE downloading, not after.」
        真实内容不是抽象的："无词级时间戳，只有段级" / "数字输出为中文而非阿拉伯数字" /
        "英文一律小写"（`paraformer-zh-small`），以及 "仅支持中文" / "仅用于流式录音，
        不能做离线批量转写"（`sherpa-streaming-zh-14m`）。
        **这些话一次都没有渲染过** —— 用户为速度选了它，代价要等到用起来才发现。

        ⚠️ **不翻译、不改写、不摘要**：契约说的是 verbatim。它是清单作者写给用户的原话，
        前端再润色一遍就等于替他重新承诺一次。
        ⚠️ 放在**动作行上方**而不是详情页深处：判据是"用户在他会走到的那条路径上真的看到了"，
        而他会走到的是这张卡上的下载按钮。
      */}
      {variant.capabilityCaveats && variant.capabilityCaveats.length > 0 ? (
        <ul
          className="mt-3 space-y-0.5 rounded-md border border-line bg-surface-0 px-2.5 py-1.5"
          data-testid="model-capability-caveats"
        >
          {variant.capabilityCaveats.map((c) => (
            <li key={c} className="flex items-start gap-1.5 text-xs text-ink-secondary">
              <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" aria-hidden />
              <span>{c}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <QuantSelector
          variants={group.variants}
          selectedId={variant.id}
          onSelect={setSelectedId}
          locale={locale}
        />
        <span className="text-xs text-ink-secondary">
          {t('models.card.vramNeeded', {
            size: formatBytes(variant.requirements.vramRequiredMB * 1e6, locale),
          })}
        </span>
        <FitEta fitness={variant.fitness} />
      </div>

      {/* #106：`reasonEn` 契约里一直有，这里原来写死取中文那一份。 */}
      <p className="mt-2 text-xs text-ink-secondary">
        {pickLocalized(locale, variant.fitness.reasonZh, variant.fitness.reasonEn)}
      </p>
      <FitGpuLayers fitness={variant.fitness} />

      {/*
        ★ T-153：CoreML encoder（Apple 神经引擎）。**这是 ANE 链路上断掉的那一环。**

        `libwhisper.coreml.dylib` 早就编进 macOS 包里了（T-146 `[CI 实测]` 解包确认），
        清单里也有 encoder 条目，但它是 `optional` —— daemon 只在收到
        `includeOptional:['coreml-encoder']` 时才下载，而**全仓没有任何地方传过这个值**。
        于是自检一直如实报 `asr.coreml warn 未启用 ANE`，而用户在界面上
        **没有任何办法**去装它。这个勾选框就是那个办法。

        只在 Apple Silicon 上渲染：其它平台勾了也会被 daemon 按 `platforms` 过滤掉，
        画一个"勾了什么都不会发生"的框比不画更糟。
      */}
      {offerCoreMl ? (
        <label
          className="mt-2 flex items-start gap-2 text-xs text-ink-secondary"
          data-testid="model-coreml-optin"
        >
          <input
            type="checkbox"
            checked={wantCoreMl}
            onChange={(e) => setWantCoreMl(e.target.checked)}
            className="mt-0.5"
            data-testid="model-coreml-checkbox"
          />
          <span>
            {t('models.card.coreml.label', {
              size: formatBytes(coreMlFile!.sizeBytes, locale),
            })}
            <span className="block text-ink-muted">{t('models.card.coreml.hint')}</span>
          </span>
        </label>
      ) : null}

      <div className="mt-3 flex items-center justify-end gap-2">
        {installed ? (
          <>
            {!isActive ? (
              <Button size="sm" variant="secondary" onClick={() => onActivate(variant.id)}>
                <Star className="size-3.5" aria-hidden />
                {t('models.card.setDefault')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onDelete(variant.id)}
              data-testid="model-delete"
            >
              <Trash2 className="size-3.5" aria-hidden />
              {t('models.card.delete')}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant={variant.fitness.tier === 'recommended' ? 'primary' : 'secondary'}
            disabled={hardBlocked || pending}
            onClick={() => onPull(variant, wantCoreMl && offerCoreMl ? ['coreml-encoder'] : [])}
            data-testid="models-download-button"
          >
            <Download className="size-3.5" aria-hidden />
            {pending
              ? t('models.card.starting')
              : hardBlocked
                ? t('models.card.noSpace')
                : variant.fitness.tier === 'unsupported'
                  ? t('models.card.downloadAnyway', {
                      size: formatBytes(variant.totalSizeBytes, locale),
                    })
                  : t('models.card.download', {
                      size: formatBytes(variant.totalSizeBytes, locale),
                    })}
          </Button>
        )}
      </div>
    </article>
  );
}
