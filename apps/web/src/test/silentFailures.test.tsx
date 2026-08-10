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
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { render, click, type, stubApi } from './host';
import { NoteActionsMenu } from '../features/notes/NoteActionsMenu';
import { countUnfinishedJobs } from '../features/tasks/api';
import { JobToaster } from '../components/common/JobToaster';
import { bus } from '../lib/events/bus';
import { notifyJobAttached } from '../lib/jobs/attachedNotice';
import { useModelPullMutation } from '../features/models/api';
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
