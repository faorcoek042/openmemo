#!/usr/bin/env node
/**
 * ★ `scripts/check-locale-ratchet.mjs` 的正反向自检。
 *
 * 判据和这个目录里其它 selftest 一样：每一条"必须红"的性质都用一个具体输入证明
 * 它**真的会红**，不是读代码猜。每个用例在 `mkdtemp` 出来的**独立 git 仓**里跑
 * （PROTOCOL §10：反向验证不许在共享工作树里做）。
 *
 * 被测脚本用 `dirname(import.meta.url)/..` 推仓库根、并且只读 `git ls-tree HEAD`，
 * 所以沙箱里必须**真的 commit**，它才看得见。
 *
 * 跑：`node scripts/ci/selftest-locale-ratchet.mjs`（`pnpm test:ci-scripts` 会调）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const SCRIPT = join(REPO, 'scripts', 'check-locale-ratchet.mjs');
const LOCALES = 'apps/web/src/app/i18n/locales';

const TMP = mkdtempSync(join(tmpdir(), 'om-locale-ratchet-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

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

function commit(root, msg) {
  execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--no-gpg-sign', '-m', msg],
    { cwd: root },
  );
}

function run(root, args = []) {
  const r = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'check-locale-ratchet.mjs'), ...args],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  return { status: r.status, all: (r.stdout ?? '') + (r.stderr ?? '') };
}

/**
 * 造一个沙箱：两份 locale（默认完全对称、含探针 `search.title`），
 * 一个引用了若干 key 的源文件，一份空豁免名单。
 * `n` 是生成的 key 数，默认 750，稳稳高于被测脚本的 MIN_KEYS=700。
 */
function sandbox({ n = 750, extraEn = {}, extraZh = {}, refs = [] } = {}) {
  const root = mkdtempSync(join(TMP, 'repo-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, LOCALES), { recursive: true });
  mkdirSync(join(root, 'apps/web/src/features'), { recursive: true });
  cpSync(SCRIPT, join(root, 'scripts', 'check-locale-ratchet.mjs'));

  const body = { search: { title: 'x' }, gen: {} };
  for (let i = 0; i < n; i++) body.gen[`k${String(i).padStart(4, '0')}`] = 'v';
  const en = JSON.parse(JSON.stringify(body));
  const zh = JSON.parse(JSON.stringify(body));
  Object.assign(en, extraEn);
  Object.assign(zh, extraZh);

  writeLocale(root, 'en', en);
  writeLocale(root, 'zh-CN', zh);
  // ⚠️ 必须造出 >100 个 t() 引用：被测脚本有一条「从提交树里扫到的字面量 key
  //    少于 100 就判扫描坏了」的地板（空集返回绿的守卫比没有守卫更坏）。
  //    夹具里给足真实数量，才不会为了让夹具跑通而去把那条地板调松。
  const baseRefs = Array.from({ length: 120 }, (_, i) => `gen.k${String(i).padStart(4, '0')}`);
  const allRefs = [...baseRefs, ...refs];
  writeFileSync(
    join(root, 'apps/web/src/features/Page.tsx'),
    `export const P = () => <>{${allRefs.map((k) => `t('${k}')`).join('}{')}}</>;\n`,
  );
  writeAllow(root, { asymmetric: [], unreferenced: [] });

  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  commit(root, 'fixture');
  return root;
}

const writeLocale = (root, name, obj) =>
  writeFileSync(join(root, LOCALES, `${name}.json`), `${JSON.stringify(obj, null, 2)}\n`);
const writeAllow = (root, obj) =>
  writeFileSync(
    join(root, 'scripts', 'locale-allowlist.json'),
    `${JSON.stringify(obj, null, 2)}\n`,
  );
const readLocale = (root, name) =>
  JSON.parse(
    execFileSync('git', ['show', `HEAD:${LOCALES}/${name}.json`], { cwd: root, encoding: 'utf8' }),
  );
const commitAll = (root, msg) => {
  execFileSync('git', ['add', '-A'], { cwd: root });
  commit(root, msg);
};

/* ── ① 对照组 ───────────────────────────────────────────────────────────────── */
console.log('\n① 对照组');

check('两份 locale 完全对称 → 绿（否则下面所有反向用例都不可信）', () => {
  const r = run(sandbox());
  if (r.status !== 0) throw new Error(`期望 0，实得 ${r.status}\n${r.all}`);
  if (!/两份 key 集合一致/.test(r.all)) throw new Error(`绿的时候也要说清结论：\n${r.all}`);
});

check('源码引用的 key 都有翻译 → 绿', () => {
  const r = run(sandbox({ refs: ['search.title', 'gen.k0001'] }));
  if (r.status !== 0) throw new Error(`正常引用被判红：\n${r.all}`);
});

/* ── ② ★反向：不对称（整文件重写的实际形状） ──────────────────────────────── */
console.log('\n② ★反向：一份 locale 少了 key —— 这就是那次事故');

check('★反向：zh-CN 少一个 key → 红，点名文件 + key', () => {
  const root = sandbox({ extraEn: { search: { title: 'x', tokenizerDegraded: 'boom' } } });
  const r = run(root);
  if (r.status === 0) throw new Error(`一份缺 key 却是绿的：\n${r.all}`);
  if (!/search\.tokenizerDegraded/.test(r.all)) throw new Error(`没点名 key：\n${r.all}`);
  if (!/zh-CN\.json/.test(r.all)) throw new Error(`没点名是哪份文件：\n${r.all}`);
});

check('★反向：en 少一个 key（反方向）也要红', () => {
  const root = sandbox({ extraZh: { onlyZh: 'x' } });
  const r = run(root);
  if (r.status === 0) throw new Error(`en 缺 key 却是绿的：\n${r.all}`);
  if (!/onlyZh/.test(r.all)) throw new Error('没点名');
});

check('★反向：整文件被早版本覆盖（一次丢 5 个）→ 5 个都要点名', () => {
  const root = sandbox();
  const en = readLocale(root, 'en');
  for (let i = 0; i < 5; i++) en.gen[`newer${i}`] = 'v';
  writeLocale(root, 'en', en); // 只加到 en，模拟 zh 被旧版本覆盖
  commitAll(root, 'en gains 5, zh stale');
  const r = run(root);
  if (r.status === 0) throw new Error('绿了');
  for (let i = 0; i < 5; i++) if (!r.all.includes(`newer${i}`)) throw new Error(`漏点名 newer${i}`);
});

/* ── ③ ★反向：源码用到但 locale 没有（parity 的盲区） ──────────────────────── */
console.log('\n③ ★反向：两份同时缺 —— parity 看不见，这条要接住');

check('★反向：两份 locale 都没有、但源码 t() 了它 → 红', () => {
  const r = run(sandbox({ refs: ['gone.key'] }));
  if (r.status === 0) throw new Error(`界面上会直接显示 key 串，却放行了：\n${r.all}`);
  if (!/gone\.key/.test(r.all)) throw new Error('没点名');
  if (!/Page\.tsx/.test(r.all)) throw new Error(`没说在哪儿用的：\n${r.all}`);
});

check('复数 key 不许误报（t("x") 对应 x_one / x_other）', () => {
  // 这条钉的是我实测踩到的那个假阳性：`app.tasksBadge` 在 locale 里只有
  // `tasksBadge_one` / `tasksBadge_other`，不认后缀就会把它当成"缺翻译"。
  const plural = { badge: { n_one: 'one', n_other: 'many' } };
  const r = run(sandbox({ extraEn: plural, extraZh: plural, refs: ['badge.n'] }));
  if (r.status !== 0) throw new Error(`复数 key 被误判成缺翻译：\n${r.all}`);
});

check('名字里带点的 key 不许误报（tasks.lane 下有 net.download 这种）', () => {
  const dotted = { tasks: { lane: { 'net.download': 'v' } } };
  const r = run(sandbox({ extraEn: dotted, extraZh: dotted, refs: ['tasks.lane.net.download'] }));
  if (r.status !== 0) throw new Error(`带点 key 名被误判：\n${r.all}`);
});

/* ── ④ ★反向：截断 / 0 字节 / 坏 JSON（事故里的那个中间态） ──────────────── */
console.log('\n④ ★反向：文件被整块写坏');

check('★反向：locale 是 0 字节 → 红，且说的是"内容没了"不是格式问题', () => {
  const root = sandbox();
  writeFileSync(join(root, LOCALES, 'zh-CN.json'), '');
  commitAll(root, 'zero bytes');
  const r = run(root);
  if (r.status === 0) throw new Error('0 字节却是绿的');
  if (!/不是合法 JSON/.test(r.all)) throw new Error(`归因说错了：\n${r.all}`);
});

check('★反向：locale 被截断到很少的 key → 红，且说"被截断"不是"翻译变少了"', () => {
  const root = sandbox();
  writeLocale(root, 'zh-CN', { search: { title: 'x' } });
  commitAll(root, 'truncated');
  const r = run(root);
  if (r.status === 0) throw new Error('截断却是绿的');
  if (!/被截断/.test(r.all)) throw new Error(`归因说错了：\n${r.all}`);
});

check('★反向：扫不到 locale（目录空了）→ 红，说"扫描范围坏了"', () => {
  const root = sandbox();
  execFileSync('git', ['rm', '-q', '-f', `${LOCALES}/zh-CN.json`], { cwd: root });
  commit(root, 'drop one locale');
  const r = run(root);
  if (r.status === 0) throw new Error('只剩一份 locale 却是绿的');
  if (!/扫描范围坏了/.test(r.all)) throw new Error(`归因说错了：\n${r.all}`);
});

/* ── ⑤ 合法的不对称：写进名单 + 理由才放行 ────────────────────────────────── */
console.log('\n⑤ 豁免名单：合法的不对称仍然做得到');

check('写进 asymmetric 且有 reason → 绿', () => {
  const root = sandbox({ extraEn: { enOnly: 'x' } });
  writeAllow(root, {
    asymmetric: [{ file: `${LOCALES}/zh-CN.json`, key: 'enOnly', reason: '自检夹具：故意只给 en' }],
    unreferenced: [],
  });
  commitAll(root, 'allow');
  const r = run(root);
  if (r.status !== 0) throw new Error(`合法豁免被挡住了：\n${r.all}`);
});

check('★反向：写进 asymmetric 但**没写 reason** → 红', () => {
  const root = sandbox({ extraEn: { enOnly: 'x' } });
  writeAllow(root, {
    asymmetric: [{ file: `${LOCALES}/zh-CN.json`, key: 'enOnly' }],
    unreferenced: [],
  });
  commitAll(root, 'allow no reason');
  const r = run(root);
  if (r.status === 0) throw new Error(`没写理由的豁免被放行了：\n${r.all}`);
  if (!/reason/.test(r.all)) throw new Error('没说清缺的是 reason');
});

check('★反向：asymmetric 里的条目已经不对称了（过期）→ 红', () => {
  const root = sandbox();
  writeAllow(root, {
    asymmetric: [{ file: `${LOCALES}/zh-CN.json`, key: 'search.title', reason: '过期条目' }],
    unreferenced: [],
  });
  commitAll(root, 'stale allow');
  const r = run(root);
  if (r.status === 0) throw new Error(`过期豁免被放行了：\n${r.all}`);
  if (!/过期/.test(r.all)) throw new Error('没说是过期');
});

check('★反向：豁免名单读不到 → 红（不许当成"没名单所以放行"）', () => {
  const root = sandbox();
  execFileSync('git', ['rm', '-q', '-f', 'scripts/locale-allowlist.json'], { cwd: root });
  rmSync(join(root, 'scripts', 'locale-allowlist.json'), { force: true });
  commit(root, 'drop allowlist');
  const r = run(root);
  if (r.status === 0) throw new Error('名单没了却是绿的 —— 这就是一条被静默关掉的守卫');
});

check('unreferenced 豁免能压住静态扫描的误判', () => {
  const root = sandbox({ refs: ['dynamic.built.at.runtime'] });
  writeAllow(root, { asymmetric: [], unreferenced: ['dynamic.built.at.runtime'] });
  commitAll(root, 'allow dynamic');
  const r = run(root);
  if (r.status !== 0) throw new Error(`豁免没生效：\n${r.all}`);
});

/* ── ⑥ 真仓库（只读） ──────────────────────────────────────────────────────── */
console.log('\n⑥ 真仓库');

check('/root/memo 上跑真脚本 → 绿', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`真仓库上是红的：\n${(r.stdout ?? '') + (r.stderr ?? '')}`);
});

console.log(`\n${failures.length === 0 ? '✔' : '✘'} ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
