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
  const v = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number];
}
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度，保留两位小数（与 D-05 §7.5 的记录口径一致，便于对照） */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
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
const DARK_MEDIA = findScope((k) => k.startsWith('@media') && k.includes('prefers-color-scheme: dark'));
const DARK_ATTR = findScope((k) => k.includes("[data-theme='dark']") && !k.startsWith('@media'));

/* ──────────────────────────── 断言 ──────────────────────────── */

const TEXT_MIN = 4.5; // WCAG 1.4.3 正文
const NON_TEXT_MIN = 3.0; // WCAG 1.4.11 图形与控件

const STATUSES = ['good', 'warning', 'serious', 'critical', 'info'] as const;

const report: string[] = [];
function expect(min: number, label: string, fg: string, bg: string): void {
  const v = contrastRatio(fg, bg);
  report.push(`${v >= min ? 'PASS' : 'FAIL'}  ${label.padEnd(48)} ${String(v).padStart(6)}:1  (需 ${min})`);
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
      expect(TEXT_MIN, `${mode} --status-${s}-ink on 自身 tint`, g(`--status-${s}-ink`), g(`--status-${s}-tint`));
    }
  });

  test(`${mode} · 非文字（边框/焦点环/块面）≥ ${NON_TEXT_MIN}:1`, () => {
    expect(NON_TEXT_MIN, `${mode} --ring`, g('--ring'), worst);
    expect(NON_TEXT_MIN, `${mode} --accent 块面`, g('--accent'), worst);
    for (const s of STATUSES) {
      expect(NON_TEXT_MIN, `${mode} --status-${s}-line`, g(`--status-${s}-line`), worst);
    }
  });
}

test('实心块（白字压在上面）明暗两档都要成立', () => {
  for (const s of ['good', 'critical'] as const) {
    const solid = resolve(LIGHT, `--status-${s}-solid`);
    expect(TEXT_MIN, `--status-${s}-solid 上的白字`, '#ffffff', '#' + solid.replace('#', ''));
    expect(NON_TEXT_MIN, `--status-${s}-solid 块面 vs 明档页底`, solid, resolve(LIGHT, '--surface-0'));
    expect(NON_TEXT_MIN, `--status-${s}-solid 块面 vs 暗档抬升面`, solid, resolve(DARK_ATTR, '--surface-2', LIGHT));
  }
});

test('打印实测表（诚实规则：数值必须能被复现，不能只写"已校验"）', () => {
  console.log(`\n[对比度实测] 来源 ${CSS_PATH}\n${report.join('\n')}\n`);
});
