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
    Promise.reject(Object.assign(new Error(message), { code, ...(retryable === undefined ? {} : { retryable }) }));
}

async function runOne(task: () => Promise<never>) {
  const q = new DownloadQueue(1);
  const { job } = q.enqueue(
    { kind: 'model', targetId: `asr/t-${Math.random().toString(36).slice(2)}`, displayName: 'x', totalBytes: 1 },
    task,
  );
  await new Promise<void>((resolve) => {
    q.on('job.failed', () => resolve());
    setTimeout(resolve, 2000).unref?.();
  });
  return q.get(job.jobId);
}

describe('下载失败时交给界面的错误文案', () => {
  it('★ 已登记的错误码必须给中文 —— 中文界面读的就是 messageZh 这一个字段', async () => {
    const job = await runOne(failingWith('INTEGRITY_ALL_SOURCES_FAILED', 'All download sources failed'));
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
});
