/**
 * T-155 —— **失败任务的中文文案**（`backlog-sweep` 的零调用方扫描查出来的）。
 *
 * ## 这条钉的是"用户看到什么"，不是"某个 map 有没有被 import"
 *
 * `JobList.tsx:115` 是：
 *
 * ```tsx
 * {i18n.language.startsWith('zh') ? job.error.messageZh : job.error.message}
 * ```
 *
 * 而 `queue.ts` 原来把**同一个英文串**同时塞进这两个字段。于是中文用户下载模型失败时
 * 看到的是 `All download sources failed` / `Access denied (403)` / `Disk full`。
 * 界面上没有任何迹象说明这里本该有中文 —— `ERROR_MESSAGES_ZH` 那 16 条
 * **从写下那天起就是零调用方**（全仓唯一一处出现是它自己的定义行）。
 *
 * 所以断言写在**队列真的跑完一单失败任务之后**读 `job.error`，
 * 而不是断言"queue.ts 里 import 了那个 map"——后者钉的是形式，
 * 把 import 留着、赋值改回去，形式那条照样绿。
 *
 * ## 反向验证（做过，见 inbox/backlog-sweep.md §RV）
 * 把 `messageZh` 改回 `detail`：★ 那两条当场红；把 `retryable` 改回 `?? false`：第三条红。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DownloadQueue } from './queue.js';

/** 抛一个带 `code` 的错误 —— 与 `DownloadError` / `HttpError` 真实抛出的形状一致。 */
function failingWith(code: string, message: string, retryable?: boolean) {
  return () =>
    Promise.reject(
      Object.assign(new Error(message), {
        code,
        ...(retryable === undefined ? {} : { retryable }),
      }),
    );
}

/**
 * 等这条任务失败。
 *
 * ## 为什么这个兜底要写成这样（T-198 收尾）
 *
 * 它原来是这三行：
 *
 * ```ts
 * await new Promise<void>((resolve) => {
 *   q.on('job.failed', () => resolve());
 *   setTimeout(resolve, 2000).unref?.();   // ← 兜底
 * });
 * ```
 *
 * 三个毛病，合起来是同一个形状 —— **一个永远不会现形的兜底**：
 *
 * 1. **`unref` 过**：unref 的定时器不把事件循环撑住。真出事（`job.failed` 不来）时
 *    循环里没别的待办，node 认为"已经空了"，这个兜底**根本不会触发**，
 *    promise 永远不结算 → 子测试被 runner 整批取消（`cancelledByParent`）。
 *    本文件下半部分正是栽在这上面，CI run 31397063723 六条全灭。
 * 2. **`resolve` 而不是 `reject`**：就算它触发了，也只是让 `runOne` 返回一个
 *    **状态还没落到 failed** 的 job，后面的断言去读 `job.error` 拿到 undefined ——
 *    用户看到的是一条语焉不详的 TypeError，而不是"等不到 job.failed"。
 * 3. **从不 `clearTimeout`**：正常路径下那个 2 秒定时器仍然挂着。
 *
 * 现在按 `waitForState()` 立的那个形状统一：**ref 过 + reject + 用完就清**。
 * 真等不到时要拿到一条**说得出原因的失败**，而不是一次静默的"通过" ——
 * **一个永远不会触发的兜底，和没有兜底，在绿灯里长得一模一样。**
 */
function waitForJobFailed(q: DownloadQueue, jobId: string, timeoutMs = 2000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `等不到 ${jobId} 的 job.failed（${timeoutMs}ms 内没到；当前状态 ${String(
            q.get(jobId)?.state,
          )}）`,
        ),
      );
    }, timeoutMs);
    q.on('job.failed', (...args: unknown[]) => {
      if ((args[0] as { jobId?: string } | undefined)?.jobId !== jobId) return;
      clearTimeout(timer);
      resolve();
    });
  });
}

function enqueueFor(q: DownloadQueue, task: (...a: never[]) => Promise<void>) {
  return q.enqueue(
    {
      kind: 'model',
      targetId: `asr/t-${Math.random().toString(36).slice(2)}`,
      displayName: 'x',
      totalBytes: 1,
    },
    task as Parameters<DownloadQueue['enqueue']>[1],
  ).job;
}

async function runOne(task: () => Promise<never>) {
  const q = new DownloadQueue(1);
  const job = enqueueFor(q, task);
  await waitForJobFailed(q, job.jobId);
  return q.get(job.jobId);
}

describe('下载失败时交给界面的错误文案', () => {
  it('★ 已登记的错误码必须给中文 —— 中文界面读的就是 messageZh 这一个字段', async () => {
    const job = await runOne(
      failingWith('INTEGRITY_ALL_SOURCES_FAILED', 'All download sources failed'),
    );
    assert.equal(job?.state, 'failed');
    assert.equal(job?.error?.messageZh, '所有下载源均失败');
    // 英文那半边不许被顺手改掉：诊断细节只在这里，丢了就再也拿不回来。
    assert.equal(job?.error?.message, 'All download sources failed');
  });

  it('★ messageZh 不许再等于英文 message（这正是原来的缺陷形态）', async () => {
    const job = await runOne(failingWith('DISK_FULL', 'Disk full'));
    assert.equal(job?.error?.messageZh, '磁盘空间不足');
    assert.equal(job?.error?.messageZh === job?.error?.message, false);
  });

  it('★ 抛出方没说 retryable 时按码本查，而不是一律当成不可重试', async () => {
    const job = await runOne(failingWith('NETWORK_TIMEOUT', 'socket hang up'));
    assert.equal(job?.error?.retryable, true);
    assert.equal(job?.error?.messageZh, '网络超时');
  });

  it('抛出方显式说了 retryable 就以它为准（码本只是兜底）', async () => {
    const job = await runOne(failingWith('NETWORK_TIMEOUT', 'socket hang up', false));
    assert.equal(job?.error?.retryable, false);
  });

  it('INTERNAL 与未登记的码保留原始 detail —— 翻成"内部错误"是把仅有的线索换成废话', async () => {
    const internal = await runOne(failingWith('INTERNAL', 'TypeError: x is not a function'));
    assert.equal(internal?.error?.messageZh, 'TypeError: x is not a function');

    const unknown = await runOne(failingWith('SOMETHING_NEW', 'brand new failure mode'));
    assert.equal(unknown?.error?.code, 'SOMETHING_NEW');
    assert.equal(unknown?.error?.messageZh, 'brand new failure mode');
  });

  it('前提自检：没有 code 的裸错误仍按 INTERNAL 处理（上面几条才有对照）', async () => {
    const job = await runOne(() => Promise.reject(new Error('naked')));
    assert.equal(job?.error?.code, 'INTERNAL');
    assert.equal(job?.error?.messageZh, 'naked');
  });

  /**
   * ★★ **这条兜底自己也要被守住**（T-198 收尾）。
   *
   * 上面 6 条全都 `await runOne(...)`，而 `runOne` 里那个"等不到就算了"的兜底
   * 原来是 **unref + resolve + 不 clearTimeout** —— 也就是说：
   * 真出事时它**根本不会触发**，触发了也只会让用例安静地往下走。
   * 它存在的那两年里，**没有任何一次运行能证明它工作过**。
   *
   * 所以这里直接把它逼到真出事的那一格：造一个**永远不会 `job.failed` 的任务**
   * （它会成功），断言兜底以**带话的失败**现形。
   *
   * 这条不是"再验一遍已经修好的东西"，它是那个兜底**唯一**的证据 ——
   * 一个永远不会触发的兜底，和没有兜底，在绿灯里长得一模一样。
   */
  it('★★ 兜底自己也要能红：job.failed 不来时必须是一条带话的失败，不是静默通过', async () => {
    const q = new DownloadQueue(1);
    // 这个任务会**成功**，所以 job.failed 永远不会到 —— 正是兜底该说话的那一格
    const job = enqueueFor(q, () => Promise.resolve());
    await assert.rejects(
      () => waitForJobFailed(q, job.jobId, 50),
      (err: Error) => {
        assert.match(err.message, /等不到.*job\.failed/, '兜底触发了，但没说清等不到什么');
        assert.match(err.message, new RegExp(job.jobId), '要说清是哪条任务');
        return true;
      },
      '兜底没有以失败现形 —— 那它和没有兜底在绿灯里长得一模一样',
    );
  });

  it('★ 正常路径下兜底会被清掉（否则这 6 条用例每条都要多挂 2 秒）', async () => {
    const q = new DownloadQueue(1);
    const job = enqueueFor(q, () => Promise.reject(new Error('boom')) as Promise<void>);
    const t0 = Date.now();
    await waitForJobFailed(q, job.jobId, 2000);
    // 真等满 2 秒说明 clearTimeout 没生效 / 走的是兜底而不是事件
    assert.ok(Date.now() - t0 < 500, `等了 ${Date.now() - t0}ms —— 兜底没被清掉`);
  });
});

/**
 * ★★ T-198 —— **取消一个正在跑的任务，必须真的到达 `cancelled`。**
 *
 * ## 这条测试不存在，正是那个 bug 能出厂的原因
 *
 * `queue.test.ts` 此前**一个 cancel 用例都没有**（全是错误文案本地化），
 * daemon 侧零个，唯一的前端 cancel 测试只断言"请求发出去了"、
 * **从不看之后长什么样**。于是 `cancel()` 里这个形状活到了用户真机上：
 *
 * ```ts
 * const idx = this.waiting.indexOf(jobId);
 * if (idx >= 0) { …; this.forceState(e.job, 'cancelled'); }  // ← 终态在 if 里
 * return true;                                                // ← 但一律回 true
 * ```
 *
 * 正在跑的任务早被 `pump()` 的 `shift()` 挪出了 waiting → `idx === -1`
 * → **终态那句根本不执行**，而端点照样回 204。
 * `[用户真机 Windows v0.7.0]` 取消 ffmpeg 下载后，任务中心同屏自相矛盾：
 * 「进行中 (1)」+ 0% + 「正在选择下载源」，紧挨着「任务不存在或已结束」。
 *
 * ## 断言的是"之后长什么样"，不是"cancel() 返回了 true"
 *
 * 返回值那条正是当初骗过所有人的东西 —— 它一直是 true。
 */
describe('★ T-198 取消：状态必须诚实', () => {
  /**
   * 一个"打不断"的任务：**故意不认 signal**，模拟 resolving/installing 那些阶段。
   *
   * ⚠️ 定时器**绝不能 `.unref()`**（T-198 复盘）。
   * unref 过的定时器不会把事件循环撑住 —— 当队列此刻没有别的待办时，
   * node 认为"循环已经空了"，这个 promise 于是**永远不结算**，
   * 子测试跑不完，父测试先结束，runner 把它们整批取消：
   *   `failureType: 'cancelledByParent'`
   *   `error: 'Promise resolution is still pending but the event loop has already resolved'`
   * 本地能过是**运气**（恰好还有别的东西撑着循环），CI 上就露馅了。
   * 而"六条钉着头号 bug 的守卫其实什么都没验"，正是这一周一直在修的那个形状。
   */
  function uninterruptible(ms: number) {
    return () => new Promise<void>((r) => setTimeout(r, ms));
  }

  /** 让出若干毫秒。同样**不许 unref**，理由同上。 */
  const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

  /**
   * 等到这条任务真的进入某个状态 —— **按事件等，不按秒等**。
   *
   * 原来是 `await tick(10)` 然后断言 `state === 'running'`。在 CI 那种更慢、
   * 更拥挤的机器上 10ms 不一定够 pump 跑起来，于是**前提断言**自己会翻脸 ——
   * 那是本文件第二个不可靠来源（第一个是 unref）。
   * 改成订阅 `job.state`：状态到了就立刻继续，永远不会等过头，也不会等不够。
   *
   * 超时兜底是 **ref 过的**定时器，而且是 `reject` 不是 `resolve`：
   * 真的等不到时要得到一条**说得出原因的失败**，而不是一个被整批取消的子测试。
   */
  function waitForState(q: DownloadQueue, jobId: string, state: string): Promise<void> {
    if (q.get(jobId)?.state === state) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`等不到 ${jobId} 进入 ${state}（当前 ${String(q.get(jobId)?.state)}）`));
      }, 5000);
      q.on('job.state', (...args: unknown[]) => {
        if ((args[0] as { jobId: string; state: string }).jobId !== jobId) return;
        if ((args[0] as { state: string }).state !== state) return;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function enqueueOne(q: DownloadQueue, task: () => Promise<void>) {
    return q.enqueue(
      {
        kind: 'model',
        targetId: `asr/t-${Math.random().toString(36).slice(2)}`,
        displayName: 'x',
        totalBytes: 1,
      },
      task,
    ).job;
  }

  it('★★ 取消一个**正在跑**的任务 → 立刻到达 cancelled（这条就是那个 bug）', async () => {
    const q = new DownloadQueue(1);
    const job = enqueueOne(q, uninterruptible(50));
    // 等它真的被 pump 起来（= 已经被 shift 出 waiting，正是出事的那个状态）
    await waitForState(q, job.jobId, 'running');
    assert.equal(q.get(job.jobId)?.state, 'running', '前提：它必须真的在跑，否则测不到这个 bug');

    assert.equal(q.cancel(job.jobId), true);
    assert.equal(
      q.get(job.jobId)?.state,
      'cancelled',
      'cancel() 回了 true，状态却没变 —— 端点会回 204 说"取消成功"',
    );
  });

  it('★ 取消时 step 一起清 —— 否则「正在选择下载源」冻在终态之后', async () => {
    const q = new DownloadQueue(1);
    const job = enqueueOne(q, uninterruptible(50));
    await waitForState(q, job.jobId, 'running');
    assert.equal(q.get(job.jobId)?.step, 'resolving', '前提：它此刻确实停在 resolving');

    q.cancel(job.jobId);
    assert.equal(q.get(job.jobId)?.step, null, '状态说"已取消"、阶段说"正在选择下载源" = 自相矛盾');
  });

  it('★★ 打不断的残余工作跑完后，**不许**把状态改回 succeeded', async () => {
    const q = new DownloadQueue(1);
    const job = enqueueOne(q, uninterruptible(40)); // 不认 signal，一定会"成功"跑完
    await waitForState(q, job.jobId, 'running');
    q.cancel(job.jobId);
    assert.equal(q.get(job.jobId)?.state, 'cancelled');

    // 等残余工作自然结束
    await tick(80);
    assert.equal(
      q.get(job.jobId)?.state,
      'cancelled',
      '残余工作把状态改回去了 —— 用户会看到一个"取消不掉"的取消',
    );
    assert.equal(q.get(job.jobId)?.step, null);
  });

  it('★ 取消一个**还在排队**的任务仍然照常工作（不许把老路径改坏）', async () => {
    const q = new DownloadQueue(1);
    const first = enqueueOne(q, uninterruptible(60)); // 占住唯一的并发位
    const queued = enqueueOne(q, uninterruptible(10));
    // 等第一条真的占住了位子，第二条才确定是"排队中"——同样按事件等，不按秒等
    await waitForState(q, first.jobId, 'running');
    assert.equal(q.get(queued.jobId)?.state, 'queued', '前提：第二条确实还在排队');

    assert.equal(q.cancel(queued.jobId), true);
    assert.equal(q.get(queued.jobId)?.state, 'cancelled');
  });

  it('★ 已经是终态的任务再取消 → 返回 false（端点据此回 409）', async () => {
    const q = new DownloadQueue(1);
    const job = enqueueOne(q, uninterruptible(5));
    await waitForState(q, job.jobId, 'running');
    q.cancel(job.jobId);
    assert.equal(q.cancel(job.jobId), false, '第二次取消必须回 false —— 界面据此知道"已经结束了"');
  });

  it('★ 取消会发出 job.state 事件（前端就是靠它清掉进度快照的）', async () => {
    const q = new DownloadQueue(1);
    const seen: string[] = [];
    q.on('job.state', (...args: unknown[]) => seen.push((args[0] as { state: string }).state));
    const job = enqueueOne(q, uninterruptible(50));
    await waitForState(q, job.jobId, 'running');
    q.cancel(job.jobId);
    assert.ok(seen.includes('cancelled'), `没发 job.state(cancelled)，实际: ${seen.join(',')}`);
  });
});
