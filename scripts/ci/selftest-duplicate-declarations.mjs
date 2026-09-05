#!/usr/bin/env node
/**
 * ★ `scripts/ci/check-duplicate-declarations.mjs` 的正反向自检。
 *
 * 它回答的是这一周反复出现的**守卫失效六型**，一型一组：
 *
 * ① **空转** —— 拿**真的违例**喂它，必须报得出来。
 *    这里的违例**不是我编的**：是 `master`（收敛之前）上那四条**逐字**的写法
 *    （下面的 `BEFORE`）。判据就是那句「**把收敛退回去，它会红吗**」——
 *    退回去红、退回去之前不红，这道门才不是摆设。
 *
 * ② **钉错** —— 不许把现存违例当成"正确形态"写进夹具。
 *    绿的那一半**不是我写的**，是从真仓库里**现读**收敛之后的那几个文件
 *    （`packages/shared/src/audio.ts`、`packages/pipeline/src/asr/types.ts` …）。
 *    它们今天是对的，这道门必须对它们保持绿；谁把收敛回退了，§1 那组当场红。
 *
 * ③ **量错东西** —— 不用替身。本文件 import 的是被测脚本**导出的那些函数本身**
 *    （`collect` / `scanFile` / `isAliasOfImport`），没有在这里重写一份"等价"的检测逻辑；
 *    CLI 那几条腿直接 spawn 真 CLI 读它的 stdout / exit code。
 *
 * ④ **写成边界** —— §4 钉的是"**不惩罚正解**"：T-150 的别名法
 *    （`export type NoteStatus = NoteStatusContract;`）**不许**被报成重复。
 *    一道会误伤的门，两周内就会被所有人学会绕过去 —— 那比没有门更坏。
 *    夹具用的是真仓库里的 `apps/web/src/lib/api/types.ts`，不是我造的样本。
 *
 * ⑤ **注释型断言 / 陈旧结论** —— §5 钉那段「这道门判不了什么」**每一轮都真的打印**，
 *    绿的时候也打，而且带一条**变异腿**：把它改成"有欠账才打印"，自检必须当场红。
 *    #103 那道门正是栽在这里（条件恰好永远不成立 ⇒ 一次都没打印过）。
 *
 * ⑥ **陈旧的基线** —— §6 钉"基线只准变短"这一支真的会红（收敛掉一条却不删条目 → 红）。
 *    这条同时是**扫描器失明的报警器**：探针瞎了的表现正是"基线大面积过期"，
 *    而那看起来像好消息。
 *
 * ⑦ **①的另一个面** —— 前六节钉的是**判据**不空转，§7 钉的是 **CLI 主体真的被执行**。
 *    这两件事可以分开坏：入口守卫失配时不报错，而是 stdout 零行、**exit 0**、CI 记 ✔。
 *    实测就是这么坏的（win32 上整道门空转，见 §7 的文件内注）。
 *
 * 跑：`node scripts/ci/selftest-duplicate-declarations.mjs`（`pnpm test:ci-scripts` 会调）
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collect, isAliasOfImport, scanFile } from './check-duplicate-declarations.mjs';
import { stripCommentsOnly } from '../lib/ts-lexer.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCRIPT = resolve(REPO, 'scripts/ci/check-duplicate-declarations.mjs');

/**
 * 做一份**改过一处**的被测脚本副本，放进临时目录里 spawn。
 *
 * ⚠️ 副本必须把 `'../lib/ts-lexer.mjs'` 换成绝对路径 —— 否则它在 `/tmp/xxx/` 下
 * 解析成一个不存在的模块，进程当场崩，而崩出来的 stdout 恰好也**不含**我们要断言的那段字符串。
 * 也就是说：**"没打印"和"根本没跑起来"长得一模一样**，而前者正是变异腿想证明的东西。
 * `[实测]` 第一版就栽在这里，两条腿一起假绿。所以每次 spawn 都顺带断言"它真的跑起来了"。
 *
 * ⚠️⚠️ 而"换成绝对路径"必须走 `pathToFileURL().href`，**不许把裸路径塞进 import**。
 * 这是 T-145（`scripts/selfcheck.mjs`）那个坑的**同一族**：Windows 上 `D:\a\…` 会被
 * ESM loader 当成 URL scheme —— `ERR_UNSUPPORTED_ESM_URL_SCHEME … Received protocol 'd:'`，
 * 于是本文件里所有起副本的腿在 win32 上**一条都跑不起来**（首次三平台实跑 run 33998491941 抓到）。
 */
function mutatedCopy(dir, ...edits) {
  let src = readFileSync(SCRIPT, 'utf8').replace(
    "from '../lib/ts-lexer.mjs'",
    `from ${JSON.stringify(pathToFileURL(resolve(REPO, 'scripts/lib/ts-lexer.mjs')).href)}`,
  );
  for (const [from, to] of edits) {
    assert(
      src.includes(from),
      `变异锚点找不到了：${from.slice(0, 60)}… —— 这条腿量不到东西，先修它`,
    );
    src = src.replace(from, to);
  }
  const p = join(dir, 'check.mjs');
  writeFileSync(p, src);
  return p;
}

/** spawn 一个副本，并先证明它**真的跑起来了**（不是崩在 import 上）。 */
function runScript(p) {
  const r = spawnSync(process.execPath, [p], { cwd: REPO, encoding: 'utf8' });
  assert(
    /扫描 \d+ 个源文件/.test(r.stdout),
    `副本没跑起来（多半崩在 import 上）—— "没打印"和"没跑起来"长得一样，先排除后者。\nstderr: ${r.stderr.slice(0, 400)}`,
  );
  return r;
}

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

const keysOf = (r) => [
  ...r.dupNames.map((g) => g.key),
  ...r.dupValues.strset.map((g) => g.key),
  ...r.dupValues.bitset.map((g) => g.key),
];
const readReal = (rel) => readFileSync(join(REPO, rel), 'utf8');

/* ══════════════════════════════════════════════════════════════════
   §1 空转：`master`（收敛之前）那四条的**原样**写法，一条都不许放过
   ══════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ 逐字来自收敛之前的 `master`。**不要**把它们"整理"得更好看 ——
 * 这里要的就是当时那副样子。四条各钉一个不同的判据分支：
 *
 * | 条 | 钉的是 | 为什么这一条非要有 |
 * |---|---|---|
 * | `RECORD_SAMPLE_RATE` | D1 同名 | 跨进程协议常量，本轮**风险最高**的一条 |
 * | `SEGMENT_FLAG` | D2 位域、**不看键名** | 三份的四个位里三个名字不同，按键名比对会全盲 |
 * | `JobState` vs `JOB_STATES` | D2 字符串集、**不看变量名** | 抄的时候顺手改了名，D1 会全盲 |
 * | `LLM_PURPOSES` | D1 + D2 同时 | 两条判据互为后备，这一条证明它们真的都活着 |
 */
const BEFORE = {
  'apps/daemon/src/ws/recorder.ts': `
    /** 16 kHz 单声道 int16 —— 与 \`AsrStream.write()\` 的契约一致。 */
    export const RECORD_SAMPLE_RATE = 16_000;
  `,
  'apps/web/src/features/recorder/asrStream.ts': `
    /** 与 daemon 的 \`RECORD_SAMPLE_RATE\` 必须一致 —— 不一致会让识别结果整体错位。 */
    export const RECORD_SAMPLE_RATE = 16_000;
  `,
  'packages/shared/src/notes.ts': `
    /** Segment flags bitfield (D-02). */
    export const SEGMENT_FLAG = {
      HALLUCINATION: 1 << 0,
      LOW_CONFIDENCE: 1 << 1,
      CONFIRMED: 1 << 2,
      SILENCE: 1 << 3,
    } as const;
  `,
  'packages/pipeline/src/asr/types.ts': `
    /** Bit flags on \`transcript_segments.flags\` (D-02 §1.5). */
    export const SEGMENT_FLAG = {
      SUSPECT_REPETITION: 1 << 0,
      LOW_CONFIDENCE: 1 << 1,
      HUMAN_CONFIRMED: 1 << 2,
      SILENCE_OR_MUSIC: 1 << 3,
    } as const;
  `,
  'packages/shared/src/jobs.ts': `
    export const JOB_STATES = [
      'queued',
      'blocked',
      'leased',
      'running',
      'paused',
      'succeeded',
      'failed',
      'cancelled',
    ] as const;
    export type JobState = (typeof JOB_STATES)[number];
  `,
  'apps/daemon/src/jobs/queue.ts': `
    export type JobState =
      'queued' | 'blocked' | 'leased' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
  `,
  'packages/llm/src/types.ts': `
    export const LLM_PURPOSES = ['chat', 'summarize', 'translate'] as const;
    export type LlmPurpose = (typeof LLM_PURPOSES)[number];
  `,
  'packages/shared/src/llm.ts': `
    export const LLM_PURPOSES = ['chat', 'summarize', 'translate'] as const;
    export type LlmPurpose = (typeof LLM_PURPOSES)[number];
  `,
};

console.log('\n§1 空转：收敛之前的原样写法，必须报得出来');
{
  const found = keysOf(collect(new Map(Object.entries(BEFORE))));

  check('D1 同名：`RECORD_SAMPLE_RATE`（daemon ↔ web 的跨进程协议常量）', () => {
    assert(
      found.includes('name:RECORD_SAMPLE_RATE'),
      `没报出来。这是本轮风险最高的一条 —— 一边改了另一边不会红，音频静默错采样。报了：${found.join(', ')}`,
    );
  });

  check('D2 位域：`SEGMENT_FLAG` —— **四个位里三个名字不同**也必须抓到', () => {
    assert(
      found.includes('bitset:1|2|4|8'),
      '没报出来。这一档如果按键名比对就会全盲：三份的 `HALLUCINATION`↔`SUSPECT_REPETITION`、' +
        '`CONFIRMED`↔`HUMAN_CONFIRMED`、`SILENCE`↔`SILENCE_OR_MUSIC` 都不同名。',
    );
  });

  check('D2 字符串集：`JobState`（手抄联合）↔ `JOB_STATES`（派生）—— **异名**也必须抓到', () => {
    assert(
      found.includes('strset:blocked|cancelled|failed|leased|paused|queued|running|succeeded'),
      '没报出来。同名那条判据对这一对是瞎的（一个叫 `JobState`、一个叫 `JOB_STATES`），' +
        '正是靠 D2 兜住。',
    );
  });

  check('D1+D2：`LLM_PURPOSES` 两条判据都得响（互为后备）', () => {
    assert(found.includes('name:LLM_PURPOSES'), 'D1 没响');
    assert(found.includes('strset:chat|summarize|translate'), 'D2 没响');
  });

  check('CLI 端到端：把这些丢进一个空基线，必须 exit 1（不是只在库里报）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dupdecl-'));
    try {
      // 真 CLI 只读真仓库，所以这条腿验的是**基线对账那一段**：
      // 把基线换成空的 → 现存 26 组全成了"新的" → 必须红。
      const bl = join(dir, 'empty.json');
      writeFileSync(bl, '{"accepted":[]}\n');
      const r = runScript(
        mutatedCopy(dir, [
          "join(REPO, 'scripts', 'duplicate-declarations-baseline.json')",
          JSON.stringify(bl),
        ]),
      );
      assert(r.status === 1, `空基线下应当 exit 1，实际 ${r.status}`);
      assert(/新的\*\*跨包重复声明/.test(r.stderr), '没打出"新的跨包重复声明"那段');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/* ══════════════════════════════════════════════════════════════════
   §2 钉错：收敛之后的**真文件**必须不再被报
   ══════════════════════════════════════════════════════════════════ */

console.log('\n§2 钉错：收敛之后的真文件（现读，不是我写的样本）必须不再被报');
{
  const AFTER_FILES = [
    'packages/shared/src/audio.ts',
    'apps/daemon/src/ws/recorder.ts',
    'packages/pipeline/src/audio/ffmpeg.ts',
    'packages/pipeline/src/asr/sherpaOnnx.ts',
    'packages/shared/src/notes.ts',
    'packages/pipeline/src/asr/types.ts',
    'packages/shared/src/jobs.ts',
    'apps/daemon/src/jobs/queue.ts',
    'packages/shared/src/llm.ts',
    'packages/llm/src/types.ts',
    'packages/shared/src/breaker.ts',
    'packages/runtime/src/probe/runProbe.ts',
  ];
  const found = keysOf(collect(new Map(AFTER_FILES.map((f) => [f, readReal(f)]))));

  for (const [what, key] of [
    ['① `RECORD_SAMPLE_RATE` / `ASR_SAMPLE_RATE`', 'name:RECORD_SAMPLE_RATE'],
    ['② `SEGMENT_FLAG` 的位域', 'bitset:1|2|4|8'],
    ['② `SEGMENT_FLAG` 的名字', 'name:SEGMENT_FLAG'],
    ['③ `JobState`', 'strset:blocked|cancelled|failed|leased|paused|queued|running|succeeded'],
    ['③ `JobState` 的名字', 'name:JobState'],
    ['④ `LLM_PURPOSES`', 'name:LLM_PURPOSES'],
    ['④ `LLM_PURPOSES` 的值', 'strset:chat|summarize|translate'],
    ['⑤ `BreakerVerdict`', 'name:BreakerVerdict'],
    ['⑤ `BreakerVerdict` 的值', 'strset:closed|open|recover'],
  ]) {
    check(`${what} 已收敛，不该再被报`, () => {
      assert(!found.includes(key), `还在报 ${key} —— 有人把收敛回退了，或者再导出写错了`);
    });
  }

  check('★ 收敛之后**只剩一处真声明**（再导出不算一次声明）', () => {
    // 这一条钉的是「再导出没被误当成第二份声明」——
    // 否则 §2 全绿只是因为检测器把两边都漏了。
    const shared = scanFile(
      'packages/shared/src/notes.ts',
      readReal('packages/shared/src/notes.ts'),
    );
    const pipeline = scanFile(
      'packages/pipeline/src/asr/types.ts',
      readReal('packages/pipeline/src/asr/types.ts'),
    );
    assert(
      shared.decls.some((d) => d.name === 'SEGMENT_FLAG'),
      'shared 里扫不到 `SEGMENT_FLAG` 的声明 —— 探针瞎了，§2 的绿是假的',
    );
    assert(
      !pipeline.decls.some((d) => d.name === 'SEGMENT_FLAG'),
      'pipeline 的 `export { SEGMENT_FLAG } from …` 被当成了一次声明',
    );
  });
}

/* ══════════════════════════════════════════════════════════════════
   §3 量错东西：检测器认的是**代码**，不是注释和字符串
   ══════════════════════════════════════════════════════════════════ */

console.log('\n§3 量错东西：注释 / 字符串里的写法不许算数');
{
  check('注释里抄一份 `SEGMENT_FLAG` 不算一次声明', () => {
    const fake = `
      /*
       * export const SEGMENT_FLAG = { A: 1 << 0, B: 1 << 1, C: 1 << 2, D: 1 << 3 } as const;
       */
      export const SOMETHING_ELSE = 1;
    `;
    const r = scanFile('packages/x/src/a.ts', fake);
    assert(!r.decls.some((d) => d.name === 'SEGMENT_FLAG'), '把注释里的当成声明了');
  });

  check('字符串里的 `export const …` 不算一次声明', () => {
    const fake = `export const TEMPLATE = "export const LLM_PURPOSES = ['chat'] as const;";`;
    const r = scanFile('packages/x/src/a.ts', fake);
    assert(!r.decls.some((d) => d.name === 'LLM_PURPOSES'), '把字符串里的当成声明了');
  });

  check('用的是共用词法器（`stripCommentsOnly`），不是本文件里另写一份', () => {
    // ③「量错东西」：这一条钉的是**没有替身**。检测器和自检读的是同一个模块。
    assert(typeof stripCommentsOnly === 'function', 'scripts/lib/ts-lexer.mjs 的导出没了');
    assert(
      !/`\/\*\*`|function\s+scanSource/.test(readFileSync(SCRIPT, 'utf8')),
      '被测脚本里自己又抄了一份扫描器 —— 那正是这道门要抓的东西',
    );
  });

  check('测试文件里复述一遍契约**不算**重复（否则会逼人把断言写虚）', () => {
    const r = collect(
      new Map([
        ['packages/a/src/x.ts', `export const K = ['p','q'] as const;`],
        ['packages/b/src/x.test.ts', `export const K = ['p','q'] as const;`],
      ]),
    );
    assert(keysOf(r).length === 0, `测试文件被算进来了：${keysOf(r).join(', ')}`);
  });

  check('同一个包里的两份**不报**（这道门只管跨包）', () => {
    const r = collect(
      new Map([
        ['packages/a/src/x.ts', `export const K = ['p','q'] as const;`],
        ['packages/a/src/y.ts', `export const K = ['p','q'] as const;`],
      ]),
    );
    assert(keysOf(r).length === 0, `同包的被报了：${keysOf(r).join(', ')}`);
  });
}

/* ══════════════════════════════════════════════════════════════════
   §4 写成边界：**不许惩罚正解**（T-150 的别名法）
   ══════════════════════════════════════════════════════════════════ */

console.log('\n§4 不惩罚正解：T-150 的别名法不许被报成重复');
{
  check('真仓库里 `apps/web/src/lib/api/types.ts` 的 4 个别名一个都不许被报', () => {
    const found = keysOf(
      collect(
        new Map([
          ['apps/web/src/lib/api/types.ts', readReal('apps/web/src/lib/api/types.ts')],
          ['packages/shared/src/notes.ts', readReal('packages/shared/src/notes.ts')],
        ]),
      ),
    );
    for (const n of ['NoteStatus', 'NoteKind', 'NoteDetail', 'RetranscribeBlocked']) {
      assert(
        !found.includes(`name:${n}`),
        `把 T-150 的别名 \`${n}\` 报成了重复 —— 这道门会惩罚正解，两周内就没人信它了`,
      );
    }
  });

  check('别名判据钉的是"右手边来自 import"，不是文件名', () => {
    const src = stripCommentsOnly(
      `import type { Foo as FooContract } from '@openmemo/shared';\nexport type Foo = FooContract;\n`,
    );
    assert(
      isAliasOfImport(src, src.indexOf('export type Foo'), new Set(['FooContract'])),
      '认不出别名',
    );
    // 反向：右手边不是 import 来的 → 仍然算一次真声明
    const src2 = stripCommentsOnly(`type Local = string;\nexport type Foo = Local;\n`);
    assert(
      !isAliasOfImport(src2, src2.indexOf('export type Foo'), new Set(['FooContract'])),
      '把本地类型的别名也当成"已收敛"了 —— 那会漏检',
    );
  });
}

/* ══════════════════════════════════════════════════════════════════
   §5 自指：那段「这道门判不了什么」必须**每一轮都真的打印**
   ══════════════════════════════════════════════════════════════════ */

console.log('\n§5 自指：「判不了的两档」绿的时候也必须打印');
{
  const real = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf8' });

  check('真 CLI 今天是绿的（否则下面几条读到的不是"绿时的输出"）', () => {
    assert(real.status === 0, `CLI exit ${real.status}\n${real.stderr}`);
  });

  check('绿的时候 stdout 里仍然有「判不了」那一段', () => {
    assert(
      /判不了.*两档/.test(real.stdout),
      '绿的时候没打印那段 —— 那正是 #103 栽的地方：条件恰好永远不成立，一次都没打印过',
    );
  });

  check('那一段里必须点名 16_000 这条**判不了**的（不许只说抽象的"有欠账"）', () => {
    assert(/16_000|16000/.test(real.stdout), '没点名那条最高风险的漏检');
  });

  check('★ 变异腿：把那段打印改成"有欠账才打印"，这一组必须当场红', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dupdecl-mut-'));
    try {
      const r = runScript(
        mutatedCopy(dir, [
          '  console.log(\n    `\\nⓘ 这道门**判不了**的两档',
          '  if (dupValues.num.length > 99) console.log(\n    `\\nⓘ 这道门**判不了**的两档',
        ]),
      );
      assert(
        !/判不了.*两档/.test(r.stdout),
        '把打印改成条件式之后它还在打 —— 说明上面那条断言量的不是这段输出',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/* ══════════════════════════════════════════════════════════════════
   §6 陈旧基线：「只准变短」那一支真的会红
   ══════════════════════════════════════════════════════════════════ */

console.log('\n§6 基线只准变短（这同时是"扫描器失明"的报警器）');
{
  const dir = mkdtempSync(join(tmpdir(), 'dupdecl-stale-'));
  try {
    const bl = join(dir, 'stale.json');
    const realBaseline = JSON.parse(
      readFileSync(join(REPO, 'scripts/duplicate-declarations-baseline.json'), 'utf8'),
    );
    realBaseline.accepted.push({
      key: 'name:ThisWasConvergedYesterday',
      sites: ['packages/a/src/x.ts :: ThisWasConvergedYesterday'],
      note: '自检用',
    });
    writeFileSync(bl, JSON.stringify(realBaseline, null, 2));
    const r = runScript(
      mutatedCopy(dir, [
        "join(REPO, 'scripts', 'duplicate-declarations-baseline.json')",
        JSON.stringify(bl),
      ]),
    );

    check('基线里有过期条目 → exit 1', () => {
      assert(r.status === 1, `应当 exit 1，实际 ${r.status}`);
      assert(/已经过期/.test(r.stderr), '没打出"已经过期"那段');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  check('已知重复**又多一份** → exit 1（第 3 份比第 2 份更坏）', () => {
    const r = collect(
      new Map([
        ['packages/a/src/x.ts', `export const K = ['p','q'] as const;`],
        ['packages/b/src/x.ts', `export const K = ['p','q'] as const;`],
        ['packages/c/src/x.ts', `export const K = ['p','q'] as const;`],
      ]),
    );
    const g = r.dupNames.find((x) => x.key === 'name:K');
    assert(g && g.sites.length === 3, `三份应当汇成一组三个 site，实际 ${JSON.stringify(g)}`);
  });
}

/* ══════════════════════════════════════════════════════════════════
   §7 入口守卫：这道门**必须真的跑**，而不是静默 exit 0
   ══════════════════════════════════════════════════════════════════ */

/**
 * ★ 这一组是①「空转」的另一个面：前六节钉的是**判据**不空转，这一节钉的是
 * **CLI 主体真的被执行**。两者是可以分开坏的 —— 而且真的分开坏过。
 *
 * `check-duplicate-declarations.mjs` 的入口守卫原来是手拼 URL
 * （`import.meta.url === \`file://${process.argv[1]}\``）。失配时它不报错，
 * 而是 **CLI 主体一行不执行 → stdout 零行 → exit 0 → CI 记 ✔**。
 * 实测（run 33998491941，这两个脚本首次上三平台）：
 *
 *   · **win32**：整个 `check-duplicate-declarations.mjs` 是**空转的**，
 *     `[36/41]` 那一格在日志里一行输出都没有，却记了 ✔。
 *   · **darwin**：真仓库路径没有软链，所以真 CLI 是好的；但自检从
 *     `mkdtemp()` 起的副本落在 `/var/folders/…`，而 macOS 的 `/var` 是
 *     通往 `/private/var` 的软链 ⇒ `argv[1]` 与 realpath 过的 `import.meta.url`
 *     天生不同 ⇒ 副本也空转，**stderr 全空**（因为它根本没崩，只是什么都没做）。
 *
 * ⚠️ 所以这三条腿是**在 Linux 上就会红**的：判据不依赖跑在哪个平台，
 * 只依赖"入口路径与 realpath 后的路径不同"这件事 —— 软链和空格 Linux 上都造得出来。
 * **把 `isDirectRun()` 退回成手拼写法，①②两条当场红。**（这就是这组存在的判据。）
 */
console.log('\n§7 入口守卫：CLI 必须真的跑起来，不许静默 exit 0');
{
  /** 起一份副本、从 `entry` 这条路径去跑它，回答"CLI 主体到底执行了没有"。 */
  const runFrom = (entry, cwd = REPO) =>
    spawnSync(process.execPath, [entry], { cwd, encoding: 'utf8' });

  const ranMarker = /扫描 \d+ 个源文件/;

  check('① 路径里有空格 / 中文 / `#` → 守卫必须仍然认出"这是直接执行"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dupdecl-entry-'));
    try {
      // 手拼 `file://` + 路径在这三种字符上各自失配（URL 要百分号编码，路径不要）。
      const odd = join(dir, 'a b#c 笔记');
      mkdirSync(odd);
      const r = runFrom(mutatedCopy(odd));
      assert(
        ranMarker.test(r.stdout),
        '装在含空格 / 中文 / `#` 的目录下时，CLI 主体一行都没执行 —— ' +
          `而它**退出码是 ${r.status}**，CI 会把这个记成 ✔。\n` +
          `stdout(${r.stdout.length} 字节): ${r.stdout.slice(0, 200)}\n` +
          `stderr: ${r.stderr.slice(0, 300)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check('② 经由软链调用（= macOS 的 `/var → /private/var`）→ 必须再比一次 realpath', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dupdecl-link-'));
    try {
      const real = join(dir, 'real');
      mkdirSync(real);
      mutatedCopy(real);
      // 'junction' 让这条腿在 Windows 上**也**造得出来（普通目录软链要提权，junction 不要）。
      symlinkSync(real, join(dir, 'link'), 'junction');
      const r = runFrom(join(dir, 'link', 'check.mjs'));
      assert(
        ranMarker.test(r.stdout),
        '经由软链调用时 CLI 主体一行都没执行 —— 这正是 macOS 上那一下：' +
          `\`import.meta.url\` 是 realpath 过的，\`argv[1]\` 不是。退出码 ${r.status}，` +
          `stdout ${r.stdout.length} 字节、stderr ${r.stderr.length} 字节（**两边都空**才是这个坑的样子）。`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check('★ 反向：被 `import` 时**不许**自己跑起来（守卫不能改成永远为真）', () => {
    // ①②只钉"该跑的时候跑"。只有这一条能挡住"把守卫删了/写成 true"这种修法 ——
    // 那样 §1–§6 全绿，而这个模块会在每次被 import 时顺手扫一遍整个仓库。
    const dir = mkdtempSync(join(tmpdir(), 'dupdecl-import-'));
    try {
      const p = join(dir, 'importer.mjs');
      writeFileSync(
        p,
        `import ${JSON.stringify(pathToFileURL(SCRIPT).href)};\nconsole.log('IMPORTED-OK');\n`,
      );
      const r = runFrom(p);
      assert(/IMPORTED-OK/.test(r.stdout), `import 本身就失败了：${r.stderr.slice(0, 300)}`);
      assert(
        !ranMarker.test(r.stdout),
        '被 import 时 CLI 主体也跑了 —— 守卫等于没有（§1–§6 照样全绿，但它已经不设防了）',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/* ══════════════════════════════════════════════════════════════════ */

console.log(`\n${failures.length ? '✘' : '✔'} ${passed} 条通过，${failures.length} 条失败`);
if (failures.length) {
  for (const f of failures) console.log(`   ✘ ${f}`);
  process.exit(1);
}
