#!/usr/bin/env node
/**
 * ★ `scripts/ci/check-usefulness.mjs` 的正反向自检。
 *
 * 它要回答的是这一周反复出现的**四种守卫失效形态**：
 *
 * ① **空转** —— 拿**真的违例**喂它，必须红。
 *    这里用的不是我编的字符串，是 `a83be41`（v0.7.3）上那 5 个控件**逐字**的写法
 *    （下面的 `HISTORICAL_BAD`）。它们是 v0.7.1 / v0.7.3 已知边界里公开承认过的东西。
 *
 * ② **钉错** —— 不许把现存违例当成"正确形态"写进夹具。
 *    所以绿的那一半**不是我写的**，是从真仓库里**现读**修好之后的那几个文件
 *    （`ExportMenu` / `NoteActionsMenu` / `MindmapExportMenu` / `BackendPackCard` /
 *    `RetranscribeButton` / `TranscriptList`）。它们今天是对的，这道门必须对它们保持绿；
 *    谁把修改回退了，这条会当场红。
 *
 * ③ **量错东西** —— 不用替身。本文件 import 的是被测脚本**导出的那些函数本身**
 *    （`scanSource` / `scanActionPlaceholders` / `collect` / `boundaryLines`），
 *    没有在这里重写一份"等价"的扫描逻辑；夹具是**真的 .tsx 文件**，走的是
 *    同一条 TypeScript 解析路径，CLI 那几条腿直接 spawn 真 CLI 读它的 stdout。
 *
 * ④ **自指** —— 这道门印出来的那段「抓不到什么」，必须**每一轮都真的出现在
 *    CI 输出里**，绿的时候也出现。#103 那道门正是在这里栽的：它把一条 ⓘ 挂在
 *    "有欠账才打印"的条件上，而条件恰好永远不成立 ⇒ **一次都没打印过**。
 *    所以下面第 §4 组断言的是 **CLI 的 stdout**，不是"源码里有没有那个字符串"；
 *    并且带一条**变异腿**：把那句打印改回"有违例才打印"，断言必须当场红。
 *
 * 跑：`node scripts/ci/selftest-usefulness.mjs`（`pnpm test:ci-scripts` 会调）
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOUNDARY,
  boundaryLines,
  collect,
  FLOORS,
  scanActionPlaceholders,
  scanSource,
} from './check-usefulness.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCRIPT = resolve(REPO, 'scripts/ci/check-usefulness.mjs');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  ✔ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✘ ${name}`);
    console.log(`      ${e && e.message ? e.message : e}`);
    failures.push(name);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const rules = (findings, rule) => findings.filter((f) => f.rule === rule);
const scanReal = (rel) => scanSource(rel, readFileSync(resolve(REPO, rel), 'utf8'));

/* ══════════════════════════════════════════════════════════════════
   §1 空转：v0.7.3 上那 5 个控件的**原样**写法，一个都不许放过
   ══════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ 逐字来自 `a83be41`。**不要**把它们"整理"得更好看 ——
 * 这里要的就是当时那副样子：理由挂在 `title` 上，没有任何 aria-*。
 */
const HISTORICAL_BAD = {
  'ExportMenu.tsx（a83be41:53）': `
    export function X() {
      return (
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} disabled={!live}
          title={live ? undefined : t('notes.exportNeedsDaemon')}>
          <Download className="size-3.5" />
          {t('notes.export')}
        </Button>
      );
    }`,
  'NoteActionsMenu.tsx（a83be41:135）': `
    export function X() {
      return (
        <Button size="sm" variant="ghost" disabled={!live} aria-haspopup="menu" aria-expanded={open}
          title={live ? undefined : t('notes.exportNeedsDaemon')} data-testid="note-actions">
          <MoreHorizontal className="size-3.5" />
          <span className="sr-only">{t('notes.actions')}</span>
        </Button>
      );
    }`,
  'BackendPackCard.tsx 卸载（a83be41:287）': `
    export function X() {
      return (
        <Button size="sm" variant="ghost" disabled={isLoadBearing || bundledWithApp}
          title={isLoadBearing ? t('runtime.pack.loadBearingTitle') : bundledWithApp ? t('runtime.pack.bundledTitle') : undefined}
          onClick={() => onRemove(pack.id)} data-testid={\`backend-remove-\${pack.id}\`}>
          <Trash2 className="size-3.5" aria-hidden />
          {t('runtime.pack.uninstall')}
        </Button>
      );
    }`,
  'BackendPackCard.tsx 安装（a83be41:343）': `
    export function X() {
      return (
        <Button size="sm" variant="secondary" disabled={installing || !pack.applicable || pendingCi}
          title={pendingCi ? t('runtime.pack.pendingCiTitle') : !pack.applicable ? stripEmphasis(inapplicableText ?? '') : undefined}
          onClick={() => onInstall(pack.id)} data-testid={\`backend-install-\${pack.id}\`}>
          {t('runtime.pack.install')}
        </Button>
      );
    }`,
  'MindmapExportMenu.tsx（a83be41:123）': `
    export function X() {
      return (
        <span role="menuitem" aria-disabled="true" title={t('mindmap.exportNeedsDaemon')}
          className="block w-full cursor-not-allowed px-3 py-1.5 text-left text-xs text-ink-muted opacity-60">
          {t('mindmap.exportFormats.md')}
        </span>
      );
    }`,
};

console.log('§1 空转 —— 真的违例喂进去必须红');
for (const [name, src] of Object.entries(HISTORICAL_BAD)) {
  check(`${name} 判红`, () => {
    const { findings } = scanSource('fixture.tsx', src);
    assert(
      rules(findings, 'disabled-reason-unreachable').length === 1,
      `期望 1 条 disabled-reason-unreachable，实得 ${JSON.stringify(findings)}`,
    );
  });
}

check('转写稿面板那条空态（a83be41:108 原样）判红', () => {
  const { findings } = scanSource(
    'fixture.tsx',
    `
    export function TranscriptList({ segments }) {
      if (segments.length === 0) {
        return <p className="px-4 py-8 text-sm text-ink-muted">{t('detail.noTranscript')}</p>;
      }
      return <div />;
    }`,
  );
  assert(rules(findings, 'empty-branch-no-next-step').length === 1, JSON.stringify(findings));
});

/* ══════════════════════════════════════════════════════════════════
   §2 钉错：绿的那一半全部从**真仓库现读**，不是我写的样板
   ══════════════════════════════════════════════════════════════════ */
console.log('§2 钉错 —— 修好之后的真文件必须绿（谁回退，这里当场红）');
for (const rel of [
  'apps/web/src/features/notes/ExportMenu.tsx',
  'apps/web/src/features/notes/NoteActionsMenu.tsx',
  'apps/web/src/features/notes/RetranscribeButton.tsx',
  'apps/web/src/features/mindmap/MindmapExportMenu.tsx',
  'apps/web/src/features/runtime/components/BackendPackCard.tsx',
  'apps/web/src/features/transcript/TranscriptList.tsx',
]) {
  check(`${rel} 零违例`, () => {
    const { findings } = scanReal(rel);
    assert(findings.length === 0, JSON.stringify(findings, null, 1));
  });
}

check('反方向：瞬时禁用（title 说的是名字不是理由）不判红', () => {
  /* `disabled={installing}` + 一句无条件的 title —— 那是"我是谁"，不是"为什么灰"。 */
  const { findings } = scanSource(
    'fixture.tsx',
    `export function X() {
       return <Button disabled={installing} title={t('runtime.pack.updateTitle')}>{t('runtime.pack.update')}</Button>;
     }`,
  );
  assert(findings.length === 0, JSON.stringify(findings));
  /* 真仓库里的两个同形实例（MindmapView 的 undo/redo）也必须绿。 */
  const real = scanReal('apps/web/src/features/mindmap/MindmapView.tsx');
  assert(
    rules(real.findings, 'disabled-reason-unreachable').length === 0,
    JSON.stringify(real.findings),
  );
});

check('反方向：aria-describedby 的**条件**不算 id 引用', () => {
  /* `blocked ? ID : undefined` 里 `blocked` 是条件。把它当 id 去找会造出一条假红。 */
  const { describedBy } = scanSource(
    'fixture.tsx',
    `export function X() {
       return <Button disabled={blocked} aria-describedby={blocked ? RETRANSCRIBE_BLOCKED_ID : undefined} />;
     }`,
  );
  assert(describedBy.length === 1, JSON.stringify(describedBy));
  assert(describedBy[0].ref === 'RETRANSCRIBE_BLOCKED_ID', describedBy[0].ref);
});

check('反方向：正确形态的空态（自己就说了没什么可做的）不判红', () => {
  /* `runtime.noPacks` 那一档：一句话里带着"CPU 后端始终可用"。判红它比没有门更坏。 */
  const { findings } = scanSource(
    'fixture.tsx',
    `export function X({ packs }) {
       if (packs.length === 0) {
         return <div><p>{t('runtime.noPacks')}</p><p>{t('runtime.cpuAlwaysWorks')}</p></div>;
       }
       return <div />;
     }`,
  );
  assert(findings.length === 0, JSON.stringify(findings));
});

/* ══════════════════════════════════════════════════════════════════
   §3 判据本身：三条各自的红/绿
   ══════════════════════════════════════════════════════════════════ */
console.log('§3 三条判据各自的红与绿');

check('① 有 aria-describedby ⇒ 绿；指不到 id ⇒ 另一条红', () => {
  const good = scanSource(
    'fixture.tsx',
    `export function X() {
       return <>
         <div id={WHY_ID}>{t('why')}</div>
         <Button disabled={!live} title={live ? undefined : t('why')} aria-describedby={!live ? WHY_ID : undefined} />
       </>;
     }`,
  );
  assert(rules(good.findings, 'disabled-reason-unreachable').length === 0, '不该红');
  assert(good.ids.has('WHY_ID') && good.describedBy.length === 1, '应收集到 id 与引用');
});

check('② {{action}}：取自按钮自己的词条 ⇒ 绿；硬编码 ⇒ 红；不传 ⇒ 红', () => {
  const keys = new Set(['notes.cancelledHint', 'detail.retranscribe.open']);
  const ok = scanActionPlaceholders(
    ['notes.cancelledHint'],
    [
      {
        rel: 'a.tsx',
        text: `const x = t('notes.cancelledHint', { action: t('detail.retranscribe.open') });`,
      },
    ],
    keys,
  );
  assert(ok.length === 0, JSON.stringify(ok));

  const hard = scanActionPlaceholders(
    ['notes.cancelledHint'],
    [{ rel: 'a.tsx', text: `const x = t('notes.cancelledHint', { action: '重新转写' });` }],
    keys,
  );
  assert(rules(hard, 'action-placeholder-hardcoded').length === 1, JSON.stringify(hard));

  const none = scanActionPlaceholders(
    ['notes.cancelledHint'],
    [{ rel: 'a.tsx', text: `const x = t('notes.cancelledHint');` }],
    keys,
  );
  assert(rules(none, 'action-placeholder-missing').length === 1, JSON.stringify(none));

  const dangling = scanActionPlaceholders(
    ['notes.cancelledHint'],
    [{ rel: 'a.tsx', text: `const x = t('notes.cancelledHint', { action: t('nope.nope') });` }],
    keys,
  );
  assert(rules(dangling, 'action-placeholder-dangling').length === 1, JSON.stringify(dangling));

  const unused = scanActionPlaceholders(['notes.cancelledHint'], [], keys);
  assert(rules(unused, 'action-placeholder-unused').length === 1, JSON.stringify(unused));
});

check('③ EmptyState 必须给 hint 或 action', () => {
  const bad = scanSource('f.tsx', `export const A = () => <EmptyState title={t('x')} />;`);
  assert(
    rules(bad.findings, 'empty-state-no-next-step').length === 1,
    JSON.stringify(bad.findings),
  );
  const okHint = scanSource(
    'f.tsx',
    `export const A = () => <EmptyState title={t('x')} hint={t('y')} />;`,
  );
  assert(okHint.findings.length === 0, JSON.stringify(okHint.findings));
  const okAction = scanSource(
    'f.tsx',
    `export const A = () => <EmptyState title={t('x')} action={<Button />} />;`,
  );
  assert(okAction.findings.length === 0, JSON.stringify(okAction.findings));
});

check('③ 空分支里有动作 ⇒ 绿；只渲染数据（无文案）⇒ 不判', () => {
  const withAction = scanSource(
    'f.tsx',
    `export function A({ xs }) {
       if (xs.length === 0) return <div><p>{t('empty')}</p><Button onClick={go} /></div>;
       return <div />;
     }`,
  );
  assert(withAction.findings.length === 0, JSON.stringify(withAction.findings));
  /* `WordHighlight` 那一支回落到原文，不是"空态" —— 判它是误报。 */
  const dataFallback = scanSource(
    'f.tsx',
    `export function A({ words, fallbackText }) {
       if (!words || words.length === 0) return <span>{fallbackText}</span>;
       return <span />;
     }`,
  );
  assert(dataFallback.findings.length === 0, JSON.stringify(dataFallback.findings));
});

check('地板不是零，而且真仓库现在在地板之上', () => {
  for (const [k, v] of Object.entries(FLOORS)) assert(v > 0, `${k} 地板是 0 = 形同虚设`);
  const { stats, localeKeys } = collect(REPO);
  for (const [k, floor] of Object.entries(FLOORS)) {
    const got = k === 'localeKeys' ? localeKeys.size : stats[k];
    assert(got >= floor, `${k}=${got} < 地板 ${floor}`);
  }
});

/* ══════════════════════════════════════════════════════════════════
   §4 那段「抓不到什么」必须真的出现在 CI 输出里 —— 断言的是 stdout
   ══════════════════════════════════════════════════════════════════ */
console.log('§4 边界声明：断言 CLI 的 stdout，绿的那一轮也要有');

const FIXTURE_LOCALES = {
  green: {
    notes: { cancelledHint: '想继续，用「{{action}}」。' },
    detail: { retranscribe: { open: '重新转写' }, noTranscript: '尚无转写稿' },
    runtime: { why: '这个包是承重墙' },
  },
  red: {
    notes: { cancelledHint: '想继续，用「{{action}}」。' },
    detail: { retranscribe: { open: '重新转写' }, noTranscript: '尚无转写稿' },
    runtime: { why: '这个包是承重墙' },
  },
};

function makeFixtureRoot(kind) {
  const root = mkdtempSync(join(tmpdir(), `usefulness-${kind}-`));
  const src = join(root, 'apps/web/src');
  const loc = join(src, 'app/i18n/locales');
  mkdirSync(join(src, 'features'), { recursive: true });
  mkdirSync(loc, { recursive: true });
  const json = JSON.stringify(FIXTURE_LOCALES[kind], null, 2);
  writeFileSync(join(loc, 'zh-CN.json'), json);
  writeFileSync(join(loc, 'en.json'), json);
  const body =
    kind === 'red'
      ? HISTORICAL_BAD['ExportMenu.tsx（a83be41:53）']
      : `
    export const WHY_ID = 'why';
    export function X() {
      return <>
        <p id={WHY_ID}>{t('runtime.why')}</p>
        <Button disabled={!live} aria-describedby={!live ? WHY_ID : undefined}>{t('notes.export')}</Button>
      </>;
    }`;
  writeFileSync(
    join(src, 'features/Fixture.tsx'),
    `${body}\nexport const hint = t('notes.cancelledHint', { action: t('detail.retranscribe.open') });\n`,
  );
  return root;
}

function runCli(root) {
  const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** 边界声明里**每一句**都必须在 stdout 里出现。 */
function assertBoundaryPrinted(out, where) {
  for (const line of [`覆盖面 ${BOUNDARY.coverage}`, BOUNDARY.regressionOnly, BOUNDARY.evasion]) {
    assert(out.includes(line), `${where}：stdout 里缺「${line.slice(0, 40)}…」`);
  }
  for (const m of BOUNDARY.missed) {
    assert(out.includes(m), `${where}：stdout 里缺一条「抓不到」：${m.slice(0, 30)}…`);
  }
}

const greenRoot = makeFixtureRoot('green');
const redRoot = makeFixtureRoot('red');
try {
  check('夹具：干净的那份 exit 0，且边界声明照样打印', () => {
    const { code, out } = runCli(greenRoot);
    assert(code === 0, `期望 exit 0，实得 ${code}\n${out}`);
    assert(out.includes('本轮判红 0 处'), out);
    assertBoundaryPrinted(out, '绿的那一轮');
  });

  check('夹具：带违例的那份 exit 1，边界声明**同样**打印', () => {
    const { code, out } = runCli(redRoot);
    assert(code === 1, `期望 exit 1，实得 ${code}\n${out}`);
    assert(out.includes('disabled-reason-unreachable'), out);
    assertBoundaryPrinted(out, '红的那一轮');
  });

  check('变异腿：把边界声明改回「有违例才打印」，上面那条断言必须当场红', () => {
    const original = readFileSync(SCRIPT, 'utf8');
    const NEEDLE = '  for (const line of boundaryLines(findings.length)) console.log(line);';
    assert(
      original.includes(NEEDLE),
      '变异腿钉的那一行不见了 —— 它一旦改写，这条腿就在量一个不存在的东西',
    );
    const mutantDir = mkdtempSync(join(tmpdir(), 'usefulness-mutant-'));
    const mutant = join(mutantDir, 'check-usefulness.mjs');
    mkdirSync(dirname(mutant), { recursive: true });
    writeFileSync(
      mutant,
      original.replace(
        NEEDLE,
        '  if (findings.length > 0) for (const line of boundaryLines(findings.length)) console.log(line);',
      ),
    );
    const r = spawnSync(process.execPath, [mutant, greenRoot], { encoding: 'utf8' });
    const out = `${r.stdout}${r.stderr}`;
    let caught = false;
    try {
      assertBoundaryPrinted(out, '变异体');
    } catch {
      caught = true;
    }
    rmSync(mutantDir, { recursive: true, force: true });
    assert(caught, '把打印挂上条件之后，§4 那条断言居然还是绿的 —— 那条断言是空转的');
  });
} finally {
  rmSync(greenRoot, { recursive: true, force: true });
  rmSync(redRoot, { recursive: true, force: true });
}

check('边界声明本身没有被写空', () => {
  assert(BOUNDARY.missed.length === 4, `抓不到的那 4 条被改成了 ${BOUNDARY.missed.length} 条`);
  assert(BOUNDARY.caught.length === 2, `抓得到的那 2 条被改成了 ${BOUNDARY.caught.length} 条`);
  assert(/^\d+\/\d+$/.test(BOUNDARY.coverage), '覆盖面写成了一句不可核的话');
  assert(boundaryLines(0).join('\n').includes('绿灯**不能**读成'), '那句话被删了');
});

console.log('');
if (failures.length > 0) {
  console.log(`✘ ${failures.length} 条不过：`);
  for (const f of failures) console.log(`    ${f}`);
  process.exit(1);
}
console.log(`✔ ${passed} 条全过。`);
