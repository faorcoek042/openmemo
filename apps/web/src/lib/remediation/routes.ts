/**
 * `remediation.action` → 应用内目标路由。**全仓唯一一份。**
 *
 * ## 为什么它必须是一份
 *
 * 此前有两张表，各自 switch：`RemediationButton.tsx`（default → `/models`，
 * `configure_api_key` → `/settings`）与 `JobToaster.tsx`（default → `/tasks`，
 * `configure_api_key` → `/settings/llm`）。同一个 action，点错误块和点任务提示
 * 去两个不同的地方 —— 而且两边都**没有一条**认识 daemon 真正发出来的那批 action。
 *
 * ## 比"两份不一致"更贵的那个问题
 *
 * 两张表覆盖的是 `install_model` / `install_backend` / `free_disk` /
 * `switch_source` / `configure_api_key` 五个。`[实测]` 全仓扫 daemon 源码，
 * **daemon 一次都没发过 `switch_source` 与 `configure_api_key`**；
 * 而它真正发的 `installSiteExtractor`（"没有适配器能处理这个链接" = yt-dlp 缺失）
 * 在两张表里都落进 default —— 用户被送去 `/models` 或 `/tasks`，
 * 而能装 yt-dlp 的地方是 `/components` 与 `/runtime`。
 *
 * **按钮点得动、跳得走、就是到不了能修的那一页，全程零报错。**
 *
 * 所以这份表不是"抄一份合并"，它带一条护栏：
 * `routes.test.ts` 直接扫 `apps/daemon/src/**` 把 daemon 会发的 action 全抠出来，
 * 断言每一个要么在 `REMEDIATION_ROUTES` 里、要么在 `UNROUTED_ACTIONS` 里**明写理由**。
 * daemon 以后新加一个 action 而前端没跟上 → 门禁红，而不是静默落进 default。
 */

/**
 * 比 `@openmemo/shared` 的 `Remediation` 宽的结构类型。
 *
 * 两个来源的形状不同，必须都能喂进来：
 * - `JobBlockedEvent.remediation` 是完整的 `Remediation`（labelZh/label/params 必填）；
 * - `ApiError.remediation` 是 HTTP 错误信封里解析出来的，`params` 可缺、值是 `unknown`。
 *
 * 写成宽结构而不是 `as Remediation`：规矩 5「禁止无谓类型断言」。
 * `Remediation` 结构上是它的子类型，现有调用点不用改。
 *
 * ⚠️ 本文件**不许** import `@openmemo/shared`：它进的是 `tsconfig.test.json`
 * 那条 CommonJS + `moduleResolution: Node` 的编译道，解析不了 shared 的 ESM exports map。
 */
export interface RemediationLike {
  action: string;
  params?: Record<string, unknown> | undefined;
  labelZh?: string | undefined;
  label?: string | undefined;
}

function str(params: Record<string, unknown> | undefined, key: string): string | null {
  const v = params?.[key];
  return typeof v === 'string' && v ? v : null;
}

/**
 * 有应用内落点的 action。
 *
 * 每一条都对得上一个 daemon 里真实的发出点（file:line 写在注释里，
 * 由 `routes.test.ts` 的扫描守卫保证不会悄悄失效）。
 */
export const REMEDIATION_ROUTES: Readonly<
  Record<string, (params: Record<string, unknown> | undefined) => string>
> = {
  /** `runtime/setup.ts:574` —— 缺 ASR 模型。带 modelId 就直达详情页。 */
  install_model: (p) => {
    const id = str(p, 'modelId');
    return id ? `/models/${encodeURIComponent(id)}` : '/models';
  },
  /** `jobs/runners/transcribe.ts:158` —— 同一件事的 camelCase 拼写（daemon 两处不同写法，两个都得认）。 */
  installModel: (p) => {
    const id = str(p, 'modelId');
    return id ? `/models/${encodeURIComponent(id)}` : '/models';
  },
  /*
   * ── `packages/llm` 的三条：落点是 `/models?tab=llm`，**不是 `/settings`** ────
   *
   * ⚠️ action 名叫 `openSettings`、params 里写着 `section:'llm'`，读起来像该去设置页。
   *    **实测不是**：`LlmSettingsSection`（apiKey / baseUrl / model 三件套的编辑处）
   *    挂在 `ModelsPage`（`features/models/ModelsPage.tsx:433`），
   *    `LocalLlmSection`（「本地模型」+ `POST /api/llm/detect` 真去敲本机端口）
   *    又嵌在它里面（`LlmSettingsSection.tsx:371`）。**设置页里没有这些控件。**
   *    照名字把它routed 到 `/settings`，就会造出本仓已经栽过三次的那种按钮：
   *    跳过去了、页面也"相关"，但用户在那儿做不成这件事。
   *
   * 判据（用户 2026-08-09 裁决）：**跳过去之后他照着做完，那个报错真的会消失。**
   *   · `LLM_AUTH_FAILED`（Key 无效/过期）→ 在那儿改 apiKey → 错误消失 ✔
   *   · `LLM_NOT_CONFIGURED`（没配 LLM）→ 在那儿加一个 provider → 错误消失 ✔
   *   · `LLM_CONNECTION_FAILED`（连不上本地后端）→ 在那儿点检测/改 baseUrl ✔
   *   · 结构化输出失败建议换个更大的模型 → 在那儿改 model ✔
   * `?tab=llm` 是 `ModelsPage` 真读的 query（`ModelsPage.tsx:87`），不是我编的。
   */
  openSettings: () => '/models?tab=llm',
  checkLocalBackend: () => '/models?tab=llm',
  retryWithLargerModel: () => '/models?tab=llm',

  /** `rest/backends.ts:330` · `runtime/setup.ts:277,574` —— 后端包缺失 / probe 装不上。 */
  install_backend: () => '/runtime',
  /** `runtime/setup.ts:284` —— probe 跑失败（不是没装），重试入口在运行时页。 */
  retry_probe: () => '/runtime',
  /**
   * `rest/notes.ts:144`（工作区在动，以 `action: 'installSiteExtractor'` 为准）—— `NO_MEDIA_SOURCE`：粘了链接但没有适配器能处理。
   *
   * ★ **这是 demo 上 `warn | tool.ytDlp | 未找到` 在界面上唯一会显形的地方。**
   * 落点选 `/components` 而不是 `/runtime`：那一页按"组件"逐个列来源与版本
   * （8 条，yt-dlp 在内），装/更新/回滚都在卡片上；`/runtime` 是 26 个按平台切的
   * 后端包，yt-dlp 只是其中一张卡。用户此刻的问题是"这个站点解析器怎么装"，
   * 不是"这台机器该选哪个加速后端"。
   */
  installSiteExtractor: () => '/components',
  /** `rest/models.ts:369` —— 磁盘预检没过。 */
  free_disk: () => '/settings/storage',
  /** `rest/models.ts:353` —— 受限权重要先去上游接受条款，详情页上有那个许可证链接。 */
  accept_license: (p) => {
    const id = str(p, 'modelId');
    return id ? `/models/${encodeURIComponent(id)}` : '/models';
  },
  /** `rest/models.ts:597` —— 删不掉正在使用的模型，得先换一个。 */
  activate_model: () => '/models',
  /** `jobs/runners/mindmap.ts:104` —— 没配 LLM。 */
  configureLlm: () => '/settings',
  /** `jobs/runners/mindmap.ts:72` —— 这条笔记还没转写稿。带 noteUid 才跳得准。 */
  transcribeFirst: (p) => {
    const uid = str(p, 'noteUid');
    return uid ? `/notes/${encodeURIComponent(uid)}` : '/notes';
  },
};

/**
 * **认识、但故意不给路由**的 action，逐条写明理由。
 *
 * 这张表存在的意义只有一个：让"没有落点"成为一个**被记录过的判断**，
 * 而不是掉进 default 之后看不出来的意外。
 * 用户要求 2.1 是"能在网页上自己修好"，不是"每个错误都得有个按钮"——
 * 给一个点了没用的按钮，比不给按钮更糟（它教会用户忽略按钮）。
 */
export const UNROUTED_ACTIONS: Readonly<Record<string, string>> = {
  /**
   * `http/server.ts:252` —— 401，令牌交接地址失效。
   * 没有"哪一页"能修：得重新握手。`ErrorBlock` 的 `isAuth` 分支已经给了
   * 「重新连接」按钮（走 `lib/api/connect.resetConnection()`），跳任何路由都只会
   * 带着同一个失效令牌再撞一次墙。
   */
  /**
   * `packages/llm/src/errors.ts:79` —— 429 `LLM_RATE_LIMITED`。
   * 用户**什么都不用做也做不了**：产品自己会重试（文案就是「稍后会自动重试」）。
   * 没有哪一页能"加快限流解除"，给按钮等于把一件自动完成的事说成需要人管
   * —— 与 `reauth` 同一类。
   */
  wait: '产品自己会重试；没有哪一页能解除限流，给按钮是把自动完成的事说成要人管',
  openHandoffUrl: 'ErrorBlock 的 isAuth 分支已给「重新连接」，跳路由解决不了令牌失效',
  /**
   * `http/server.ts:327` —— 403 CSRF_FAILED。
   * `lib/api/client.ts:316` 的 `shouldReauth()` 已经在客户端内部识别并自愈，
   * 到不了用户面前。给按钮等于把一个自动修好的东西说成需要人管。
   */
  reauth: 'client.ts 的 shouldReauth() 已在请求层自愈，不该冒到 UI',
  /**
   * `http/rest/notes.ts:196` —— 403 PATH_NOT_ALLOWED，导入的本地路径不在允许根内。
   * **产品里没有目录选择器**（浏览器里也做不出真正的目录选择）。允许的根已经在
   * `params.roots` 里、错误详情能看到；跳 `/capture` 是原地转圈 —— 用户本来就在那儿。
   * 真要修得先有"允许目录"的设置界面，那是另一件事，不在这里假装已经有了。
   */
  chooseAllowedFolder: '没有目录选择界面；allowed roots 已在错误详情里，跳任何页都是原地转圈',
  /**
   * `http/rest/storage.ts:266` —— 409，目标已经是一个 OpenMemo 数据目录。
   * daemon 自己写着「UI 点「直接使用此目录」时按这个再发一次即可」——
   * 它是一个**就地动作（重发请求）**，不是跳转。由
   * `features/settings/DataLocationSection.tsx` 传 `onRemediate` 就地处理。
   */
  useExistingDataDir:
    '就地重发 POST /settings/data-dir，由 DataLocationSection 的 onRemediate 处理',
  /**
   * `http/rest/jobs.ts:182` —— 501，暂停/继续没实现，建议改为取消。
   * 同样是**就地动作**（取消这个 job），不是跳转。
   * ⚠️ 但它目前根本到不了任何 `<ErrorBlock>`：`JobList.tsx:122` 的
   * `actions.pause.mutate()` 没有任何地方渲染 `isError` —— 点「暂停」是静默无反应。
   * 那是另一个洞，记在 inbox 里，不在这张表里假装解决。
   */
  cancel_job: '就地取消 job，不是跳转；且该错误当前未被任何 ErrorBlock 渲染（另记）',
};

/**
 * 认不出的 action 一律送任务中心。
 *
 * 判据：认不出 = **前端比 daemon 旧**。这时唯一还成立的事实是"服务端说有事要做"，
 * 而任务中心是全应用里唯一会把服务端原话（`messageZh` / blocked 原因）连同
 * 重试入口一起摆出来的地方。旧的 `RemediationButton` 默认送 `/models`
 * （"最常见的前置条件缺失来源"）—— 那是一个猜测，对任何非模型类的新 action 都是错的。
 */
export const UNKNOWN_ACTION_FALLBACK = '/tasks';

/**
 * 算出这条 remediation 该跳哪里。
 *
 * @returns 路由；`null` = **故意不给按钮**（见 `UNROUTED_ACTIONS`）。
 */
export function remediationTarget(r: RemediationLike): string | null {
  const route = REMEDIATION_ROUTES[r.action];
  if (route) return route(r.params);
  if (r.action in UNROUTED_ACTIONS) return null;
  return UNKNOWN_ACTION_FALLBACK;
}
