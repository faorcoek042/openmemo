/**
 * 任务状态机的**表级不变量**。
 *
 * `JOB_TRANSITIONS` 是一张手写的表，daemon、队列、UI 三方共用它。
 * 表里写错一个状态名，`canTransition()` 只会**恒返回 false** ——
 * 表现是"任务卡住不动"，不是"抛异常"。这类错法没有任何编译期保护：
 * `Record<JobState, readonly JobState[]>` 只约束**键**，不约束数组里的值来自哪儿
 * （`['runnning']` 这种拼错在赋值处会红，但表一旦被改成 `string[]` 就彻底无声）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  JOB_STATES,
  JOB_TRANSITIONS,
  TERMINAL_JOB_STATES,
  canTransition,
  jobTypeForKind,
  type JobState,
} from './jobs.js';

const ALL = new Set<string>(JOB_STATES);

describe('JOB_TRANSITIONS —— 表本身要自洽', () => {
  it('每个状态都有一条出边定义（漏一个就是运行时 undefined.includes 崩溃）', () => {
    for (const s of JOB_STATES) {
      assert.equal(Array.isArray(JOB_TRANSITIONS[s]), true, `${s} 在转移表里没有条目`);
    }
    assert.deepEqual(
      Object.keys(JOB_TRANSITIONS).sort(),
      [...JOB_STATES].sort(),
      '转移表的键与 JOB_STATES 对不上',
    );
  });

  it('★ 所有转移目标都必须是真实存在的状态（拼错 → canTransition 恒 false → 任务永久卡住）', () => {
    for (const [from, targets] of Object.entries(JOB_TRANSITIONS)) {
      for (const to of targets) {
        assert.equal(ALL.has(to), true, `${from} → ${to}：目标状态 ${to} 不在 JOB_STATES 里`);
      }
    }
  });

  it('没有状态能转移到自己（自环会让重试计数之类的逻辑打转）', () => {
    for (const [from, targets] of Object.entries(JOB_TRANSITIONS)) {
      assert.equal(targets.includes(from as JobState), false, `${from} 有一条指向自己的转移`);
    }
  });

  it('canTransition 与表一致（两边不许各写一份判据）', () => {
    for (const from of JOB_STATES) {
      for (const to of JOB_STATES) {
        assert.equal(
          canTransition(from, to),
          JOB_TRANSITIONS[from].includes(to),
          `canTransition(${from}, ${to}) 与 JOB_TRANSITIONS 不一致`,
        );
      }
    }
  });
});

describe('终态语义', () => {
  it('TERMINAL_JOB_STATES 里的每一项都是合法状态', () => {
    for (const s of TERMINAL_JOB_STATES) assert.equal(ALL.has(s), true, `${s} 不是合法状态`);
  });

  it('★ succeeded 是吸收态 —— 成功的任务绝不能再动起来', () => {
    assert.deepEqual(
      JOB_TRANSITIONS.succeeded,
      [],
      'succeeded 有了出边：一个已完成的任务会被重新执行，产物可能被覆盖',
    );
  });

  it('★ 终态只能回到 queued，绝不能直接跳回 running / leased', () => {
    // failed / cancelled 允许重试，但**必须重新排队**，不能原地复活 ——
    // 直接跳回 running 会绕过租约（leased）与并发控制，
    // 出现同一个任务两个执行者同时写同一个目标文件。
    for (const s of TERMINAL_JOB_STATES) {
      for (const to of JOB_TRANSITIONS[s]) {
        assert.equal(to, 'queued', `终态 ${s} 有一条到 ${to} 的转移 —— 终态重启只允许经由 queued`);
      }
    }
  });

  it('每个非终态都至少能走到某个终态（否则任务会永久悬着）', () => {
    // 从每个状态做一次可达性搜索，必须能碰到至少一个终态。
    const terminal = new Set<string>(TERMINAL_JOB_STATES);
    for (const start of JOB_STATES) {
      const seen = new Set<string>([start]);
      const queue: JobState[] = [start];
      let reached = false;
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (terminal.has(cur)) {
          reached = true;
          break;
        }
        for (const nxt of JOB_TRANSITIONS[cur]) {
          if (!seen.has(nxt)) {
            seen.add(nxt);
            queue.push(nxt);
          }
        }
      }
      assert.equal(reached, true, `从 ${start} 出发走不到任何终态`);
    }
  });
});

describe('jobTypeForKind', () => {
  it('两种 kind 各自映射到 D-02 的 jobs.type 取值', () => {
    assert.equal(jobTypeForKind('model'), 'download.model');
    assert.equal(jobTypeForKind('backend-pack'), 'download.backend');
  });
});
