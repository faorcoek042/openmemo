/**
 * T-194 —— `BackendStatus` 的非法组合**在类型层就写不出来**。
 *
 * ## 它替换掉了什么
 *
 * 不变量 **`available: true` 蕴含 `probed: true`** 此前只有两处散文
 * （`hardware.ts` 的注释 + `openapi.yaml` 的 description），
 * 唯一在守它的是一条**运行时断言**：
 *
 * ```ts
 * // notProbedVsUnavailable.test.ts:245
 * if (b.available) assert.equal(b.probed, true);
 * ```
 *
 * 那条断言只覆盖**生产者产出的那些对象**。任何一处 mock、任何一份手写夹具、
 * 任何一个跨进程收进来的 JSON 都绕得过去 —— 而它们恰恰是最容易写错的地方。
 * **这就是"用断言代替不可表达"。**
 *
 * ## 这个文件怎么"测一件编不过的事"
 *
 * 用 `@ts-expect-error`：**它自己就是断言**。如果哪天那行非法代码又能编过了，
 * TypeScript 会报「Unused '@ts-expect-error' directive」——
 * 于是 `tsc -b`（已在门禁里）当场红。不需要额外的运行时框架，
 * 也不会出现"测试通过但类型已经松掉"这种错位。
 *
 * ## 四份形状副本，这里验其中**两份**（另外两份的缺口如实记在这里）
 *
 * 1. **TS interface** —— 本文件上半部分的 `@ts-expect-error`（由 `tsc -b` 兑现）；
 * 2. **zod schema** —— 下面的运行时用例；
 * 3. ⚠️ **`openapi.yaml` 没有被任何东西机器核对**（今天就没有，不是本轮弄丢的）。
 *    本轮把它改成了 `oneOf` + `discriminator`、两条分支的必填项与上面两份同口径，
 *    但**它漂了不会有任何东西出声**。给它写用例需要一个 YAML 解析器，
 *    而 `@openmemo/shared` 今天没有声明 `yaml` 依赖 —— 为了一条断言去动
 *    package.json + lockfile，在多路并行的树上代价大于收益。**记成缺口，不假装有网。**
 * 4. ⚠️ **`packages/downloader/scripts/reference-server.mjs`（手写 mock）同样没有覆盖** ——
 *    它在模块作用域里 `server.listen()`，测试 import 它就会起一个服务器，
 *    也没有任何测试去 spawn 它。那六条已在 2026-08-10 手工逐条核对（全部合法），
 *    文件里留了同样的提醒。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BackendStatus } from './hardware.js';
import { HardwareInfoSchema } from './schemas.js';

/* ────────────────────────── 类型层：非法组合编不过 ────────────────────────── */

const COMMON = { id: 'cuda', installed: true, version: null, deviceIndex: null } as const;

/** ✅ 合法：枚举到设备 ⇒ 必然探测过。 */
const legalAvailable: BackendStatus = { ...COMMON, available: true, probed: true };

/** ✅ 合法：不可用 + 真裁决（加载了、没设备）+ 一句理由。 */
const legalRealVerdict: BackendStatus = {
  ...COMMON,
  available: false,
  probed: true,
  unavailableReason: 'installed but enumerated no devices (driver missing or too old)',
  unavailableKind: 'enumerated_none',
};

/** ✅ 合法：不可用 + 零信息（这一轮根本没加载它）+ 一句**不谈驱动**的理由。 */
const legalNotProbed: BackendStatus = {
  ...COMMON,
  available: false,
  probed: false,
  unavailableReason: 'installed, but this detection run did not load it',
  unavailableKind: 'not_probed_this_run',
};

/**
 * ★★ 这一条就是 T-194 的全部目的：**「可用但没探测过」写不出来。**
 *
 * 它此前完全合法（两个各自独立的 boolean），要等 `notProbedVsUnavailable.test.ts`
 * 跑到才会红，而那条断言看不见 mock 与夹具。
 */
// @ts-expect-error available: true 时 probed 的类型就是 true，写 false 编不过
const illegalAvailableNotProbed: BackendStatus = { ...COMMON, available: true, probed: false };

/** ★ 说了"不可用"却不说为什么 —— 界面上就是那句光秃秃的「不可用」。 */
// @ts-expect-error available: false 分支里 unavailableReason 必填
const illegalNoReason: BackendStatus = { ...COMMON, available: false, probed: true };

/**
 * ★ 可用却挂着一句不可用理由 —— 自相矛盾的对象。
 *
 * ⚠️ `@ts-expect-error` 放在**声明这一行**，不是放在那个属性上：
 * 类型错误报在整个对象字面量的赋值处，放在属性行上会变成一条
 * 「Unused '@ts-expect-error' directive」——**守卫自己红，而它想守的那件事没被守住**。
 * 第一版就是这么写的，`tsc` 当场把它照出来了。
 */
// @ts-expect-error 可用的后端不许带不可用理由
const illegalAvailableWithReason: BackendStatus = {
  ...COMMON,
  available: true,
  probed: true,
  unavailableReason: '这句话不该存在',
};

/**
 * ★ T-196：说了"不可用"却给不出**机器可判**的成因。
 *
 * 只有那句英文自由文本的话，界面要分档就只能去正则匹配它 ——
 * 而「本平台不适用」和「还没装」必须分得开：后者是一条"去装吧"的指引，
 * 前者照着做就是去找一个不可能存在的包。本仓在匹配这类字符串上栽过两次。
 */
// @ts-expect-error available: false 分支里 unavailableKind 必填
const illegalNoKind: BackendStatus = {
  ...COMMON,
  available: false,
  probed: true,
  unavailableReason: 'installed but enumerated no devices (driver missing or too old)',
};

/**
 * ★ 可用却挂着"为什么不可用"的成因 —— 与挂着一句理由同样自相矛盾。
 *
 * ⚠️ 注意这里的 `@ts-expect-error` 位置**与上面那条相反**：上面
 * `illegalAvailableWithReason` 要放在**声明行**，而这一条 `tsc` 把错误报在
 * **属性那一行**（TS2322），放到声明行上就会变成一条
 * 「Unused '@ts-expect-error' directive」—— 守卫自己红，而它要守的那件事没被守住。
 *
 * **判据不是"按上一条的样子抄"，是"看 `tsc` 到底把错误报在哪一行"。**
 * 两条都是本文件跑一次 `tsc -b` 照出来的，不是推出来的。
 */
const illegalAvailableWithKind: BackendStatus = {
  ...COMMON,
  available: true,
  probed: true,
  // @ts-expect-error 可用的后端没有不可用成因
  unavailableKind: 'not_installed',
};

/* ──────────────────────── 运行时层：zod 也得拦住同样三条 ──────────────────── */

const HW = {
  schemaVersion: 1,
  detectedAt: '2026-08-10T00:00:00.000Z',
  os: { platform: 'linux', arch: 'x64', version: '6.1' },
  cpu: { brand: 'x', physicalCores: 4, logicalCores: 8, features: ['avx2'] },
  ram: { totalMB: 16000, availableMB: 8000 },
  unifiedMemory: false,
  gpus: [],
  selectedBackend: 'cpu',
  selectedGpuIndex: null,
  disks: [],
};

const withBackends = (backends: unknown[]): unknown => ({ ...HW, backends });

describe('BackendStatus 的非法组合在类型层不可表达（T-194）', () => {
  it('★ 类型层：三条非法组合都被 @ts-expect-error 钉住', () => {
    /*
     * 这个用例本身几乎不做运行时断言 —— **真正的断言是上面那三行 `@ts-expect-error`**：
     * 非法组合一旦重新变得合法，`tsc` 会报「Unused '@ts-expect-error' directive」，
     * 门禁里的 Typecheck 当场红。这里只是把它们引用一次，
     * 免得 `noUnusedLocals` 把它们删掉（那会把守卫悄悄拆掉）。
     */
    assert.equal(legalAvailable.available, true);
    assert.equal(legalRealVerdict.probed, true);
    assert.equal(legalNotProbed.probed, false);
    assert.equal(illegalAvailableNotProbed.id, 'cuda');
    assert.equal(illegalNoReason.id, 'cuda');
    assert.equal(illegalAvailableWithReason.id, 'cuda');
    assert.equal(illegalNoKind.id, 'cuda');
    assert.equal(illegalAvailableWithKind.id, 'cuda');
  });

  it('★ T-196 运行时层：zod 必须拒绝 available:false 而没有 unavailableKind', () => {
    const r = HardwareInfoSchema.safeParse(
      withBackends([
        { ...COMMON, available: false, probed: true, unavailableReason: 'installed but …' },
      ]),
    );
    assert.equal(
      r.success,
      false,
      '只有自由文本没有成因码 —— 界面要分档就只能去匹配那句英文，而那正是要消灭的做法',
    );
  });

  it('★ T-196 运行时层：不认识的成因码必须被拒（不是悄悄放行）', () => {
    const r = HardwareInfoSchema.safeParse(
      withBackends([
        {
          ...COMMON,
          available: false,
          probed: true,
          unavailableReason: 'x',
          unavailableKind: 'because_i_said_so',
        },
      ]),
    );
    assert.equal(r.success, false, '成因码是枚举，放行任意字符串等于没有这一格');
  });

  it('★ 运行时层：zod 必须拒绝 available:true + probed:false', () => {
    const r = HardwareInfoSchema.safeParse(
      withBackends([{ ...COMMON, available: true, probed: false }]),
    );
    assert.equal(
      r.success,
      false,
      '跨进程收进来的 JSON 仍然能带着这个组合进来 —— 类型只管本仓自己的代码',
    );
  });

  it('★ 运行时层：zod 必须拒绝 available:false 而没有 unavailableReason', () => {
    const r = HardwareInfoSchema.safeParse(
      withBackends([{ ...COMMON, available: false, probed: true }]),
    );
    assert.equal(r.success, false, '"不可用"却没有理由，界面只能显示一句光秃秃的「不可用」');
  });

  it('★ 阴性对照：合法的三种形状必须全部通过（否则只是把闸门焊死在 false 上）', () => {
    for (const b of [legalAvailable, legalRealVerdict, legalNotProbed]) {
      const r = HardwareInfoSchema.safeParse(withBackends([b]));
      assert.equal(
        r.success,
        true,
        `合法形状被拒了：${JSON.stringify(b)}\n${r.success ? '' : JSON.stringify(r.error.issues)}`,
      );
    }
  });

  it('★ 判别联合必须真的按 available 分叉（两条分支的必填项不同）', () => {
    // available:true 那条不要求 unavailableReason；available:false 那条要求。
    const ok = HardwareInfoSchema.safeParse(withBackends([legalAvailable]));
    const bad = HardwareInfoSchema.safeParse(
      withBackends([{ ...COMMON, available: false, probed: false }]),
    );
    assert.equal(ok.success, true);
    assert.equal(bad.success, false, '两条分支的必填项如果一样，那它就不是判别联合');
  });
});
