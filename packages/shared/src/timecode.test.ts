/**
 * 时间码：基准向量 + 「全仓只许有一份实现」的结构守卫。
 *
 * 两层各守一段，缺一不可：
 *
 * 1. **基准向量** —— 钉住"保留的是哪一份的语义"。只做合并、不写向量的话，
 *    下一个人把 `floor` 改成 `round` 不会有任何东西变红。
 *    这组向量是从三处旧实现的边界逐个搬过来的（`packages/mindmap/src/timecode.test.ts`
 *    的四行分叉点、`apps/web/src/lib/format/singleSource.test.ts` 的十一行等价表）。
 * 2. **结构守卫** —— 钉住"不许再出现第二份"。它是两层里唯一能在
 *    **复制粘贴的那一刻**变红的；第 1 层要等到有人把值改坏才红。
 *
 * ── 为什么这条守卫值得跨包扫 ────────────────────────────────────────────────
 *
 * 收敛前这个函数在仓里有**三份**，且都是逐字等价的，所以谁都没有症状：
 *
 * | 位置 | 名字 | 输出给谁看 |
 * | --- | --- | --- |
 * | `apps/web/src/lib/format/time.ts` | `timecode()` | 播放器、正文里的锚点（屏幕上那个） |
 * | `packages/mindmap/src/timecode.ts` | `formatTimestamp()` | 导图导出的 `.md` |
 * | `apps/daemon/src/http/rest/content.ts` | `msToClock()` | 转写稿导出的 `.md` |
 *
 * 而本轮**必须**再加一处消费点：`apps/daemon/src/db/richText.ts` 要把正文里的
 * 时间锚点投影成 `[12:34]` 写进 `notes.body_text` —— **那是被 FTS5 索引的字符串**。
 * 它与第一行那份一旦漂移（哪怕只是补零规则变了），用户照着屏幕上的时间码搜自己的
 * 锚点就会搜不到，而**没有任何一处会报错**。四份靠"写的时候都一样"是守不住的。
 *
 * ⚠️ 判据只会漏检、不会误伤（本仓门禁的既定方向）：只认
 * `Math.floor(… / 3600)` 这个**把秒切成小时**的写法。量过：
 * `Math.round(seconds / 3600)`（`approxEta` 的小时档）、
 * `Math.floor(t / 3600000)`（`timecodeFull` 的 SRT 时间轴）、
 * `Math.floor((total % 3600) / 60)`（分钟位）**都不命中**，
 * 改之前全仓恰好 3 条真阳、0 条误报，改之后恰好 1 条（本包的 `timecode.ts`）。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { formatTimecode, timeAnchorText, TIME_ANCHOR_NODE_TYPE } from './timecode.js';

/*
 * 测试跑在 `packages/shared/dist/` 上（见本包 package.json 的 test 脚本），
 * 所以仓库根是它的上三层。用 `import.meta.url` 而不是 `process.cwd()`：
 * cwd 取决于谁在什么目录下敲的命令，而这条守卫必须扫到**别的包**。
 */
const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

/** 这份实现的家。全仓唯一允许命中结构判据的文件。 */
const HOME = 'packages/shared/src/timecode.ts';

describe('formatTimecode —— 基准向量（换实现不是换行为）', () => {
  it('常规', () => {
    assert.equal(formatTimecode(0), '0:00');
    assert.equal(formatTimecode(1_000), '0:01');
    assert.equal(formatTimecode(9_000), '0:09');
    assert.equal(formatTimecode(59_999), '0:59');
    assert.equal(formatTimecode(60_000), '1:00');
    assert.equal(formatTimecode(754_000), '12:34');
  });

  it('floor 而不是 round —— 90500ms 是 1:30，不是 1:31', () => {
    // `packages/mindmap` 里两份旧实现分叉的第一处：round 会把 90.5s 进位到 91s，
    // 时间码于是指向那一刻**之后**，跳过去会错过用户要找的那句话的开头。
    assert.equal(formatTimecode(90_500), '1:30');
    assert.equal(formatTimecode(3_599_999), '59:59');
  });

  it('小时档的进位与补零', () => {
    assert.equal(formatTimecode(3_600_000), '1:00:00');
    assert.equal(formatTimecode(4_354_000), '1:12:34');
  });

  it('不足一小时时分钟位**不**补零（分叉的第二处）', () => {
    assert.equal(formatTimecode(90_000), '1:30');
    assert.notEqual(formatTimecode(90_000), '01:30');
  });

  it('负数 / NaN / Infinity 不产出垃圾字符串', () => {
    // NaN 会一路变成 `NaN:NaN`，写进 .srt 会让整个字幕文件在播放器里失效，
    // 而在我们自己的界面上完全看不出来。
    assert.equal(formatTimecode(-1), '0:00');
    assert.equal(formatTimecode(Number.NaN), '0:00');
    assert.equal(formatTimecode(Number.POSITIVE_INFINITY), '0:00');
    assert.equal(formatTimecode(Number.NEGATIVE_INFINITY), '0:00');
  });

  it('浮点毫秒按"落在哪一秒里"取（播放器给的就是浮点）', () => {
    // 审计现场那三个锚点的 startMs 就是这个样子（currentTime * 1000）
    assert.equal(formatTimecode(4706.022), '0:04');
    assert.equal(formatTimecode(39854.604999999996), '0:39');
    assert.equal(formatTimecode(88305.031), '1:28');
  });
});

describe('timeAnchorText —— 两端共用的那个字符串', () => {
  it('就是 `[时间码]`，方括号是契约的一部分', () => {
    assert.equal(timeAnchorText(4706.022), '[0:04]');
    assert.equal(timeAnchorText(754_000), '[12:34]');
    assert.equal(timeAnchorText(Number.NaN), '[0:00]');
  });

  it('节点类型名也在这里，两端不许各写各的字面量', () => {
    assert.equal(TIME_ANCHOR_NODE_TYPE, 'timeAnchor');
  });
});

/* ═════════════════ 结构守卫：全仓只许有一份实现 ═════════════════ */

/** 剥注释。本文件与被收敛的三个文件里都有讲这段历史的说明，逐字包含被禁的写法。 */
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

/** `apps/<pkg>/src` 与 `packages/<pkg>/src` 下的产品源码（不含测试、不含测试宿主）。 */
function productFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 某个包没有 src/ 就跳过，不是失败
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'test') continue;
        walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push(relative(REPO, p).replace(/\\/g, '/'));
      }
    }
  };
  for (const group of ['apps', 'packages']) {
    let pkgs;
    try {
      pkgs = readdirSync(join(REPO, group), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const p of pkgs) if (p.isDirectory()) walk(join(REPO, group, p.name, 'src'));
  }
  return out.sort();
}

/** 把秒切成小时 —— 时间码实现的签名动作。 */
const HOUR_SPLIT = /Math\.floor\([^)]*\/\s*3600\s*\)/;

describe('★ 结构守卫：时间码实现全仓只许有一份', () => {
  it('前提自检：扫描器真的看得见东西（空集 ≠ 干净）', () => {
    const files = productFiles();
    assert.ok(files.length > 200, `只扫到 ${files.length} 个文件 —— 目录遍历坏了`);
    assert.ok(files.includes(HOME), `扫不到 ${HOME}，下面那条是空转`);
    // 跨包确实扫到了：这条守卫的全部价值就在"扫得到别的包"
    for (const probe of [
      'apps/web/src/lib/format/time.ts',
      'apps/daemon/src/db/richText.ts',
      'packages/mindmap/src/timecode.ts',
    ]) {
      assert.ok(files.includes(probe), `没扫到 ${probe} —— 跨包遍历失效了`);
    }
  });

  it('前提自检：剥注释在工作（否则会指着自己的说明文字判红）', () => {
    const src = 'const a = 1; // Math.floor(x / 3600)\n/* Math.floor(x / 3600) */\nconst b = 2;';
    assert.equal(HOUR_SPLIT.test(stripComments(src)), false);
  });

  it('前提自检：判据认得出真货（阳性对照）', () => {
    assert.equal(HOUR_SPLIT.test('const h = Math.floor(total / 3600);'), true);
    // 阴性对照：这三种写法**不是**第二份时间码，判红它们就是误伤
    assert.equal(HOUR_SPLIT.test('const hr = Math.round(seconds / 3600);'), false);
    assert.equal(HOUR_SPLIT.test('pad(Math.floor(t / 3600000))'), false);
    assert.equal(HOUR_SPLIT.test('const m = Math.floor((total % 3600) / 60);'), false);
  });

  it(`★ \`Math.floor(… / 3600)\` 只许出现在 ${HOME}`, () => {
    const offenders: string[] = [];
    for (const f of productFiles()) {
      if (f === HOME) continue;
      const body = stripComments(readFileSync(join(REPO, f), 'utf8'));
      body.split('\n').forEach((line, i) => {
        if (HOUR_SPLIT.test(line)) offenders.push(`  ${f}:${i + 1}\n      ${line.trim()}`);
      });
    }
    assert.deepEqual(
      offenders,
      [],
      '仓里又出现了第二份时间码实现：\n' +
        offenders.join('\n') +
        `\n⚠️ 请改用 \`@openmemo/shared\` 的 \`formatTimecode()\`（三个包都已经依赖它）。` +
        '\n第二份的危害与它今天算得对不对无关：**分叉是以后才发生的，而分叉时没有任何东西会报错**。' +
        '\n这一族里最贵的一条是 `apps/daemon/src/db/richText.ts` —— 它产出的字符串' +
        '直接进 FTS5 索引，与屏幕上那个漂了就意味着"用户照着屏幕搜自己的锚点，搜不到"。',
    );
  });

  it('★ 本文件的实现确实还在（守卫不许因为家没了而"全绿"）', () => {
    const home = stripComments(readFileSync(join(REPO, HOME), 'utf8'));
    assert.equal(
      HOUR_SPLIT.test(home),
      true,
      `${HOME} 里已经没有时间码实现了 —— 上面那条于是变成一条永远为空的断言`,
    );
  });
});
