/**
 * **测试用的端口不许撞上用户真实实例的 17650。**
 *
 * ## 起因
 *
 * `http/rest/settings.roundtrip.test.ts` 曾经是 `17_600 + rand(300)` 配 `maxPort: port + 40`，
 * 实际可达 **17600–17939** —— **区间里就含 `DEFAULT_PORT = 17650`**。
 * 本仓库自己立过规矩（`daemon.test.ts` 文件头：「用高位端口（19xxx）跑测试，
 * 避免与真实实例的 17650 打架」），另外四个 daemon 测试文件都照做了，**只有它没有**。
 *
 * 撞上的后果分两种，都不致命但都真实：
 * - 用户 daemon 在跑 → 测试拿 `StartupConflictError` 红一格（**假红灯**，
 *   会让人去查一个根本不存在的 bug）；
 * - 用户 daemon 没跑而此刻要起 → 它漂到 17651，而**浏览器麦克风授权按 origin 隔离**，
 *   端口一变用户就得重新授权。
 *
 * 一条"要记得用 19xxx"的纪律，等价于一条迟早会被违反的纪律 —— 这次就违反了。
 * 所以把它变成会红的东西。
 *
 * ## 判据（刻意选简单且不可能误判的那个）
 *
 * **所有显式端口基数 ≥ 19000。** 不是"不许等于 17650"——
 * `startDaemon` 的 `maxPort` 是**向上扫**的，所以只要起点在 19000 以上，
 * 无论扫多远都不可能回到 17650。这条判据不需要算出每个区间到底有多宽，
 * 也就不会因为算错宽度而误红。
 *
 * 另外两条：**基数两两至少隔 30**（node:test 一个文件一个子进程、并行跑，
 * 两个文件挑同一个基数就会互抢），以及**能静态算出宽度的那种写法必须真的放得下**。
 *
 * ## 这条测试自己不许变瞎（最重要的一条）
 *
 * 扫描器最坏的失败不是报错，是**遇到没见过的写法就跳过**，然后一直报绿。
 * 所以：**每一行 `const port = …` / `let portCursor = …` 都必须被归入某一类，
 * 归不了类就当场红**，并把原文打出来让人来决定。
 * 宁可因为新写法红一次，也不要一个看不见新写法的检查器。
 *
 * ## 已知边界（明写，不假装覆盖）
 *
 * `let portCursor = N` 这种游标式写法，**宽度取决于运行时调用了多少次**，
 * 静态数不出来。这里按**保留 30 个**处理。某个文件真起了超过 30 个 daemon
 * 就会漂进下一段 —— 这一点本检查器**测不出来**，写在这里免得有人以为它保证了。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { DEFAULT_PORT } from './bootstrap/single-instance.js';

/** 最低允许的端口基数：远高于 17650，且 `maxPort` 只向上扫，永远回不去。 */
const MIN_BASE = 19_000;
/** 游标式写法保留的区间宽度（见文件头「已知边界」）。 */
const CURSOR_RESERVED = 30;
/** 两个基数之间至少要隔开多少 —— 并行跑的两个文件不能挑同一段。 */
const MIN_GAP = 30;

/** 仓库根：从本文件所在的 dist 位置往上找 `pnpm-workspace.yaml`。 */
function repoRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      statSync(join(d, 'pnpm-workspace.yaml'));
      return d;
    } catch {
      d = resolve(d, '..');
    }
  }
  throw new Error('找不到仓库根（pnpm-workspace.yaml）');
}

const REPO = repoRoot();
const SELF = 'apps/daemon/src/testPorts.test.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

interface Band {
  where: string;
  base: number;
  /** 已知上界；游标式写法用保留宽度 */
  hi: number;
  form: string;
}

const bands: Band[] = [];
const unparsed: string[] = [];

const num = (s: string): number => Number(s.replace(/_/g, ''));

for (const file of walk(join(REPO, 'apps', 'daemon', 'src'))) {
  /*
   * ★ T-147：路径要归一成 `/` 才能和 `SELF` 比 —— `relative()` 在 Windows 上给的是
   * `apps\daemon\src\…`，于是本文件排除不掉、会开始扫描自己。
   */
  const rel = relative(REPO, file).split(sep).join('/');
  if (rel === SELF) continue;
  const src = readFileSync(file, 'utf8');
  /*
   * ★ T-147：**按 `\r?\n` 切，不能只按 `\n`。**
   *
   * git 在 Windows 上默认 `core.autocrlf=true`，检出的源码是 CRLF。只按 `\n` 切，
   * 每行末尾会多一个 `\r`，而下面那条形态正则以 `(?:\/\/.*)?$` 收尾 ——
   * `.` 不匹配 `\r`、`$` 又要求到串尾，于是**带行尾注释的那几行整个归不了类**。
   *
   * `[CI 实测]` ci-crossplatform run 31039060738，win32/x64：
   *   `restart-datadir.test.ts` 的三行 `const port = 19_7x0 + …; // 同上`
   *   全部落进 `unparsed`，`bands` 随之少 3 个、跌破前提自检的下限。
   *
   * 这条**不是** Windows 专属的怪癖：任何人在 CRLF 检出的仓库里跑它都会红。
   * 而它坏的方式恰好是本文件文件头警告过的那种 ——「遇到没见过的写法就跳过」的反面：
   * 这次是把见过的写法也认不出来了，好在它设计成了**认不出就红**。
   */
  const lines = src.split(/\r?\n/);

  // 本文件里 `maxPort: port + N` 的最大 N（算得出宽度的那种写法要用）
  let maxExtra = 0;
  for (const m of src.matchAll(/maxPort:\s*port\d*\s*\+\s*([0-9_]+)/g)) {
    maxExtra = Math.max(maxExtra, num(m[1] as string));
  }

  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    const decl = /^\s*(?:const|let)\s+(port|portCursor)\s*=\s*(.+?);?\s*(?:\/\/.*)?$/.exec(line);
    if (!decl) return;
    const rhs = (decl[2] ?? '').trim();

    // ── 形态 A：游标 `let portCursor = 19340;`
    const cursor = /^([0-9][0-9_]*)$/.exec(rhs);
    if (decl[1] === 'portCursor' && cursor) {
      const base = num(cursor[1] as string);
      bands.push({ where: at, base, hi: base + CURSOR_RESERVED - 1, form: 'cursor' });
      return;
    }
    // ── 形态 B：随机 `const port = 19_940 + Math.floor(Math.random() * 40);`
    const rand = /^([0-9][0-9_]*)\s*\+\s*Math\.floor\(Math\.random\(\)\s*\*\s*([0-9_]+)\)$/.exec(rhs);
    if (rand) {
      const base = num(rand[1] as string);
      const span = num(rand[2] as string);
      bands.push({ where: at, base, hi: base + span - 1 + maxExtra, form: 'random' });
      return;
    }
    // ── 形态 C：从游标取号 / 由 OS 分配 —— 都不引入新的区间
    if (/^nextPort\(\)$/.test(rhs)) return;
    if (/^portCursor\+\+$/.test(rhs)) return;
    if (/\(server\.address\(\)\s+as\s+/.test(rhs)) return; // OS 随机分配，不是固定段

    // ── 归不了类 → 当场红，把原文打出来（见文件头：这条测试不许变瞎）
    unparsed.push(`${at}  ${line.trim()}`);
  });
}

/** 参考服务器的默认端口 —— 它是长驻服务，撞上 17650 会把用户 daemon 挤到 17651。 */
function referenceServerDefaultPort(): { where: string; port: number } {
  const rel = 'packages/downloader/scripts/reference-server.mjs';
  const src = readFileSync(join(REPO, rel), 'utf8');
  const m = /const PORT = Number\(argv\[argv\.indexOf\('--port'\) \+ 1\]\)\s*\|\|\s*([0-9_]+);/.exec(src);
  assert.notEqual(m, null, `${rel} 里的 PORT 默认值写法变了，本检查器已经看不懂它 —— 请更新这条`);
  return { where: rel, port: num((m as RegExpExecArray)[1] as string) };
}

describe('测试端口不许撞上用户的真实实例', () => {
  it('★ 扫描器必须认得每一处端口声明（认不出就红，不许静默跳过）', () => {
    assert.deepEqual(
      unparsed,
      [],
      '出现了本检查器没见过的端口写法。\n' +
        '这不一定是错的 —— 但**没被检查过**，而这条测试的全部价值就是"没有漏网的"。\n' +
        '请把新写法加进上面的形态表，或者改用已有写法：\n  ' +
        unparsed.join('\n  '),
    );
  });

  it('★ 每一个端口基数都必须 ≥ 19000（`maxPort` 只向上扫，所以永远回不到 17650）', () => {
    assert.equal(DEFAULT_PORT, 17_650, '前提变了：DEFAULT_PORT 不再是 17650，本条判据要重写');
    const low = bands.filter((b) => b.base < MIN_BASE);
    assert.deepEqual(
      low.map((b) => `${b.where} base=${b.base}`),
      [],
      `这些端口基数低于 ${MIN_BASE}，有可能扫到用户真实实例的 ${DEFAULT_PORT}`,
    );
  });

  it('★ 参考服务器的默认端口同样不许是 17650，也要 ≥ 19000', () => {
    const rs = referenceServerDefaultPort();
    assert.notEqual(
      rs.port,
      DEFAULT_PORT,
      `${rs.where} 的默认端口就是 DEFAULT_PORT —— 它是长驻服务，会把用户的 daemon 挤到 17651（麦克风授权按 origin 隔离，会失效）`,
    );
    assert.equal(rs.port >= MIN_BASE, true, `${rs.where} 默认端口 ${rs.port} 低于 ${MIN_BASE}`);
    // 也不许落进任何一个测试段
    const clash = bands.filter((b) => rs.port >= b.base && rs.port <= b.hi);
    assert.deepEqual(clash.map((b) => b.where), [], `参考服务器默认端口 ${rs.port} 落在测试段里`);
  });

  it('★ 各段之间不许挨太近 —— node:test 并行跑，两个文件挑同一段就会互抢', () => {
    /*
     * 这一条抓到过我自己：把 restart-datadir 挪进 19xxx 时，
     * `maxPort` 的跨度让每段宽 70，而我按 60 的间隔排基数 —— 三段互相压住，
     * 第三段还压到了 noteDetailContract 的 19860。**新造的护栏第一个抓到的是造它的人。**
     */
    const sorted = [...bands].sort((a, b) => a.base - b.base);
    const problems: string[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1] as Band;
      const cur = sorted[i] as Band;
      if (cur.base - prev.base < MIN_GAP) {
        problems.push(`${prev.where}(base=${prev.base}) 与 ${cur.where}(base=${cur.base}) 相距不足 ${MIN_GAP}`);
      }
      if (prev.form === 'random' && cur.base <= prev.hi) {
        problems.push(`${prev.where}[${prev.base}..${prev.hi}] 压住了 ${cur.where}(base=${cur.base})`);
      }
    }
    assert.deepEqual(
      problems,
      [],
      `端口段冲突：\n  ${problems.join('\n  ')}\n当前全部段：\n  ` +
        sorted.map((b) => `${b.base}..${b.hi}  ${b.form.padEnd(6)} ${b.where}`).join('\n  '),
    );
  });

  it('前提自检：确实扫到了东西（扫出 0 个段会让上面三条全部恒真）', () => {
    /*
     * 没有这一条的话，仓库结构一变（比如测试挪了目录），
     * `walk()` 扫出空集，上面每一条断言都变成"对空数组成立"——**全绿，且什么都没验**。
     * ⑤A-2 那一族的形状：空集永远是绿的。
     */
    assert.equal(bands.length >= 6, true, `只扫到 ${bands.length} 个端口段，比预期少 —— 扫描路径可能不对了`);
  });
});
