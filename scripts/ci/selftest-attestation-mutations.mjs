#!/usr/bin/env node
/**
 * 凭证里 `mutations` 三态的**证明** —— 秒级，不要网络、不要包。
 *
 * ## 它守的那条性质
 *
 * > **`ran` 必须真的意味着「每一条变异都有结论」。**
 *
 * v0.7.3 已知边界第 13 条：那一格此前只有 `ran|skipped`，而
 * `e2e-runtime-audit.mjs --mutate` 的退出码 `3 = 跑起来了但什么都没证明`**不判红**
 * ⇒ 它被记成 `ran`。`e2e-runtime` 的 darwin 格从 2026-08-10 起**每一轮**都是这样
 * （`M-driver-lie`：`libggml-metal.so` 随 macOS 核心包发 ⇒ `metal.probed` 恒为 true
 * ⇒ 前提在**任何一台 Mac** 上都不存在），而凭证一直写着 `mutations: ran`。
 *
 * **一句把两种结局合起来说的话，会被读成前一种。** 这次它长在凭证上。
 *
 * ## ⚠️ 第三次同形的防线：**钉的是"闸门念了什么"，不是"文件里写了什么"**
 *
 * #103 那道门栽过这个跟头：字段写进了文件，却没有任何用例钉住它**出现在闸门的
 * 输出里**，于是"念出来"悄悄没了也没人知道。所以下面第 ③ 节断言的是
 * `coverageAdvisories()` / `coverageText()` 的**返回字符串**，
 * 以及 `emit-e2e-attestation.mjs` 真跑一次之后的 **stdout**。
 *
 * 用法：`node scripts/ci/selftest-attestation-mutations.mjs`（已挂进 `pnpm test:ci-scripts`）
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import {
  STRICT_RAN_SCHEMA,
  coverageAdvisories,
  coverageText,
  mutationState,
} from './attestation-coverage.mjs';
import { collectUnverified } from './collect-unverified-mutations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

let cases = 0;
let failures = 0;
const say = (s = '') => console.log(s);
function expect(name, fn) {
  cases += 1;
  try {
    fn();
    say(`  ✔ ${name}`);
  } catch (e) {
    failures += 1;
    say(`  ✘ ${name}\n      ${String(e.message ?? e)}`);
  }
}

const cov = (o) => ({ ok: true, undecided: 0, mode: null, schemaVersion: 2, ...o });

say('── ① 归一：三态 + 老凭证 ────────────────────────────────────────────────');

expect('新凭证 ran ⇒ ran（每一条都有结论）', () => {
  assert.equal(mutationState(cov({ mutations: 'ran' })), 'ran');
});
expect('ran-unverified ⇒ ran-unverified', () => {
  assert.equal(
    mutationState(
      cov({ mutations: 'ran-unverified', unverifiedMutations: ['darwin-arm64:M-driver-lie'] }),
    ),
    'ran-unverified',
  );
});
expect('skipped ⇒ skipped', () => {
  assert.equal(mutationState(cov({ mutations: 'skipped' })), 'skipped');
});
expect('没上报 ⇒ none（与 skipped 是两句话）', () => {
  assert.equal(mutationState(cov({ mutations: null })), 'none');
});
expect('🔴 **老凭证（schemaVersion 1）的 ran ⇒ legacy-ran**，不许当成新语义的 ran', () => {
  assert.equal(mutationState({ ok: true, schemaVersion: 1, mutations: 'ran' }), 'legacy-ran');
  assert.equal(
    mutationState({ ok: true, mutations: 'ran' }),
    'legacy-ran',
    '缺 schemaVersion 也算老的',
  );
});
expect('读不懂的取值不许当成好消息', () => {
  assert.equal(mutationState(cov({ mutations: 'probably-fine' })), 'unknown');
});

say('');
say('── ② 闸门**每一轮都要念** —— 断言的是返回的字符串，不是文件内容 ──────────');

const leg = (mutations, extra = {}) => ({ leg: 'runtime', cov: cov({ mutations, ...extra }) });

expect('ran-unverified：必须念出来，且**必须说出是哪几条**', () => {
  const lines = coverageAdvisories([
    leg('ran-unverified', { unverifiedMutations: ['darwin-arm64:M-driver-lie'] }),
  ]);
  const hit = lines.find((l) => /ran-unverified/.test(l));
  assert.ok(hit, `没念 ran-unverified：${JSON.stringify(lines)}`);
  assert.match(hit, /1 条什么都没证明/);
  assert.match(hit, /darwin-arm64:M-driver-lie/, '只报了状态没报是哪条 —— 报警不给线索');
});
expect('legacy-ran：必须念出「旧语义、分不清」', () => {
  const lines = coverageAdvisories([
    {
      leg: 'runtime',
      cov: { ok: true, undecided: 0, mode: null, schemaVersion: 1, mutations: 'ran' },
    },
  ]);
  assert.ok(
    lines.some((l) => /旧语义/.test(l)),
    JSON.stringify(lines),
  );
});
expect('unknown 取值：必须念出来', () => {
  assert.ok(coverageAdvisories([leg('xyz')]).some((l) => /读不懂/.test(l)));
});
expect('skipped 仍然念（老行为没丢）', () => {
  assert.ok(coverageAdvisories([leg('skipped')]).some((l) => /整轮没跑/.test(l)));
});
expect('🔴 全都有结论时**一个字都不多念**（挡"永远写 ran-unverified"那种恒吵）', () => {
  assert.deepEqual(coverageAdvisories([leg('ran')]), []);
});
expect('coverageText 里那一小段也分得开三态', () => {
  assert.match(coverageText(cov({ mutations: 'ran' })), /变异=ran〕|变异=ran /);
  assert.match(
    coverageText(cov({ mutations: 'ran-unverified', unverifiedMutations: ['a', 'b'] })),
    /ran-unverified（2 条什么都没证明）/,
  );
  assert.match(coverageText({ ok: true, undecided: 0, mode: null, mutations: 'ran' }), /旧语义/);
});

say('');
say('── ③ 汇总器：缺一格要往**响**的那边倒 ────────────────────────────────────');

expect('两格都有结论 ⇒ ran', () => {
  const r = collectUnverified(['linux-x64', 'darwin-arm64'], () => ({ ok: true, ids: [] }));
  assert.equal(r.state, 'ran');
  assert.deepEqual(r.ids, []);
});
expect('darwin 有一条没证明 ⇒ ran-unverified，且 id 带上平台', () => {
  const r = collectUnverified(['linux-x64', 'darwin-arm64'], (l) =>
    l === 'darwin-arm64' ? { ok: true, ids: ['M-driver-lie'] } : { ok: true, ids: [] },
  );
  assert.equal(r.state, 'ran-unverified');
  assert.deepEqual(r.ids, ['darwin-arm64:M-driver-lie']);
});
expect('🔴 有一格读不到 ⇒ **仍然 ran-unverified**（不知道 ≠ 都有结论）', () => {
  const r = collectUnverified(['linux-x64', 'darwin-arm64'], (l) =>
    l === 'darwin-arm64' ? { ok: false, why: '缺文件' } : { ok: true, ids: [] },
  );
  assert.equal(r.state, 'ran-unverified', '缺一格却说"每条都有结论" —— 那是把不知道写成正面断言');
  assert.ok(r.ids.some((x) => x.startsWith('darwin-arm64:')));
  assert.ok(r.notes.length > 0, '读不到必须留一句话，不许安静');
});

say('');
say('── ④ 真跑一次 emit：JSON **与 stdout** 都要对（#103 那道门栽在只看文件）──');

const scratch = mkdtempSync(join(tmpdir(), 'om-attest-selftest-'));
const runEmit = (args) =>
  spawnSync('node', [join(HERE, 'emit-e2e-attestation.mjs'), ...args], { encoding: 'utf8' });
const baseArgs = (out) => [
  '--leg',
  'runtime',
  '--bundle-run',
  '31568189189',
  '--platforms',
  'linux-x64,darwin-arm64',
  '--out',
  out,
];

expect('ran-unverified：JSON 有清单、schemaVersion=2、**stdout 念出是哪几条**', () => {
  const out = join(scratch, 'a.json');
  const r = runEmit([
    ...baseArgs(out),
    '--mutations',
    'ran-unverified',
    '--unverified-mutations',
    'darwin-arm64:M-driver-lie',
  ]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(j.schemaVersion, STRICT_RAN_SCHEMA);
  assert.equal(j.mutations, 'ran-unverified');
  assert.deepEqual(j.unverifiedMutations, ['darwin-arm64:M-driver-lie']);
  assert.match(r.stdout, /什么都没证明/, 'stdout 没念 —— 只写进文件等于没有');
  assert.match(r.stdout, /darwin-arm64:M-driver-lie/, 'stdout 没说是哪条');
});
expect('ran：清单为 null，且 stdout 不喊', () => {
  const out = join(scratch, 'b.json');
  const r = runEmit([...baseArgs(out), '--mutations', 'ran']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(j.mutations, 'ran');
  assert.equal(j.unverifiedMutations, null);
  assert.ok(!/什么都没证明/.test(r.stdout));
});
expect('🔴 ran-unverified 但不给清单 ⇒ **当场炸**（报警不给线索）', () => {
  const r = runEmit([...baseArgs(join(scratch, 'c.json')), '--mutations', 'ran-unverified']);
  assert.notEqual(r.status, 0, '居然发出去了');
  assert.match(r.stderr, /必须同时给 --unverified-mutations/);
});
expect('🔴 给了清单却写 ran ⇒ **当场炸**（凭证自带反例）', () => {
  const r = runEmit([
    ...baseArgs(join(scratch, 'd.json')),
    '--mutations',
    'ran',
    '--unverified-mutations',
    'darwin-arm64:M-driver-lie',
  ]);
  assert.notEqual(r.status, 0, '居然发出去了');
  assert.match(r.stderr, /自相矛盾/);
});
expect('乱七八糟的取值仍然炸', () => {
  const r = runEmit([...baseArgs(join(scratch, 'e.json')), '--mutations', 'probably-fine']);
  assert.notEqual(r.status, 0);
});
rmSync(scratch, { recursive: true, force: true });

say('');
say('── ⑤ 接线：MUT_LABELS 必须与变异 matrix 一致（否则每轮虚报一条）────────────');

/*
 * ★ 每一条接了这条轴的腿：collect 步骤必须有 `id: mut`，且 emit 必须真的读它。
 *   少一个 `id:`，`steps.mut.outputs.*` 会**静默渲染成空串** ⇒ `--mutations ""`
 *   ⇒ emit die ⇒ 凭证发不出去。宁可在这里红，也别在发布当天红。
 */
const wfDir = join(REPO, '.github', 'workflows');
const wired = [];
for (const f of readdirSync(wfDir).filter((x) => x.endsWith('.yml'))) {
  const doc = parse(readFileSync(join(wfDir, f), 'utf8'));
  const steps = Object.values(doc?.jobs ?? {}).flatMap((j) => j?.steps ?? []);
  const collect = steps.find((x) => /collect-unverified-mutations\.mjs/.test(String(x.run ?? '')));
  if (!collect) continue;
  wired.push(f);
  const emit = steps.find((x) => /emit-e2e-attestation\.mjs/.test(String(x.run ?? '')));
  const sum = steps.find((x) => /sum-undecided\.mjs/.test(String(x.run ?? '')));
  expect(`${f}：collect 有 id、emit 真的读它、两个 flag 都在`, () => {
    assert.ok(collect.id, 'collect 步骤没有 id: —— 下游会静默拿到空串');
    assert.ok(emit, '没有 emit 步骤');
    const run = String(emit.run);
    const re = (k) => new RegExp(`\\$\\{\\{\\s*steps\\.${collect.id}\\.outputs\\.${k}\\s*\\}\\}`);
    assert.ok(re('mutations_state').test(run), 'emit 没读 mutations_state');
    assert.ok(re('unverified_flag').test(run), 'emit 没读 unverified_flag');
    assert.ok(
      !/--unverified-mutations\s+"[^$]/.test(run),
      '把清单写死了 —— 那个数永远不会跟着实际情况变',
    );
  });
  if (sum) {
    /*
     * ★ browser / notes 的 collect 与 sum **读的是同一份文件**（复用覆盖面 artifact）。
     *   两处 `--file-template` 一旦分叉，collect 会永远找不到文件 ⇒ 每轮虚报
     *   `ran-unverified` ⇒ 恒吵。这里正面钉住它们一致。
     */
    expect(`${f}：collect 与 sum 读同一份文件（--file-template 必须逐字相同）`, () => {
      const t = (x) => String(x.run).match(/--file-template\s+'([^']+)'/)?.[1] ?? null;
      const dirOf = (x) => String(x.run).match(/--dir\s+(\S+)/)?.[1] ?? null;
      if (dirOf(collect) !== dirOf(sum)) return; // 各读各的目录，不适用
      assert.equal(t(collect), t(sum), '同一个目录、不同的模板 —— collect 会永远读不到');
    });
  }
}
expect(`扫到 ${wired.length} 条接了这条轴的腿（地板 3：runtime / browser / notes）`, () => {
  assert.ok(
    wired.length >= 3,
    `只扫到 ${wired.length} 条：${wired.join(', ')} —— 扫描本身坏了，或有腿掉线了`,
  );
});

expect('e2e-runtime.yml 的 MUT_LABELS ≡ mutations matrix 的标签', () => {
  const d = parse(readFileSync(join(REPO, '.github', 'workflows', 'e2e-runtime.yml'), 'utf8'));
  const labels = d.jobs.mutations.strategy.matrix.include.map((x) => String(x.label));
  const env = String(d.jobs.attest.env.MUT_LABELS ?? '');
  assert.equal(
    env,
    labels.join(','),
    `MUT_LABELS=${env} 与变异 matrix ${labels.join(',')} 对不上 —— ` +
      '多一格会每轮虚报一条未验证（恒吵），少一格会漏掉那一格的未验证（假绿）',
  );
  assert.ok(labels.length > 0, '变异 matrix 空了 —— 扫描本身坏了');
});
expect('MUT_LABELS 与 PLATFORMS **确实不同**（win32 不在变异矩阵里）', () => {
  const d = parse(readFileSync(join(REPO, '.github', 'workflows', 'e2e-runtime.yml'), 'utf8'));
  assert.notEqual(
    String(d.jobs.attest.env.MUT_LABELS),
    String(d.jobs.attest.env.PLATFORMS),
    '两者相同的话，说明有人把它们合成了一份 —— 那正是这条用例要挡的',
  );
});

say('');
say(`── ${cases} 条，失败 ${failures} 条 ──`);
if (failures > 0) {
  say('');
  say('✘ 凭证 mutations 三态**没有过关**。');
  process.exit(1);
}
say('✔ 凭证 mutations：ran 真的意味着「每条都有结论」，未验证的会被念出来且说得出是哪几条。');
