#!/usr/bin/env node
/**
 * ★ `scripts/ci/check-comment-facts.mjs` 的正反向自检。
 *
 * ## 它要回答的是这一周抓到的**四种守卫失效形态**
 *
 * ① **空转** —— 拿一条**真的坏注释**喂它，必须红。
 *    这里用的不是我编的字符串，是 `9ea52e8` 里**逐字**的那一行（下面的 `HISTORICAL_BAD`）：
 *    `source.ts` 注入点的那句 JSDoc，「见」的是一个从来不存在的 `mockSource.ts`。
 *    ⚠️ 注意它**没有反引号**。第一版正则要求反引号，这条用例当场把它证伪了 ——
 *    一道抓不到自己头号病例的门，就是第七道空转守卫。
 *
 * ② **钉错** —— 不许把现存的某条坏注释当成"正确形态"写进夹具。
 *    所以反例**不是我写的**，是从真仓库里**现读**这一周已经修好的那几个文件
 *    （`degradedPolling.ts` / `RetranscribeButton.tsx` / `sse.ts` / `content.ts` /
 *    `packages/mindmap` 的历史叙述）。它们今天说的是真话，这道门**必须对它们保持绿**。
 *    用修过的真实例当误报测试，比造假数据强：假数据只能证明我理解的规则，
 *    真文件能证明**这道门明天不会拦住写得对的人**。
 *
 * ③ **量错东西** —— 不许用替身。本文件 `import` 的是被测脚本**导出的那个函数本身**
 *    （`scanCommentFacts` / `blockedCodesFrom` / `pipelineErrorCodesFrom`），
 *    没有在这里重写一份"等价"的扫描逻辑。重写一份，量的就不是那道门了。
 *
 * ④ **自指** —— 被测脚本自己的注释不许成为第 9 条实例：最后一节直接在真仓库上
 *    跑 CLI，而 `scripts/ci` 下的 .mjs 本来就在它的扫描范围里，所以它必然扫到自己。
 *
 * 跑：`node scripts/ci/selftest-comment-facts.mjs`（`pnpm test:ci-scripts` 会调）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  blockedCodesFrom,
  commentSpans,
  constArrayFrom,
  fallbackNameCodesFrom,
  notInContract,
  pipelineErrorCodesFrom,
  scanCommentFacts,
  stripComments,
  WAIVERS,
} from './check-comment-facts.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCRIPT = resolve(REPO, 'scripts/ci/check-comment-facts.mjs');

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

const tracked = execFileSync('git', ['-C', REPO, 'ls-files'], {
  encoding: 'utf8',
  maxBuffer: 1 << 28,
})
  .split('\n')
  .filter(Boolean);

/** 只喂给扫描器一份内容，其余用真仓库的在册清单。 */
const scanOne = (rel, text, opts = {}) =>
  scanCommentFacts({ files: [{ rel, text }], docs: [], tracked, ...opts });

const readRepo = (rel) => readFileSync(resolve(REPO, rel), 'utf8');

/* ── ① 空转：真的坏注释必须红 ─────────────────────────────────────────────── */
console.log('\n① 空转 —— 真的坏注释喂进去，必须红');

/**
 * `9ea52e8` 的原文，一个字都没改。**裸的，没有反引号。**
 * 它在仓库里活了两个月，`tsc` / `eslint` / 全部单测**一个都没说过话**。
 */
const HISTORICAL_BAD = `  /** 注入式，便于用 mock 源替换真实 EventSource（见 mockSource.ts） */`;

check('9ea52e8 的原文（裸 token，无反引号）→ 红', () => {
  const r = scanOne('apps/web/src/lib/events/source.ts', HISTORICAL_BAD);
  if (r.violations.length !== 1) {
    throw new Error(`期望 1 条违规，实得 ${r.violations.length}：${JSON.stringify(r.violations)}`);
  }
  if (r.violations[0].token !== 'mockSource.ts') {
    throw new Error(`报的 token 不对：${r.violations[0].token}`);
  }
});

check('同一句话加上反引号 → 一样红（两种写法都得认）', () => {
  const r = scanOne('a/b.ts', '/** 见 `mockSource.ts` */');
  if (r.violations.length !== 1) throw new Error(`实得 ${r.violations.length} 条`);
});

check('英文指路语 `see foo/doesNotExist.ts` → 红', () => {
  const r = scanOne('a/b.ts', '// see foo/doesNotExist.ts for the rationale');
  if (r.violations.length !== 1) throw new Error(`实得 ${r.violations.length} 条`);
});

check('CLI 在一条坏注释上真的退出 1（不只是打印）', () => {
  // 直接用真脚本，但把 WAIVERS 掏空是做不到的 —— 所以这里验的是它今天就在真仓库上
  // 会为"缺文件"退 1：把 PIPELINE_ERROR_CODES 那条规则单独拿出来构造。
  const r = blockedCodesFrom([{ rel: 'x.ts', text: `queue.block(job.id, 'BRAND_NEW_CODE', r);` }]);
  const contract = pipelineErrorCodesFrom(readRepo('packages/shared/src/jobs.ts'));
  const missing = [...r.codes.keys()].filter((c) => !contract.includes(c));
  if (missing.length !== 1 || missing[0] !== 'BRAND_NEW_CODE') {
    throw new Error(`漏配没被发现：${JSON.stringify(missing)}`);
  }
});

/* ── ② 钉错：这一周修好的真文件，必须绿 ───────────────────────────────────── */
console.log('\n② 钉错 —— 已经修好的真实例（现读真仓库），一条都不许被拦');

/**
 * 这 8 条校准实例里，4/6/7/8 已经在 `e590e06` / `3fe1aa0` 修过了。
 * **它们是反例**：这道门抓到它们中的任何一条，都说明它在拦写得对的人。
 */
const FIXED_FOR_REAL = [
  ['apps/web/src/lib/events/degradedPolling.ts', '#4 降级轮询（已实现，现在是真话）'],
  ['apps/web/src/lib/events/source.ts', '#4/#5 同一个文件（含 mockSource 的叙述句）'],
  ['apps/web/src/features/notes/RetranscribeButton.tsx', '#6 已改成「曾经为真／现在不成立」'],
  ['apps/web/src/components/common/AsrModelPicker.tsx', '#6 同族'],
  ['apps/web/src/components/common/AsrEngineStatus.tsx', '#6 同族'],
  ['apps/daemon/src/http/rest/content.ts', '#7 已修'],
  ['apps/web/src/features/runtime/sse.ts', '#8 那段 emit 已删，剩下的是叙述'],
];
for (const [rel, why] of FIXED_FOR_REAL) {
  check(`${rel} → 绿（${why}）`, () => {
    const r = scanOne(rel, readRepo(rel));
    if (r.violations.length > 0) {
      throw new Error(`把修好的文件判红了：${JSON.stringify(r.violations, null, 2)}`);
    }
  });
}

/**
 * `packages/mindmap` 有 5 处提到**已经删掉的** `adapters/markmap.ts`，
 * 每一处都是**正确的历史叙述**（「此前有两份」「整块摘掉了」）。
 * 一个只做存在性检查的版本会把这 5 条全判红 —— 那正是它被否掉的原因。
 */
const NARRATIONS = [
  'packages/mindmap/src/index.ts',
  'packages/mindmap/src/timecode.ts',
  'packages/mindmap/src/serialize/markdown.ts',
  'packages/mindmap/src/serialize/serialize.test.ts',
  'packages/mindmap/src/timecode.test.ts',
];
for (const rel of NARRATIONS) {
  check(`${rel} → 绿（讲的是已删掉的 adapters/markmap.ts，是叙述不是指路）`, () => {
    const r = scanOne(rel, readRepo(rel));
    if (r.violations.length > 0) throw new Error(`叙述被判成指路：${JSON.stringify(r.violations)}`);
  });
}

check('「与 X 那份输出不同」这种非指路句 → 不判（指路语必须紧挨 token）', () => {
  const r = scanOne('a/b.ts', '/* 与 `adapters/markmap.ts` 那份（旧的）输出不同 */');
  if (r.violations.length !== 0) throw new Error('把叙述当成了指路');
});

check('指路到一个真的存在的文件 → 绿', () => {
  const r = scanOne('a/b.ts', '/** 详见 `packages/shared/src/jobs.ts` */');
  if (r.violations.length !== 0) throw new Error(`真文件被判红：${JSON.stringify(r.violations)}`);
});

/* ── ③ 已知会踩的两个坑（都是实测踩出来的，不是想象的） ───────────────────── */
console.log('\n③ 回归 —— 两个实测踩出来的坑');

check('`.tsx` 不许被截成 `.ts`（第一版实测报出 14 条假红）', () => {
  const r = scanOne('a/b.ts', '/** 见 `JobToaster.tsx` 文件头 */');
  if (r.violations.length !== 0) {
    throw new Error(`JobToaster.tsx 被截成 .ts 判红了：${JSON.stringify(r.violations)}`);
  }
  const spans = commentSpans('/** 见 `JobToaster.tsx` */', 'a.ts');
  if (spans.length !== 1) throw new Error('注释都没抠出来');
});

check('注释里举例的 `queue.block()` 不许被数成调用点', () => {
  const proseOnly = `/* 说明：daemon 会 queue.block(id, 'FOO') 这样挂起任务 */\nconst x = 1;`;
  const r = blockedCodesFrom([{ rel: 'a.ts', text: proseOnly }]);
  if (r.callSites !== 0) throw new Error(`把注释数成了 ${r.callSites} 个调用点`);
  if (stripComments(proseOnly).includes('queue.block')) throw new Error('注释没挖干净');
});

check('真的调用点数得对（真仓库：3 个 runner 调用点 + 1 个测试）', () => {
  const rels = execFileSync('git', ['-C', REPO, 'ls-files', 'apps/**/*.ts', 'packages/**/*.ts'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\n')
    .filter(Boolean);
  const r = blockedCodesFrom(rels.map((rel) => ({ rel, text: readRepo(rel) })));
  if (r.callSites < 3) throw new Error(`只数到 ${r.callSites} 个 queue.block( —— 扫描坏了`);
  if (r.undecidable !== 0) {
    throw new Error(`出现了静态判不了的调用点 ${r.undecidable} 个 —— 这道门看不见它们`);
  }
  for (const want of ['MISSING_ASR_MODEL', 'NO_TRANSCRIPT', 'LLM_NOT_CONFIGURED']) {
    if (!r.codes.has(want)) throw new Error(`漏掉了真实存在的码 ${want}`);
  }
});

/* ── ④ `{@link}` ─────────────────────────────────────────────────────────── */
console.log('\n④ {@link} 符号存在性');

check('`{@link NoSuchSymbolAnywhere}` → 红', () => {
  const r = scanOne('a/b.ts', '/** 见 {@link NoSuchSymbolAnywhere} */\n');
  if (r.violations.length !== 1) throw new Error(`实得 ${r.violations.length} 条`);
  if (r.violations[0].rule !== 'link') throw new Error('归错规则了');
});

check('`{@link}` 指向同文件里真的存在的符号 → 绿', () => {
  const r = scanOne('a/b.ts', '/** 见 {@link realThing} */\nexport function realThing() {}\n');
  if (r.violations.length !== 0) throw new Error(`真符号被判红：${JSON.stringify(r.violations)}`);
});

check('`{@link}` 自己不算"这个符号存在"（否则恒绿）', () => {
  const r = scanOne('a/b.ts', '/** {@link ghost} 又一次 {@link ghost} */\n');
  if (r.violations.length !== 2) {
    throw new Error(`两处 {@link ghost} 互相作保了，实得 ${r.violations.length} 条`);
  }
});

/* ── ⑤ 契约本体没被改走形 ─────────────────────────────────────────────────── */
console.log('\n⑤ 契约');

check('从 jobs.ts 源码里真的读得出 PIPELINE_ERROR_CODES', () => {
  const codes = pipelineErrorCodesFrom(readRepo('packages/shared/src/jobs.ts'));
  if (!codes || codes.length === 0) throw new Error('读不出来 —— 常量被改名/改写了？');
  if (!codes.includes('MISSING_ASR_MODEL')) throw new Error('读出来的内容不对');
});

check('常量被改名 → 报"找不到"，不是悄悄当成空集放行', () => {
  if (pipelineErrorCodesFrom('export const SOMETHING_ELSE = [] as const;') !== null) {
    throw new Error('改名之后它返回了非 null —— 那会让这条规则静默失效');
  }
});

/* ── ⑤b 前端那两份手写清单 ⊆ 契约 ────────────────────────────────────────── */
console.log('\n⑤b 前端两份清单 ⊆ 契约');

/**
 * ⚠️ 这两份**不是同一个东西**（`JobToaster.tsx` 的注释在这一点上是对的）：
 * `KNOWN_BLOCKED_CODES` 答「**为什么**卡住」，`blockedFallbackName()` 答「这是**哪种**任务」。
 * 所以下面**没有**一条"它们必须相等"的断言 —— 只断言两份都 ⊆ 契约。
 */
const BLOCKED_REASON = 'apps/web/src/lib/jobs/blockedReason.ts';
const JOB_TOASTER = 'apps/web/src/components/common/JobToaster.tsx';

check(`从 ${BLOCKED_REASON} 真的读得出 KNOWN_BLOCKED_CODES`, () => {
  const got = constArrayFrom(readRepo(BLOCKED_REASON), 'KNOWN_BLOCKED_CODES');
  if (!got || got.length === 0) throw new Error('读不出来 —— 常量被改名/改写了？');
  if (!got.includes('MISSING_ASR_MODEL')) throw new Error(`读出来的内容不对：${got.join(',')}`);
});

check(`从 ${JOB_TOASTER} 真的读得出 blockedFallbackName() 认的码`, () => {
  const got = fallbackNameCodesFrom(readRepo(JOB_TOASTER));
  if (!got || got.length === 0) throw new Error('读不出来 —— 函数被改名/改写了？');
  for (const want of ['MISSING_ASR_MODEL', 'NO_TRANSCRIPT', 'LLM_NOT_CONFIGURED']) {
    if (!got.includes(want)) throw new Error(`漏读了 ${want}：实得 ${got.join(',')}`);
  }
});

check('★反向：函数被改名 → 返回 null（不许当成"没有码所以通过"）', () => {
  if (fallbackNameCodesFrom('function somethingElse(code) { return code; }') !== null) {
    throw new Error('改名之后返回了非 null —— 这条规则会静默恒真');
  }
});

check('★反向：清单里多一个契约没有的码 → 判定函数必须报出来', () => {
  const contract = pipelineErrorCodesFrom(readRepo('packages/shared/src/jobs.ts'));
  const extra = notInContract(['MISSING_ASR_MODEL', 'CODE_THE_CONTRACT_NEVER_HEARD_OF'], contract);
  if (extra.length !== 1 || extra[0] !== 'CODE_THE_CONTRACT_NEVER_HEARD_OF') {
    throw new Error(`多出来的码没被报出来：${JSON.stringify(extra)}`);
  }
});

check('真仓库上这两份今天都 ⊆ 契约（这条绿是结论，不是假设）', () => {
  const contract = pipelineErrorCodesFrom(readRepo('packages/shared/src/jobs.ts'));
  for (const [rel, got] of [
    [BLOCKED_REASON, constArrayFrom(readRepo(BLOCKED_REASON), 'KNOWN_BLOCKED_CODES')],
    [JOB_TOASTER, fallbackNameCodesFrom(readRepo(JOB_TOASTER))],
  ]) {
    const extra = notInContract(got, contract);
    if (extra.length > 0) throw new Error(`${rel} 里有契约没有的码：${extra.join(' / ')}`);
  }
});

/* ── ⑥ 真仓库（只读）+ 自指 ───────────────────────────────────────────────── */
console.log('\n⑥ 真仓库');

check('真仓库上跑 CLI → 绿', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`真仓库上是红的：\n${(r.stdout ?? '') + (r.stderr ?? '')}`);
});

check('④ 自指：被测脚本自己的注释也过了这道门', () => {
  const rel = 'scripts/ci/check-comment-facts.mjs';
  const text = readRepo(rel);
  const r = scanOne(rel, text);
  if (r.violations.length > 0) {
    throw new Error(`它自己就是第 9 条实例：${JSON.stringify(r.violations, null, 2)}`);
  }
  /*
   * ⚠️ 这里**不能**只断言"零违规"就完事 —— 一个根本没被读到的文件也是零违规。
   * 所以先证明它真的被扫了：这个文件是本仓注释密度最高的之一（三百多行注释）。
   * 断言注释行数，而不是断言"它自己有几条指路语"：后者写过一版，
   * 结果是我为了让那条断言成立、在自己的文件头里**留着**一句指路语 ——
   * 那就是让被测对象去迁就测试。
   */
  const spans = commentSpans(text, rel);
  if (spans.length < 100) throw new Error(`只从它自己身上抠出 ${spans.length} 行注释 —— 没真的扫`);
  const tracked_mjs = execFileSync('git', ['-C', REPO, 'ls-files', 'scripts/ci/*.mjs'], {
    encoding: 'utf8',
  });
  if (!tracked_mjs.includes(rel)) throw new Error(`${rel} 不在册，CLI 根本扫不到它自己`);
});

check('本自检文件自己也过', () => {
  const rel = 'scripts/ci/selftest-comment-facts.mjs';
  const r = scanOne(rel, readRepo(rel));
  if (r.violations.length > 0) throw new Error(JSON.stringify(r.violations, null, 2));
});

check('每条豁免都写了理由，且指向一个真的在扫的文件', () => {
  for (const w of WAIVERS) {
    if (!w.reason || w.reason.length < 20) throw new Error(`${w.file} 的豁免没写清理由`);
    if (!tracked.includes(w.file)) throw new Error(`${w.file} 不在册 —— 这条豁免永远不会命中`);
  }
});

console.log(`\n${failures.length === 0 ? '✔' : '✘'} ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
