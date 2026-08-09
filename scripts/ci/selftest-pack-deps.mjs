#!/usr/bin/env node
/**
 * `scripts/ci/pack-native-deps.mjs` 的本机自检。
 *
 * ## 覆盖面上的两条刻意选择
 *
 * ① **ELF 那一半用真系统二进制**，并且**与 `objdump -p` 交叉核对过**
 *    （见本文件 §0：先跑 objdump 拿到 ground truth，再断言脚本给出同一个集合）。
 *    用真二进制是因为要验的正是"解析真实布局"这件事 —— 自己造的 ELF 只能证明
 *    "我造的和我解的是同一套假设"。
 *
 * ② **PE 那一半用现造的最小 PE**。这台机器上没有 Windows 二进制，而
 *    "只在 Linux 上跑得起来的守卫"等于在 Windows 上什么都没断言
 *    （D-11 §3.3 那一族：三条 assetPaths 用例在 Windows 上什么都没断言到）。
 *    现造的 PE 只覆盖"导入表解析"这一件事，**不声称覆盖真实 MSVC 产物的全部形态**。
 *
 * 跑：`pnpm test:ci-scripts`
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const WORK = mkdtempSync(join(tmpdir(), 'om-packdeps-'));
process.on('exit', () => rmSync(WORK, { recursive: true, force: true }));

let pass = 0;
let fail = 0;
const ok = (m) => {
  console.log(`  \x1b[32m✔\x1b[0m ${m}`);
  pass++;
};
const bad = (m, detail) => {
  console.log(`  \x1b[31m✘\x1b[0m ${m}`);
  if (detail) console.log(`      ${String(detail).split('\n').slice(0, 12).join('\n      ')}`);
  fail++;
};
const expect = (cond, okMsg, badMsg, detail) => (cond ? ok(okMsg) : bad(badMsg, detail));

const TOOL = join(import.meta.dirname, 'pack-native-deps.mjs');
const run = (args) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [TOOL, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

/** 找一个存在的系统库目录（发行版之间不一样，不写死）。 */
const LIBDIRS = [
  '/usr/lib/x86_64-linux-gnu',
  '/lib/x86_64-linux-gnu',
  '/usr/lib64',
  '/usr/lib',
].filter((d) => existsSync(d));

const objdumpNeeded = (p) => {
  try {
    return execFileSync('objdump', ['-p', p], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes('NEEDED'))
      .map((l) => l.trim().split(/\s+/)[1])
      .sort();
  } catch {
    return null;
  }
};

console.log('\n§0 交叉核对：脚本读出来的依赖集合 == `objdump -p` 说的（ELF 那一半的地基）');
{
  const probe = ['/usr/bin/git', '/bin/bash', '/usr/bin/objdump'].filter((p) => existsSync(p));
  if (probe.length === 0 || objdumpNeeded(probe[0]) === null) {
    // 「我拿不到」≠「这里没有问题」：说清楚跳过了什么，而不是安静地少测一条。
    bad('本机没有 objdump 或没有可用的探针二进制 —— 这一节的地基验不了', '不把它算成通过');
  } else {
    for (const p of probe) {
      const truth = (objdumpNeeded(p) ?? []).filter(
        (n) =>
          !/^(libc|libm|libdl|librt|libpthread|libstdc\+\+|libgcc_s|libgomp|ld-linux.*)\.so\.\d+$/.test(
            n,
          ),
      );
      const dir = join(WORK, 'x' + p.replace(/\W/g, ''));
      mkdirSync(dir, { recursive: true });
      copyFileSync(p, join(dir, p.split('/').pop()));
      const r = run(['--verify', '--dir', dir]);
      const reported = [...r.out.matchAll(/^\s{4}(\S+)\s+←/gm)].map((m) => m[1]).sort();
      expect(
        JSON.stringify(reported) === JSON.stringify(truth),
        `${p.split('/').pop()}：脚本报的缺件集合与 objdump 的 NEEDED（去掉系统库后）逐项一致 [${truth.join(' ') || '空'}]`,
        `${p} 对不上`,
        `objdump: ${truth.join(' ')}\n脚本  : ${reported.join(' ')}\n${r.out}`,
      );
    }
  }
}

console.log('\n① 正向：只依赖系统库的包 → exit 0');
{
  const dir = join(WORK, 'good');
  mkdirSync(dir, { recursive: true });
  copyFileSync('/bin/true', join(dir, 'whisper-cli'));
  const r = run(['--verify', '--dir', dir]);
  expect(r.code === 0, 'exit 0', '应当 exit 0', r.out);
  expect(
    /1 个二进制/.test(r.out),
    '打印了数到几个二进制（数到 0 个是红，见 ⑤）',
    '没打印计数',
    r.out,
  );
}

console.log('\n② ★反向：缺一个非系统依赖 → 红，并点名是谁要的');
{
  const dir = join(WORK, 'miss');
  mkdirSync(dir, { recursive: true });
  copyFileSync('/usr/bin/git', join(dir, 'git'));
  const r = run(['--verify', '--dir', dir]);
  expect(r.code === 1, 'exit 1', '缺件却报绿了', r.out);
  expect(/←\s*git 要的/.test(r.out), '点名了是哪个二进制要的', '没点名引用方', r.out);
  expect(
    /dlopen 失败不是错误/.test(r.out),
    '错误信息说清了"后果是静默的"',
    '错误信息没说后果',
    r.out,
  );
}

console.log('\n③ --collect 的**传递闭包**：没人点名的那一层也要被带上');
{
  const dir = join(WORK, 'collect');
  mkdirSync(dir, { recursive: true });
  copyFileSync('/usr/bin/objdump', join(dir, 'objdump'));
  const direct = (objdumpNeeded('/usr/bin/objdump') ?? []).filter((n) =>
    /^lib(bfd|opcodes|ctf|sframe)/.test(n),
  );
  const r = run(['--collect', '--dir', dir, ...LIBDIRS.flatMap((d) => ['--search', d])]);
  expect(r.code === 0, 'exit 0', '收集失败', r.out);
  const got = readdirSync(dir);
  expect(
    direct.every((n) => got.includes(n)),
    `直接依赖全部收齐（${direct.join(' ')}）`,
    '直接依赖没收齐',
    `目录里：${got.join(' ')}`,
  );
  // libbfd 自己要 libz / libzstd —— **objdump 的导入表里没有它们**，
  // 只有再问一遍 libbfd 才会知道。这一条就是 libcublas → libcublasLt 的同一形状。
  const secondOrder = (
    objdumpNeeded(join(dir, 'libbfd' + (got.find((g) => g.startsWith('libbfd')) ?? '').slice(6))) ??
    []
  ).filter((n) => /^lib(z|zstd)\.so/.test(n));
  expect(
    secondOrder.length > 0 && secondOrder.every((n) => got.includes(n)),
    `★ 二阶依赖也被带上了（${secondOrder.join(' ')}）—— 没有任何一处点过它们的名`,
    '二阶依赖没被带上（传递闭包没生效）',
    `目录里：${got.join(' ')}`,
  );
  expect(
    run(['--verify', '--dir', dir]).code === 0,
    '收集完再跑守卫是绿的（收集与验证用同一份判据）',
    '收集完守卫仍红',
  );
}

console.log('\n④ ★反向：--collect 找不到必需件 → 红（不许"找不到就算了"）');
{
  const dir = join(WORK, 'nosrc');
  mkdirSync(dir, { recursive: true });
  copyFileSync('/usr/bin/git', join(dir, 'git'));
  const empty = join(WORK, 'emptysearch');
  mkdirSync(empty, { recursive: true });
  const r = run(['--collect', '--dir', dir, '--search', empty]);
  expect(r.code === 1, 'exit 1', '找不到却报绿了', r.out);
  expect(
    /静默 no-op/.test(r.out),
    '错误信息点名了「静默 no-op」这一族',
    '错误信息没点名成因',
    r.out,
  );
}

console.log('\n⑤ ★反向：目录里没有可解析的二进制 = 什么都没检查，必须红');
{
  const dir = join(WORK, 'nobin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.txt'), '不是二进制');
  const r = run(['--verify', '--dir', dir]);
  expect(r.code === 1, 'exit 1（ci-prep C5 那一族：数到 0 个不许报绿）', '没有二进制却报绿', r.out);
}

console.log('\n⑥ 驱动提供的库既不算缺、也不许被收集');
{
  const host = ['/usr/bin/vulkaninfo', '/usr/bin/vkcube'].find(
    (p) => existsSync(p) && (objdumpNeeded(p) ?? []).some((n) => /^libvulkan\.so/.test(n)),
  );
  if (!host) {
    console.log(
      '  \x1b[33m—\x1b[0m 本机没有依赖 libvulkan.so.1 的二进制，这一条跳过（如实记：**没验到**）',
    );
  } else {
    const dir = join(WORK, 'drv');
    mkdirSync(dir, { recursive: true });
    copyFileSync(host, join(dir, 'probe-bin'));
    const r = run(['--collect', '--dir', dir, ...LIBDIRS.flatMap((d) => ['--search', d])]);
    expect(
      !readdirSync(dir).some((f) => /^libvulkan\.so/.test(f)),
      '★ libvulkan.so.1 没有被拷进包（driver 类永不收集）',
      'driver 类被收集了',
      readdirSync(dir).join(' '),
    );
    expect(
      r.code === 0 || !/libvulkan/.test(r.out),
      'libvulkan 也不被算成缺件',
      'libvulkan 被当成了缺件',
      r.out,
    );
  }
}

console.log('\n⑦ PE（Windows）那一半：现造一个最小 PE，验导入表解析真的走到了');
{
  /**
   * 最小 PE32+：DOS 头 → PE 签名 → COFF → 可选头（含数据目录）→ 一个 .rdata 段，
   * 段里放 IMAGE_IMPORT_DESCRIPTOR 数组 + DLL 名字符串。
   * 只为验解析路径，不求能被 Windows 加载。
   */
  const makePe = (dllNames) => {
    const SECT_RVA = 0x1000;
    const SECT_RAW = 0x400;
    const descBytes = (dllNames.length + 1) * 20;
    const names = [];
    let cur = descBytes;
    for (const n of dllNames) {
      names.push({ n, off: cur });
      cur += Buffer.byteLength(n, 'ascii') + 1;
    }
    const sect = Buffer.alloc(Math.max(0x200, cur + 16));
    dllNames.forEach((n, i) => {
      sect.writeUInt32LE(SECT_RVA + names[i].off, i * 20 + 12); // Name RVA
      sect.writeUInt32LE(1, i * 20 + 16); // FirstThunk 非零，避免看起来像终止项
    });
    for (const { n, off } of names) sect.write(n + '\0', off, 'ascii');

    const optSize = 240; // PE32+ 可选头 112 + 16 个数据目录 * 8
    const headers = Buffer.alloc(SECT_RAW);
    headers.write('MZ', 0, 'ascii');
    headers.writeUInt32LE(0x80, 0x3c);
    const pe = 0x80;
    headers.write('PE\0\0', pe, 'ascii');
    headers.writeUInt16LE(0x8664, pe + 4); // Machine x64
    headers.writeUInt16LE(1, pe + 6); // NumberOfSections
    headers.writeUInt16LE(optSize, pe + 20); // SizeOfOptionalHeader
    headers.writeUInt16LE(0x2022, pe + 22); // Characteristics: DLL | EXECUTABLE
    const opt = pe + 24;
    headers.writeUInt16LE(0x20b, opt); // PE32+
    const dd = opt + 112;
    headers.writeUInt32LE(SECT_RVA, dd + 8); // DataDirectory[1] = Import, RVA
    headers.writeUInt32LE(descBytes, dd + 12); // size
    const sh = opt + optSize;
    headers.write('.rdata\0\0', sh, 'ascii');
    headers.writeUInt32LE(sect.length, sh + 8); // VirtualSize
    headers.writeUInt32LE(SECT_RVA, sh + 12); // VirtualAddress
    headers.writeUInt32LE(sect.length, sh + 16); // SizeOfRawData
    headers.writeUInt32LE(SECT_RAW, sh + 20); // PointerToRawData
    return Buffer.concat([headers, sect]);
  };

  const dir = join(WORK, 'pe');
  mkdirSync(dir, { recursive: true });
  // 逐字用真实产物里出现过的名字：一个必须随包的、一个驱动的、一个系统的、一个已立案缺口的
  writeFileSync(
    join(dir, 'ggml-cuda.dll'),
    makePe(['cublas64_12.dll', 'nvcuda.dll', 'KERNEL32.dll', 'VCRUNTIME140.dll']),
  );
  const r = run(['--verify', '--dir', dir]);
  expect(r.code === 1, 'exit 1', 'PE 缺件却报绿', r.out);
  expect(
    /cublas64_12\.dll/.test(r.out),
    '★ 认出必须随包的 cublas64_12.dll',
    '没认出 cublas64_12.dll',
    r.out,
  );
  expect(
    !/nvcuda\.dll/.test(r.out),
    'nvcuda.dll 不算缺件（驱动提供，且不许再分发）',
    'nvcuda.dll 被当成了缺件',
    r.out,
  );
  expect(!/KERNEL32/.test(r.out), 'KERNEL32.dll 不算缺件（系统）', 'KERNEL32 被当成了缺件', r.out);
  expect(
    /已立案缺口：VCRUNTIME140\.dll/.test(r.out),
    'VCRUNTIME140.dll 走「已立案缺口」并**打印出来**，不是被默默放过',
    '已立案缺口没打印',
    r.out,
  );

  // 补齐之后必须变绿 —— 否则上面那条红可能只是"它对什么都报红"
  writeFileSync(join(dir, 'cublas64_12.dll'), makePe(['KERNEL32.dll']));
  const r2 = run(['--verify', '--dir', dir]);
  expect(r2.code === 0, '把 cublas64_12.dll 放进去之后变绿（对照组）', '补齐了仍然红', r2.out);
}

console.log('\n⑧ Mach-O：认得出、读不了 —— 必须**打印**成未覆盖，而不是当成"没有二进制"');
{
  const dir = join(WORK, 'macho');
  mkdirSync(dir, { recursive: true });
  // 只写魔数：本守卫对 Mach-O 只做识别，不解析 LC_LOAD_DYLIB（理由见脚本里那段注释）
  const mh = Buffer.alloc(64);
  mh.writeUInt32BE(0xfeedfacf, 0); // MH_MAGIC_64
  writeFileSync(join(dir, 'libggml-metal.so'), mh);
  const r = run(['--verify', '--dir', dir]);
  expect(r.code === 0, '不因为"读不了"就把 macOS 腿打红', '把 Mach-O 判成了错误', r.out);
  expect(/Mach-O 1 个/.test(r.out), '★ 数出来并打印了（1 个）', '没打印 Mach-O 计数', r.out);
  expect(/没有被覆盖/.test(r.out), '明说"没有被覆盖，不是检查过了没问题"', '没说清覆盖面', r.out);
  expect(
    /未覆盖的 Mach-O 1 个/.test(r.out),
    '成功那一行也带上未覆盖计数（不让它从摘要里消失）',
    '摘要里没有 Mach-O 计数',
    r.out,
  );
}

console.log('');
if (fail === 0) console.log(`\x1b[32m✔\x1b[0m selftest-pack-deps: ${pass} 个用例全部通过`);
else {
  console.log(`\x1b[31m✘\x1b[0m selftest-pack-deps: ${pass} passed, ${fail} failed`);
  process.exit(1);
}
