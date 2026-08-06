/**
 * 时间码护栏。
 *
 * 修的是什么：`formatTimestamp` 在本包里曾有**两份**，输出不同 ——
 * `adapters/markmap.ts` 给 `1:30`，`serialize/markdown.ts` 给 `01:31`（同一个 90500ms）。
 * 同一张导图，渲染出来和导出成 Markdown，时间码对不上。
 *
 * 这里有三层断言，缺一不可：
 *
 * 1. **基准向量** —— 钉住"保留的是哪一份的语义"。光合并不写向量，
 *    下一个人把 `floor` 改成 `round` 不会有任何东西变红。
 * 2. **端到端一致** —— 钉的是**后果**（"两种导出的时间码必须是同一个字符串"），
 *    不是形式。这条即使有人把两份实现又拆开、但恰好写得一样，也仍然是对的。
 * 3. **结构守卫** —— 钉的是"不许再出现第二份"。这条是三层里唯一能在
 *    *复制粘贴的那一刻* 变红的，前两条要等到有人把值改坏才红。
 *
 * ⚠️ 第 3 条**必须先剥注释再数**：本包里现在有三处注释在讲这段历史，
 * 每一处都写着 `formatTimestamp` 这个词。不剥注释，守卫会数出 4 份然后
 * **为了错误的理由变红** —— 本项目今天已经在这个陷阱上摔过六次
 * （`/\bEmphasis\b/` 匹到自己旁边的注释、`/activeJobId/` 同样）。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { toMarkmap } from './adapters/markmap.js';
import { toMarkdown } from './serialize/markdown.js';
import { formatTimestamp } from './timecode.js';
import type { MindMapDoc } from './types.js';

// 测试跑在 dist 上，源码在 ../../src
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

/** 剥掉 `//` 与 `/* *\/` 注释；字符串字面量保留（不影响本用途）。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('formatTimestamp —— 基准向量', () => {
  // 这四行就是当初两份实现分叉的地方。
  it('90500ms → 1:30（floor，不是 round 出来的 1:31）', () => {
    assert.equal(formatTimestamp(90500), '1:30');
  });

  it('3599999ms → 59:59（round 会进位成 1:00:00）', () => {
    assert.equal(formatTimestamp(3599999), '59:59');
  });

  it('不足一小时时分钟位不补零', () => {
    assert.equal(formatTimestamp(90000), '1:30');
    assert.equal(formatTimestamp(9000), '0:09');
  });

  it('超过一小时补齐分秒两位', () => {
    assert.equal(formatTimestamp(3600000), '1:00:00');
    assert.equal(formatTimestamp(4354000), '1:12:34');
  });

  it('负数 / NaN / Infinity 不产出垃圾字符串', () => {
    assert.equal(formatTimestamp(-1), '0:00');
    assert.equal(formatTimestamp(Number.NaN), '0:00');
    assert.equal(formatTimestamp(Number.POSITIVE_INFINITY), '0:00');
  });

  it('★ 与 apps/web 的 timecode() 同义 —— 这组向量是两边一致性的唯一契约', () => {
    // packages/mindmap 不能 import apps/web，所以一致性只能靠同一组向量守。
    // 改这里的期望值时，必须同时改 apps/web/src/lib/format/time.ts 的 timecode()。
    assert.equal(formatTimestamp(754000), '12:34');
    assert.equal(formatTimestamp(0), '0:00');
  });
});

describe('★ 两种导出的时间码必须是同一个字符串（钉后果，不钉形式）', () => {
  const doc: MindMapDoc = {
    schemaVersion: 1,
    uid: 'u',
    title: '根',
    rootKey: 'r',
    revision: 0,
    nodes: {
      r: { key: 'r', text: '根', children: ['a'] },
      // 90500 与 3599999 正是两份旧实现给出不同答案的那两个输入
      a: {
        key: 'a',
        text: '子',
        children: [],
        refs: [{ transcriptUid: 't1', startMs: 90500, endMs: 91000, quote: 'x' }],
      },
    },
  };

  it('markmap 渲染与 Markdown 导出对同一个 ref 给出同一个时间码', () => {
    const md = toMarkdown(doc, { includeTimestamps: true });
    const mm = JSON.stringify(toMarkmap(doc, { showTimestamps: true }));
    assert.equal(md.includes('[1:30]'), true, `Markdown 里没有 [1:30]：\n${md}`);
    assert.equal(mm.includes('[1:30]'), true, `markmap 里没有 [1:30]：\n${mm}`);
    // 旧的 Markdown 实现会写 01:31 —— 显式钉住它不许回来
    assert.equal(md.includes('01:31'), false, 'Markdown 又用回了 round + 补零的那份');
  });
});

describe('★ 结构守卫：本包只许有一份 formatTimestamp 实现', () => {
  it('剥掉注释后，全包恰好一个定义，且在 timecode.ts', () => {
    const defs: string[] = [];
    for (const f of tsFiles(SRC)) {
      const body = stripComments(readFileSync(f, 'utf8'));
      // 只数**定义**（function 声明 / const 箭头函数），不数 import 与调用点
      const re = /(?:function\s+formatTimestamp\b|(?:const|let|var)\s+formatTimestamp\s*[:=])/g;
      const n = (body.match(re) ?? []).length;
      for (let i = 0; i < n; i += 1) defs.push(relative(SRC, f));
    }
    assert.deepEqual(
      defs,
      ['timecode.ts'],
      `formatTimestamp 的实现份数不对（应恰好 1 份、在 timecode.ts）。实际：${JSON.stringify(defs)}`,
    );
  });

  it('守卫本身有效：注释里的 formatTimestamp 不许被数进来', () => {
    // 这条钉的是上面那条守卫的**判据**。本包现在有 3 处注释提到这个名字，
    // 如果哪天有人把 stripComments 去掉"简化"一下，这条会当场红。
    const raw = tsFiles(SRC)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const inComments = (raw.match(/formatTimestamp/g) ?? []).length;
    const stripped = (stripComments(raw).match(/formatTimestamp/g) ?? []).length;
    assert.equal(inComments > stripped, true, '注释里应当仍留着讲这段历史的说明');
  });
});
