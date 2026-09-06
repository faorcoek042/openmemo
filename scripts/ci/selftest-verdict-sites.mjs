#!/usr/bin/env node
/**
 * selftest-verdict-sites.mjs —— 证明 `count-verdict-sites.mjs` 那道门**换来了鉴别力**。
 *
 * ## 它守的是什么
 *
 * `count-verdict-sites.mjs` 只可靠地做三件事（它自己文件头写着）：
 *   ① 把脚本分成 守卫 / 自检 / 仪表 / 判据库
 *   ② 说出它用的是哪一种写法
 *   ③ **让「一个守卫被数出 0」变成一件必须有人看的事**
 *
 * ③ 是全部价值所在 —— 而 ③ 恰恰是最容易悄悄坏掉的：**扫描器认不出写法时，
 * 它给出的也是 0**。一个把所有脚本都数成 0 的扫描器，和一个把所有脚本都数成
 * "没问题"的扫描器，在日志里长得一模一样。所以这里的每一格都在问同一个问题：
 *
 *   > **抽掉这一条识别，它会不会红？**
 *
 * ⚠️ 用**合成夹具**喂，不读真实脚本：真实脚本每天在变，拿它们当夹具的自检
 *    迟早会因为别人的改动而红 —— 那种红没有信息，只会训练人忽略这道门。
 */
import { strict as assert } from 'node:assert';
import { detect, scan } from './count-verdict-sites.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let n = 0;
const it = (name, fn) => {
  fn();
  n++;
  console.log(`  \x1b[32m✔\x1b[0m ${name}`);
};

console.log('\nA 组：六种写法都要认得出来（认不出 ⇒ 数成 0 ⇒ 门失效）');

it('① assert 抛出', () => {
  const r = detect(
    `import { strict as assert } from 'node:assert';\nassert.equal(a,b);\nassert.ok(c);`,
  );
  assert.equal(r.idiom, 'assert 抛出');
  assert.ok(r.sites >= 2);
});

it('② 显式助手 ok()', () => {
  const r = detect(`function ok(x){}\nok(1);ok(2);ok(3);\nprocess.exit(1);`);
  assert.match(r.idiom, /ok\(\)/);
  assert.ok(r.sites >= 3);
});

it('③ 布尔账本 rec()', () => {
  const r = detect(
    `const results=[];const rec=(id,s)=>results.push({id,s});\n` +
      `rec('C1','PASS');rec('C2','FAIL');rec('C3','PASS');\n` +
      `process.exit(results.filter(x=>x.s==='FAIL').length>0?1:0);`,
  );
  assert.match(r.idiom, /rec\(\)/);
  assert.ok(r.sites >= 3, `账本没被认出来：${JSON.stringify(r)}`);
});

it('④ 收集器 problems.push()', () => {
  const r = detect(
    `const problems=[];\nproblems.push('a');problems.push('b');problems.push('c');\n` +
      `if(problems.length>0){console.error('x');process.exit(1);}`,
  );
  assert.match(r.idiom, /收集器 problems/);
  assert.equal(r.sites, 3);
});

it('⑤ main() 返回退出码（probe-warmup-verify 那一种）', () => {
  const r = detect(
    `async function main(){ if(bad) return 1; if(worse) return 1; return 0; }\n` +
      `main().then((code)=>process.exit(code),(e)=>{process.exit(1);});`,
  );
  assert.equal(r.idiom, 'main() 返回退出码');
  assert.equal(r.sites, 2);
});

it('⑥ 聚合谓词（summarize-gate 那一种）', () => {
  const r = detect(`const allPass = a && b && c;\nprocess.exit(allPass ? 0 : 1);`);
  assert.match(r.idiom, /聚合谓词/);
  assert.equal(r.sites, 1);
});

console.log('\nB 组：仪表 / 自身出错 不许被当成判据');

it('★ 「脚本自身出错」那一发不算判据处（否则仪表会被误报成守卫）', () => {
  const r = detect(
    `async function main(){ console.log('量一量'); }\n` +
      `main().then(()=>process.exit(0),(e)=>{ say('✘ 脚本自身出错：'+e.stack); process.exit(1); });`,
  );
  assert.equal(r.sites, 0, `仪表被认出了判据：${JSON.stringify(r)}`);
});

console.log('\nC 组：反向验证 —— 抽掉识别，这道门必须红');

/** 造一棵只有夹具的临时 scripts/ci，喂给 scan()。 */
function withFixtures(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'vsites-'));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LEDGER_GUARD =
  `const results=[];const rec=(id,s)=>results.push({id,s});\n` +
  `rec('C1','PASS');rec('C2','FAIL');\n` +
  `process.exit(results.filter(x=>x.s==='FAIL').length>0?1:0);\n`;

it('★★ 账本式守卫被认出来 ⇒ 不红', () => {
  const { problems } = withFixtures({ 'guard-ledger.mjs': LEDGER_GUARD }, (dir) =>
    scan({ dir, instruments: [] }),
  );
  assert.deepEqual(problems, [], `不该红却红了：${problems.join(' / ')}`);
});

it('★★ 消融：把账本写法从识别表里抽掉 ⇒ 同一个脚本当场红', () => {
  const { problems } = withFixtures({ 'guard-ledger.mjs': LEDGER_GUARD }, (dir) =>
    // helpers 里没有 rec/record ⇒ ③ 认不出；它也不是收集器/main/聚合谓词 ⇒ 落到 0
    scan({ dir, instruments: [], helpers: ['assert', 'must'] }),
  );
  assert.equal(problems.length, 1, `消融之后应当红一条，实际：${problems.length}`);
  assert.match(problems[0], /0 处判据/);
  // ⚠️ 红的**理由**也要对：它得说"要么写法不认识，要么扫描器坏了"，
  //    而不是让人以为那个被扫的脚本没有判据。判红和判红的理由是两件事。
  assert.match(problems[0], /扫描器坏了/);
});

it('★★ 仪表登记册长出真判据 ⇒ 红（一个被当成仪表的守卫，绿会被所有人忽略）', () => {
  const { problems } = withFixtures({ 'inst.mjs': LEDGER_GUARD }, (dir) =>
    scan({ dir, instruments: [{ script: 'scripts/ci/inst.mjs' }] }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /可能已经不是仪表了/);
});

it('★ 登记册指向一个不存在的文件 ⇒ 红', () => {
  const { problems } = withFixtures({ 'a.mjs': 'export const x=1;\n' }, (dir) =>
    scan({ dir, instruments: [{ script: 'scripts/ci/gone.mjs' }] }),
  );
  assert.ok(problems.some((p) => /不存在/.test(p)));
});

it('阴性对照：纯判据库（没有 exit/exitCode）不该被要求有判据', () => {
  const { problems } = withFixtures({ 'lib.mjs': 'export function f(){ return 1; }\n' }, (dir) =>
    scan({ dir, instruments: [] }),
  );
  assert.deepEqual(problems, []);
});

console.log(`\n\x1b[32m✔ selftest-verdict-sites: ${n} 条全过\x1b[0m`);
