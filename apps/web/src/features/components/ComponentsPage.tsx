import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleHelp, RefreshCw, ShieldCheck } from 'lucide-react';
import type { ComponentStatus } from '@openmemo/shared';
import { upstreamHasNewer, upstreamKnownVersion } from '@openmemo/shared';

import { Banner } from '../../components/common/Banner';
import { Button } from '../../components/common/Button';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { useCheckUpdatesMutation, useComponentsQuery, useUpdateComponentMutation } from './api';
import { ComponentCard } from './components/ComponentCard';

/**
 * 组件与来源页。
 *
 * 回答用户直接提出的两个问题：
 *   「只要写明从哪里下载对应依赖即可」 → 每个组件的来源链完整可见且可点：
 *      源码 submodule commit → 发布页 → 二进制 → sha256（含来源说明）→ 许可证
 *   「检测上游组件对应版本然后灵活更新各个组件」 → 三个版本并列 + 单组件一键更新
 *
 * ★ 默认不自动更新。检测到新版本只提示，更新永远是用户点出来的。
 *   上游换版本可能直接改变行为（我们自己就出过 ONNX / ggml 格式不兼容那次），
 *   静默更新会让用户的转写结果莫名其妙变化，而且无从追查。
 */
export default function ComponentsPage() {
  const { i18n } = useTranslation();
  const locale = i18n.language;

  // 首屏不查上游：先把本地清单和来源渲染出来，联网检测是用户点出来的额外动作。
  const q = useComponentsQuery(false);
  const check = useCheckUpdatesMutation();
  const update = useUpdateComponentMutation();

  const [busyId, setBusyId] = useState<string | null>(null);

  /*
   * ★ T-200 S-6：**渲染只认活查询，不认 mutation 的返回值。**
   *
   * 这里原本是 `check.data ?? q.data`。`check.data` 是一次「检查更新」的**快照**，
   * 而 `useMutation` 的 `data` 在下一次 mutate 之前**永远不变**（`check.reset()` 全仓零调用），
   * 于是它一旦有值就把活的 `q.data` 永久压住 —— 整页冻结在那一刻。
   *
   * 而服务端那一侧一直在正确地更新：`features/components/sse.ts` 的
   * `backend.installed` / `backend.removed` / `model.installed` 与
   * `api.ts` 的 `useUpdateComponentMutation.onSuccess` 都 invalidate 了
   * `qk.components.all`，`q.data` 真的变新了 —— **只是渲染读不到。**
   *
   * 用户看到的：点「更新到 X」→ 任务真的跑完 → 卡片仍显示旧版本和「更新到 X」按钮
   * → **他会再点一次**。
   *
   * 删掉 `check.data ?? ` **不丢任何信息**：`useCheckUpdatesMutation.onSuccess`
   * 已经把整份响应 `setQueryData` 写进了 `[...qk.components.all, false]` 与 `[..., true]`
   * 两把键（见 `api.ts`）——也就是说检查结果本来就已经在 `q.data` 里了，
   * `check.data` 从头到尾只是同一份数据的第二个、而且不会更新的副本。
   */
  const data = q.data;
  const components = useMemo(() => data?.components ?? [], [data]);
  /*
   * ★ #66：这两行原来是**在 UI 层把服务端已经算过的结论重新推导一遍** ——
   *   `c.updateAvailable` 与 `!c.updateAvailable && !c.latestVersion`。
   *   后者尤其危险：它把「没查过」「查失败了」「没有上游可问」**外加**
   *   「查到了但比不出新旧」全都算成"没问到"，然后底部那句话对它们统一说
   *   "再点一次「检查更新」通常就好"。
   *   现在读 `upstreamCheck.kind`，一件事一格。
   */
  const updatable = components.filter((c) => upstreamHasNewer(c.upstreamCheck));
  /** 真的问了、真的没问到 —— **只有这一档重试才有意义**。 */
  const failed = components.filter((c) => c.upstreamCheck.kind === 'failed');
  /** 问到了版本号但排不出先后。重试**不会**变好，所以不能和上面那档说同一句话。 */
  const indeterminate = components.filter((c) => c.upstreamCheck.kind === 'indeterminate');
  const sweep = data?.sweep;

  async function handleUpdate(c: ComponentStatus) {
    /*
     * 同一个端点，两种语境：**没装过 = 安装，装过 = 更新**。
     * 文案必须分开 —— 对一个从没装过的组件说"从 X 更新到 null"是句假话，
     * 而 `latestVersion` 在没点过「检查更新」时本来就是 null。
     */
    const installing = c.installedVersion.kind === 'not-installed';
    /*
     * 「从**哪一版**换成钉定的那一版」—— 只有 `known` 那一格答得出来。
     *
     * 这一句原来直接插值 `c.installedVersion`，而那一栏可能是哨兵 `'installed'`，
     * 于是确认框上会出现「将「ffmpeg」从 installed 换成目录钉定的 …」。
     * 走到这个分支时判据（`pinRelation()`）已经保证是 `differs-from-pinned` ⇒ `known`；
     * 兜底那句只是为了让这个函数是全的，不是给哨兵留的后门。
     */
    const from = c.installedVersion.kind === 'known' ? c.installedVersion.version : '当前这一份';
    const ok = window.confirm(
      installing
        ? `安装「${c.displayNameZh}」${c.pinnedVersion}？\n\n` +
            `· 从 ${c.provenance.repoUrl} 的官方发布页下载\n` +
            `· 会校验 sha256，校验不通过不会安装\n` +
            `· 许可证：${c.provenance.license}\n\n` +
            `确定现在安装吗？`
        : /*
           * ⚠️ **最后一行原本写着「旧版本会保留，出问题可以一键回滚」。那是假的**（T-157 ②）。
           *
           * 那套回滚管道从来没运行过一次，现在已整体删除（决定与理由：
           * `docs/adr/ADR-017-component-rollback-removed.md`）。这句承诺却**每次点更新
           * 都会说出来** —— 所以先把话说对。
           *
           * 换成两句真的：
           *   · 失败**确实**不会破坏当前版本 —— `installer.ts` 先解压到 temp、
           *     校验并解包成功后才 rm+rename 换上去；下载/校验/解包任一步失败，
           *     旧目录原地未动（`install()` 的 catch 只清 temp 与刚建的链接）。
           *   · 但更新**成功之后**没有退路：清单里只钉一个版本，没有第二个 sha256 可回。
           *     说清楚，让用户在点之前就知道。
           */
          /*
           * ★★ 这一行原本写着「从 {pinnedVersion} 更新到 {latestVersion}」——**是假的**。
           *
           * 服务端那条路由**不读请求体**，装的永远是**目录钉死的 `pinnedVersion`**
           * （`rest/components.ts`，它自己的注释就写着「更新 = 安装清单里钉死的那个版本」，
           * 那段注释里"我们手上没有上游那一版的 sha256"这句**今天已经不成立** ——
           * `[实测 2026-08-11]` GitHub releases API 直接给出每个资产的 sha256 digest
           * （whisper.cpp v1.9.2 9/9、yt-dlp 24/24、我们的镜像仓 3/3），`upstream.ts` 也已经在解析它。
           * 真正的理由是**那个摘要与"有新版本"来自同一个来源**：它证明字节没在路上被改，
           * 不证明来源本身没问题。目录钉的那一版，其 sha256 是我们本机独立复算过的。）
           * 于是用户点「更新到 v1.9.2」→ 装了一遍 v1.9.1 → 卡片仍写着 v1.9.2 →
           * **他会再点一次**。这句话每点一次就被服务端证伪一次。
           *
           * 现在说的是真的：**你手上那份和目录钉的不是同一版，这一次把钉的那一版装上。**
           * 「上游更新了」那件事已经挪到卡片上单独说（`component-upstream-newer-*`），
           * 不再冒充成一个可点的动作。
           */
          `将「${c.displayNameZh}」从 ${from} 换成目录钉定的 ${c.pinnedVersion}？\n\n` +
            `· 装的是**目录钉死的那一版**，不是上游最新版 —— 目录这一版的 sha256 是我们本机独立复算过的\n` +
            `· 会重新下载并校验 sha256，校验不通过不会安装\n` +
            `· 上游换版本可能改变行为（例如文件格式变化），不一定完全兼容\n` +
            `· 下载或校验失败时，当前版本原地不动（新版本校验通过后才替换）\n` +
            `· ⚠️ 但更新成功后**无法回退到旧版本** —— 清单里只钉了一个版本\n\n` +
            `确定现在更新吗？`,
    );
    if (!ok) return;
    setBusyId(c.id);
    try {
      // ★ 不再发 `toVersion`：服务端从不读它，而它正是上面那句假话的载体（契约里已拿掉）。
      await update.mutateAsync({ id: c.id });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4" data-testid="components-page">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">组件与来源</h1>
          <p className="mt-0.5 text-xs text-ink-secondary">
            每个组件从哪里下载、钉在哪个版本、上游有没有新版本 —— 全部可查。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {sweep?.kind === 'attempted' ? (
            <span className="text-[11px] text-ink-muted" data-testid="components-sweep-at">
              {new Date(sweep.at).toLocaleString(locale)} 检查（问到 {sweep.reached}/{sweep.total}）
            </span>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            disabled={check.isPending}
            onClick={() => void check.mutateAsync({})}
            data-testid="components-check-updates"
          >
            <RefreshCw
              className={check.isPending ? 'size-3.5 animate-spin' : 'size-3.5'}
              aria-hidden
            />
            {check.isPending ? '检查中…' : '检查更新'}
          </Button>
        </div>
      </header>

      {/* 默认不自动更新 —— 说明白，让用户知道这是有意为之 */}
      <Banner
        tone="info"
        icon={<ShieldCheck className="size-4" aria-hidden />}
        title="不会自动更新"
        detail="检测到新版本只会在这里提示。是否更新、什么时候更新，由你决定 —— 上游换版本可能改变行为。"
      />

      {updatable.length > 0 ? (
        <Banner
          tone="warning"
          title={`${updatable.length} 个组件有新版本`}
          detail={updatable
            .map((c) => `${c.displayNameZh} → ${upstreamKnownVersion(c.upstreamCheck)}`)
            .join(' · ')}
        />
      ) : null}

      {/*
        检查过但一个都没问到 → 明确说这是"不知道"，不是"都最新"。

        ★ 判据从 `data?.checkedAt && !data.online` 换成 `sweep` 这一个字段：
          原来那两个字段拼出的第三态（"查过了" ∧ "没人答"）现在是
          `kind === 'attempted' && reached === 0`，一处读完，没有第二处要保持一致。
        ★ `[实测 2026-08-11]` 这条横幅**今天在真 daemon 上就该亮**：
          `GET :10000/api/components?check=1` → 27 条**全部** `timed out after 8000ms`，
          问到 0 个。成因是并发数 —— 27 个查询同时打 GitHub，而单次往返本机实测 1.3–2.6s，
          daemon 的超时是 8s。查询去重（27 → 9）之后实测 9/9 全答上、总耗时 2.6s。
      */}
      {sweep?.kind === 'attempted' && sweep.reached === 0 ? (
        <Banner
          tone="warning"
          icon={<CircleHelp className="size-4" aria-hidden />}
          title={`没能问到任何上游（0/${sweep.total}）`}
          detail="下面这些组件的上游状态是「不知道」，不代表已是最新。已安装的组件不受影响，照常可用。"
        />
      ) : null}

      {q.isError ? <ErrorBlock error={q.error} onRetry={() => void q.refetch()} /> : null}
      {/* 「检查」失败以前完全静默；本页的查询错误一直是渲染的，这里只是漏了 */}
      {check.isError ? <ErrorBlock error={check.error} /> : null}
      {/*
        ★ 「安装 / 更新」失败此前**一个字都不显示**。
        `handleUpdate` 是 `await update.mutateAsync(...)` 包在 `try { } finally { }` 里
        —— **没有 catch**，调用点又是 `void handleUpdate(x)`，rejection 直接漏成
        unhandled rejection；而 `update.isError` 全仓零渲染点（`ComponentCard` 里
        连 `error` 这个词都没出现过，它只收 `busy`）。
        用户点「更新到 X」，sha256 对不上 / 上游 404 / 磁盘满 —— 界面什么都没有，
        按钮只是从「更新中…」变回「更新到 X」，与"按钮是死的"完全一样。
        ⚠️ 上一轮「7 处 void mutateAsync 全部补上」在本文件里**只加了 `check` 那一行**，
        `update` 从头到尾不在那份名单上 —— 这是**当时漏的**，不是刻意留的。
      */}
      {update.isError ? <ErrorBlock error={update.error} /> : null}
      {q.isLoading ? <p className="text-xs text-ink-muted">正在读取组件清单…</p> : null}

      {!q.isLoading && components.length === 0 ? (
        <EmptyState
          title="还没有登记任何组件"
          hint="组件清单来自 vendor/manifests/components.json。"
        />
      ) : null}

      <section className="space-y-3">
        {components.map((c) => (
          <ComponentCard
            key={c.id}
            component={c}
            locale={locale}
            busy={busyId === c.id}
            onUpdate={(x) => void handleUpdate(x)}
          />
        ))}
      </section>

      {/*
        ★ 底部这一段原来只有一句话，覆盖的却是四种情形；其中两种听了它的建议会白费力气：
          · `no-upstream` —— 再点一百次也没有上游可问；
          · `indeterminate` —— 问到了，只是比不出先后，重试不会变好。
        所以现在只有**重试真的有意义**的那一档才说"再点一次"。
      */}
      {sweep?.kind === 'attempted' && failed.length > 0 ? (
        <p className="text-[11px] text-ink-muted" data-testid="components-failed-note">
          {failed.length} 个组件这次没问到上游（可能是限流、超时或网络问题）。
          再点一次「检查更新」通常就好；查不到不影响安装和使用。
        </p>
      ) : null}
      {sweep?.kind === 'attempted' && indeterminate.length > 0 ? (
        <p className="text-[11px] text-ink-muted" data-testid="components-indeterminate-note">
          {indeterminate.length} 个组件问到了上游版本号，但它和目录钉的
          <strong className="text-ink-secondary">不是同一套编号，排不出先后</strong>
          —— 这是「不知道」，不是「已是最新」，而且
          <strong className="text-ink-secondary">重试也不会变好</strong>
          。多半是那个仓同时在发好几族 tag，而我们没写明要哪一族。
        </p>
      ) : null}
    </div>
  );
}
