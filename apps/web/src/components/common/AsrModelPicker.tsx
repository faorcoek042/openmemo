import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { Cpu, Download } from 'lucide-react';

import type { GetInstalledResponse, InstalledModel } from '@openmemo/shared';

import { api } from '../../lib/api/client';
import { qk } from '../../app/query';
import { arr } from '../../lib/safe';
import { Button } from './Button';
import { ErrorBlock } from './ErrorBlock';

/**
 * 语音识别模型选择器 —— **列表来自后端，选择真的生效**。
 *
 * ## 它替换掉了什么
 *
 * 原来 `RecorderPage` 里写死了 `useState<'paraformer' | 'turbo'>`：
 * - 不来自 manifest，装再多模型也不会出现（用户看到的"只有两个可选"就是这么来的）
 * - 选中的值**从不发给后端**，选了等于没选
 * - `'turbo'` 这个字符串在后端根本不存在
 *
 * 三条合起来是同一个病：**UI 假装自己有权决定，实际什么都没决定。**
 *
 * ## 现在的真实边界（重要，不粉饰）
 *
 * 这个组件切的是**全局激活的模型**（`POST /api/models/activate`），
 * 不是"这一次任务用哪个" —— 界面上那句 `asr.activeIsGlobal` 说的就是这件事。
 *
 * ─── 但当初的**理由**已经不成立了，两边都留着（#99 ①）──────────────────
 * 原文写的是「后端的 `ImportNoteRequest` 只接受 `{input, title?, language?}`，
 * **没有 `engineId` / `modelId`**，"单次任务用哪个模型"目前不可指定」。
 * **今天不是这样**：`POST /api/notes/import`（`rest/notes.ts` 的 `ImportBody`）
 * 与 `POST /api/notes/:uid/retranscribe`（`rest/content.ts`）**都解析
 * `engineId` / `modelId` / `prompt` 并塞进 job payload**，
 * `jobs/runners/transcribe.ts` 也真的在按它们挑引擎和模型。
 *
 * 所以「per-task 覆盖」现在**是后端支持的**，只是前端一处都没接
 * （全仓没有任何请求体带过这三个键）。这里保持全局语义是**尚未裁决**，
 * 不是"后端不收"—— 见 #99 ①。⚠️ 别再拿旧理由挡下一个来问的人。
 */
/**
 * 下拉里那一行字。
 *
 * ⚠️ 不能无条件拼 `${displayName} (${quantization})`：manifest 里的 `displayName`
 * 本身**往往已经含量化档**，于是实测出现过 `Whisper base (Q5_1) (q5_1)` ——
 * 同一个信息写两遍，第二遍还是小写的，看起来像 bug（因为它就是 bug）。
 *
 * 判据是"名字里是否已经出现过这个量化标记"，大小写与分隔符（`_`/`-`）都归一化后再比，
 * 因为目录里 `Q5_1` / `q5-1` 两种写法都出现过。
 */
function optionLabel(m: InstalledModel): string {
  const name = m.displayName;
  const q = m.quantization;
  if (!q) return name;
  const norm = (s: string) => s.toLowerCase().replace(/[_\-\s]/g, '');
  return norm(name).includes(norm(q)) ? name : `${name} (${q})`;
}

/**
 * 按 `groupId` 聚成族，保持后端给的顺序（后端已按推荐度排过，前端重排会把它推翻）。
 * 组名取该族第一条的 `displayName` 去掉量化括号 —— manifest 没有单独的族显示名字段。
 */
function groupByFamily(models: InstalledModel[]): [string, InstalledModel[]][] {
  const map = new Map<string, InstalledModel[]>();
  for (const m of models) {
    const key = m.groupId || m.id;
    (map.get(key) ?? map.set(key, []).get(key)!).push(m);
  }
  return [...map.entries()].map(([key, list]) => {
    const label = (list[0]?.displayName ?? key).replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim();
    return [label || key, list] as [string, InstalledModel[]];
  });
}

/**
 * 当前**真正激活**的 ASR 模型（`/api/models/installed` 的 `active.asr`）。
 *
 * 存在的理由是一次真实事故：录音页把重跑提示的模型名写死成 `large-v3-turbo`，
 * 而实测机器上激活的是 `whisper-tiny-q5_1` —— **同一个页面的下拉里就显示着 Whisper tiny**，
 * 提示条却在说另一个名字。i18n 用的是 `{{model}}` 占位，是调用点填了常量。
 *
 * 这类"**UI 说出一个它没核对过的具体名字**"和 `MINDMAP_SAVE_SUPPORTED`、
 * `showModel={false}` 同族：**写的时候是对的，环境一变就成了谎**。
 * 修法同样不是改个更准的常量，而是**让它没有常量可写** —— 名字只能从后端来。
 */
export function useActiveAsrModel(): { id: string | null; displayName: string | null } {
  const { data } = useQuery({
    queryKey: qk.models.installed,
    queryFn: () => api<GetInstalledResponse>('models', '/models/installed'),
    staleTime: 30_000,
  });
  const id = data?.active?.asr ?? null;
  const m = arr(data?.models).find((x) => x.id === id);
  // 拿不到就回 null，由调用点决定"说什么都不说" —— 绝不回退到某个猜的名字
  return { id, displayName: m?.displayName ?? null };
}

export function AsrModelPicker({ className }: { className?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: qk.models.installed,
    queryFn: () => api<GetInstalledResponse>('models', '/models/installed'),
  });

  const activate = useMutation({
    mutationFn: (id: string) =>
      api<unknown>('models', '/models/activate', { method: 'POST', body: { role: 'asr', id } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.models.installed }),
  });

  /*
   * ★ T-199 ①：**选择器和运行器必须用同一个谓词。**
   *
   * 修之前这里是 `m.integrity !== 'missing_files'`，而真正决定"能不能拿去跑"的是
   * `packages/downloader/src/store.ts` 的 `findInstalledByRole(..., {requireIntegrityOk:true})`
   * —— 它要求 `integrity === 'ok'`。两个谓词的分歧样例是 `{role:'asr', integrity:'corrupt'}`
   * （用户点过「校验」且有文件 sha256 对不上，`rest/models.ts:757` 写的）：
   * 这里放行 → 用户选得中、`/models/activate` 也成功 → 起转写时 daemon 那边找不到它
   * → job 转 `blocked` 弹「去安装模型」，而 `/models` 上明明写着它已安装。
   * **选得中、跑不了，全程没有一句话解释。**
   *
   * 🔴 而 `'missing_files'` **全仓没有任何写入方**（只有类型声明和这一处读取）——
   * 也就是说这条判据**排除的是一个不存在的值，放行的是真实存在的那个**。
   *
   * 修法按裁决：**不隐藏，显示但禁用并给出原因**。隐藏了用户就不知道自己
   * 那个模型怎么了（他明明在 `/models` 上看得见它）。
   */
  const models: InstalledModel[] = arr(data?.models).filter(
    (m) => m.role === 'asr',
  ) as InstalledModel[];
  /** 与 `findInstalledByRole` 的 `requireIntegrityOk` 同一口径 —— 只有 `ok` 才真的跑得起来。 */
  const isRunnable = (m: InstalledModel): boolean => m.integrity === 'ok';
  const activeId = data?.active?.asr ?? null;

  if (isLoading) {
    return <span className={className}>{t('common.loading')}</span>;
  }

  // 一个都没装：给出路，而不是一个空下拉框
  if (models.length === 0) {
    /*
     * ★ 用户 2026-08-08 真机报告：「点击去安装模型，完全没有任何反应。」
     *
     * 成因不是事件没绑上，是**这个按钮就渲染在 `/models` 上**
     * （`ModelsPage` 自己用了这个 picker），而它的动作是 `navigate('/models')` ——
     * **导航到你已经在的那一页 = 什么都不发生**。按钮可点、样式正常、
     * 控制台干净、请求一条没有 —— 在用户那里与"按钮是死的"完全一样。
     * `[真浏览器实测]` URL 没变、DOM 没变、0 个 /api 请求、0 条异常。
     *
     * 修法：**已经在目标页上时，不要渲染一个什么都做不了的按钮** ——
     * 改成一句说明，告诉用户"就在这一页里装"。
     * 判据是"点了要么有事发生、要么给出看得懂的话"，一个不动的按钮两头都不占。
     */
    const alreadyOnModels = location.pathname.startsWith('/models');
    return (
      <span className={className}>
        <span className="mr-2 text-xs text-warning">{t('asr.noModel')}</span>
        {alreadyOnModels ? (
          <span className="text-xs text-ink-secondary">{t('asr.installHereHint')}</span>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => navigate('/models')}>
            <Download className="size-3.5" />
            {t('asr.goInstall')}
          </Button>
        )}
      </span>
    );
  }

  return (
    <label className={className}>
      <span className="mr-2 inline-flex items-center gap-1 text-xs text-ink-secondary">
        <Cpu className="size-3.5" aria-hidden />
        {t('asr.modelLabel')}
      </span>
      <select
        value={activeId ?? ''}
        onChange={(e) => activate.mutate(e.target.value)}
        disabled={activate.isPending}
        aria-label={t('asr.modelLabel')}
        data-testid="asr-model-select"
        className="h-8 rounded-md border border-line bg-surface-0 px-2 text-sm text-ink"
      >
        {activeId === null ? <option value="">{t('asr.notSelected')}</option> : null}
        {/*
          按模型族分组（T-114）。目录里同一个族有 2～4 个量化档，装了几档就平铺几行 ——
          `Whisper 基础模型 (Q5_1)` / `(Q8_0)` / `(F16)` 三行只差括号里那几个字符，
          在一列等宽选项里靠"读到第几个字才不同"来区分是最慢的一种辨认方式。
          `<optgroup>` 是原生分组，零依赖、读屏器天然支持。

          ⚠️ 这只解决**已安装**列表。`/models` 目录页的 25 条平铺是另一件事：
          memo.ac 的做法是「语言 × 速度」双轴筛选卡片，而我们的 manifest **缺速度轴**
          （`quantTier` 是体积轴，tiny-f16 和 large-v3-f16 都落进 `full`，速度差几十倍）。
          见 R-06 附录 B —— 该字段属 `model-mgmt`，我这一轮做不了。
        */}
        {groupByFamily(models).map(([family, list]) => (
          <optgroup key={family} label={family}>
            {list.map((m) => (
              /*
               * 跑不了的**留在列表里但禁用**，并把原因写进标签 —— 用户在 `/models` 上
               * 看得见这个模型，这里凭空少一行只会让他以为是自己看花了眼。
               * `disabled` 是原生语义：鼠标点不中、键盘跳过、读屏器会念"不可用"。
               */
              <option key={m.id} value={m.id} disabled={!isRunnable(m)}>
                {optionLabel(m)}
                {isRunnable(m) ? '' : t('asr.unusableSuffix')}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {/* 说清楚这是全局切换，不是"本次任务用哪个" —— 免得用户以为可以按任务选 */}
      <span className="ml-2 text-xs text-ink-muted">{t('asr.activeIsGlobal')}</span>
      {/*
        ★ 切换失败此前**完全静默**：`activate.mutate()` 没有 onError，也没有任何 isError 渲染点。
        `<select>` 是受控的（`value={activeId ?? ''}`），失败后 `activeId` 没变 ⇒
        **下拉悄悄弹回旧值**。用户看到的是"我选了，它自己跳回去了"——
        与"这个下拉坏了"完全同形，而真实原因（模型文件损坏 / 引擎构造不起来）一个字都没有。
      */}
      {activate.isError ? <ErrorBlock error={activate.error} className="mt-2" /> : null}
    </label>
  );
}
