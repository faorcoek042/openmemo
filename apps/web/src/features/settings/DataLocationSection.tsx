import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Copy, FolderOpen, HardDrive, Loader2 } from 'lucide-react';

import { api, ApiError } from '../../lib/api/client';
import { useModelsStorageQuery } from '../../lib/api/models';
import { Button } from '../../components/common/Button';
import { Emphasis } from '../../components/common/Emphasis';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { formatBytes } from '../../lib/format/bytes';
import { pickLocalized } from '../../lib/format/localized';
import { copyText } from '../../lib/secure-context';

interface HealthResponse {
  dataDir?: string;
  version?: string;
}

/**
 * `GET /api/settings/data-dir` —— daemon 侧的目录清单。
 *
 * `usage` 是**整个数据目录**的总量，这正是 `/models/storage` 给不了的那个数：
 * 后者只统计模型目录，所以此前这一节只能一边显示"模型占用"一边写小字提醒
 * "这不是总量"。现在总量有了权威来源，就该显示它。
 *
 * ⚠️ **这里原来写着「`entries` 没有各自的字节数，所以只列用途不列大小」——
 * 那句话是错的，而且它压着一个早就存在的能力。** 实测 daemon 的真实响应：
 * 七条 entry **每条都带 `bytes` 与 `files`**（`rest/storage.ts` 里对每个子目录
 * 各跑一次 `measureTree`，源码注释还专门写了为什么必须逐目录 ——
 * 「只给总数，用户知道占了 3GB 却不知道该删哪个」）。
 * 前端的类型里没有这两个字段，于是它们被 TS 结构化子类型静静丢掉，
 * 界面上"没有大小"这件事看起来就成了 daemon 的限制。
 * 用户点名要过"可统计大小"，这一格其实一直是通的。
 *
 * 同理 `externalFiles`：daemon 一直在返回**数据目录外面**那个指针文件的说明与风险，
 * 而这个类型里没有它 —— 那条警告写出来之后从没到达过任何用户。
 * 它讲的正是 PROTOCOL §9 那场事故的用户侧形态（删了数据目录、留下指针 →
 * 下次启动按指针去建空目录 → "笔记全没了"）。
 *
 * T-135：`purpose` 是新补的英文对应（`rest/storage.ts` 的 `layout()`）。
 * 在它存在之前，这一节是 `/settings` 英文界面上**全部 81 个汉字**的来源 ——
 * 而且前端修不了：没有可回落的英文，删掉又等于不告诉用户哪个目录能删。
 * 现在走 `pickLocalized()`，与 `displayName/displayNameZh` 同一套。
 * 类型上仍是可选，因为**老版本 daemon 不会给这些字段**（前端可以比 daemon 新）。
 */
interface DataDirResponse {
  dataDir?: string;
  usage: { bytes: number; files: number } | null;
  entries: {
    path: string;
    name: string;
    purposeZh: string;
    purpose?: string;
    /** 逐目录占用。老 daemon 没有 → 那一行不显示大小，而不是显示 0。 */
    bytes?: number;
    files?: number;
  }[];
  externalFiles?: {
    path: string;
    purposeZh: string;
    purpose?: string;
    /**
     * 「它为什么必须待在数据目录**外面**」。
     * 少了这半句，用户知道有个外部文件要一起删，却不知道原因 ——
     * 而最自然的反应是把它挪进数据目录里，那正是这句话要拦的事
     * （挪进去 → 跟着数据一起搬走 → 搬完再也找不到新位置）。
     */
    whyOutsideZh: string;
    whyOutside?: string;
    riskZh: string;
    risk?: string;
  }[];
}

/**
 * `POST /api/settings/data-dir` 的返回。
 *
 * ★ `warningZh` / `staleLinks` 是 T-128 的产物，**必须渲染**。
 *
 * 背景：移动数据目录曾经会静默弄坏 whisper 后端的 `.so` 符号链接 —— 用户那次
 * 8 条链接全断、转写完全不可用，而自检报告"一切正常"。daemon 现在会检测出
 * "搬完之后还指着旧位置"的链接并回一条 `warningZh`。
 *
 * 检测到了却不显示，就只是把**假绿灯**换成一盏**没接线的红灯**，用户看到的
 * 依然是"移动成功"。所以这个字段在这里不是可选的装饰，它就是修复本身的出口。
 */
interface MoveDataDirResponse {
  restartRequired?: boolean;
  moved?: boolean;
  files?: number;
  links?: number;
  messageZh?: string;
  /** 非致命警告：数据搬到位了，但有链接失效了 / 有一部分根本没检查到。 */
  warningZh?: string;
  staleLinks?: { rel: string; target: string; resolved: string }[];
  /**
   * ⚠️ T-166：**没能检查到**的位置。
   *
   * 它和 `staleLinks` 必须一起读：两者都为空才等于"检查过了、没问题"。
   * 只看 `staleLinks` 的话，"扫完了没发现问题"和"扫到一半炸了什么也没看到"
   * 会被读成同一件事 —— 一次"看起来干净"的搬迁就此留下没人知道的坏软链。
   */
  unscannedLinkPaths?: { rel: string; code: string }[];
}

/**
 * ★ T-128：搬完之后失效的符号链接，必须显示出来。
 *
 * **单独抽成组件是为了它能被真的渲染一次做断言。** 内联在 `DataLocationSection`
 * 里时，要触发它就得先在受控输入框里打字 —— 而组件测试宿主驱动不了受控文本框
 * （`fireEvent.change`/`input` 都进不到 React 的 onChange，状态始终为空，
 * 见 `coordination/inbox/storage-fix.md`）。于是这段"修复的唯一出口"就会变成
 * **没有任何测试覆盖**的一块 JSX —— 而它防的恰恰就是"没人看的东西会悄悄失效"。
 */
export function StaleLinksWarning({
  warningZh,
  staleLinks,
  unscanned,
}: {
  warningZh: string;
  staleLinks?: { rel: string; target: string }[];
  /** 没能检查到的位置（T-166）。**这一段不能省** —— 省了就等于替用户断言"那边没事"。 */
  unscanned?: { rel: string; code: string }[];
}) {
  return (
    <div
      role="status"
      data-testid="data-dir-stale-links"
      className="rounded-md border border-warning/40 bg-warning/10 p-2"
    >
      <p className="flex items-start gap-1.5 text-xs text-warning">
        <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>{warningZh}</span>
      </p>
      {/*
        只给一句概括不够：用户得知道**是哪几条**链接断了，
        否则他既不知道该重装哪个后端，也无法自己核对。
        超过 5 条折叠成计数，避免把整页刷满。
      */}
      {staleLinks?.length ? (
        <ul className="mt-1.5 space-y-0.5 pl-5">
          {staleLinks.slice(0, 5).map((l) => (
            <li key={l.rel} className="truncate font-mono text-[11px] text-ink-secondary">
              {l.rel} → {l.target}
            </li>
          ))}
          {staleLinks.length > 5 ? (
            <li className="text-[11px] text-ink-muted">…… 共 {staleLinks.length} 条</li>
          ) : null}
        </ul>
      ) : null}
      {/*
        ⚠️ 没检查到的位置要**单独列**，不能和上面失效的链接混在一起 ——
        「查出来是坏的」和「根本没查」是两件事，混在一起用户会以为都查过了。
      */}
      {unscanned?.length ? (
        <ul className="mt-1.5 space-y-0.5 pl-5" data-testid="data-dir-unscanned">
          {unscanned.slice(0, 5).map((u) => (
            <li key={u.rel} className="truncate font-mono text-[11px] text-ink-secondary">
              未检查：{u.rel}（{u.code}）
            </li>
          ))}
          {unscanned.length > 5 ? (
            <li className="text-[11px] text-ink-muted">…… 共 {unscanned.length} 个位置未检查</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * 成功之后该说哪一句 —— **搬了**，还是**只改了指向**。
 *
 * ## 为什么单独抽成函数
 *
 * 与 `StaleLinksWarning` 同一个理由：宿主驱动不了受控文本输入框
 * （`fireEvent.change` / `input` 都进不到 React 的 onChange，state 恒为空），
 * 所以"打开表单 → 输路径 → 点应用 → 看结果文案"这条链在组件测试里跑不起来。
 * 内联成三元表达式的话，这段判断就**一条测试都没有**。
 *
 * ## 判据取 daemon 回的 `moved`，不取前端自己发了什么
 *
 * 本轮修的 bug 恰恰是"前端以为自己发了 A、服务端做了 B"。
 * 如果这里改成"按我发的 moveExisting 显示"，那么下一次两端再对不上时，
 * 界面会**继续自信地报告一件没发生的事** —— 那就等于把同一个 bug 又埋回来一次。
 * 所以只信执行方的回执。老 daemon 不给 `moved` → 回落到中性文案，不猜。
 */
export function resultTextKey(moved: boolean | undefined): string {
  if (moved === true) return 'settings.dataDir.resultMoved';
  if (moved === false) return 'settings.dataDir.resultPointed';
  return 'settings.dataDir.needRestart';
}

/**
 * 数据位置 —— 定义 / 修改 / 移动 / 统计大小。
 *
 * ## 路径的权威来源只能是 daemon
 *
 * 我在密钥那件事上踩过一次：前端按"约定俗成"硬编码了一个路径告诉用户密钥存在哪，
 * 真实位置其实是 `<dataDir>/secrets.json`，而 dataDir 本身可以被
 * `OPENMEMO_DATA_DIR` / `--data-dir` 改掉。前端**没有任何办法**知道用户是怎么启动的。
 * 结论写在那次的复盘里：**凡是要明文告知用户的路径，一律问 daemon**。
 * 这里同理 —— `GET /api/health` 返回 `dataDir`，那是唯一说得准的地方。
 *
 * ## 关于"统计大小"的诚实边界
 *
 * daemon 目前只有 `GET /api/models/storage`，它统计的是**模型目录**
 * （`modelsRoot`）与所在卷的剩余空间，**不是整个 dataDir 的总大小**。
 * 所以下面的文案逐项标明各是什么，绝不把"模型占用"写成"数据占用" ——
 * 模型通常占九成以上，但笔记、音频原件、数据库都不在这个数里，
 * 写成总量会让用户按错误的数字去清理磁盘。
 */
export function DataLocationSection() {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const [newPath, setNewPath] = useState('');
  const [moveExisting, setMoveExisting] = useState(true);
  const [showChange, setShowChange] = useState(false);

  const health = useQuery({
    queryKey: ['health', 'dataDir'] as const,
    queryFn: () => api<HealthResponse>('health', '/health'),
    staleTime: 60_000,
  });

  /*
   * ★ 收敛：这里原来自己写了一条 `useQuery` —— 与 `features/models/api.ts` 那条
   *   共用 `qk.models.storage`，但一个带 `'models'` surface、一个是裸的（⇒ `'generic'`），
   *   `staleTime` 也一个 30s 一个 0。react-query 只跑先挂载的那份，
   *   于是"哪个 API 面被标成已接通"取决于用户先开设置页还是先开模型页。
   *   实现现在唯一地住在 `lib/api/models.ts`（`features/` 之间不许互相 import，
   *   所以共享的那份必须在 `lib/`）。
   */
  const storage = useModelsStorageQuery();

  const layout = useQuery({
    queryKey: ['settings', 'data-dir'] as const,
    queryFn: () => api<DataDirResponse>('settings', '/settings/data-dir'),
    staleTime: 30_000,
  });

  /**
   * 修改数据目录。
   *
   * `GET|POST /api/settings/data-dir` **已经落地**（`rest/storage.ts`），
   * 这段注释此前还写着"端点目前不存在" —— 已订正。
   *
   * 保留的设计：写操作**绝不静默回落 mock**，失败会如实抛出并渲染成 `ErrorBlock`；
   * 按钮不灰掉，因为灰掉的控件不解释原因，用户只会以为坏了。
   * 端点若因版本差异缺席，`notImplemented` 分支仍会给出环境变量这条真能用的替代路径。
   */
  const changeDir = useMutation({
    mutationFn: (p: { path: string; moveExisting: boolean }) =>
      api<MoveDataDirResponse>('settings', '/settings/data-dir', {
        method: 'POST',
        body: p,
      }),
  });

  const dataDir = health.data?.dataDir ?? null;
  const notImplemented = changeDir.error instanceof ApiError && changeDir.error.status === 404;

  return (
    <section className="rounded-lg border border-line bg-surface-1 p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-ink">
        <HardDrive className="size-4" aria-hidden />
        {t('settings.dataDir.title')}
      </h2>

      {/* ── 定义：当前在哪 ── */}
      <div className="mb-4">
        <p className="mb-1 text-xs text-ink-secondary">{t('settings.dataDir.current')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <code
            className="min-w-0 flex-1 truncate rounded-md border border-line bg-surface-0 px-2 py-1.5 font-mono text-xs text-ink"
            data-testid="data-dir-path"
            title={dataDir ?? ''}
          >
            {/* 拿不到就说拿不到，绝不填一个"看起来对"的默认路径 */}
            {dataDir ?? t('common.loading')}
          </code>
          <Button
            size="sm"
            variant="secondary"
            disabled={!dataDir}
            onClick={() => {
              if (!dataDir) return;
              /*
               * 用 `copyText()` 而不是 `navigator.clipboard?.writeText()`：
               * 后者在非安全上下文（http://<IP>）下会被可选链整条短路 ——
               * 不复制、也不报错，按钮静默失效。
               */
              void copyText(dataDir).then((ok) => {
                setCopied(ok ? 'ok' : 'fail');
                setTimeout(() => setCopied(null), 2000);
              });
            }}
          >
            <Copy className="size-3.5" />
            {copied === 'ok'
              ? t('settings.dataDir.copied')
              : copied === 'fail'
                ? t('settings.dataDir.copyFailed')
                : t('settings.dataDir.copy')}
          </Button>
        </div>
      </div>

      {/* ── 统计大小：逐项标明各是什么，不合并成一个含糊的"总计" ── */}
      {storage.data || layout.data?.usage ? (
        <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          {layout.data?.usage ? (
            <div>
              <dt className="text-ink-muted">{t('settings.dataDir.totalUsed')}</dt>
              <dd className="text-ink" data-testid="data-dir-total-used">
                {formatBytes(layout.data.usage.bytes, i18n.language)}
                <span className="ml-1 text-ink-muted">
                  {t('settings.dataDir.fileCount', { n: layout.data.usage.files })}
                </span>
              </dd>
            </div>
          ) : null}
          {storage.data ? (
            <div>
              <dt className="text-ink-muted">{t('settings.dataDir.modelsUsed')}</dt>
              <dd className="text-ink" data-testid="data-dir-models-used">
                {formatBytes(storage.data.usedBytes, i18n.language)}
              </dd>
            </div>
          ) : null}
          {storage.data ? (
            <>
              <div>
                <dt className="text-ink-muted">{t('settings.dataDir.volumeFree')}</dt>
                <dd className="text-ink">
                  {formatBytes(storage.data.volume.freeBytes, i18n.language)}
                </dd>
              </div>
              <div>
                <dt className="text-ink-muted">{t('settings.dataDir.volumeTotal')}</dt>
                <dd className="text-ink">
                  {formatBytes(storage.data.volume.totalBytes, i18n.language)}
                </dd>
              </div>
            </>
          ) : null}
        </dl>
      ) : null}
      {/* 带 `**模型目录**` —— 划定统计范围的那个词，必须看得出来（T-129b） */}
      <Emphasis
        className="mb-4 block text-xs text-ink-muted"
        text={t('settings.dataDir.sizeScopeNote')}
      />

      {/*
        ── 目录清单：日志 / 临时文件 / 数据库 这三类此前完全没露过面 ──
        用户问"这个目录能不能删、删了丢什么"，答案取决于里面是什么；
        只报一个总字节数回答不了这个问题。用途文案来自 daemon，
        与"凡是要明文告知用户的路径一律问 daemon"同一条理由。
      */}
      {layout.data?.entries?.length ? (
        <div className="mb-4" data-testid="data-dir-layout">
          <p className="mb-1.5 text-xs text-ink-secondary">{t('settings.dataDir.layoutTitle')}</p>
          <ul className="divide-y divide-line rounded-md border border-line bg-surface-0">
            {layout.data.entries.map((e) => (
              <li
                key={e.path}
                className="flex flex-wrap items-baseline gap-x-2 px-2 py-1.5 text-xs"
              >
                <code className="font-mono text-ink">{e.name}</code>
                <span className="min-w-0 flex-1 text-ink-secondary">
                  {pickLocalized(i18n.language, e.purposeZh, e.purpose)}
                </span>
                {/*
                  逐目录大小 —— daemon 一直在给，只是前端此前把它丢了。
                  `undefined` 与 `0` 必须分开：老 daemon 不给这个字段时**不显示**，
                  而不是显示 "0 B"（那是在替一个我们没测过的数字背书）。
                */}
                {typeof e.bytes === 'number' ? (
                  <span
                    className="shrink-0 font-mono text-ink-muted"
                    data-testid={`data-dir-entry-size-${e.name}`}
                  >
                    {formatBytes(e.bytes, i18n.language)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-ink-muted">{t('settings.dataDir.perDirNote')}</p>
        </div>
      ) : null}

      {/*
        ── 数据目录**外面**的那个文件 ──

        daemon 从一开始就在 `externalFiles` 里返回它，但前端的响应类型里没有这个字段，
        所以这段警告**一次都没有到达过用户**。它说的是：删掉数据目录却留下指针，
        daemon 下次启动会按指针去那个已不存在的位置建一套空的，界面上表现为"笔记全没了"。
        这正是本仓 PROTOCOL §9 记录的那场事故在用户侧的样子。
      */}
      {layout.data?.externalFiles?.length ? (
        <div
          className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-2"
          data-testid="data-dir-external-files"
        >
          <p className="mb-1 flex items-start gap-1.5 text-xs font-medium text-warning">
            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>{t('settings.dataDir.externalTitle')}</span>
          </p>
          <ul className="space-y-1 pl-5">
            {layout.data.externalFiles.map((f) => (
              <li key={f.path} className="text-[11px] text-ink-secondary">
                <code className="break-all font-mono text-ink">{f.path}</code>
                <span className="ml-1">{pickLocalized(i18n.language, f.purposeZh, f.purpose)}</span>
                <Emphasis
                  className="mt-0.5 block"
                  text={pickLocalized(i18n.language, f.whyOutsideZh, f.whyOutside)}
                />
                <Emphasis
                  className="mt-0.5 block"
                  text={pickLocalized(i18n.language, f.riskZh, f.risk)}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── 修改 / 移动 ── */}
      {!showChange ? (
        <Button size="sm" variant="secondary" onClick={() => setShowChange(true)}>
          <FolderOpen className="size-3.5" />
          {t('settings.dataDir.change')}
        </Button>
      ) : (
        <div className="space-y-2 rounded-md border border-line bg-surface-0 p-3">
          <label className="block text-xs text-ink-secondary" htmlFor="data-dir-new">
            {t('settings.dataDir.newPath')}
          </label>
          <input
            id="data-dir-new"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder={dataDir ?? '/path/to/openmemo-data'}
            spellCheck={false}
            autoComplete="off"
            data-testid="data-dir-new-input"
            className="h-8 w-full rounded-md border border-line bg-surface-1 px-2 font-mono text-xs text-ink"
          />
          <label className="flex items-center gap-2 text-xs text-ink-secondary">
            <input
              type="checkbox"
              checked={moveExisting}
              onChange={(e) => setMoveExisting(e.target.checked)}
              className="size-3.5 accent-[var(--accent)]"
            />
            {t('settings.dataDir.moveExisting')}
          </label>

          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!newPath.trim() || changeDir.isPending}
              onClick={() => changeDir.mutate({ path: newPath.trim(), moveExisting })}
            >
              {changeDir.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {changeDir.isPending ? t('settings.dataDir.moving') : t('settings.dataDir.apply')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowChange(false)}>
              {t('capture.cancel')}
            </Button>
          </div>

          {/*
            ★ 成功之后必须说清**到底做了哪一件事**：搬了，还是只改了指向。

            这两件事的后果天差地别（一个动了几十 GB 且不可逆，一个一个字节没动），
            而此前无论哪一种都只显示同一句「已保存。重启后生效。」——
            于是"我以为我选了 A，系统做了 B"在结果页上也**看不出来**。
            本轮那个 bug 能长期不被发现，这里是第二道失守的关口：
            即使请求被误解了，只要结果页把真相说出来，用户当场就会发现。

            `moved` 由 daemon 回（`{moved:true, files:N}` / `{moved:false}`），
            不由前端按自己发了什么去猜 —— 猜的话就又回到"两边各说各的"。
            老 daemon 不给 `moved` 时回落到原来那句中性文案。
            带 `**…**` 的半句走 <Emphasis>（T-129b）。
          */}
          {changeDir.isSuccess ? (
            <p data-testid="data-dir-result">
              <Emphasis
                className="block text-xs text-good"
                text={t(resultTextKey(changeDir.data?.moved), { n: changeDir.data?.files ?? 0 })}
              />
            </p>
          ) : null}

          {/*
            ★ T-128：搬完之后如果有符号链接失效，**必须让用户看见**。

            刻意放在「需要重启」那句绿色提示的**下面而不是替代它** ——
            数据确实搬成功了（绿的那句是真的），但转写后端可能已经不能用了，
            两件事都是事实，只说其中一件都是误导。

            文案直接用 daemon 给的 `warningZh`，不走 i18n：
            同一个组件里 `entries[].purposeZh` 已经是这么渲染的（"凡是要明文告知
            用户的路径/后果，一律以 daemon 为权威来源"）。这样也不必去动
            `locales/*.json` —— 那两个文件此刻正被别的 agent 改着。
          */}
          {changeDir.data?.warningZh ? (
            <StaleLinksWarning
              warningZh={changeDir.data.warningZh}
              {...(changeDir.data.staleLinks ? { staleLinks: changeDir.data.staleLinks } : {})}
              {...(changeDir.data.unscannedLinkPaths
                ? { unscanned: changeDir.data.unscannedLinkPaths }
                : {})}
            />
          ) : null}

          {/*
            端点还没上线时给**真的能用**的办法，而不是一句"暂不支持"。
            这是本地部署工具 —— 用户本来就是自己起进程的，环境变量对他不是负担。
          */}
          {notImplemented ? (
            <p className="text-xs text-warning" data-testid="data-dir-unsupported">
              {t('settings.dataDir.unsupported')}
              <code className="ml-1 font-mono">OPENMEMO_DATA_DIR=&lt;path&gt;</code>
            </p>
          ) : changeDir.isError ? (
            /*
             * ★ T-140：26 个 `<ErrorBlock>` 里，**这一个**的补救不是"去某一页"，
             * 是**就地重发一次请求**。
             *
             * daemon 对着"目标已经是一个 OpenMemo 数据目录"回 409 + `useExistingDataDir`，
             * 并在源码里写明「UI 点「直接使用此目录」时按这个再发一次即可」，
             * params 特意压平成 `{path, moveExisting:false}` 就是为了让前端原样转发。
             * `lib/remediation/routes.ts` 把它列进 `UNROUTED_ACTIONS`（没有落点），
             * 所以按钮只会因为这里传了 `onRemediate` 才出现 —— 这正是那个 prop
             * 现在的唯一职责：**"我能就地办"**。
             *
             * ⚠️ 这个 key 曾经是 `move`，而请求体发的是 `moveExisting` ——
             * daemon 读不到，缺省成"搬"，于是又撞回同一道 409。
             * **实测：这个按钮从上线起一次都没成功过**（点了只是把同一条错误再显示一遍）。
             * 现在两端统一叫 `moveExisting`。
             *
             * 只认 `moveExisting === false`：将来若 daemon 发了 `true`（真搬运），
             * 也不该被这条无声地当成"直接使用"执行掉。宁可不渲染按钮。
             */
            <ErrorBlock
              error={changeDir.error}
              onRemediate={(action, params) => {
                if (action !== 'useExistingDataDir') return;
                const path = params?.['path'];
                if (typeof path !== 'string' || !path || params?.['moveExisting'] !== false) return;
                changeDir.mutate({ path, moveExisting: false });
              }}
            />
          ) : null}
        </div>
      )}

      {/*
        ★ 说清楚后果。这条是实测过的：运行中 rm -rf 数据目录 → health 仍 200；
        停掉重启 → 自动重建，notes / selfcheck 均 200。
        所以"删了会不会把程序搞坏"可以明确回答"不会"，但**必须同时说清丢什么** ——
        只说前半句会让人以为删了没代价。
      */}
      <p className="mt-4 border-t border-line pt-3 text-xs text-ink-muted">
        {t('settings.dataDir.safeToDelete')}
      </p>
    </section>
  );
}
