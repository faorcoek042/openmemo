#!/usr/bin/env node
/**
 * ELF 产物的 **glibc 运行时下限**守卫。
 *
 * ## 它防的是哪一件事
 *
 * D-11 §8.0 那一族：「构建机总是那个最新、装得最全的环境，而用户的机器不是。凡是
 * 不显式指定就取构建机当前值的东西，都会把构建机的新度焊进产物」。Linux 这一格的
 * 具体形态是 **`GLIBC_x.y` 符号版本**：
 *
 *   `[实测]` `whispercpp-vulkan-linux-x64` 需要 **GLIBC_2.38**，具体是三个符号
 *       (GLIBC_2.38) __isoc23_strtoul / __isoc23_strtoull / __isoc23_strtol
 *   —— C23 的 strtol 家族。GCC 13+ / glibc 2.38 起，编译器会把普通的 `strtol`
 *   **自动重定向**到 `__isoc23_*` 变体。**源码一个字没改，换台机器编就多了一条下限。**
 *
 *   成因可以指名道姓：cpu 腿刻意留在 `ubuntu-22.04` 当 glibc 基线，
 *   而 vulkan/cuda 为了拿 `glslc` 被挪到 24.04（D-11 §4.2）——
 *   那次挪动解决了编译问题，同时把运行时下限从 2.34 抬到 2.38，**没有人注意到**。
 *
 * ## 为什么它必须是**守卫**而不是一条注释
 *
 * D-11 §8.2 自己写着：「**一条靠"记得别动它"维持的基线，等价于一条迟早会被绕过的基线**」。
 * 那条基线此前只存在于 `build-backends.yml` 的一句 YAML 注释里（“刻意留 22.04 =
 * glibc 基线”），于是它被绕过了一次，而且是**在解决另一个问题的过程中顺手绕过的**。
 *
 * ## 为什么后果是静默的（这条决定了守卫必须在 CI 上，而不能靠用户报障）
 *
 * `GGML_BACKEND_DL=ON` 下 `dlopen` 失败**不是错误**，只是"这个后端没注册上"：
 * whisper 照常用 CPU 跑完，用户只会觉得"装了 Vulkan 包但没变快"。
 * 安装记录是成功的，sha256 是对的，自检里也没有对应的检查项 —— **没有任何一处会说话。**
 *
 * ## 用法
 *
 *   node scripts/ci/check-elf-glibc.mjs --dir <目录> [--max 2.34] [--allow-missing-objdump]
 *
 * 判据（三条，缺一不可）：
 *   1. 目录里**至少数到一个 ELF** —— 数到 0 个就红。
 *      “工具返回空集 ≠ 没有问题”，一个什么都没检查的检查器是最坏的那种绿。
 *   2. 每个 ELF 的最高 `GLIBC_x.y` 引用 ≤ `--max`。
 *   3. `objdump` 必须真的存在并真的产出了动态符号表；拿不到就红（除非显式
 *      `--allow-missing-objdump`，那是给本机开发用的，CI 上不许传）。
 *
 * 退出码：0 = 全部通过；1 = 有超标 / 没数到东西 / 工具不可用。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

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
  console.error(`\x1b[31mcheck-elf-glibc: ${msg}\x1b[0m`);
  process.exit(1);
};

const dir = args.get('dir');
if (!dir) die('缺少 --dir <目录>');

/**
 * 版本号比较。两条都是踩过的：
 *   ① **必须按数字比** —— 字符串比会把 `2.9` 判成大于 `2.34`，
 *      于是一个完全合规的产物被报成超标（假红同样是谎）。
 *   ② **段数不固定** —— 真 objdump 里既有 `GLIBC_2.34` 也有 `GLIBC_2.2.5` / `GLIBC_2.3.4`。
 *      按两段写的正则会**静默跳过**三段的那些；这里它们都远低于阈值所以无害，
 *      但"无害地漏掉"正是下一个人接手时最容易信错的东西。
 */
const cmpVer = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

const maxAllowed = args.get('max') ?? '2.34';
if (!/^\d+\.\d+$/.test(maxAllowed)) die(`--max 形如 2.34，得到 ${maxAllowed}`);

/** ELF 魔数。判据是文件头，不是扩展名 —— `.so.0.15.1` / 无后缀的可执行文件都要认。 */
async function isElf(path) {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size < 4) return false;
    const fh = await readFile(path, { flag: 'r' });
    return fh[0] === 0x7f && fh[1] === 0x45 && fh[2] === 0x4c && fh[3] === 0x46;
  } catch {
    return false;
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
      else if (e.isSymbolicLink()) continue; // 软链指向的目标本身也在列表里，别数两遍
      else if (await isElf(p)) out.push(p);
    }
  }
  return out.sort();
}

const main = async () => {
  let objdumpOk = true;
  try {
    await run('objdump', ['--version']);
  } catch {
    objdumpOk = false;
  }
  if (!objdumpOk) {
    if (args.get('allow-missing-objdump') === 'true') {
      console.log('check-elf-glibc: 本机没有 objdump，按 --allow-missing-objdump 跳过');
      process.exit(0);
    }
    die('本机没有 objdump（binutils）。不装它就没法回答这个问题 —— 而"没法回答"不等于"没问题"。');
  }

  const files = await walk(dir);
  if (files.length === 0) {
    die(`${dir} 底下一个 ELF 都没数到。
  这不是"没问题"，这是"什么都没检查" —— 一个数到 0 个还报绿的检查器
  正是本仓 ci-prep C5 修掉的那个形状。`);
  }

  const rows = [];
  let worst = '0.0';
  for (const f of files) {
    let stdout = '';
    try {
      ({ stdout } = await run('objdump', ['-T', f], { maxBuffer: 64 * 1024 * 1024 }));
    } catch (err) {
      die(`objdump -T 在 ${f} 上失败：${String(err)}`);
    }
    const versions = new Set();
    const symbols = new Map();
    for (const line of stdout.split('\n')) {
      const m = /\(GLIBC_(\d+(?:\.\d+)+)\)\s+(\S+)\s*$/.exec(line.trimEnd());
      if (!m) continue;
      versions.add(m[1]);
      const list = symbols.get(m[1]) ?? [];
      list.push(m[2]);
      symbols.set(m[1], list);
    }
    const top = [...versions].sort(cmpVer).pop() ?? null;
    if (top !== null && cmpVer(top, worst) > 0) worst = top;
    rows.push({ file: f, top, symbols: top === null ? [] : (symbols.get(top) ?? []) });
  }

  const over = rows.filter((r) => r.top !== null && cmpVer(r.top, maxAllowed) > 0);

  console.log(`check-elf-glibc: ${files.length} 个 ELF，上限 GLIBC_${maxAllowed}，实测最高 GLIBC_${worst}`);
  for (const r of rows) {
    const mark = r.top !== null && cmpVer(r.top, maxAllowed) > 0 ? '\x1b[31m✘\x1b[0m' : '\x1b[32m✔\x1b[0m';
    console.log(`  ${mark} ${r.top === null ? '(无 GLIBC 引用)'.padEnd(8) : `GLIBC_${r.top}`.padEnd(12)} ${r.file}`);
  }

  if (over.length > 0) {
    console.error('');
    console.error('\x1b[31m✘ 以下产物的 glibc 下限高于基线：\x1b[0m');
    for (const r of over) {
      console.error(`  ${r.file}  需要 GLIBC_${r.top}`);
      // 点名具体符号，这让结论不是推测 —— D-11 §8.2 就是靠这三个符号名定的性。
      for (const s of [...new Set(r.symbols)].sort().slice(0, 12)) {
        console.error(`      (GLIBC_${r.top}) ${s}`);
      }
    }
    console.error('');
    console.error(`发行版对照：Ubuntu 22.04 = 2.35 · Debian 12 = 2.36 · Ubuntu 24.04 = 2.39 · Debian 13 = 2.41`);
    console.error(`后果是**静默的**：GGML_BACKEND_DL 下 dlopen 失败只是"后端没注册上"，`);
    console.error(`whisper 照常用 CPU 跑完 —— 装得上、校验过、自检看得见的那一层全绿。`);
    process.exit(1);
  }

  console.log(`\x1b[32m✔\x1b[0m 全部 ≤ GLIBC_${maxAllowed}`);
};

main().catch((e) => die(String(e)));
