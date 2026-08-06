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
 * 跑：`pnpm test:ci-scripts`
 */

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

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

const CHECKER = join(import.meta.dirname, 'check-elf-glibc.mjs');

/** 造一个"是 ELF"的文件 —— 检查器按魔数认，不看扩展名。 */
const elfFile = (dir, name) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]));
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
  try {
    const stdout = execFileSync(process.execPath, [CHECKER, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: stubDir === null ? { ...process.env, PATH: '/nonexistent' } : { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

// 逐字对着真 objdump -T 的输出写的（`objdump -T /usr/bin/true` 的一行）：
//   0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.2.5) getenv
const SYM = (ver, name) => `0000000000000000      DF *UND*\t0000000000000000 (GLIBC_${ver}) ${name}`;

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
  r.code === 0 ? ok('exit 0') : bad('应当 exit 0', r.out);
  /^.*实测最高 GLIBC_2\.34/m.test(r.out)
    ? ok('打印出了实测最高值（2.34）')
    : bad('没打印实测最高值', r.out);
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
  r.code === 1 ? ok('exit 1') : bad('应当 exit 1', r.out);
  r.out.includes('libggml-vulkan.so') ? ok('点名了是哪个文件') : bad('没说是哪个文件', r.out);
  ['__isoc23_strtoul', '__isoc23_strtoull', '__isoc23_strtol'].every((s) => r.out.includes(s))
    ? ok('★ 点名了三个 __isoc23_* 符号 —— 这让结论不是推测')
    : bad('没点名符号', r.out);
  !r.out.includes('libggml-cpu.so  需要')
    ? ok('没有把合规的那个也一起报成超标')
    : bad('误报了合规文件', r.out);
}

console.log('\n③ ★反向：一个 ELF 都没数到 = 什么都没检查，必须红');
{
  const dir = join(WORK, 'empty');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.txt'), '不是 ELF');
  const stub = stubObjdump(join(WORK, 'stub-empty'), {});
  const r = runChecker(['--dir', dir, '--max', '2.34'], stub);
  r.code === 1 ? ok('exit 1（不许"数到 0 个还报绿"）') : bad('空目录居然绿了', r.out);
  r.out.includes('一个 ELF 都没数到') ? ok('理由说的是"什么都没检查"') : bad('理由不对', r.out);
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
  r.code === 0 ? ok('2.9 与 2.34 并存时判为合规（2.9 < 2.34）') : bad('把 2.9 当成了大于 2.34', r.out);
  r.out.includes('实测最高 GLIBC_2.34') ? ok('最高值取的是 2.34 而不是 2.9') : bad('最高值取错', r.out);
}

console.log('\n⑤ ★反向：objdump 不存在时必须红 ——「我拿不到」不等于「这里没有」');
{
  const dir = join(WORK, 'noobjdump');
  elfFile(dir, 'a.so');
  const r = runChecker(['--dir', dir, '--max', '2.34'], null);
  r.code === 1 ? ok('exit 1') : bad('没有 objdump 却报绿', r.out);
  r.out.includes('没法回答') ? ok('说清了"没法回答不等于没问题"') : bad('理由不对', r.out);
  const r2 = runChecker(['--dir', dir, '--max', '2.34', '--allow-missing-objdump'], null);
  r2.code === 0
    ? ok('显式 --allow-missing-objdump 才跳过（CI 上不许传）')
    : bad('显式豁免没生效', r2.out);
}

console.log('');
if (fail === 0) {
  console.log(`\x1b[32m✔\x1b[0m selftest-elf-glibc: ${pass} 个用例全部通过`);
} else {
  console.log(`\x1b[31m✘\x1b[0m selftest-elf-glibc: ${pass} passed, ${fail} failed`);
  process.exit(1);
}
