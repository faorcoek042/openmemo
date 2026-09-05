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
 * 2. **端到端** —— 钉的是**后果**（用户下载到的那个 `.md` 里写的是哪个时间码），
 *    不是形式。
 * 3. **结构守卫** —— 钉的是"不许再出现第二份"。这条是三层里唯一能在
 *    *复制粘贴的那一刻* 变红的，前两条要等到有人把值改坏才红。
 *
 * ⚠️ 第 3 条**必须先剥注释再数**：本包里现在有几处注释在讲这段历史，
 * 每一处都写着 `formatTimestamp` 这个词。不剥注释，守卫会数出好几份然后
 * **为了错误的理由变红** —— 本项目已经在这个陷阱上摔过六次
 * （`/\bEmphasis\b/` 匹到自己旁边的注释、`/activeJobId/` 同样）。
 *
 * ── ★ T-165：第 2 条**从"两个导出器互相比对"降级成"钉住 Markdown 这一条"** ──
 *
 * 原文是「markmap 渲染与 Markdown 导出对同一个 ref 给出同一个时间码」。
 * markmap 适配器本轮**整块删掉了**（产品里没有大纲视图，见 `index.ts` 文件头），
 * 所以那个比对**没有第二方了**。
 *
 * **诚实地记一笔这次降级损失了什么**：原来那条能抓住"有人把两份实现又拆开、
 * 且写得不一样"，现在抓不住了 —— 这一格改由第 3 条（结构守卫）承担，
 * 而它只在**新出现一份定义**时红，抓不住"改坏了唯一那一份"。
 * 那一格由第 1 条的基准向量守。**三层各守一段，删掉一层就该说清楚哪一段空了。**
 *
 * 保下来的那一半是**载重的那一半**：`serialize/markdown.ts` 的旧实现给 `01:31`，
 * 而它正是 `GET /api/notes/:uid/export?what=mindmap&format=md` 真正吐给用户的字节
 * （`apps/daemon/src/http/rest/content.ts` 的 `exportMindmap()`）。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

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

  it('★ 与 apps/web 的 timecode() 同义 —— 现在是同一个函数，不再靠同一组向量', () => {
    /*
     * ★ 订正：这条原来写着「这组向量是两边一致性的**唯一**契约」，理由是
     * 「packages/mindmap 不能 import apps/web」。前半句对，结论错了 ——
     * 复用的落点从来不是 `apps/web`，是 `@openmemo/shared`（本包已经依赖它）。
     *
     * 收敛之后 `formatTimestamp` / `apps/web` 的 `timecode()` / daemon 的
     * `msToClock()` 三个名字都只是 `@openmemo/shared` 的 `formatTimecode()` 的转发，
     * 一致性因此是**结构性的**，不再依赖两处向量各自被记得更新。
     *
     * 这组向量于是改守另一件事：**转发没转错、语义没被换掉**。
     * 它仍然是 `.md` 导出这条链路上唯一的行为断言，所以不能删。
     */
    assert.equal(formatTimestamp(754000), '12:34');
    assert.equal(formatTimestamp(0), '0:00');
  });
});

describe('★ 用户下载到的 .md 里写的必须是保留下来的那一份时间码（钉后果，不钉形式）', () => {
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

  it('Markdown 导出（导出端点真正吐出去的字节）用的是 floor + 不补零的那一份', () => {
    /*
     * `toMarkdown(doc, {includeTimestamps:true})` 就是
     * `content.ts` 的 `exportMindmap()` 在 `format=md` 分支里调的那一句 ——
     * 这里断的字符串会**逐字**出现在用户下载到的 `.md` 里。
     */
    const md = toMarkdown(doc, { includeTimestamps: true });
    assert.equal(md.includes('[1:30]'), true, `Markdown 里没有 [1:30]：\n${md}`);
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
