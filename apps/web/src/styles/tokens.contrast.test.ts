/**
 * 设计令牌的对比度校验（T-114）。
 *
 * ── 为什么这是测试而不是一次性脚本 ──
 *
 * 这套颜色**曾经被校验过一次然后悄悄失效**：D-05 §7.2 记录的实测值
 * （warning 1.79:1 / serious 2.57:1）是按**图表记号**的 3:1 线核的，
 * 结论是"配图标+文字即可"。可后来这些色被 54 处拿去当**文字色**用，
 * 文字线是 4.5:1 —— 前提换了，结论没跟着换，而且**没有任何东西会报错**。
 *
 * 所以判据必须钉在 CI 里，而且必须**从 tokens.css 现场解析**而不是抄一份常量：
 * 抄一份就等于允许两边分叉，那正是上一轮出问题的方式。
 *
 * 跑法：`pnpm --filter @openmemo/web test:unit`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/* ────────────────────────── WCAG 2.x 对比度 ────────────────────────── */

function parseHex(h: string): [number, number, number] {
  const s = h.trim().replace('#', '');
  const v =
    s.length === 3
      ? s
          .split('')
          .map((c) => c + c)
          .join('')
      : s;
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number];
}
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const toHex = (v: [number, number, number]): string =>
  '#' +
  v
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, c)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

/**
 * 把 `rgb(R G B / P%)` 形式的半透明填充**合成**到某个不透明表层上。
 *
 * 为什么必须合成而不是直接比较：`--fill-hover` 是半透明的，它本身没有对比度可言 ——
 * 用户看到的是「叠加之后的那个颜色」。T-124 之前 hover 用的是不透明的 `--surface-2`，
 * 于是这件事根本没人算过，结果明档 hover 实测只有 **1.02:1**（等于没有反馈）。
 */
function composite(fill: string, base: string): string {
  const m = /rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)%\s*\)/.exec(fill.trim());
  if (!m) throw new Error(`认不出的半透明写法：${fill}（本文件只支持 rgb(R G B / P%)）`);
  const a = Number(m[4]) / 100;
  const f = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255] as [
    number,
    number,
    number,
  ];
  const b = parseHex(base);
  return toHex(f.map((c, i) => c * a + b[i]! * (1 - a)) as [number, number, number]);
}

/** WCAG 对比度，保留两位小数（与 D-05 §7.5 的记录口径一致，便于对照） */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/* ─────────────────── 从 tokens.css 现场解析三个作用域 ─────────────────── */

type Scope = Record<string, string>;

function locateTokensCss(): string {
  const candidates = [
    join(process.cwd(), 'src/styles/tokens.css'),
    join(process.cwd(), 'apps/web/src/styles/tokens.css'),
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error(`找不到 tokens.css，试过：\n  ${candidates.join('\n  ')}`);
  return hit;
}

/**
 * 极简 CSS 扫描：只认 `选择器 { --名: 值; }`，够用且不引依赖。
 * 返回 `选择器链 -> 声明表`。
 */
function parseScopes(css: string): Map<string, Scope> {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map<string, Scope>();
  const stack: string[] = [];
  let buf = '';

  for (const ch of src) {
    if (ch === '{') {
      stack.push(buf.trim().replace(/\s+/g, ' '));
      buf = '';
    } else if (ch === '}') {
      flush();
      stack.pop();
      buf = '';
    } else if (ch === ';') {
      flush();
      buf = '';
    } else {
      buf += ch;
    }
  }
  return out;

  function flush(): void {
    const m = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/s.exec(buf);
    if (!m || stack.length === 0) return;
    const key = stack.join(' >> ');
    const scope = out.get(key) ?? {};
    scope[m[1]!] = m[2]!;
    out.set(key, scope);
  }
}

/** 展开 `var(--x)` 引用（本文件里最多一层，但写成循环以防以后加链） */
function resolve(scope: Scope, name: string, fallback?: Scope): string {
  let v = scope[name] ?? fallback?.[name];
  for (let i = 0; i < 8 && v?.startsWith('var('); i++) {
    const ref = /var\(\s*(--[\w-]+)\s*\)/.exec(v)?.[1];
    if (!ref) break;
    v = scope[ref] ?? fallback?.[ref];
  }
  if (!v) throw new Error(`令牌 ${name} 在作用域里解析不出来`);
  return v;
}

const CSS_PATH = locateTokensCss();
const SCOPES = parseScopes(readFileSync(CSS_PATH, 'utf8'));

const findScope = (pred: (k: string) => boolean): Scope => {
  const hit = [...SCOPES.entries()].find(([k]) => pred(k));
  if (!hit) throw new Error('tokens.css 里找不到期望的作用域');
  return hit[1];
};

const LIGHT = findScope((k) => k === ':root');
const DARK_MEDIA = findScope(
  (k) => k.startsWith('@media') && k.includes('prefers-color-scheme: dark'),
);
const DARK_ATTR = findScope((k) => k.includes("[data-theme='dark']") && !k.startsWith('@media'));

/* ──────────────────────────── 断言 ──────────────────────────── */

const TEXT_MIN = 4.5; // WCAG 1.4.3 正文
const NON_TEXT_MIN = 3.0; // WCAG 1.4.11 图形与控件
/**
 * 表层之间、以及淡底/交互填充与表层之间的**最小可分辨差**。
 *
 * ⚠️ 这条 **1.06 不是 WCAG 规定的**，标准里没有"两块背景要差多少"这一项 ——
 * 这是本仓库自己定的下限，来源是实测出来的两个反例：
 *   ① 明档 `--surface-1` ↔ `--surface-2` = **1.02:1**（hover 与选中态等于不存在）；
 *   ② 明档 `--status-warning-tint` 压在新页底上 = **1.00:1**（芯片的底完全消失）。
 * 取 1.06 是因为 GitHub Primer 的 hover 层级差在 1.06–1.10 之间，是"能看见但不吵"的量级。
 * 标为自定阈值，不要拿它去冒充无障碍标准。
 */
const SURFACE_MIN = 1.06;

const STATUSES = ['good', 'warning', 'serious', 'critical', 'info'] as const;

const report: string[] = [];
function expect(min: number, label: string, fg: string, bg: string): void {
  const v = contrastRatio(fg, bg);
  report.push(
    `${v >= min ? 'PASS' : 'FAIL'}  ${label.padEnd(48)} ${String(v).padStart(6)}:1  (需 ${min})`,
  );
  assert.ok(v >= min, `${label}: ${fg} on ${bg} = ${v}:1，低于 ${min}:1`);
}

test('暗色两个作用域必须逐字相同（重复声明最容易悄悄分叉）', () => {
  const keys = new Set([...Object.keys(DARK_MEDIA), ...Object.keys(DARK_ATTR)]);
  for (const k of keys) {
    assert.equal(
      DARK_MEDIA[k],
      DARK_ATTR[k],
      `${k} 在 @media(prefers-color-scheme:dark) 与 :root[data-theme='dark'] 里不一致：` +
        `${DARK_MEDIA[k]} vs ${DARK_ATTR[k]}。两处必须同时改（D-05 §7.5）。`,
    );
  }
});

for (const [mode, scope] of [
  ['明档', LIGHT],
  ['暗档', DARK_ATTR],
] as const) {
  const g = (n: string): string => resolve(scope, n, LIGHT);
  // 最不利表层：明档是最深的页底，暗档是最浅的抬升面
  const worst = mode === '明档' ? g('--surface-0') : g('--surface-2');

  test(`${mode} · 文字与图标 ≥ ${TEXT_MIN}:1`, () => {
    report.push(`\n──── ${mode}  最不利表层 ${worst} ····`);
    expect(TEXT_MIN, `${mode} --ink-primary`, g('--ink-primary'), worst);
    expect(TEXT_MIN, `${mode} --ink-secondary`, g('--ink-secondary'), worst);
    // 这条曾经不达标（明档 3.41:1）：--ink-muted 承载的是说明正文不是装饰
    expect(TEXT_MIN, `${mode} --ink-muted`, g('--ink-muted'), worst);
    expect(TEXT_MIN, `${mode} --accent-ink`, g('--accent-ink'), worst);
    // 主按钮文案 —— 全站点击最多的一行字，明档曾 4.42、暗档曾 3.64
    expect(TEXT_MIN, `${mode} --accent-fg on --accent（主按钮）`, g('--accent-fg'), g('--accent'));

    for (const s of STATUSES) {
      expect(TEXT_MIN, `${mode} --status-${s}-ink vs 表层`, g(`--status-${s}-ink`), worst);
      // 芯片里文字压在自己的淡底上，那才是它真正的背景
      expect(
        TEXT_MIN,
        `${mode} --status-${s}-ink on 自身 tint`,
        g(`--status-${s}-ink`),
        g(`--status-${s}-tint`),
      );
    }
  });

  test(`${mode} · 非文字（边框/焦点环/块面）≥ ${NON_TEXT_MIN}:1`, () => {
    expect(NON_TEXT_MIN, `${mode} --ring`, g('--ring'), worst);
    expect(NON_TEXT_MIN, `${mode} --accent 块面`, g('--accent'), worst);
    for (const s of STATUSES) {
      expect(NON_TEXT_MIN, `${mode} --status-${s}-line`, g(`--status-${s}-line`), worst);
    }
  });

  /*
   * ── T-124 新增的三组 ──
   *
   * 前三条断言都只盯"前景 vs 背景"。而 T-114 之后暴露出来的问题是另一类：
   * **两块背景之间没有差**（页底 vs 卡片 1.03、卡片 vs hover 1.02、芯片淡底 vs 页底 1.00）。
   * 这类缺陷不会让任何一条文字断言失败，却让"层级""hover""选中"三件事同时消失。
   */
  test(`${mode} · 表层与淡底的可分辨性 ≥ ${SURFACE_MIN}:1（自定阈值，非 WCAG）`, () => {
    expect(SURFACE_MIN, `${mode} 页底 vs 面`, g('--surface-0'), g('--surface-1'));
    for (const s of STATUSES) {
      expect(
        SURFACE_MIN,
        `${mode} --status-${s}-tint vs 最不利表层`,
        g(`--status-${s}-tint`),
        worst,
      );
    }
    expect(SURFACE_MIN, `${mode} --accent-tint vs 面`, g('--accent-tint'), g('--surface-1'));
    // 选中项：品牌文字压在品牌淡底上，这是它真正的背景
    expect(
      TEXT_MIN,
      `${mode} --accent-ink on --accent-tint`,
      g('--accent-ink'),
      g('--accent-tint'),
    );
    // 搜索命中高亮用的是 --accent-tint + --ink-primary
    expect(
      TEXT_MIN,
      `${mode} --ink-primary on --accent-tint`,
      g('--ink-primary'),
      g('--accent-tint'),
    );
  });

  test(`${mode} · hover / active 填充：既要看得见，又不能把文字压垮`, () => {
    for (const [layer, base] of [
      ['页底', g('--surface-0')],
      ['面', g('--surface-1')],
    ] as const) {
      const hover = composite(g('--fill-hover'), base);
      const active = composite(g('--fill-active'), base);
      expect(SURFACE_MIN, `${mode} ${layer} hover 合成 ${hover}`, hover, base);
      expect(SURFACE_MIN, `${mode} ${layer} active 合成 ${active}`, active, base);
      // hover 之后底色变了，压在上面的文字必须仍然达标 —— 这是 hover 态最常见的漏检
      expect(TEXT_MIN, `${mode} ${layer} hover 上的 --ink-secondary`, g('--ink-secondary'), hover);
      expect(TEXT_MIN, `${mode} ${layer} hover 上的 --ink-muted`, g('--ink-muted'), hover);
      expect(TEXT_MIN, `${mode} ${layer} active 上的 --ink-muted`, g('--ink-muted'), active);
    }
  });
}

test('实心块（白字压在上面）明暗两档都要成立', () => {
  for (const s of ['good', 'critical'] as const) {
    const solid = resolve(LIGHT, `--status-${s}-solid`);
    expect(TEXT_MIN, `--status-${s}-solid 上的白字`, '#ffffff', '#' + solid.replace('#', ''));
    expect(
      NON_TEXT_MIN,
      `--status-${s}-solid 块面 vs 明档页底`,
      solid,
      resolve(LIGHT, '--surface-0'),
    );
    expect(
      NON_TEXT_MIN,
      `--status-${s}-solid 块面 vs 暗档抬升面`,
      solid,
      resolve(DARK_ATTR, '--surface-2', LIGHT),
    );
  }
});

test('打印实测表（诚实规则：数值必须能被复现，不能只写"已校验"）', () => {
  console.log(`\n[对比度实测] 来源 ${CSS_PATH}\n${report.join('\n')}\n`);
});
