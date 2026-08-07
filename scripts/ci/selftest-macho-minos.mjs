#!/usr/bin/env node
/**
 * `scripts/ci/check-macho-minos.mjs` 的本机自检。
 *
 * ## 为什么这一条能在 Linux 上真的跑红（而 elf-glibc 那条只能桩 objdump）
 *
 * 检查器是**纯解析**的（不调 `otool` / `vtool`，那两个只有 macOS 上有），
 * 所以夹具可以是**真的 Mach-O 头**，逐字节按 `<mach-o/loader.h>` 拼出来。
 * 于是「把守卫拆掉 / 把 minos 抬高 / 把版本信息删掉」这几件事在这台 Linux
 * 开发机上就能拿到真红灯，不必赌一次 20 分钟的 macOS CI ——
 * 而"拿不到红灯的反向验证"等于没有反向验证。
 *
 * ⚠️ 边界如实说：这里验的是**解析与阈值逻辑**，不是「dyld 真的会拒绝加载」。
 * 后者只有真 Mac 能验，本仓没有。`minos > 系统版本 → dyld 拒绝` 这条是 Apple 的
 * 文档事实 + `pack-publish` T-146 在真 runner 上量到的 `minos=26.0.0`，
 * 不是我在这里证明的。
 *
 * 跑：`pnpm test:ci-scripts`
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const WORK = mkdtempSync(join(tmpdir(), 'om-machominos-'));
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
const expect = (cond, okMsg, badMsg, detail) => {
  if (cond) ok(okMsg);
  else bad(badMsg, detail);
};

const CHECKER = join(import.meta.dirname, 'check-macho-minos.mjs');

const MH_MAGIC_64 = 0xfeedfacf;
const LC_BUILD_VERSION = 0x32;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_UUID = 0x1b;

const encodeVer = (s) => {
  const [a = 0, b = 0, c = 0] = String(s).split('.').map(Number);
  return ((a & 0xffff) << 16) | ((b & 0xff) << 8) | (c & 0xff);
};

/**
 * 造一个 thin 64 位 Mach-O。
 *
 * `opts.minos === null` → 不写任何版本 load command（用一条 LC_UUID 占位），
 * 这正好是判据 3「读不出版本必须红」要喂的那个输入。
 */
function machO({ minos = '13.3', sdk = '26.5', platform = 1, legacy = false } = {}) {
  const cmds = [];
  if (minos === null) {
    const c = Buffer.alloc(24);
    c.writeUInt32LE(LC_UUID, 0);
    c.writeUInt32LE(24, 4);
    cmds.push(c);
  } else if (legacy) {
    const c = Buffer.alloc(16);
    c.writeUInt32LE(LC_VERSION_MIN_MACOSX, 0);
    c.writeUInt32LE(16, 4);
    c.writeUInt32LE(encodeVer(minos), 8);
    c.writeUInt32LE(encodeVer(sdk), 12);
    cmds.push(c);
  } else {
    const c = Buffer.alloc(24);
    c.writeUInt32LE(LC_BUILD_VERSION, 0);
    c.writeUInt32LE(24, 4);
    c.writeUInt32LE(platform, 8);
    c.writeUInt32LE(encodeVer(minos), 12);
    c.writeUInt32LE(encodeVer(sdk), 16);
    c.writeUInt32LE(0, 20); // ntools
    cmds.push(c);
  }
  const body = Buffer.concat(cmds);
  const head = Buffer.alloc(32);
  head.writeUInt32LE(MH_MAGIC_64, 0);
  head.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  head.writeUInt32LE(0, 8);
  head.writeUInt32LE(2, 12); // MH_EXECUTE
  head.writeUInt32LE(cmds.length, 16);
  head.writeUInt32LE(body.length, 20);
  head.writeUInt32LE(0x00200085, 24);
  head.writeUInt32LE(0, 28);
  return Buffer.concat([head, body]);
}

/** universal binary：把若干 thin slice 拼进 FAT 容器（大端头）。 */
function fat(slices) {
  const align = 0x4000;
  const headerLen = 8 + slices.length * 20;
  let cursor = Math.ceil(headerLen / align) * align;
  const head = Buffer.alloc(cursor);
  head.writeUInt32BE(0xcafebabe, 0);
  head.writeUInt32BE(slices.length, 4);
  const parts = [];
  slices.forEach((s, i) => {
    const p = 8 + i * 20;
    head.writeUInt32BE(0x0100000c, p);
    head.writeUInt32BE(0, p + 4);
    head.writeUInt32BE(cursor, p + 8);
    head.writeUInt32BE(s.length, p + 12);
    head.writeUInt32BE(14, p + 16);
    parts.push({ off: cursor, buf: s });
    cursor += Math.ceil(s.length / align) * align;
  });
  const out = Buffer.alloc(cursor);
  head.copy(out, 0);
  for (const p of parts) p.buf.copy(out, p.off);
  return out;
}

let caseNo = 0;
const dirWith = (files) => {
  caseNo += 1;
  const d = join(WORK, `c${caseNo}`);
  mkdirSync(d, { recursive: true });
  for (const [name, buf] of Object.entries(files)) writeFileSync(join(d, name), buf);
  return d;
};

const runChecker = (extra) => {
  try {
    const stdout = execFileSync(process.execPath, [CHECKER, ...extra], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

console.log('\n① 正向：全部 ≤ 上限时必须绿，并且**报出数到了几个**');
{
  const d = dirWith({
    'openmemo-probe': machO({ minos: '13.3' }),
    'libggml-base.0.15.1.dylib': machO({ minos: '13.3' }),
    'libggml-metal.so': machO({ minos: '12.0' }),
  });
  const r = runChecker(['--dir', d, '--max', '13.3']);
  expect(r.code === 0, '合规目录 exit 0', '合规目录居然红了', r.out);
  expect(
    /3 个 Mach-O/.test(r.out),
    '打印了"3 个 Mach-O"（数到 0 个会红，见 ③）',
    '没有打印数量 —— 一个不说自己检查了几个的检查器，绿了也不可信',
    r.out,
  );
  expect(
    /实测最高 13\.3\.0/.test(r.out),
    '打印了实测最高值 13.3.0',
    '没打印实测最高值',
    r.out,
  );
}

console.log('\n② ★反向：一个 minos=26.0 的探针必须红，并且**点名它**');
{
  const d = dirWith({
    'libggml-base.0.15.1.dylib': machO({ minos: '13.3' }),
    'openmemo-probe': machO({ minos: '26.0' }), // ← T-167 在真产物上量到的那个值
  });
  const r = runChecker(['--dir', d, '--max', '13.3']);
  expect(r.code === 1, '超标 exit 1', '超标居然放过去了', r.out);
  expect(
    /openmemo-probe/.test(r.out) && /minos 26\.0\.0/.test(r.out),
    '点名了 openmemo-probe 与 minos 26.0.0',
    '红了但没说是谁、也没说是多少 —— 那种红没法拿去修',
    r.out,
  );
  expect(
    !/✘.*libggml-base/.test(r.out),
    '没有连坐合规的 libggml-base',
    '把合规文件也报红了 —— 一条会对不相干的东西发表意见的检查，说对的时候也不该被相信',
    r.out,
  );
}

console.log('\n③ ★反向：数到 0 个必须红（空集 ≠ 没问题）');
{
  const d = dirWith({ 'README.txt': Buffer.from('not a mach-o') });
  const r = runChecker(['--dir', d, '--max', '13.3']);
  expect(r.code === 1, '空集 exit 1', '一个 Mach-O 都没数到却报绿 —— 最坏的那种绿', r.out);
}

console.log('\n④ ★反向：既没有 LC_BUILD_VERSION 也没有 LC_VERSION_MIN_MACOSX 必须红');
{
  const d = dirWith({ 'openmemo-probe': machO({ minos: null }) });
  const r = runChecker(['--dir', d, '--max', '13.3']);
  expect(r.code === 1, '读不出版本 exit 1', '读不出版本却当成没问题', r.out);
  expect(
    /读不出版本|既没有 LC_BUILD_VERSION/.test(r.out),
    '说清了"读不出来"而不是别的原因',
    '红的理由说错了',
    r.out,
  );
}

console.log('\n⑤ ★反向：platform 不是 macOS 必须红（iOS slice 混进来）');
{
  const d = dirWith({ 'openmemo-probe': machO({ minos: '13.3', platform: 2 }) });
  const r = runChecker(['--dir', d, '--max', '13.3']);
  expect(r.code === 1, 'platform=iOS exit 1', 'iOS 的二进制被当成 macOS 放过去了', r.out);
}

console.log('\n⑥ ★反向：universal binary 里**任何一个** slice 超标都要红');
{
  const d = dirWith({
    'openmemo-probe': fat([machO({ minos: '13.3' }), machO({ minos: '26.0' })]),
  });
  const r = runChecker(['--dir', d, '--max', '13.3']);
  expect(
    r.code === 1,
    'fat 里第二个 slice 超标 → exit 1',
    '只看了第一个 slice —— 一个超标的 arm64 slice 可以躲在正常的 x86_64 后面',
    r.out,
  );
  expect(/slice 1/.test(r.out), '点名了是哪个 slice', '没说是哪个 slice', r.out);
}

console.log('\n⑦ 版本比较按数字，不是按字符串');
{
  // 字符串比会把 "9.0" 判成 > "13.3"，于是一个完全合规的产物被报成超标。
  const d = dirWith({ 'libggml.dylib': machO({ minos: '9.0' }) });
  const r = runChecker(['--dir', d, '--max', '13.3']);
  expect(r.code === 0, 'minos 9.0 ≤ 13.3（数字比较）', '把 9.0 判成大于 13.3 —— 假红同样是谎', r.out);
}

console.log('\n⑧ 老式 LC_VERSION_MIN_MACOSX 也要认');
{
  const d = dirWith({ 'legacy.dylib': machO({ minos: '26.0', legacy: true }) });
  const r = runChecker(['--dir', d, '--max', '13.3']);
  expect(
    r.code === 1,
    '老式 load command 里的超标同样被抓到',
    '只认 LC_BUILD_VERSION —— 老编译器产出的二进制会整个绕过这条守卫',
    r.out,
  );
}

console.log('\n⑨ --max 必须真的起作用（阈值放宽后同一份输入必须变绿）');
{
  const d = dirWith({ 'openmemo-probe': machO({ minos: '26.0' }) });
  const strict = runChecker(['--dir', d, '--max', '13.3']);
  const loose = runChecker(['--dir', d, '--max', '26.0']);
  expect(
    strict.code === 1 && loose.code === 0,
    '同一份输入：--max 13.3 红、--max 26.0 绿',
    '阈值参数没有真的参与判断',
    `strict=${strict.code} loose=${loose.code}\n${strict.out}`,
  );
}

console.log(`\nselftest-macho-minos: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
