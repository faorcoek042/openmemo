import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { useProgressStore, pushProgress } from './progress.store.js';
import { useSurfaceStore } from '../api/surfaces.js';

/**
 * ★ zustand 选择器的**引用稳定性**测试。
 *
 * ## 这组测试是为一个真实事故写的
 *
 * `model-mgmt` 在真浏览器里测到 `/tasks` **整页崩溃**（React error #185，
 * "Maximum update depth exceeded"），0 个可交互元素。根因是这一行：
 *
 * ```ts
 * const jobs = useProgressStore((s) => Object.values(s.byJob));   // ← 事故
 * ```
 *
 * `Object.values()` **每次调用都返回新数组**。zustand 默认用 `Object.is` 比较选择器结果，
 * 于是"状态没变"也被判定成"变了" → 组件重渲染 → 再次调用选择器 → 又是新数组 → **无限循环**。
 *
 * ## 为什么纯逻辑测试挡不住、而这组能
 *
 * 被测的东西**不是某个函数的返回值对不对**，而是**同一份状态下两次调用是否返回同一个引用**。
 * 这类不变量只有在"连续调用两次并比较引用"时才暴露，
 * 而它一旦被破坏，代价是整页白屏 —— 属于最贵的那种 bug。
 *
 * 规则：**store 选择器只能返回原始值或 store 里已有的引用，
 * 绝不能在选择器里 `map`/`filter`/`Object.values`/构造对象字面量。**
 * 需要派生就在组件里用 `useMemo`，或用 `useShallow`。
 */

/** 模拟 React 的行为：同一份状态连续取两次，比较引用。 */
function selectTwice<T>(sel: (s: never) => T, store: { getState: () => unknown }): [T, T] {
  const s = store.getState() as never;
  return [sel(s), sel(s)];
}

describe('progress.store 选择器引用稳定性', () => {
  test('★ 选 byJob 本身：同一状态两次调用必须是同一个引用', () => {
    pushProgress({
      jobId: 'j1',
      jobType: 'download.model',
      state: 'running',
      progress: 0.5,
      step: 'downloading',
      completedBytes: 1,
      totalBytes: 2,
      speedBps: 3,
      etaSeconds: 4,
    });

    const [a, b] = selectTwice((s: { byJob: unknown }) => s.byJob, useProgressStore);
    assert.strictEqual(a, b, 'byJob 必须引用稳定，否则订阅它的组件会无限重渲染');
  });

  test('★ 反例固化：Object.values 每次都是新数组 —— 这正是 /tasks 崩溃的根因', () => {
    const [a, b] = selectTwice(
      (s: { byJob: Record<string, unknown> }) => Object.values(s.byJob),
      useProgressStore,
    );
    assert.notStrictEqual(a, b, '如果这条断言失败，说明 zustand 行为变了，可以重新评估这条禁令');
  });

  test('选派生标量（长度/计数）是安全的：按值比较', () => {
    const [a, b] = selectTwice(
      (s: { byJob: Record<string, unknown> }) => Object.keys(s.byJob).length,
      useProgressStore,
    );
    assert.strictEqual(a, b, '数字按值比较，不会触发重渲染');
  });

  test('选单个 job（组件按 jobId 订阅自己那一条）引用稳定', () => {
    const [a, b] = selectTwice(
      (s: { byJob: Record<string, unknown> }) => s.byJob['j1'],
      useProgressStore,
    );
    assert.strictEqual(a, b);
  });
});

describe('surfaces.store 选择器引用稳定性', () => {
  test('states 对象引用稳定', () => {
    const [a, b] = selectTwice((s: { states: unknown }) => s.states, useSurfaceStore);
    assert.strictEqual(a, b);
  });

  test('未变更时 set 不产生新对象（避免无谓的重渲染扩散）', () => {
    const before = useSurfaceStore.getState().states;
    useSurfaceStore.getState().set('notes', useSurfaceStore.getState().states.notes);
    assert.strictEqual(
      useSurfaceStore.getState().states,
      before,
      '写入相同值时必须原样返回旧 state —— 否则每次 API 调用都会让全应用重渲染',
    );
  });

  test('变更时才产生新对象', () => {
    const before = useSurfaceStore.getState().states;
    useSurfaceStore.getState().set('notes', 'live');
    assert.notStrictEqual(useSurfaceStore.getState().states, before);
  });
});
