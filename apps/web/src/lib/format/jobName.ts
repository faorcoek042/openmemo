/**
 * 一个 job 的显示名 → 当前界面语言下该显示的那个名字。
 *
 * ## 为什么要有这一处
 *
 * 名字是 **daemon 建 job 那一刻就定死的**，而且写死成中文：
 * `apps/daemon/src/http/rest/models.ts:416` `displayName: model.displayNameZh`。
 * `packages/downloader/src/queue.ts` 的 `enqueue()` 把它写进对象存起来，
 * `/api/jobs` 只是原样序列化出去 —— **读的时候完全不现算**。
 * 于是**任何英文界面都会看到 `Downloading model · 超小英文模型`**。
 *
 * ## 为什么不在 daemon 修
 *
 * - **猜 `Accept-Language`** ⇒ 同一个 job 在两个标签页里显示不同名字，**而它是同一个 job**；
 * - **两份名字都存进 job** ⇒ 把**观察者属性**（语言）烤进**被观察对象**（job 的快照），
 *   建模就是错的。
 *
 * 语言属于**读的那一刻**，所以本地化必须发生在读的那一刻 —— 也就是这里。
 * daemon 那个 `displayName` **保留为兜底**，见下。
 *
 * ## 兜底：什么时候**不**替换（这三种都不是异常，是正常路径）
 *
 * | 情形 | 显示什么 | 为什么 |
 * | --- | --- | --- |
 * | 目录还没加载 / 加载失败 | daemon 给的 `displayName` | 首帧必然如此，不能闪空 |
 * | `targetId` 不在目录里 | daemon 给的 `displayName` | 本地导入的模型 id 形如 `asr/imported-<文件名>`（`models.ts:836`），**永远不会在目录里**，而那时 daemon 给的正是**文件名**，恰恰是该显示的东西 |
 * | 后端包（`download.backend`） | daemon 给的 `displayName` | 后端包在**另一份目录**里（`qk.backends.catalog`），不是模型目录 |
 *
 * ⚠️ **兜底绝不返回空串，也绝不返回原始 slug。** daemon 的 `displayName` 在上面三种
 * 情形下都是有意义的人话。只有它自己也空了，才退到 `targetId` ——
 * 那是"什么都没有"时唯一还剩的真话，比空白强。
 *
 * ## 为什么住在 `lib/` 而不是 `features/models/`
 *
 * 消费方之一是 `components/common/JobToaster.tsx`，而 eslint（D-05 §3.5,
 * `eslint.config.js:82-99`）禁止 `lib/` 与 `components/` 依赖 `features/`。
 * 所以"id → 本地化名字"必须是一个**不认识任何 feature 的纯函数**，
 * 目录由调用方以 `lookup` 注入。这与 `stepLabel.ts` 是同一个形状：
 * **一份实现，多个渲染点共用。**
 */

import { localizedName } from './localized';

/** 目录里一条能提供两份名字的东西。字段名照 `packages/shared` 的契约。 */
export interface LocalizableEntry {
  readonly displayName?: string | null;
  readonly displayNameZh?: string | null;
}

/**
 * 由调用方注入的目录查表。
 *
 * 返回 `null` = **这个 id 我不认识**（目录没加载、或它压根不在目录里）。
 * 注意这与"认识但两份名字都是空"是两回事，后者由 {@link jobDisplayName} 的兜底兜住。
 */
export type CatalogLookup = (targetId: string) => LocalizableEntry | null | undefined;

/** {@link jobDisplayName} 需要从 job 上读的那几个字段（只读这些，不要整个 job）。 */
export interface JobNameInput {
  /** `packages/shared/src/jobs.ts`：`'download.model' | 'download.backend' | 'transcribe' | …` */
  readonly type: string;
  /** 目录 slug。只有 `DownloadJob` 有；`PipelineJob` 没有，传 `null`。 */
  readonly targetId?: string | null;
  /** daemon 建 job 那一刻写死的名字。**兜底用的就是它。** */
  readonly displayName?: string | null;
}

/**
 * ⚠️ **只有模型下载才查目录。**
 *
 * `transcribe` / `mindmap` 这些流水线 job 的 `displayName` 是**用户自己的笔记标题**
 * （`apps/daemon/src/jobs/events.ts:81`）—— 把用户数据"本地化"成别的字符串是错的，
 * 而且它们**根本没有 `targetId`**。这里用 `type` 做**结构式**判别，
 * 不是去嗅名字长什么样。
 */
function usesModelCatalog(type: string): boolean {
  return type === 'download.model';
}

/**
 * @param locale 当前界面语言（`i18n.language`），`zh` 前缀算中文。
 * @param job 只读 `type` / `targetId` / `displayName` 三个字段。
 * @param lookup 目录查表；不传 = 没有目录可查，直接走兜底。
 */
export function jobDisplayName(locale: string, job: JobNameInput, lookup?: CatalogLookup): string {
  const fallback = (job.displayName ?? '').trim();
  const targetId = (job.targetId ?? '').trim();

  if (lookup !== undefined && targetId !== '' && usesModelCatalog(job.type)) {
    const entry = lookup(targetId);
    if (entry !== null && entry !== undefined) {
      const localized = localizedName(locale, entry).trim();
      // 目录里认识它、但两份名字都空 —— 这不该发生，真发生了也不能把界面弄空
      if (localized !== '') return localized;
    }
  }

  if (fallback !== '') return fallback;
  // 最后一道：daemon 的名字也没有。原始 slug 不好看，但它是**真的**，比空白强。
  return targetId;
}
