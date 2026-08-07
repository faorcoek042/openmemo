#!/usr/bin/env node
/**
 * Mach-O 产物的 **macOS 最低系统版本**守卫（`LC_BUILD_VERSION.minos`）。
 *
 * ## 它防的是哪一件事
 *
 * 与 `check-elf-glibc.mjs` 是同一条规律的 macOS 那一格 —— D-11 §8.0：
 * 「构建机总是那个最新、装得最全的环境，而用户的机器不是。**凡是不显式指定就取
 * 构建机当前值的东西，都会把构建机的新度焊进产物**」。
 *
 * Linux 那一格是 `GLIBC_x.y` 符号版本；macOS 这一格是 `LC_BUILD_VERSION.minos`：
 * 不显式设 `CMAKE_OSX_DEPLOYMENT_TARGET` / `-mmacosx-version-min`，
 * 编译器就把**构建机自己的系统版本**写进去，而 runner 是 `macos-26`。
 *
 * ## 这条守卫不是假想出来的 —— 同一个洞已经在**同一个产物族**里出现过两次
 *
 * ① `[CI 实测 T-146]` `whispercpp-cpu-macos-arm64` 的 12 个二进制全是 `minos=26.0.0`。
 *    修法是 `build-whisper.sh` 加 `-DCMAKE_OSX_DEPLOYMENT_TARGET=13.3`（上游
 *    `build-xcframework.sh:5` 自己写的 `MACOS_MIN_OS_VERSION`）。
 *
 * ② `[本机实测 2026-08-07，T-167]` **`openmemo-probe` 没跟着修** ——
 *    同一轮 CI（run 31121718587）产出的两样东西，一个包里一个包外：
 *
 *    ```
 *    whispercpp-cpu-macos-arm64.tar.gz 里的 20 个 Mach-O   minos = 13.3.0
 *    dist/probe/openmemo-probe                             minos = 26.0.0   ← ★
 *    ```
 *
 *    与 T-163 在 Linux 上发现的**完全是同一句话**：「守卫只看包的内容，
 *    而探针是单独 upload 的」。**一个漏掉探针的守卫，在两个平台上各漏了一次。**
 *
 * ## 为什么后果是静默的（这决定了它必须是 CI 上的一步）
 *
 * `minos` 高于用户系统版本时，**dyld 直接拒绝加载，进程根本不启动**。
 * 而探针挂掉的表现是 `runProbe()` 返回一个失败结果 →
 * `hardware.backends[*].available = false` → 界面上写「尚未探测到硬件能力」——
 * **与"这台机器真的没有 GPU"一模一样**。安装记录成功、sha256 正确、
 * 包里每个文件都在。没有任何一处会说"你的 macOS 太旧了"。
 *
 * ## 为什么用纯 node 解析而不是调 `otool` / `vtool`
 *
 * 那两个工具**只有 macOS 上有**。如果守卫依赖它们，它就只能在 macOS runner 上跑，
 * 于是它的反向验证也只能在 macOS runner 上做 —— 而本仓的判据是
 * 「反向验证要真的拿到红灯」。纯解析让 `selftest-macho-minos.mjs` 在这台 Linux
 * 开发机上就能把 5 条反向用例真的跑红，不必赌一次 20 分钟的 CI。
 *
 * ## 用法
 *
 *   node scripts/ci/check-macho-minos.mjs --dir <目录> [--max 13.3]
 *
 * 判据（四条，缺一不可）：
 *   1. 目录里**至少数到一个 Mach-O** —— 数到 0 个就红。
 *      「工具返回空集 ≠ 没有问题」，一个什么都没检查的检查器是最坏的那种绿。
 *   2. 每个 Mach-O 的 `minos` ≤ `--max`。
 *   3. **拿不到版本信息就红**（既没有 `LC_BUILD_VERSION` 也没有 `LC_VERSION_MIN_MACOSX`）。
 *      「我读不出来」不等于「这里没问题」—— 与 check-elf-glibc 对 objdump 缺失的态度同源。
 *   4. platform 必须是 macOS(1)。一个 iOS/Catalyst 的 slice 混进 macOS 包里，
 *      在这台机器上永远起不来，而 `minos` 那个数字看上去还挺正常。
 *
 * 退出码：0 = 全部通过；1 = 有超标 / 数到 0 个 / 读不出版本 / platform 不对。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next !== undefined && !next.startsWith('--')) {
    args.set(key, next);
    i++;
  } else {
    args.set(key, 'true');
  }
}

const die = (msg) => {
  console.error(`\x1b[31mcheck-macho-minos: ${msg}\x1b[0m`);
  process.exit(1);
};

const dir = args.get('dir');
if (!dir) die('缺少 --dir <目录>');

const maxAllowed = args.get('max') ?? '13.3';
if (!/^\d+(\.\d+){0,2}$/.test(maxAllowed)) die(`--max 形如 13.3，得到 ${maxAllowed}`);

/**
 * 版本号按**数字逐段**比，不是字符串比。
 * 与 check-elf-glibc 同一条教训：字符串比会把 `9.0` 判成大于 `13.3`。
 */
const cmpVer = (a, b) => {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

const MH_MAGIC_64 = 0xfeedfacf; // 64 位、小端（我们所有产物都是这一种）
const MH_CIGAM_64 = 0xcffaedfe; // 64 位、大端字节序写下的同一个魔数
const FAT_MAGIC = 0xcafebabe; // universal binary（大端）
const FAT_MAGIC_64 = 0xcafebabf;

const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const PLATFORM_MACOS = 1;

/** LC_BUILD_VERSION / LC_VERSION_MIN_MACOSX 的版本编码：xxxx.yy.zz。 */
const decodeVer = (v) => `${v >>> 16}.${(v >>> 8) & 0xff}.${v & 0xff}`;

const PLATFORM_NAMES = {
  1: 'macOS',
  2: 'iOS',
  3: 'tvOS',
  4: 'watchOS',
  6: 'macCatalyst',
  7: 'iOSSimulator',
};

/**
 * 解析一个 thin Mach-O（从 buf 的 base 偏移开始），返回
 * `{ platform, minos, sdk, source }`，读不出来就返回 null。
 */
function parseThin(buf, base) {
  if (base + 32 > buf.length) return null;
  const magic = buf.readUInt32LE(base);
  const be = magic === MH_CIGAM_64;
  if (magic !== MH_MAGIC_64 && !be) return null;
  const u32 = (off) => (be ? buf.readUInt32BE(off) : buf.readUInt32LE(off));
  const ncmds = u32(base + 16);
  let off = base + 32;
  for (let i = 0; i < ncmds; i++) {
    if (off + 8 > buf.length) return null;
    const cmd = u32(off);
    const size = u32(off + 4);
    if (size < 8) return null;
    if (cmd === LC_BUILD_VERSION && off + 20 <= buf.length) {
      return {
        platform: u32(off + 8),
        minos: decodeVer(u32(off + 12)),
        sdk: decodeVer(u32(off + 16)),
        source: 'LC_BUILD_VERSION',
      };
    }
    if (cmd === LC_VERSION_MIN_MACOSX && off + 16 <= buf.length) {
      // 老编译器产出的形式。它按定义就是 macOS，没有 platform 字段。
      return {
        platform: PLATFORM_MACOS,
        minos: decodeVer(u32(off + 8)),
        sdk: decodeVer(u32(off + 12)),
        source: 'LC_VERSION_MIN_MACOSX',
      };
    }
    off += size;
  }
  return null;
}

/**
 * 返回该文件里所有 slice 的版本信息。
 * universal binary 逐个 slice 都要看 —— 只看第一个的话，
 * 一个 minos 被抬高的 arm64 slice 可以躲在一个正常的 x86_64 slice 后面。
 */
function parseMachO(buf) {
  if (buf.length < 8) return null;
  const magic = buf.readUInt32BE(0);
  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    const nfat = buf.readUInt32BE(4);
    const wide = magic === FAT_MAGIC_64;
    const entry = wide ? 32 : 20;
    const slices = [];
    for (let i = 0; i < nfat; i++) {
      const p = 8 + i * entry;
      if (p + entry > buf.length) break;
      const offset = wide ? Number(buf.readBigUInt64BE(p + 8)) : buf.readUInt32BE(p + 8);
      slices.push(parseThin(buf, offset));
    }
    return { fat: true, slices };
  }
  const le = buf.readUInt32LE(0);
  if (le !== MH_MAGIC_64 && le !== MH_CIGAM_64) return null;
  return { fat: false, slices: [parseThin(buf, 0)] };
}

/** 是不是 Mach-O？判据是文件头魔数，不是扩展名（`.so` / `.dylib` / 无后缀都要认）。 */
async function readMachO(path) {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size < 8) return null;
    const buf = await readFile(path);
    return parseMachO(buf);
  } catch {
    return null;
  }
}

async function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isSymbolicLink()) continue; // 软链的目标本身也在列表里，别数两遍
      else {
        const parsed = await readMachO(p);
        if (parsed !== null) out.push({ file: p, parsed });
      }
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

const main = async () => {
  const found = await walk(dir);
  if (found.length === 0) {
    die(`${dir} 底下一个 Mach-O 都没数到。
  这不是"没问题"，这是"什么都没检查" —— 一个数到 0 个还报绿的检查器
  正是本仓 ci-prep C5 修掉的那个形状。`);
  }

  const rows = [];
  for (const { file, parsed } of found) {
    for (const [i, slice] of parsed.slices.entries()) {
      rows.push({
        file,
        slice: parsed.fat ? `[slice ${i}] ` : '',
        info: slice,
      });
    }
  }

  const unreadable = rows.filter((r) => r.info === null);
  const wrongPlatform = rows.filter(
    (r) => r.info !== null && r.info.platform !== PLATFORM_MACOS,
  );
  const over = rows.filter(
    (r) =>
      r.info !== null &&
      r.info.platform === PLATFORM_MACOS &&
      cmpVer(r.info.minos, maxAllowed) > 0,
  );

  let worst = '0.0.0';
  for (const r of rows) {
    if (r.info !== null && cmpVer(r.info.minos, worst) > 0) worst = r.info.minos;
  }

  console.log(
    `check-macho-minos: ${found.length} 个 Mach-O（${rows.length} 个 slice），` +
      `上限 minos ${maxAllowed}，实测最高 ${worst}`,
  );
  for (const r of rows) {
    const bad =
      r.info === null ||
      r.info.platform !== PLATFORM_MACOS ||
      cmpVer(r.info.minos, maxAllowed) > 0;
    const mark = bad ? '\x1b[31m✘\x1b[0m' : '\x1b[32m✔\x1b[0m';
    const desc =
      r.info === null
        ? '(读不出版本)'
        : `minos ${r.info.minos} sdk ${r.info.sdk} ${PLATFORM_NAMES[r.info.platform] ?? `platform=${r.info.platform}`}`;
    console.log(`  ${mark} ${desc.padEnd(46)} ${r.slice}${r.file}`);
  }

  if (unreadable.length > 0) {
    console.error('');
    console.error('\x1b[31m✘ 以下 Mach-O 既没有 LC_BUILD_VERSION 也没有 LC_VERSION_MIN_MACOSX：\x1b[0m');
    for (const r of unreadable) console.error(`  ${r.slice}${r.file}`);
    console.error('');
    console.error('「我读不出来」不等于「这里没问题」—— 一个连下限都没写的二进制，');
    console.error('它在哪些 macOS 上起得来是**未定义**的，而未定义的东西不许出厂。');
    process.exit(1);
  }

  if (wrongPlatform.length > 0) {
    console.error('');
    console.error('\x1b[31m✘ 以下 slice 的 platform 不是 macOS：\x1b[0m');
    for (const r of wrongPlatform) {
      console.error(
        `  ${r.slice}${r.file}  platform=${PLATFORM_NAMES[r.info.platform] ?? r.info.platform}`,
      );
    }
    process.exit(1);
  }

  if (over.length > 0) {
    console.error('');
    console.error(`\x1b[31m✘ 以下产物要求的 macOS 版本高于基线 ${maxAllowed}：\x1b[0m`);
    for (const r of over) {
      console.error(`  ${r.slice}${r.file}  minos ${r.info.minos}（sdk ${r.info.sdk}）`);
    }
    console.error('');
    console.error('成因几乎一定是**没有显式指定部署目标**，于是取了构建机自己的系统版本');
    console.error('（runner 是 macos-26）。修法：');
    console.error('  · CMake 项目   → -DCMAKE_OSX_DEPLOYMENT_TARGET=13.3');
    console.error('  · 直接调编译器 → -mmacosx-version-min=13.3');
    console.error('13.3 的来源是上游自己写的 build-xcframework.sh:5 `MACOS_MIN_OS_VERSION=13.3`。');
    console.error('');
    console.error('后果是**静默的**：dyld 直接拒绝加载，进程根本不启动。探针挂掉的表现是');
    console.error('「尚未探测到硬件能力」—— 与"这台机器真的没有 GPU"在界面上完全一样。');
    process.exit(1);
  }

  console.log(`\x1b[32m✔\x1b[0m 全部 minos ≤ ${maxAllowed}`);
};

main().catch((e) => die(String(e)));
