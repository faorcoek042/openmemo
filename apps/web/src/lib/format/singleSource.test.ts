/**
 * 守卫：**格式化只有一份实现**（时间码 / 百分比 / ETA / 绝对时间戳的 locale）。
 *
 * ── 为什么是一条源码扫描，而不是四条单测 ────────────────────────────────────
 *
 * 这四条守的不是"函数算得对不对"（那种单测已经有了），而是
 * **"仓里有没有长出第二份"**。第二份的危害与第一份对不对无关：
 * 它今天可能逐字等价，而**分叉是以后才发生的**，且分叉时没有任何东西会报错。
 * 本轮四条真实发作：
 *
 * | 第二份在哪 | 它和正版差在哪 | 用户看到什么 |
 * | --- | --- | --- |
 * | `DownloadRow` 的本地 `formatEta()` | **漏了小时档** | 3 小时的下载，模型页说「剩余约 180 分钟」，同一个 job 的 toast 说「约 3 小时」 |
 * | `DownloadRow` 的 `Math.round(ratio*100)%` | 没有本地化、没有量纲检查、没有 `'—'` 兜底 | 越界时理直气壮地渲染一个数（#90 那个恒 `100%` 就是这么来的） |
 * | `TimeAnchor` 的 `formatTimecode()` | 今天等价 | 它一旦漂，**FTS 索引里的 `[12:34]` 和屏幕上的对不上，搜索静默地坏掉** |
 * | `MockNotice` 的 `toLocaleTimeString(undefined,…)` | 用**浏览器** locale 而不是应用 locale | 中文界面里那一格按系统语言排版 |
 *
 * ── 判据都是"结构"，且都只会漏检、不会误伤 ───────────────────────────────────
 *
 * 每一条都先在全仓量过：**改之前各 1 条真阳、改之后 0 条**，没有一条误报
 * （这就是为什么下面**没有**「秒→分钟的除法只许出现在 lib/format」那条 ——
 * 量了，`className="border-line/60"` 这种字符串里的 `/60` 会误伤，一条会误伤的门禁
 * 两周内就会被所有人学会绕过去，那比没有门更坏）。
 *
 * **把修法退回去它们会红吗**：四条逐一验过，会。
 *
 * ⚠️ 扫描前**必须剥注释**：本文件上面那张表、以及被修文件里"这里原来是 …"的说明，
 * 逐字包含被禁的写法。不剥的话这条守卫会指着自己的解释文字判红 —— 假红灯比没有门更坏。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, globSync, readFileSync } from 'node:fs';

import { approxEta, timecode } from './time';

/**
 * 剥注释。行注释要看引号状态（`'https://…'` 里的 `//` 不是注释）；
 * 块注释用等量换行替换，**不能直接删** —— 直接删会把后面所有行号往上顶，
 * 于是守卫红的时候指着一个错误的位置（`lib/remediation/routes.test.ts` 实测踩过）。
 */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    '\n'.repeat((m.match(/\n/g) ?? []).length),
  );
  return noBlock
    .split('\n')
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (quote) {
          if (ch === '\\') i++;
          else if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        else if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

interface Hit {
  at: string;
  line: string;
}

/** 产品源码（不含测试与测试宿主）。 */
function productFiles(): string[] {
  return [...globSync('src/**/*.ts'), ...globSync('src/**/*.tsx')]
    .filter((f) => !/\.test\.tsx?$/.test(f))
    .filter((f) => !f.startsWith('src/test/'))
    .map((f) => f.replace(/\\/g, '/'));
}

function scan(re: RegExp, keep: (file: string) => boolean): Hit[] {
  const out: Hit[] = [];
  for (const file of productFiles()) {
    if (!keep(file)) continue;
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) out.push({ at: `${file}:${i + 1}`, line: lines[i]!.trim() });
    }
  }
  return out;
}

const show = (hits: Hit[]): string => hits.map((h) => `  ${h.at}\n      ${h.line}`).join('\n');
const outsideFormat = (f: string): boolean => !f.startsWith('src/lib/format/');

describe('前提自检：扫描器真的看得见东西（空集 ≠ 干净）', () => {
  test('文件清单非空，且包含 src/ 第一层与 lib/format 下的文件', () => {
    const files = productFiles();
    assert.ok(files.length > 100, `只扫到 ${files.length} 个文件 —— glob 坏了`);
    assert.ok(
      files.includes('src/lib/format/time.ts'),
      'lib/format/time.ts 都扫不到，下面全是空转',
    );
    assert.ok(
      files.some((f) => f.split('/').length === 3),
      '扫不到 src/ 第一层的文件（main.tsx 那一类）—— 与 check-orphan-exports.mjs 当年踩的是同一个 glob 坑',
    );
    assert.ok(existsSync('src/lib/format/time.ts'), 'cwd 不是 apps/web —— 这条守卫跑错地方了');
  });

  test('剥注释确实在工作（否则下面四条会指着自己的说明文字判红）', () => {
    const src = "const a = 1; // padStart(2, '0')\n/* padStart(2, '0') */\nconst b = 2;";
    assert.equal(/padStart\(2/.test(stripComments(src)), false);
  });
});

describe('★ 时间码只有一份实现（第二份会静默弄坏搜索）', () => {
  test('`padStart(2` 只许出现在 lib/format/ 里', () => {
    const hits = scan(/padStart\(\s*2/, outsideFormat);
    assert.deepEqual(
      hits.map((h) => h.at),
      [],
      '`lib/format/` 之外出现了补零逻辑 —— 多半是又抄了一份时间码：\n' +
        show(hits) +
        '\n⚠️ `TimeAnchor.renderText()` 产出的 `[12:34]` **正是被 FTS 索引的那个字符串**，' +
        '而屏幕上那个来自另一次调用。两份实现一旦漂移，用户照着屏幕搜自己的锚点会搜不到，' +
        '**没有任何一处报错**。请改用 `lib/format/time.ts` 的 `timecode()`。',
    );
  });

  test('`timecode()` 在被收敛掉的那份的全部边界上行为不变（换实现不是换行为）', () => {
    // 左边是被删掉的 TimeAnchor.formatTimecode 当时的输出，逐个手算核过
    const table: [number, string][] = [
      [0, '0:00'],
      [1_000, '0:01'],
      [59_999, '0:59'],
      [60_000, '1:00'],
      [754_000, '12:34'],
      [3_599_999, '59:59'],
      [3_600_000, '1:00:00'],
      [4_354_000, '1:12:34'],
      [-1, '0:00'],
      [Number.NaN, '0:00'],
      [Number.POSITIVE_INFINITY, '0:00'],
    ];
    for (const [ms, want] of table) {
      assert.equal(timecode(ms), want, `timecode(${ms})`);
    }
  });
});

describe('★ 百分比只有一份实现', () => {
  test('`Math.round(… * 100)` 不许出现在 lib/format/ 之外', () => {
    const hits = scan(/Math\.round\([^)]*\*\s*100\s*\)/, outsideFormat);
    assert.deepEqual(
      hits.map((h) => h.at),
      [],
      '有人又手写了一次百分比：\n' +
        show(hits) +
        '\n手写会丢掉 `formatPercent()` 的三样东西：本地化的百分号、量纲检查' +
        '（`reportProgressDimensionViolation` —— #90 那个恒 `100%` 就是它抓的）、' +
        "以及非有限值退化成 `'—'` 而不是渲染出 `NaN%`。",
    );
  });
});

describe('★ ETA 只有一份实现（漏一个档位就会让两个页面各说各话）', () => {
  test('凡是渲染 `etaSeconds` 的组件（.tsx），必须 import `approxEta`', () => {
    /*
     * ⚠️ 判据的**边界要说清楚**：只看 `.tsx`。理由是 `.tsx` ≈ 会把值画到屏幕上，
     * 而 `.ts` 里出现 `etaSeconds` 的那几处（`features/tasks/api.ts` 的合并、
     * `lib/stores/progress.store.ts` 的存放、两个 `sse.ts` 的搬运、`lib/api/mock.ts` 的造数据）
     * **只搬运不渲染**，要求它们 import 一个格式化函数是纯噪音。
     *
     * 于是这条**漏得掉**"某个 `.ts` helper 自己拼 ETA 文案"这一档 ——
     * 那是刻意选在**只会漏检、不会误伤**的那一侧（本仓门禁的既定方向）。
     */
    const offenders = productFiles()
      .filter((f) => f.endsWith('.tsx'))
      .filter((f) => /\betaSeconds\b/.test(stripComments(readFileSync(f, 'utf8'))))
      .filter((f) => !/\bapproxEta\b/.test(stripComments(readFileSync(f, 'utf8'))));
    assert.deepEqual(
      offenders,
      [],
      '这些组件读了 `etaSeconds` 却没走 `approxEta()`，多半是又写了一份 ETA 文案：\n' +
        offenders.map((f) => `  ${f}`).join('\n') +
        '\n`DownloadRow` 的那一份**漏了小时档**，于是一个 3 小时的下载在模型页显示' +
        '「剩余约 180 分钟」，而同一个 job 的 toast 显示「约 3 小时」。',
    );
  });

  test('前提：这条判据不是空转（今天确实有 .tsx 在渲染 etaSeconds）', () => {
    const renderers = productFiles()
      .filter((f) => f.endsWith('.tsx'))
      .filter((f) => /\betaSeconds\b/.test(stripComments(readFileSync(f, 'utf8'))));
    assert.ok(
      renderers.length >= 3,
      `只找到 ${renderers.length} 个渲染 etaSeconds 的组件（${renderers.join(', ')}）—— 扫描或改名把它扫空了`,
    );
  });

  test('★ `approxEta()` 的小时档必须在（被收敛掉的那份缺的就是它）', () => {
    assert.equal(approxEta(3 * 3600, 'zh-CN'), '约 3 小时');
    assert.equal(approxEta(3 * 3600, 'en'), 'about 3 hr');
    // 边界：59 分钟仍然按分钟说，60 分钟起才换档
    assert.equal(approxEta(59 * 60, 'zh-CN'), '约 59 分钟');
    assert.equal(approxEta(3600, 'zh-CN'), '约 1 小时');
    // 反面：不到一分钟不许四舍五入成「0 分钟」
    assert.equal(approxEta(40, 'zh-CN'), '不到 1 分钟');
    assert.equal(approxEta(0, 'zh-CN'), null);
    assert.equal(approxEta(null, 'zh-CN'), null);
  });
});

describe('★ 绝对时间戳一律用应用 locale，不用浏览器 locale', () => {
  test('`toLocale*(undefined, …)` 一处都不许有', () => {
    const hits = scan(/toLocale[A-Za-z]*\(\s*undefined\b/, () => true);
    assert.deepEqual(
      hits.map((h) => h.at),
      [],
      '`undefined` 在这里的含义是**浏览器的语言**，不是应用的语言：\n' +
        show(hits) +
        '\n用户在引导第一步选的那个语言存在 `i18n.language` 里；' +
        '全仓另外十几处绝对时间戳用的都是它。请显式传 `i18n.language` / `locale`。',
    );
  });
});
