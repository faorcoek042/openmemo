/**
 * `RESOLUTION_PLANS`（`../tools.ts`）—— 每个工具必须显式声明解析顺序，不许静默继承。
 *
 * `tsc` 已经保证了"键"这一半：`RESOLUTION_PLANS` 的类型直接派生自 `ToolPaths`
 * （`Exclude<keyof ToolPaths, 'vadModel'>`），给 `ToolPaths` 加一个字段却忘了在
 * `RESOLUTION_PLANS` 里补一条，编译直接不过。这个文件补运行时那一半——防止有人
 * 用空字符串把 `reason` 糊弄过编译器，以及钉住 2026-08-10 Manager 裁决的具体
 * 顺序（ffmpeg/ffprobe/yt-dlp 内置排 PATH 之前；whisper-cli/whisper-vad 相反），
 * 免得下一次改动"顺手"把两组混到一起。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RESOLUTION_PLANS, type ResolutionTier } from '../tools.js';

const TOOLS = ['ffmpeg', 'ffprobe', 'whisperCli', 'whisperVad', 'ytDlp'] as const;

describe('RESOLUTION_PLANS', () => {
  it('每个工具都有一条计划，且 reason 非空', () => {
    for (const tool of TOOLS) {
      const plan = RESOLUTION_PLANS[tool];
      assert.ok(plan, `${tool} 没有 RESOLUTION_PLANS 条目`);
      assert.ok(plan.reason.trim().length > 0, `${tool} 的 reason 是空字符串`);
    }
  });

  it('每条 order 都是三档（pack/path/bundle）的一个排列，不重不漏', () => {
    const allTiers: ResolutionTier[] = ['pack', 'path', 'bundle'];
    for (const tool of TOOLS) {
      const order = RESOLUTION_PLANS[tool].order;
      assert.equal(order.length, 3, `${tool}.order 长度不是 3`);
      assert.deepEqual(
        [...order].sort(),
        [...allTiers].sort(),
        `${tool}.order 不是三档的排列：${JSON.stringify(order)}`,
      );
    }
  });

  it('所有工具：已装后端包永远排第一（下载优先于系统/内置，用户原话）', () => {
    for (const tool of TOOLS) {
      assert.equal(RESOLUTION_PLANS[tool].order[0], 'pack', `${tool} 第一顺位应是 pack`);
    }
  });

  it('2026-08-10 裁决：ffmpeg/ffprobe/yt-dlp —— 内置排在系统 PATH 之前', () => {
    for (const tool of ['ffmpeg', 'ffprobe', 'ytDlp'] as const) {
      const order = RESOLUTION_PLANS[tool].order;
      assert.ok(
        order.indexOf('bundle') < order.indexOf('path'),
        `${tool}: bundle 应排在 path 之前，实际 ${JSON.stringify(order)}`,
      );
    }
  });

  it('whisper-cli/whisper-vad 维持原判（2026-08-08 裁决）：PATH 排在内置之前', () => {
    for (const tool of ['whisperCli', 'whisperVad'] as const) {
      const order = RESOLUTION_PLANS[tool].order;
      assert.ok(
        order.indexOf('path') < order.indexOf('bundle'),
        `${tool}: path 应排在 bundle 之前，实际 ${JSON.stringify(order)}`,
      );
    }
  });
});
