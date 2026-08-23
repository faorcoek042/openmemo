#!/usr/bin/env node
/**
 * `scripts/ci/check-elf-glibc.mjs` 的本机自检。
 *
 * ## 为什么用桩 objdump 而不是真二进制
 *
 * 拿本机 `/usr/bin/*` 当夹具是**不可复现的**：这台机器是 Debian 13（glibc 2.42），
 * CI 上是 ubuntu-22.04/24.04，同一个 `/usr/bin/true` 报出来的下限不一样。
 * 夹具跟着宿主漂，测试就会在别的机器上变成"什么都没断言"——
 * 本仓已经为这个形状付过账（D-11 §3.3：三条 assetPaths 用例在 Windows 上什么都没断言到）。
 *
 * 所以这里桩掉 `objdump`，喂**固定**的动态符号表：判据是解析与阈值逻辑，
 * 而那正是这个脚本自己唯一的逻辑。真二进制上的行为另有一条实测记在
 * `coordination/inbox/amd-vulkan.md`（本机 objdump 自己就需要 GLIBC_2.38，
 * 三个符号与 D-11 §8.2 记的那三个逐字相同）。
 *
 * **全程不联网、不读本机 `/usr/lib`**：夹具是这个文件里写死的字符串。
 *
 * ## 覆盖到哪儿
 *
 *   ①–⑤  glibc 那一格：正向 / 超标点名 / 空目录 / 数字比 / objdump 缺失
 *   ⑥–⑩  C++ 那一格（`GLIBCXX_` / `CXXABI_`，本轮新增）：默认上限压线 /
 *         只有 C++ 超标也要红 / **三段版本号 3.4.29 > 3.4.9** / CXXABI 独立成闸 /
 *         三族不许串味
 *
 * 桩表里的符号名**一个都不是编的** —— 每条上面都标了 `[实测]` 是从哪个真文件量到的。
 * 这条纪律的意义在 ⑦ 上最明显：`_ZNSt18condition_variable4waitE…` 确实只在
 * `GLIBCXX_3.4.30` 那一档存在，夹具因此是"一个真的会发生的未来"，而不是造出来的假设。
 *
 * 跑：`pnpm test:ci-scripts`
 */

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { narrowTo } from './platform-scope.mjs';

/*
 * ★ 只在 Linux 上跑（2026-08-23 收窄）。
 *
 * `[实测 run 32651393827 / 32656407764]` win32 上这条自检 21/34 红，
 * 每条的成因都是同一句 `objdump: … file format not recognized`：
 * 上面那段"桩掉 objdump"在 Windows 上**没有生效**，真 objdump 上场，
 * 对着本文件造的 Linux ELF 夹具当然读不懂。
 */
narrowTo(['linux'], {
  subject: 'scripts/ci/check-elf-glibc.mjs —— 读 ELF 动态符号表、判 glibc/GLIBCXX/CXXABI 下限',
  why:
    'ELF 与 glibc 是 Linux 的东西：这个检查器只被 build-backends 的 Linux 腿调用，' +
    '产出的判决只对 Linux 产物有意义。在 macOS/Windows 上跑它是范畴错误 —— ' +
    '那里的红说的是"桩没生效"，不是"判定逻辑坏了"。',
  lost:
    '解析与阈值那段逻辑本身是平台无关的纯函数，本可以在三平台各验一遍；' +
    '收窄之后它只在 Linux 上被验。损失有限（同一份代码、同一个结论），但不是零。',
});

const WORK = mkdtempSync(join(tmpdir(), 'om-elfglibc-'));
process.on('exit', () => rmSync(WORK, { recursive: true, force: true }));

let pass = 0;
let fail = 0;
const ok = (m) => {
  console.log(`  \x1b[32m✔\x1b[0m ${m}`);
  pass++;
};
const bad = (m, detail) => {
  console.log(`  \x1b[31m✘\x1b[0m ${m}`);
  if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`);
  fail++;
};
/** `cond` 真 → 记一条通过；否则记一条失败并附上被检查者的真实输出。 */
const expect = (cond, okMsg, badMsg, detail) => {
  if (cond) ok(okMsg);
  else bad(badMsg, detail);
};

const CHECKER = join(import.meta.dirname, 'check-elf-glibc.mjs');

/** 造一个"是 ELF"的文件 —— 检查器按魔数认，不看扩展名。 */
const elfFile = (dir, name) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]),
  );
};

/**
 * 桩 objdump：按**文件名**决定吐哪一份符号表。
 * 输出格式逐字模仿真 objdump -T 的那一列。
 */
const stubObjdump = (dir, table) => {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'objdump');
  writeFileSync(
    p,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('GNU objdump (stub) 2.99'); process.exit(0); }
const target = require('node:path').basename(args[args.length - 1]);
const TABLE = ${JSON.stringify(table)};
const lines = TABLE[target];
if (lines === undefined) { console.error('stub-objdump: 没有为 ' + target + ' 准备符号表'); process.exit(1); }
console.log('DYNAMIC SYMBOL TABLE:');
for (const l of lines) console.log(l);
`,
  );
  chmodSync(p, 0o755);
  return dir;
};

const runChecker = (args, stubDir) => {
  const env =
    stubDir === null
      ? { ...process.env, PATH: '/nonexistent' }
      : { ...process.env, PATH: `${stubDir}:${process.env.PATH}` };
  try {
    const stdout = execFileSync(process.execPath, [CHECKER, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

// 逐字对着真 objdump -T 的输出写的（`objdump -T /usr/bin/true` 的一行）：
//   0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.2.5) getenv
const SYM = (ver, name) =>
  `0000000000000000      DF *UND*\t0000000000000000 (GLIBC_${ver}) ${name}`;

/**
 * C++ 侧的同一行格式。`tag` 传完整的族名+版本（`GLIBCXX_3.4.29` / `CXXABI_1.3.9`），
 * 因为两族的行长得一模一样，分开写两个 helper 只会多一份要维护的模板。
 *
 * `kind` 默认 `'DF'`（函数）。`[实测]` 真的符号表里还有 `'D '`（数据对象，两个空格对齐）：
 *   0000000000000000      D  *UND*\t0000000000000000 (GLIBCXX_3.4.11) _ZSt15__once_callable
 * 检查器的正则只看行尾的 `(版本) 符号名`，**不该**依赖中间那一列 —— ⑥ 里混着两种，
 * 就是为了让"哪天有人把正则收紧到只认 DF"这件事当场红。
 */
const CXXSYM = (tag, name, kind = 'DF') =>
  `0000000000000000      ${kind} *UND*\t0000000000000000 (${tag}) ${name}`;

console.log('\n① 正向：全部 ≤ 上限时退出 0');
{
  const dir = join(WORK, 'good');
  elfFile(dir, 'libggml-cpu.so');
  elfFile(dir, 'whisper-cli');
  const stub = stubObjdump(join(WORK, 'stub-good'), {
    'libggml-cpu.so': [SYM('2.17', 'memcpy'), SYM('2.34', 'pthread_create')],
    'whisper-cli': [SYM('2.2.5', 'malloc'), SYM('2.34', 'dlopen')],
  });
  const r = runChecker(['--dir', dir, '--max', '2.34'], stub);
  expect(r.code === 0, 'exit 0', '应当 exit 0', r.out);
  expect(
    /实测最高 GLIBC_2\.34/m.test(r.out),
    '打印出了实测最高值（2.34）',
    '没打印实测最高值',
    r.out,
  );
}

console.log('\n② ★反向：有一个超标就必须红，并**点名具体符号**');
{
  const dir = join(WORK, 'bad');
  elfFile(dir, 'libggml-cpu.so');
  elfFile(dir, 'libggml-vulkan.so');
  const stub = stubObjdump(join(WORK, 'stub-bad'), {
    'libggml-cpu.so': [SYM('2.34', 'pthread_create')],
    // D-11 §8.2 实测到的那三个，逐字照抄
    'libggml-vulkan.so': [
      SYM('2.38', '__isoc23_strtoul'),
      SYM('2.38', '__isoc23_strtoull'),
      SYM('2.38', '__isoc23_strtol'),
      SYM('2.17', 'memcpy'),
    ],
  });
  const r = runChecker(['--dir', dir, '--max', '2.34'], stub);
  expect(r.code === 1, 'exit 1', '应当 exit 1', r.out);
  expect(r.out.includes('libggml-vulkan.so'), '点名了是哪个文件', '没说是哪个文件', r.out);
  expect(
    ['__isoc23_strtoul', '__isoc23_strtoull', '__isoc23_strtol'].every((s) => r.out.includes(s)),
    '★ 点名了三个 __isoc23_* 符号 —— 这让结论不是推测',
    '没点名符号',
    r.out,
  );
  expect(
    !r.out.includes('libggml-cpu.so  需要'),
    '没有把合规的那个也一起报成超标',
    '误报了合规文件',
    r.out,
  );
}

console.log('\n③ ★反向：一个 ELF 都没数到 = 什么都没检查，必须红');
{
  const dir = join(WORK, 'empty');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.txt'), '不是 ELF');
  const stub = stubObjdump(join(WORK, 'stub-empty'), {});
  const r = runChecker(['--dir', dir, '--max', '2.34'], stub);
  expect(r.code === 1, 'exit 1（不许"数到 0 个还报绿"）', '空目录居然绿了', r.out);
  expect(r.out.includes('一个 ELF 都没数到'), '理由说的是"什么都没检查"', '理由不对', r.out);
}

console.log('\n④ 版本号按数字比，不按字符串比');
{
  const dir = join(WORK, 'ver');
  elfFile(dir, 'a.so');
  const stub = stubObjdump(join(WORK, 'stub-ver'), {
    // 字符串比较会把 "2.9" 判成 > "2.34" —— 那会把一个完全合规的产物报成超标
    'a.so': [SYM('2.9', 'foo'), SYM('2.34', 'bar')],
  });
  const r = runChecker(['--dir', dir, '--max', '2.34'], stub);
  expect(r.code === 0, '2.9 与 2.34 并存时判为合规（2.9 < 2.34）', '把 2.9 当成了大于 2.34', r.out);
  expect(
    r.out.includes('实测最高 GLIBC_2.34'),
    '最高值取的是 2.34 而不是 2.9',
    '最高值取错',
    r.out,
  );
}

console.log('\n⑤ ★反向：objdump 不存在时必须红 ——「我拿不到」不等于「这里没有」');
{
  const dir = join(WORK, 'noobjdump');
  elfFile(dir, 'a.so');
  const r = runChecker(['--dir', dir, '--max', '2.34'], null);
  expect(r.code === 1, 'exit 1', '没有 objdump 却报绿', r.out);
  expect(r.out.includes('没法回答'), '说清了"没法回答不等于没问题"', '理由不对', r.out);
  const r2 = runChecker(['--dir', dir, '--max', '2.34', '--allow-missing-objdump'], null);
  expect(
    r2.code === 0,
    '显式 --allow-missing-objdump 才跳过（CI 上不许传）',
    '显式豁免没生效',
    r2.out,
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * ⑥–⑩ · C++ 运行时那一格（GLIBCXX_ / CXXABI_）
 *
 * 这一格此前**完全没有守卫**：`better-sqlite3` 的 `linux-x64.node` 需要
 * `GLIBC_2.34`（压线通过旧守卫）**同时**需要 `GLIBCXX_3.4.29` / `CXXABI_1.3.9`，
 * 于是一台 libstdc++ 偏旧的机器上它会一路绿到 `require()` 那一刻才死。
 * 下面五条钉的就是"绿得没有道理"这件事不能再发生。
 *
 * 夹具里的符号名不是编的，都是本机 objdump 量到的真名（见每条上面的 `[实测]`）。
 * ═══════════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑥ 正向：C++ 两族**默认上限**下压线通过（≤ 是含等号的）');
{
  const dir = join(WORK, 'cxx-good');
  elfFile(dir, 'linux-x64.node');
  const stub = stubObjdump(join(WORK, 'stub-cxx-good'), {
    // `[实测 2026-08-08]` better-sqlite3@13.0.2 prebuilds/linux-x64.node 的真实符号，逐字照抄。
    // 它的三族最高值正好 = 三条默认上限，所以这条同时验了"边界不许差一格"。
    'linux-x64.node': [
      SYM('2.34', 'pthread_create'),
      SYM('2.2.5', 'malloc'),
      CXXSYM('GLIBCXX_3.4.29', '_ZSt28__throw_bad_array_new_lengthv'),
      CXXSYM(
        'GLIBCXX_3.4.21',
        '_ZNSt13random_device7_M_initERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE',
      ),
      // 这一条是 `D  `（数据对象）不是 `DF` —— 中间那一列不该影响解析
      CXXSYM('GLIBCXX_3.4.11', '_ZSt15__once_callable', 'D '),
      CXXSYM('CXXABI_1.3.9', '_ZdlPvm'),
    ],
  });
  const r = runChecker(['--dir', dir, '--max', '2.34'], stub);
  expect(
    r.code === 0,
    'exit 0（3.4.29 ≤ 默认 3.4.29、1.3.9 ≤ 默认 1.3.9）',
    '把压线值判成了超标',
    r.out,
  );
  expect(
    /实测最高 GLIBCXX_3\.4\.29 \/ CXXABI_1\.3\.9/m.test(r.out),
    '打印出了 C++ 两族的实测最高值',
    '没打印 C++ 实测最高值',
    r.out,
  );
  expect(
    /实测最高 GLIBC_2\.34/m.test(r.out),
    'glibc 那一行的原格式没被改坏',
    'glibc 汇总行变了',
    r.out,
  );
}

console.log('\n⑦ ★反向：只有 GLIBCXX 超标（glibc 完全合规）也必须红，并**点名具体符号**');
{
  const dir = join(WORK, 'cxx-bad');
  elfFile(dir, 'ok.node');
  elfFile(dir, 'too-new.node');
  const stub = stubObjdump(join(WORK, 'stub-cxx-bad'), {
    'ok.node': [
      SYM('2.34', 'pthread_create'),
      CXXSYM('GLIBCXX_3.4.18', '_ZNSt13random_device7_M_finiEv'),
    ],
    'too-new.node': [
      // glibc 侧完全合规 —— 这正是盲区的形状：旧守卫看这一栏，然后放行。
      SYM('2.34', 'pthread_create'),
      // `[实测]` 本机 libstdc++.so.6（.so.6.0.35）里 GLIBCXX_3.4.30 那一档的真符号：
      //   00000000000e2de0 g DF .text 000000000000000c  GLIBCXX_3.4.30 _ZNSt18condition_variable4waitERSt11unique_lockISt5mutexE
      CXXSYM('GLIBCXX_3.4.30', '_ZNSt18condition_variable4waitERSt11unique_lockISt5mutexE'),
    ],
  });
  const r = runChecker(['--dir', dir, '--max', '2.34'], stub);
  expect(r.code === 1, 'exit 1', 'C++ 下限超标却报绿 —— 正是这次要堵的那个洞', r.out);
  expect(r.out.includes('too-new.node'), '点名了是哪个文件', '没说是哪个文件', r.out);
  expect(
    r.out.includes('_ZNSt18condition_variable4waitERSt11unique_lockISt5mutexE'),
    '★ 点名了具体符号 —— 这让结论不是推测',
    '没点名符号',
    r.out,
  );
  expect(
    !r.out.includes('以下产物的 glibc 下限高于基线'),
    '没有连坐：glibc 合规就不报 glibc 的错',
    '把 C++ 超标误报成了 glibc 超标',
    r.out,
  );
  expect(
    !r.out.includes('ok.node  需要'),
    '没有把合规的那个也一起报成超标',
    '误报了合规文件',
    r.out,
  );
}

console.log('\n⑧ ★三段版本号：3.4.29 必须判成 > 3.4.9（字符串比和 parseFloat 都会判反）');
{
  const dir = join(WORK, 'cxx-ver');
  elfFile(dir, 'a.node');
  const stub = stubObjdump(join(WORK, 'stub-cxx-ver'), {
    // `[实测]` 3.4.9 那一档的真符号：_ZNSi10_M_extractIjEERSiRT_（本机 libstdc++.so.6）
    'a.node': [
      SYM('2.34', 'pthread_create'),
      CXXSYM('GLIBCXX_3.4.9', '_ZNSi10_M_extractIjEERSiRT_'),
      CXXSYM('GLIBCXX_3.4.29', '_ZSt28__throw_bad_array_new_lengthv'),
    ],
  });
  // 上限压到 3.4.9：真实答案是"超标"（3.4.29 > 3.4.9）。
  //   · 字符串比：'3.4.29' <= '3.4.9'（'2' < '9'）→ 会**静默放行**
  //   · parseFloat：3.4 vs 3.4 → 相等 → 也会**静默放行**
  // 两种偷懒写法在这里都表现为 exit 0，所以这一条能同时钉死它们。
  const r = runChecker(['--dir', dir, '--max', '2.34', '--max-glibcxx', '3.4.9'], stub);
  expect(
    r.code === 1,
    '★ exit 1（3.4.29 > 3.4.9）',
    '把 3.4.29 判成了 ≤ 3.4.9 —— 逐段数字比被写坏了',
    r.out,
  );
  expect(
    r.out.includes('需要 GLIBCXX_3.4.29'),
    '取的最高值是 3.4.29 而不是 3.4.9',
    '最高值取错',
    r.out,
  );

  // 反过来：上限给到 3.4.29 就该绿，且汇总行报的最高值仍是 3.4.29。
  const r2 = runChecker(['--dir', dir, '--max', '2.34', '--max-glibcxx', '3.4.29'], stub);
  expect(r2.code === 0, '上限 3.4.29 时判为合规', '把合规的判成了超标（假红同样是谎）', r2.out);
  expect(
    r2.out.includes('实测最高 GLIBCXX_3.4.29'),
    '汇总行取的最高值是 3.4.29',
    '汇总行最高值取错',
    r2.out,
  );
}

console.log('\n⑨ ★CXXABI 是**独立**的一条闸：自己的 --max-cxxabi，自己单独触发');
{
  const dir = join(WORK, 'abi');
  elfFile(dir, 'a.node');
  const stub = stubObjdump(join(WORK, 'stub-abi'), {
    // `[实测]` CXXABI 的真实取值里两段（1.3）与三段（1.3.7 / 1.3.9）并存 ——
    // sherpa-onnx 的 libsherpa-onnx-cxx-api.so 最高就是 CXXABI_1.3。
    'a.node': [
      SYM('2.34', 'pthread_create'),
      CXXSYM('GLIBCXX_3.4.18', '_ZNSt13random_device7_M_finiEv'),
      CXXSYM('CXXABI_1.3', '_ZTVN10__cxxabiv117__class_type_infoE'),
      CXXSYM('CXXABI_1.3.7', '_ZTIPKn'),
      CXXSYM('CXXABI_1.3.9', '_ZdlPvm'),
    ],
  });
  const r = runChecker(['--dir', dir, '--max', '2.34', '--max-cxxabi', '1.3.8'], stub);
  expect(r.code === 1, 'exit 1（1.3.9 > 1.3.8）', 'CXXABI 超标却报绿', r.out);
  expect(r.out.includes('_ZdlPvm'), '点名了 sized delete 那个符号', '没点名符号', r.out);
  expect(
    r.out.includes('需要 CXXABI_1.3.9'),
    '最高值取 1.3.9（1.3 / 1.3.7 段数不同也要比对）',
    '最高值取错',
    r.out,
  );
  expect(
    !r.out.includes('高于基线（GLIBCXX）'),
    'GLIBCXX 合规就不跟着报 —— 三族各判各的',
    'CXXABI 超标把 GLIBCXX 也连坐了',
    r.out,
  );
  const r2 = runChecker(['--dir', dir, '--max', '2.34'], stub);
  expect(
    r2.code === 0,
    '默认上限 1.3.9 下同一份夹具是绿的',
    '默认 CXXABI 上限把本仓产物报红了',
    r2.out,
  );
}

console.log('\n⑩ ★三族不许串味：GLIBCXX_3.4.29 绝不能被当成 GLIBC_3.4.29');
{
  const dir = join(WORK, 'nocrosstalk');
  elfFile(dir, 'pure-cxx.node');
  const stub = stubObjdump(join(WORK, 'stub-nocrosstalk'), {
    // 一条 GLIBC_ 都没有，只有 C++ 两族。
    'pure-cxx.node': [
      CXXSYM('GLIBCXX_3.4.29', '_ZSt28__throw_bad_array_new_lengthv'),
      CXXSYM('CXXABI_1.3.9', '_ZdlPvm'),
    ],
  });
  const r = runChecker(['--dir', dir, '--max', '2.34'], stub);
  // 正则的交替分支若写成 `GLIBC|GLIBCXX|CXXABI` 而引擎又不回溯，`GLIBCXX_3.4.29`
  // 会被算进 GLIBC 族 → 3.4.29 > 2.34 → 这里当场变红。exit 0 就是"没串味"的证据。
  expect(
    r.code === 0,
    '★ exit 0 —— GLIBCXX 没有被算进 GLIBC 族',
    'GLIBCXX_ 被当成 GLIBC_ 判了超标',
    r.out,
  );
  expect(
    r.out.includes('实测最高 GLIBC_0.0'),
    'glibc 族确实一条都没数到',
    'glibc 族数到了不该有的东西',
    r.out,
  );
  expect(
    r.out.includes('(无 GLIBC 引用)'),
    '逐行那一列照旧标注"无 GLIBC 引用"',
    '逐行标注变了',
    r.out,
  );
  expect(
    r.out.includes('实测最高 GLIBCXX_3.4.29 / CXXABI_1.3.9'),
    '同一份输入在 C++ 两族里被正确数到',
    'C++ 两族没数到',
    r.out,
  );
}

console.log('');
if (fail === 0) {
  console.log(`\x1b[32m✔\x1b[0m selftest-elf-glibc: ${pass} 个用例全部通过`);
} else {
  console.log(`\x1b[31m✘\x1b[0m selftest-elf-glibc: ${pass} passed, ${fail} failed`);
  process.exit(1);
}
