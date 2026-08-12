/**
 * 「写操作失败了，界面必须说话」—— 这一族的**回归腿**。
 *
 * ## 为什么单独开一个 bundle，而不是并进 components.test.tsx
 *
 * 判据不同。`components.test.tsx` 覆盖的是"这个组件渲染/交互对不对"；
 * 这里覆盖的是**一条横切规则**：
 *
 *   > **任何一个用户点出来的写操作，失败时界面上必须出现可读的东西。**
 *
 * 这条规则被违反过至少 16 次（14 处 `void mutateAsync` + 本轮又查出的几处），
 * 每次的形状都一样：成功路径接了，失败路径没人渲染，**用户看到的与"按钮是死的"完全一样**。
 * 把它们收在一个文件里，加新按钮的人一眼能看到该照着写什么。
 *
 * ## ⚠️ 断言钉的是**结构**，不是**用词**
 *
 * 这一点是 B11 那次教训的直接产物。`e2e-browser-audit.mjs` 的 B11 原来用关键词表
 * （`/失败|错误|重试|无法|不可用|出错|error|failed|retry/i`）判断"说话了没有"，
 * 而产品对 `FOLDER_NOT_FOUND` 渲染的是「文件夹不存在 / 它可能刚被删掉了。侧栏刷新后
 * 重新选一个。」—— **一个关键词都不含**。于是产品明明说了话，断言报「界面一个字都没说」。
 *
 * **文案写得越好，关键词判据越判不出来** —— 它在惩罚好文案。
 * 所以这里一律断言 `[data-testid="error-block"]`（`ErrorBlock` 的结构标记，
 * 同时带 `role="alert"`）**出现在该出现的容器里**，且**文字非空**。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient, useQuery } from '@tanstack/react-query';

import { render, click, type, text, stubApi } from './host';
import { ConnectionBanner } from '../components/common/ConnectionBanner';
import { useConnectionStore } from '../lib/stores/connection.store';
import { DEGRADED_POLL_INTERVAL_MS, startDegradedPolling } from '../lib/events/degradedPolling';
import { NoteActionsMenu } from '../features/notes/NoteActionsMenu';
import { countUnfinishedJobs } from '../features/tasks/api';
import { JobToaster } from '../components/common/JobToaster';
import { bus } from '../lib/events/bus';
import { notifyJobAttached } from '../lib/jobs/attachedNotice';
import { useModelPullMutation } from '../features/models/api';
import { ModelCard } from '../features/models/components/ModelCard';
import zhLocale from '../app/i18n/locales/zh-CN.json';

const UID = '01B11AAAAAAAAAAAAAAAAAAAAA';
const NOTE = { uid: UID, title: '一条笔记' };

/** 造一个真实形状的错误响应（照抄 daemon 的错误信封）。 */
const fail = (status: number, code: string, messageZh: string) =>
  new Response(JSON.stringify({ error: { code, message: code, messageZh } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** 某个容器里有没有一个**说得出话**的错误块。 */
function spoke(root: Element | null): { block: boolean; text: string } {
  if (!root) return { block: false, text: '' };
  const el = root.querySelector('[data-testid="error-block"]');
  return { block: el !== null, text: (el?.textContent ?? '').replace(/\s+/g, ' ').trim() };
}

async function openMenu(r: Awaited<ReturnType<typeof render>>) {
  await click(r.container.querySelector('[data-testid="note-actions"]'));
  await r.flush();
}

describe('写操作失败时界面必须说话（NoteActionsMenu）', () => {
  /*
   * ★ 这一条是 B11 的等价复现。
   * B11 在真浏览器里报「端点回了 404 FOLDER_NOT_FOUND，而界面一个字都没说」——
   * 这里证明那是**假指控**：产品一直是说话的，B11 的判据看不见它。
   */
  test('★ 移动失败：面板留在原地，且面板里出现错误块（B11 的等价复现）', async () => {
    stubApi({
      '/folders': { folders: [] },
      [`PUT /notes/${UID}/folder`]: fail(404, 'FOLDER_NOT_FOUND', '文件夹不存在'),
    });
    const r = await render(<NoteActionsMenu note={NOTE} />);
    await openMenu(r);
    await click(r.container.querySelector('[data-testid="note-move"]'));
    await r.flush();

    await click(r.container.querySelector('[data-testid="note-move-root"]'));
    await r.flush();

    const panel = r.container.querySelector('[data-testid="note-move-panel"]');
    assert.equal(
      panel === null,
      false,
      '移动失败后面板被收起来了 —— 用户分不清"移好了"还是"被吞了"',
    );
    const got = spoke(panel);
    assert.equal(got.block, true, `面板里没有错误块。面板文字：${panel?.textContent ?? ''}`);
    assert.equal(got.text.length > 0, true, '错误块渲染出来了，但一个字都没有');
  });

  /*
   * ★ 删除：修之前 `onError: () => close()` 把整个下拉卸载，而 `del.isError` 零渲染点。
   *   更坏的是它旁边那句注释写着"错误由 mutation 自己的状态呈现"—— 那个渲染点不存在。
   */
  test('★ 删除失败：菜单不许收起，且要出现错误块', async () => {
    stubApi({
      '/folders': { folders: [] },
      [`DELETE /notes/${UID}`]: fail(409, 'NOTE_IN_USE', '这条笔记正在被使用'),
    });
    const r = await render(<NoteActionsMenu note={NOTE} />);
    await openMenu(r);
    await click(r.container.querySelector('[data-testid="note-delete"]'));
    await r.flush();
    await click(r.container.querySelector('[data-testid="note-delete-confirm"]'));
    await r.flush();

    // 判据先证明自己不是空的：确认区还在，说明菜单没被卸载
    assert.equal(
      r.container.querySelector('[data-testid="note-delete-confirm"]') === null,
      false,
      '删除失败后菜单整个收起来了 —— 笔记还在、一个字都没有，用户只会以为自己没点中',
    );
    const got = spoke(r.container);
    assert.equal(got.block, true, `删除失败后没有任何错误块：${r.container.textContent ?? ''}`);
    assert.equal(got.text.length > 0, true, '错误块渲染出来了，但一个字都没有');
  });

  /* ★ 改名：修之前是 `onSettled: close` —— 成功失败都收起，失败等于静默。 */
  test('★ 改名失败：输入框不许收起，且要出现错误块', async () => {
    stubApi({
      '/folders': { folders: [] },
      [`PATCH /notes/${UID}`]: fail(400, 'BAD_REQUEST', '标题不合法'),
    });
    const r = await render(<NoteActionsMenu note={NOTE} />);
    await openMenu(r);
    await click(r.container.querySelector('[data-testid="note-rename"]'));
    await r.flush();
    await type(r.container.querySelector('[data-testid="note-rename-input"]'), '新标题');
    await click(r.container.querySelector('[data-testid="note-rename-save"]'));
    await r.flush();

    assert.equal(
      r.container.querySelector('[data-testid="note-rename-input"]') === null,
      false,
      '改名失败后输入框被收起 —— 用户看到"面板关了、标题没变"，分不清是没刷新还是被吞了',
    );
    const got = spoke(r.container);
    assert.equal(got.block, true, `改名失败后没有任何错误块：${r.container.textContent ?? ''}`);
    assert.equal(got.text.length > 0, true, '错误块渲染出来了，但一个字都没有');
  });

  /*
   * ★ 反向的守卫：**什么都还没失败的时候**不许出现错误块。
   *   没有它，把 `{isError ? … }` 写成恒真也能让上面三条全绿。
   *
   * ⚠️ 这条**第一版写错了**，如实记下：原来是"移动成功之后不许有错误块"。
   *   `[实测]` 把渲染条件改成恒真，它**照样绿** —— 因为移动成功会 `setMode('menu')`，
   *   整个面板连同里面的错误块一起卸载，"没有错误块"是**卸载**保证的，
   *   跟那个条件写成什么完全无关。一条因为正确的结果、错误的理由通过的断言。
   *   改成"面板刚打开、还没点任何东西"才具备鉴别力：恒真的话它当场就会显出来。
   */
  test('★ 还没有任何失败时不许出现错误块（否则上面三条写成恒真也会绿）', async () => {
    stubApi({
      '/folders': { folders: [] },
      [`PUT /notes/${UID}/folder`]: { uid: UID, folderUid: null },
    });
    const r = await render(<NoteActionsMenu note={NOTE} />);
    await openMenu(r);
    await click(r.container.querySelector('[data-testid="note-move"]'));
    await r.flush();

    const panel = r.container.querySelector('[data-testid="note-move-panel"]');
    assert.equal(panel === null, false, '面板没打开 —— 这条断言就什么都没验');
    assert.equal(spoke(panel).block, false, '什么都还没失败，界面上就摆着一个错误块');
  });
});

describe('ErrorBlock 的结构标记本身', () => {
  /*
   * `role="alert"` 与 `data-testid="error-block"` 是**契约**：
   * `e2e-browser-audit.mjs` 的 B11 直接按这个 testid 找错误块。
   * 谁把它改掉，这条会当场红，而不是让那条浏览器腿在 CI 上莫名其妙变绿/变红。
   */
  test('★ 错误块必须带 role="alert"（读屏要当场播报），且 testid 是浏览器腿约定的那个', async () => {
    stubApi({
      '/folders': { folders: [] },
      [`PUT /notes/${UID}/folder`]: fail(404, 'FOLDER_NOT_FOUND', '文件夹不存在'),
    });
    const r = await render(<NoteActionsMenu note={NOTE} />);
    await openMenu(r);
    await click(r.container.querySelector('[data-testid="note-move"]'));
    await r.flush();
    await click(r.container.querySelector('[data-testid="note-move-root"]'));
    await r.flush();

    const el = r.container.querySelector('[data-testid="error-block"]');
    assert.equal(el === null, false, '没有 data-testid="error-block" —— B11 那条浏览器腿会瞎掉');
    assert.equal(el?.getAttribute('role'), 'alert');
  });
});

/* ══════════════ 侧栏「任务」徽标：环境信号不许只在 Toast 里 ══════════════ */

/**
 * `JobToaster` 的列表是 SSE `job.created` 喂养的 React 状态，**已发生的事件不重放**。
 * 于是 SPA 一重挂 Toast 层就空了 —— 而这不止"刷新"一种：
 * **切页 / 手动关掉 Toast / 开着另一个标签页**，用户都会失去唯一的进度反馈。
 *
 * 判据（Manager 2026-08-10）：**用户不需要"想起来去点"，屏幕上就有东西告诉他还有任务在跑。**
 *
 * ⚠️ 这里只钉**纯函数口径**。徽标的渲染由 `App.tsx` 的 `SideLink` 负责，
 * 而那条路要挂整个 App（路由 + 七个 provider），成本远高于它能挡住的东西；
 * 真正会错的是**"算哪些任务"**，那正是这个纯函数。
 * （渲染那一层由 e2e 的 D 组覆盖 —— 那里本来就在点侧栏。）
 */
describe('侧栏「任务」徽标的计数口径', () => {
  const job = (state: string) => ({ state }) as { state: never };

  test('★ 计的是"还没结束的"，不是"正在跑的" —— blocked 必须算进去', () => {
    // blocked 永远不会自己结束，正是最该把用户叫过去的那一种。
    assert.equal(countUnfinishedJobs([job('blocked')]), 1);
    assert.equal(
      countUnfinishedJobs([job('queued'), job('leased'), job('running'), job('paused')]),
      4,
    );
  });

  test('★ failed 不许算进去 —— 它是终态且永远留在列表里，算了徽标就永不归零', () => {
    // 徽标永不归零 = 徽标疲劳 = 等于没有徽标（⑤B「假红会训练人忽略告警」同一条）。
    assert.equal(countUnfinishedJobs([job('failed')]), 0);
    assert.equal(countUnfinishedJobs([job('succeeded'), job('cancelled')]), 0);
  });

  test('★ 没有任何未完成任务时必须是 0（徽标要真的会消失，不能恒亮）', () => {
    assert.equal(countUnfinishedJobs([]), 0);
    assert.equal(countUnfinishedJobs([job('succeeded'), job('failed'), job('cancelled')]), 0);
  });

  test('★ 混合场景：只数未完成的那几条', () => {
    assert.equal(
      countUnfinishedJobs([
        job('running'),
        job('succeeded'),
        job('blocked'),
        job('failed'),
        job('queued'),
      ]),
      3,
    );
  });
});

/* ══════ 点了就得有反应：被服务端去重的那一次，界面也必须说话 ══════ */

/**
 * 真机缺陷（2026-08-10）：对一个**当前还在下载中**的模型再点一次「下载」，
 * 界面**一个字都没有**。报成了「打开量化选择器就没有 Toast」，
 * 而 `[实测 jsdom 三组对照]` 弹出层无关 —— 变量是"这个模型此刻正在下载"。
 *
 * 机制：`downloader/queue.ts:111` 命中 `findActiveByTarget` 就 return，
 * 走不到 `:154` 的 `emit('job.created')` ⇒ Toast 层收不到任何东西。
 *
 * ⚠️ 判据是 Manager 点的那条：**重复点两次，第二次仍然要有 toast** ——
 * 而不是只断言"toast 存在"（第一次的 toast 还在，那条断言恒真，验不出第二次）。
 * 所以下面先 `dismiss` 掉第一次的 toast（等价于用户手动关掉、或切页回来），
 * 再发第二次的"已去重"通知，要求它**重新出现**。
 */
describe('被去重的那次点击也必须有反应', () => {
  const jobCreated = (jobId: string) =>
    bus.emit('job.created', {
      type: 'job.created',
      ts: new Date().toISOString(),
      job: {
        jobId,
        kind: 'model',
        type: 'model_pull',
        targetId: 'asr/whisper-tiny-q5_1',
        displayName: 'Whisper 超小模型（Q5_1 量化）',
        state: 'running',
        step: 'downloading',
        provider: null,
        totalBytes: 40_000_000,
        completedBytes: 0,
        speedBps: 0,
        etaSeconds: null,
        parts: [],
        currentFile: null,
        fileIndex: 0,
        fileCount: 1,
        attempt: 1,
        maxAttempts: 3,
        error: null,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

  const toasts = (c: HTMLElement) => c.querySelectorAll('[data-testid^="job-toast-"]');

  test('★ 第一次点：job.created 来了 → 有 toast（前提自检，证明这条用例不是空的）', async () => {
    stubApi({ '/health': { ok: true } });
    const r = await render(<JobToaster />);
    await r.flush();
    jobCreated('job-1');
    await r.flush();
    assert.equal(toasts(r.container).length, 1);
    r.unmount();
  });

  test('★ 第二次点（被去重，daemon 不发 job.created）：仍然必须有 toast', async () => {
    stubApi({ '/health': { ok: true } });
    const r = await render(<JobToaster />);
    await r.flush();

    // 第一次：正常创建
    jobCreated('job-1');
    await r.flush();
    assert.equal(toasts(r.container).length, 1, '第一次就没有 toast —— 后面什么都测不了');

    // 用户关掉它（或切页回来），toast 层空了
    await click(r.container.querySelector('[data-testid="job-toast-job-1"] button'));
    await r.flush();
    assert.equal(toasts(r.container).length, 0, '关不掉的话下面那条断言会因为第一条还在而恒真');

    /*
     * 第二次点击：服务端去重，**没有 job.created**。
     * 这里走的是产品真实路径的那一半：`useModelPullMutation.onSuccess` 在
     * `deduplicated === true` 时调的就是这个函数。
     */
    notifyJobAttached({ jobId: 'job-1', targetId: 'asr/whisper-tiny-q5_1' });
    await r.flush();

    const list = toasts(r.container);
    assert.equal(list.length, 1, '被去重的那次点击，界面一个字都没有 —— 与"按钮是死的"完全一样');
    const text = (list[0]?.textContent ?? '').replace(/\s+/g, ' ').trim();
    assert.equal(text.length > 0, true, 'toast 渲染出来了，但一个字都没有');
    /*
     * ⚠️ 钉的是「说清了是哪一种情况」，判据取 **i18n 词条本身**（不是我在这里另写一句中文）——
     * 文案改了词条，这条跟着走；文案被换成一句泛泛的"有反应了"，这条才红。
     */
    const zhJobToast = (zhLocale as unknown as { jobToast: Record<string, string> }).jobToast;
    const expected = (zhJobToast['alreadyRunning'] ?? '').replace(
      '{{name}}',
      'asr/whisper-tiny-q5_1',
    );
    assert.equal(text.includes(expected), true, `没说清是"已经在进行中"：${text}`);
    r.unmount();
  });

  test('★ 已经有 toast 时不许把它改写成「已经在进行中」（那条"开始下载"是真话）', async () => {
    stubApi({ '/health': { ok: true } });
    const r = await render(<JobToaster />);
    await r.flush();
    jobCreated('job-1');
    await r.flush();
    const before = (
      r.container.querySelector('[data-testid="job-toast-job-1"]')?.textContent ?? ''
    ).trim();

    notifyJobAttached({ jobId: 'job-1', targetId: 'asr/whisper-tiny-q5_1' });
    await r.flush();
    const after = (
      r.container.querySelector('[data-testid="job-toast-job-1"]')?.textContent ?? ''
    ).trim();
    assert.equal(after, before, 'seed 语义被破坏了：已有的 toast 被改写');
    r.unmount();
  });
});

/**
 * ⚠️ 上面那三条只覆盖了「toaster 收到通知会不会说话」这一半。
 * **另一半 —— `useModelPullMutation` 在 `deduplicated` 时到底通不通知 —— 才是生产里坏掉的那半。**
 * （反向验证时发现的：把 `if (data.deduplicated)` 短路掉，上面三条**一条都不红**。）
 * 所以这里走产品真实路径：真的调那个 hook、真的让 `POST /models/pull` 回 `deduplicated: true`。
 */
describe('去重的那次点击：产品真实路径（hook → toaster）', () => {
  function PullProbe() {
    const pull = useModelPullMutation();
    return (
      <button
        type="button"
        data-testid="probe-pull"
        onClick={() =>
          pull.mutate({
            id: 'asr/whisper-tiny-q5_1',
            kind: 'model',
            provider: 'auto',
            licenseAccepted: true,
            includeOptional: [],
          })
        }
      >
        下载
      </button>
    );
  }

  test('★ 服务端回 deduplicated:true → 界面必须出现 toast（此前一个字都没有）', async () => {
    stubApi({
      '/health': { ok: true },
      'POST /models/pull': {
        jobId: 'job-dedup',
        state: 'running',
        targetId: 'asr/whisper-tiny-q5_1',
        totalBytes: 40_000_000,
        eventsUrl: '/api/events',
        deduplicated: true,
      },
    });
    const r = await render(
      <>
        <PullProbe />
        <JobToaster />
      </>,
    );
    await r.flush();
    assert.equal(r.container.querySelectorAll('[data-testid^="job-toast-"]').length, 0);

    await click(r.container.querySelector('[data-testid="probe-pull"]'));
    await r.flush();

    const list = r.container.querySelectorAll('[data-testid^="job-toast-"]');
    assert.equal(list.length, 1, '服务端说"已经在跑了"，而界面一个字都没有');
    assert.equal((list[0]?.textContent ?? '').trim().length > 0, true, 'toast 出来了但没有字');
  });

  test('★ 正常（deduplicated:false）时不许凭空造 toast —— 那条要等真的 job.created', async () => {
    // 没有这一条，把通知写成"无条件发"也能让上面那条绿。
    stubApi({
      '/health': { ok: true },
      'POST /models/pull': {
        jobId: 'job-fresh',
        state: 'queued',
        targetId: 'asr/whisper-tiny-q5_1',
        totalBytes: 40_000_000,
        eventsUrl: '/api/events',
        deduplicated: false,
      },
    });
    const r = await render(
      <>
        <PullProbe />
        <JobToaster />
      </>,
    );
    await r.flush();
    await click(r.container.querySelector('[data-testid="probe-pull"]'));
    await r.flush();
    assert.equal(
      r.container.querySelectorAll('[data-testid^="job-toast-"]').length,
      0,
      '没被去重却先造了一条 toast —— 真正的 job.created 来时会变成两条/或说错话',
    );
  });
});

/* ══════ 契约里"算好给界面用"的字段，必须在用户会走到的路径上真的看到 ══════ */

/**
 * 判据（Manager 2026-08-10）：**不是"渲染了"、不是"字段传下去了"，
 * 是"用户在他会走到的那条路径上真的看到了"。**
 *
 * 所以下面不去单独渲染 `FitBadge`，而是渲染**模型卡**（`ModelCard`）——
 * 那是用户点「下载」的地方，也是这三条字段该出现的地方。
 */
describe('契约字段必须出现在用户走到的路径上', () => {
  const FIT = (over: Record<string, unknown> = {}) => ({
    tier: 'recommended',
    reasonCode: 'ok',
    reasonZh: '可以跑',
    reasonEn: 'ok',
    estGpuLayers: null,
    estMinutesPerAudioHour: null,
    speedTier: 'normal',
    speedSource: 'none',
    cpuFeaturesUnverified: [],
    notRecommendedForLanguage: false,
    detail: {
      needMB: 1200,
      vramBudgetMB: 0,
      ramBudgetMB: 8000,
      diskFreeMB: 50000,
      diskNeededMB: 1400,
    },
    ...over,
  });

  const variant = (over: Record<string, unknown> = {}) => ({
    id: 'asr/paraformer-zh-small',
    groupId: 'asr/paraformer',
    displayName: 'Paraformer small',
    displayNameZh: 'Paraformer 小模型',
    role: 'asr',
    quantization: 'q5_1',
    totalSizeBytes: 40_000_000,
    engines: ['sherpa-onnx'],
    license: { id: 'MIT', url: 'https://x', gated: false, requiresAcceptance: false },
    requirements: { ramRequiredMB: 400, vramRequiredMB: 0, diskRequiredMB: 60, cpuFeatures: [] },
    fitness: FIT(),
    benchmark: null,
    speedClass: 'fast',
    files: [],
    installed: false,
    ...over,
  });

  const group = (v: Record<string, unknown>) => ({
    groupId: 'asr/paraformer',
    role: 'asr',
    displayName: 'Paraformer',
    displayNameZh: 'Paraformer',
    tags: [],
    variants: [variant(v)],
  });

  const card = (v: Record<string, unknown> = {}) => (
    <ModelCard
      group={group(v) as never}
      locale="zh-CN"
      installedIds={new Set<string>()}
      activeId={null}
      pendingId={null}
      onPull={() => undefined}
      onDelete={() => undefined}
      onActivate={() => undefined}
    />
  );

  /*
   * ① 那句**诚实的第三种说法**必须在"没探测过"的现场真的出现。
   *   `cpuFeaturesUnverified: ['avx2']` 就是 Windows 上的真实形态
   *   （`detectCpuWin32()` 无条件返回空特性集）。
   */
  test('★ ① 没查过指令集时，卡片上必须出现"无法确认"，而不是"不支持"', async () => {
    stubApi({});
    const r = await render(card({ fitness: FIT({ cpuFeaturesUnverified: ['avx2'] }) }));
    await r.flush();
    const el = r.container.querySelector('[data-testid="fit-cpu-unverified"]');
    assert.equal(el === null, false, `卡片上没有那句诚实的话：${text(r.container).slice(0, 200)}`);
    const said = (el?.textContent ?? '').trim();
    assert.equal(said.includes('avx2'), true, `没说清是哪个指令集：${said}`);
    /*
     * ⚠️ 判据取 i18n 词条本身，不在这里另写一句中文 —— 文案改词条这条跟着走，
     * 被换成"可能不支持"那种把"没查过"重新说成"查过且不行"的措辞时才红。
     */
    const zhFit = (zhLocale as unknown as { models: { fit: Record<string, string> } }).models.fit;
    assert.equal(said.includes(zhFit['cpuUnverified']!.split('{{')[0]!.trim()), true, said);
    r.unmount();
  });

  test('★ ① 反面：查过（数组为空）时不许冒出这句话', async () => {
    // 没有这一条，把渲染条件写成恒真也能让上面那条绿。
    stubApi({});
    const r = await render(card());
    await r.flush();
    assert.equal(r.container.querySelector('[data-testid="fit-cpu-unverified"]') === null, true);
    r.unmount();
  });

  /* ② 能力取舍必须在**下载按钮所在的那张卡**上、且**逐字**。 */
  test('★ ② 能力取舍逐字显示在下载按钮同一张卡上', async () => {
    stubApi({});
    const caveats = ['无词级时间戳，只有段级', '数字输出为中文而非阿拉伯数字', '英文一律小写'];
    const r = await render(card({ capabilityCaveats: caveats }));
    await r.flush();
    const box = r.container.querySelector('[data-testid="model-capability-caveats"]');
    assert.equal(box === null, false, '能力取舍一个字都没有');
    for (const c of caveats) {
      assert.equal((box?.textContent ?? '').includes(c), true, `逐字要求：漏了「${c}」`);
    }
    // 必须和下载入口在同一张卡上 —— "下载之前知道"是这条契约的全部理由
    assert.equal(
      r.container.querySelector('[data-testid^="model-download"], button') === null,
      false,
      '卡片上没有任何可点的东西 —— 这条用例就没有验到"下载之前"',
    );
    r.unmount();
  });

  test('★ ② 反面：没有取舍时不许画一个空框', async () => {
    stubApi({});
    const r = await render(card());
    await r.flush();
    assert.equal(
      r.container.querySelector('[data-testid="model-capability-caveats"]') === null,
      true,
    );
    r.unmount();
  });
});

/* ══════════ A-4：「使用中」与「真的用得上」是两件事 ══════════ */

/**
 * `[用户真机 2026-08-09, Windows]` 同一台机器上两个消费方说相反的话：
 * 激活态说这个 VAD **正在用**，流水线装配同一时刻说 whisper.cpp **加载不了它**、
 * 切分降级为固定窗口 —— 那条警告一次启动出现 **3 遍**。
 *
 * 服务端（A-4 ②③）已经把事实算出来发在 `activeUnusable` 里了。
 * 这一组钉的是**用户在他会走到的那条路径上真的看到了**，而且看到的是
 * **对应他这一种情况的那个动作** —— 三种情况的动作完全不同，糊在一起等于没修。
 */
describe('A-4 三态在模型卡上各说各的动作', () => {
  const UNUSABLE_FIT = {
    tier: 'recommended',
    reasonCode: 'ok',
    reasonZh: '可以跑',
    reasonEn: 'ok',
    estGpuLayers: null,
    estMinutesPerAudioHour: null,
    speedTier: 'normal',
    speedSource: 'none',
    cpuFeaturesUnverified: [],
    notRecommendedForLanguage: false,
    detail: { needMB: 1, vramBudgetMB: 0, ramBudgetMB: 8000, diskFreeMB: 5000, diskNeededMB: 2 },
  };

  const vadGroup = {
    groupId: 'vad/silero-vad',
    role: 'vad',
    displayName: 'Silero VAD',
    displayNameZh: 'Silero VAD',
    tags: [],
    variants: [
      {
        id: 'vad/silero-vad-onnx',
        groupId: 'vad/silero-vad',
        displayName: 'Silero VAD (ONNX)',
        displayNameZh: 'Silero VAD (ONNX)',
        role: 'vad',
        quantization: 'f16',
        totalSizeBytes: 2_327_524,
        engines: ['sherpa-onnx'],
        license: { id: 'MIT', url: 'https://x', gated: false, requiresAcceptance: false },
        requirements: { ramRequiredMB: 1, vramRequiredMB: 0, diskRequiredMB: 1, cpuFeatures: [] },
        fitness: UNUSABLE_FIT,
        benchmark: null,
        speedClass: 'fast',
        files: [],
        installed: true,
      },
    ],
  };

  const vadCard = (unusable: Record<string, unknown> | null) => (
    <ModelCard
      group={vadGroup as never}
      locale="zh-CN"
      installedIds={new Set(['vad/silero-vad-onnx'])}
      activeId={null}
      pendingId={null}
      onPull={() => undefined}
      onDelete={() => undefined}
      onActivate={() => undefined}
      unusableActive={unusable as never}
    />
  );

  const zhCard = (zhLocale as unknown as { models: { card: Record<string, string> } }).models.card;
  /** 取词条里**变量之前**那一段做判据 —— 文案改词条这条跟着走，改语义才红。 */
  const head = (key: string): string => zhCard[key]!.split('{{')[0]!.trim();

  test('★★ 能用的那份已经装了 ⇒ 给一个真按钮（他该做的是激活，不是重下一遍）', async () => {
    stubApi({});
    const r = await render(
      vadCard({
        modelId: 'vad/silero-vad-onnx',
        engine: 'whisper.cpp',
        usableInstalled: 'vad/silero-vad-ggml',
      }),
    );
    await r.flush();
    const said = text(r.container);
    assert.equal(
      said.includes(head('unusableActive')),
      true,
      `没说出加载不了：${said.slice(0, 200)}`,
    );
    assert.equal(
      said.includes(head('unusableSwitch')),
      true,
      `没说"你已经装了能用的"：${said.slice(0, 200)}`,
    );
    assert.equal(
      r.container.querySelector('[data-testid="model-unusable-switch-vad/silero-vad"]') === null,
      false,
      '只说了话、没有可点的出口 —— 那正是这一周在删的那种"到不了能修的那一页"',
    );
    r.unmount();
  });

  test('★★ 确知一份都没有 ⇒ 说"去装一个"，且**不给**那个改用按钮', async () => {
    stubApi({});
    const r = await render(
      vadCard({ modelId: 'vad/silero-vad-onnx', engine: 'whisper.cpp', usableInstalled: null }),
    );
    await r.flush();
    const said = text(r.container);
    assert.equal(said.includes(head('unusableInstall')), true, said.slice(0, 200));
    assert.equal(
      r.container.querySelector('[data-testid="model-unusable-switch-vad/silero-vad"]') === null,
      true,
      '一份能用的都没装，却给了"改用那一份" —— 按钮点下去无处可去',
    );
    r.unmount();
  });

  test('★★ 说不出（字段缺失）⇒ 只报事实，**一个动作都不给**', async () => {
    stubApi({});
    const r = await render(vadCard({ modelId: 'vad/silero-vad-onnx', engine: 'whisper.cpp' }));
    await r.flush();
    const said = text(r.container);
    assert.equal(said.includes(head('unusableActive')), true, said.slice(0, 200));
    assert.equal(
      said.includes(head('unusableUnknown')),
      true,
      `没说"这次没查出来"：${said.slice(0, 200)}`,
    );
    // 猜一个动作会把已经装好的人送去重下一遍 / 把没装的人送去找不存在的东西
    assert.equal(said.includes(head('unusableInstall')), false, '说不出的时候不许给"去装一个"');
    assert.equal(said.includes(head('unusableSwitch')), false, '说不出的时候不许给"改用那一份"');
    r.unmount();
  });

  test('★ 反面：没有这一格时不许凭空多出一行警示（缺失 ≠ 否）', async () => {
    stubApi({});
    const r = await render(vadCard(null));
    await r.flush();
    assert.equal(r.container.querySelector('[data-testid="model-unusable-vad/silero-vad"]'), null);
    r.unmount();
  });
});

/* ────────── SSE 降级之后：兜底必须真的在拉数据（#101） ────────── */

/**
 * ## 这一组防的是什么
 *
 * `lib/events/source.ts` 的 `MAX_RECONNECT_BEFORE_DEGRADE` 注释写着
 * 「连续这么多次重连失败后**降级为轮询（约 15s）**」。顺着 `degraded` 查下来只有
 * 三样东西：一个枚举值、一条黄色横幅、一张 tone 表 —— **全仓没有一处在拉数据**。
 *
 * 也就是说：SSE 断到降级之后，界面**永久停在最后一帧**，
 * 而横幅还在说「正在轮询」，注释还在让下一个人**不去查这里**。
 *
 * ## 判据：必须钉「真的又去要了一次数据」
 *
 * 这是本组唯一的重点。只钉「state 变成了 degraded」或「横幅出现了」都会**恒绿** ——
 * 缺陷状态下这两件事本来就都成立，缺的从来就是那次请求。
 * 所以探针是一个真实的 `useQuery`，断言的是它的 `queryFn` **被再调用了一次**。
 *
 * ⚠️ 每条用例都必须把连接态复位：store 是模块级单例，
 * 上一条留下的 `degraded` 会让下一条从"已经在轮询"起步，得到一个假绿。
 */
describe('SSE 降级的轮询兜底', () => {
  /** 探针：一个真实的活跃 query。`calls` 就是"它又去要了几次数据"。 */
  function probe() {
    const calls = { n: 0 };
    const Probe = () => {
      const q = useQuery({
        queryKey: ['degraded-probe'],
        queryFn: () => {
          calls.n += 1;
          return Promise.resolve(calls.n);
        },
        staleTime: 0,
        gcTime: 0,
        retry: false,
      });
      return <span data-testid="probe">{String(q.data ?? '')}</span>;
    };
    return { calls, Probe };
  }

  const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

  beforeEach(() => {
    useConnectionStore.setState({ state: 'connecting' });
  });
  afterEach(() => {
    useConnectionStore.setState({ state: 'connecting' });
  });

  test('★★ 进入 degraded 后，活跃 query 必须真的被重新拉 —— 否则「降级」只是一条横幅', async () => {
    stubApi({});
    const { calls, Probe } = probe();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
    });
    // 20ms 只为让用例跑得完；产品用的是 DEGRADED_POLL_INTERVAL_MS（15s），下面单独钉
    const stop = startDegradedPolling(qc, { intervalMs: 20 });
    const r = await render(<Probe />, { queryClient: qc });
    await r.flush();

    const atOpen = calls.n;
    assert.ok(atOpen >= 1, '前提自检：探针本身没拉过数据，这条用例就是空的');

    useConnectionStore.setState({ state: 'degraded' });
    await r.flush();
    assert.ok(
      calls.n > atOpen,
      `降级的第一拍就该立刻重拉一次（让用户干等 15 秒，横幅那句话在这 15 秒里就是假的）。实际仍是 ${calls.n}`,
    );

    const afterFirst = calls.n;
    await wait(70);
    await r.flush();
    assert.ok(
      calls.n > afterFirst,
      `轮询没有继续 —— 只在进入降级时拉一次不叫兜底。实际停在 ${calls.n}`,
    );

    stop();
    r.unmount();
    qc.clear();
  });

  test('★ 反面：连接正常时不许自己轮询（否则上面那条写成恒真也会绿）', async () => {
    stubApi({});
    const { calls, Probe } = probe();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
    });
    const stop = startDegradedPolling(qc, { intervalMs: 20 });
    const r = await render(<Probe />, { queryClient: qc });
    await r.flush();

    const baseline = calls.n;
    useConnectionStore.setState({ state: 'open' });
    await wait(70);
    await r.flush();
    assert.equal(calls.n, baseline, 'SSE 好好的时候还去轮询 = 白白多打一倍请求');

    stop();
    r.unmount();
    qc.clear();
  });

  test('★ 恢复 open 之后必须停下来 —— 否则降级过一次就永远多一条轮询', async () => {
    stubApi({});
    const { calls, Probe } = probe();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
    });
    const stop = startDegradedPolling(qc, { intervalMs: 20 });
    const r = await render(<Probe />, { queryClient: qc });
    await r.flush();

    useConnectionStore.setState({ state: 'degraded' });
    await wait(70);
    await r.flush();
    useConnectionStore.setState({ state: 'open' });
    await r.flush();

    const afterRecovery = calls.n;
    await wait(70);
    await r.flush();
    assert.equal(calls.n, afterRecovery, `恢复之后定时器没清掉，还在拉（${calls.n}）`);

    stop();
    r.unmount();
    qc.clear();
  });

  test('★ 间隔就是注释当初承诺的那个数（15s）—— 不许改小声了事', () => {
    assert.equal(
      DEGRADED_POLL_INTERVAL_MS,
      15_000,
      'source.ts 的注释对读者许的是"约 15s"。改这个数就要同时改那句话，否则它又变回一句假话',
    );
  });

  /**
   * 横幅这一格钉的是**它说的话对不对、给不给得出下一步**。
   *
   * 上一版它写的是「实时更新已断开，正在轮询」—— 后半句当时是假的。
   * 现在轮询真的有了，但用户看到的仍是**最多迟 15 秒**的界面，
   * 所以横幅必须给一条不丢页面状态的出路（F5 整页重载会丢掉正在播的音频与滚动位置）。
   */
  test('★★ 降级横幅要给一个点得动的动作，且点下去真的重拉', async () => {
    stubApi({});
    const { calls, Probe } = probe();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
    });
    const r = await render(
      <>
        <Probe />
        <ConnectionBanner />
      </>,
      { queryClient: qc },
    );
    await r.flush();

    assert.equal(
      r.container.querySelector('[data-testid="sse-degraded-refresh"]'),
      null,
      '前提自检：没降级时不该有这条横幅',
    );

    useConnectionStore.setState({ state: 'degraded' });
    await r.flush();

    const btn = r.container.querySelector('[data-testid="sse-degraded-refresh"]');
    assert.ok(btn, `降级了却没有任何用户能做的动作：${text(r.container).slice(0, 200)}`);
    assert.ok(text(r.container).length > 0, '横幅必须说话');

    const before = calls.n;
    await click(btn);
    await r.flush();
    assert.ok(calls.n > before, '「立即刷新」点了不重拉 —— 又一个只会变色的按钮');

    r.unmount();
    qc.clear();
  });
});
