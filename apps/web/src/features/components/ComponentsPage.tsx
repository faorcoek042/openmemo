import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleHelp, RefreshCw, ShieldCheck } from 'lucide-react';
import type { ComponentStatus } from '@openmemo/shared';
import { upstreamHasNewer, upstreamKnownVersion } from '@openmemo/shared';

import { Banner } from '../../components/common/Banner';
import { Button } from '../../components/common/Button';
import { Emphasis } from '../../components/common/Emphasis';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { localizedName } from '../../lib/format/localized';
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
  /*
   * ★★ #105 ①：**这一页此前一个 `t(` 都没有。**
   *
   * `[闸门实测 2026-08-12，真浏览器]` 同一个上下文里 `documentElement.lang === 'en'`、
   * 侧栏英文、`/runtime` 英文，而这一页的 `h1` 是「组件与来源」、芯片是
   * 「未检测 / 已安装 / 目录钉定 / 本机已装 / 上游最新」、正文整片中文。
   *
   * 代价不是"不好看"：这一轮在**这一页上**做的三件事 ——
   * `a2c2e28`（说不出已装版本时不许号召重下 145 MB）、`af25cf3`（止血两句假话）、
   * `23a8471`（删掉那颗承诺了服务端装不到的版本号的按钮）——
   * **在英文界面上等于不存在**。修的是同一批话能不能被读到。
   *
   * ⚠️ 英文那份是**真英文**，不是把中文搬进 `en.json`（`79cc117` 立的规矩）。
   */
  const { t, i18n } = useTranslation();
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
    const from =
      c.installedVersion.kind === 'known'
        ? c.installedVersion.version
        : t('components.currentCopy');
    /*
     * ⚠️ 这两句话此前**连名字都取错了语言**：插的是 `c.displayNameZh`，
     * 于是英文界面上的确认框里会冒出组件的中文名。`localizedName()` 是仓里
     * 早就有的那一个（T-135 给卡片接上过），这里跟着用同一份。
     * ⚠️ 词条里**不带 `**` 标记**：`window.confirm` 渲染不了 `<strong>`，
     * 带了就是把裸星号送到用户眼前（`Emphasis` 文件头记的正是这条）。
     */
    const name = localizedName(locale, c);
    const ok = window.confirm(
      installing
        ? t('components.confirmInstall', {
            name,
            version: c.pinnedVersion,
            repo: c.provenance.repoUrl,
            license: c.provenance.license,
          })
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
          t('components.confirmUpdate', { name, from, version: c.pinnedVersion }),
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
          <h1 className="text-lg font-semibold text-ink">{t('components.title')}</h1>
          <p className="mt-0.5 text-xs text-ink-secondary">{t('components.intro')}</p>
        </div>
        <div className="flex items-center gap-2">
          {sweep?.kind === 'attempted' ? (
            <span className="text-[11px] text-ink-muted" data-testid="components-sweep-at">
              {t('components.sweepAt', {
                at: new Date(sweep.at).toLocaleString(locale),
                reached: sweep.reached,
                total: sweep.total,
              })}
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
            {check.isPending ? t('components.checking') : t('components.checkUpdates')}
          </Button>
        </div>
      </header>

      {/* 默认不自动更新 —— 说明白，让用户知道这是有意为之 */}
      <Banner
        tone="info"
        icon={<ShieldCheck className="size-4" aria-hidden />}
        title={t('components.noAutoUpdateTitle')}
        detail={t('components.noAutoUpdateDetail')}
      />

      {updatable.length > 0 ? (
        <Banner
          tone="warning"
          title={t('components.updatableTitle', { n: updatable.length })}
          /* 名字也走 `localizedName()` —— 这条横幅原来固定念 `displayNameZh` */
          detail={updatable
            .map((c) => `${localizedName(locale, c)} → ${upstreamKnownVersion(c.upstreamCheck)}`)
            .join(' · ')}
        />
      ) : null}

      {/*
        检查过但一个都没问到 → 明确说这是"不知道"，不是"都最新"。

        ★ 判据从 `data?.checkedAt && !data.online` 换成 `sweep` 这一个字段：
          原来那两个字段拼出的第三态（"查过了" ∧ "没人答"）现在是
          `kind === 'attempted' && reached === 0`，一处读完，没有第二处要保持一致。
        ★ `[实测 2026-08-11]` 这条横幅**真的会亮**：那天 `GET :10000/api/components?check=1`
          → 27 条**全部** `timed out after 8000ms`，问到 0 个。
          ⚠️ 但**成因不是并发数**（我一开始是这么写的，后来被自己的复测证伪）：
          同样 27 并发、同样 8s 超时复现一次，是 26/27 拿到 200、0 超时、总耗时 2.4s。
          那次是**网络瞬态**（同一刻单发一个请求就要 7.35s）。
          这条横幅要处理的正是这种情形 —— 它不需要知道为什么问不到，只需要说清
          「问到 0 个」**不等于**「都最新」。
      */}
      {sweep?.kind === 'attempted' && sweep.reached === 0 ? (
        <Banner
          tone="warning"
          icon={<CircleHelp className="size-4" aria-hidden />}
          title={t('components.sweepNoneTitle', { total: sweep.total })}
          detail={t('components.sweepNoneDetail')}
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
      {q.isLoading ? <p className="text-xs text-ink-muted">{t('components.loading')}</p> : null}

      {!q.isLoading && components.length === 0 ? (
        <EmptyState title={t('components.emptyTitle')} hint={t('components.emptyHint')} />
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
        ★ #100 又收窄一次：`failed` 里还分**立刻重试有用**（超时／网络瞬态）和
          **必须等**（配额用尽，`reason` 里带着"约 X 分钟后恢复"）两种。
          这里不再替它们统一说"再点一次通常就好" —— 那对后者是句白话，
          而"等 3 分钟"才是可执行的。措辞的唯一来源是
          `packages/downloader/src/upstream.ts` 的 `httpFailureReason()`。
      */}
      {/*
        ⚠️ 强调段从写死的 `<strong>` 换成词条里的 `**…**` + `<Emphasis>`（T-129b 那条路）：
        JSX 里穿插 `<strong>` 的句子**没法整句翻译** —— 断句、语序、哪一段该重读，
        每种语言都不一样，拆成三段各自翻译只会拼出一句谁都不会说的话。
      */}
      {sweep?.kind === 'attempted' && failed.length > 0 ? (
        <p className="text-[11px] text-ink-muted" data-testid="components-failed-note">
          <Emphasis text={t('components.failedNote', { n: failed.length })} />
        </p>
      ) : null}
      {sweep?.kind === 'attempted' && indeterminate.length > 0 ? (
        <p className="text-[11px] text-ink-muted" data-testid="components-indeterminate-note">
          <Emphasis text={t('components.indeterminateNote', { n: indeterminate.length })} />
        </p>
      ) : null}
    </div>
  );
}
