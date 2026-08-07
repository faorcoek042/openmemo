#!/usr/bin/env node
/**
 * ELF 产物的 **运行时下限**守卫：glibc（`GLIBC_`）+ C++ 运行时（`GLIBCXX_` / `CXXABI_`）。
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
 * ## 同一条规律的第二格：**C++ 运行时的下限**（T-预编译包第二阶段补上）
 *
 * `GLIBC_x.y` 只是这条规律的一半。C++ 写的原生模块还有第二条、**与 glibc 完全独立**
 * 的下限：`libstdc++.so.6` 的 **`GLIBCXX_x.y.z`** 与 **`CXXABI_x.y.z`** 符号版本。
 * 它由**编译器（GCC）**的新度决定，而不是 glibc —— 两者可以各走各的，
 * 于是「glibc 够新、libstdc++ 偏旧」的发行版是一个真实存在的格子。
 *
 * 这不是假想，是量出来的：
 *
 *   `[实测 2026-08-08 · objdump 2.47 · objdump -T]`
 *   `node_modules/.pnpm/better-sqlite3@13.0.2/…/prebuilds/linux-x64.node`
 *       GLIBC_2.34       ← **正好压线通过**旧版守卫的 `--max 2.34`，一路绿
 *       GLIBCXX_3.4.29     (GLIBCXX_3.4.29) _ZSt28__throw_bad_array_new_lengthv
 *       CXXABI_1.3.9       (CXXABI_1.3.9)   _ZdlPvm
 *
 *   也就是说：**这个文件在旧守卫下是绿的，但它要求比基线更新的 libstdc++。**
 *   一台 libstdc++ 偏旧的机器上，它会过掉我们所有的闸（装得上、sha256 对、自检绿），
 *   然后在 `require()` 那个 `.node` 时以 `symbol lookup error` 死掉。
 *   而我们**正要把这个文件装进预编译包**（D-17 §3.5 已经把这一格记成已知盲区，
 *   §9 把"补上它"列为第二阶段的活）—— 盲区从"理论上存在"变成"下一个 release 就碰到"。
 *
 * ## 为什么它必须是**守卫**而不是一条注释
 *
 * D-11 §8.2 自己写着：「**一条靠"记得别动它"维持的基线，等价于一条迟早会被绕过的基线**」。
 * 那条基线此前只存在于 `build-backends.yml` 的一句 YAML 注释里（“刻意留 22.04 =
 * glibc 基线”），于是它被绕过了一次，而且是**在解决另一个问题的过程中顺手绕过的**。
 * C++ 那一格更甚：它此前连注释都不是守卫，只是 D-17 里的一句"建议第二阶段补"。
 *
 * ## 为什么后果是静默的（这条决定了守卫必须在 CI 上，而不能靠用户报障）
 *
 * `GGML_BACKEND_DL=ON` 下 `dlopen` 失败**不是错误**，只是"这个后端没注册上"：
 * whisper 照常用 CPU 跑完，用户只会觉得"装了 Vulkan 包但没变快"。
 * 安装记录是成功的，sha256 是对的，自检里也没有对应的检查项 —— **没有任何一处会说话。**
 * C++ 那一格的形状略有不同但同样难查：`.node` 加载失败是一条 `symbol lookup error`，
 * 而它出现在**用户的机器上**、我们的 CI 上永远不会出现。
 *
 * ## 用法
 *
 *   node scripts/ci/check-elf-glibc.mjs --dir <目录>
 *        [--max 2.34] [--max-glibcxx 3.4.29] [--max-cxxabi 1.3.9]
 *        [--allow-missing-objdump]
 *
 * 判据（三条，缺一不可）：
 *   1. 目录里**至少数到一个 ELF** —— 数到 0 个就红。
 *      “工具返回空集 ≠ 没有问题”，一个什么都没检查的检查器是最坏的那种绿。
 *   2. 每个 ELF 的最高符号版本 ≤ 对应上限，**三族各自独立判**：
 *      `GLIBC_x.y` ≤ `--max`、`GLIBCXX_x.y.z` ≤ `--max-glibcxx`、`CXXABI_x.y.z` ≤ `--max-cxxabi`。
 *      任何一族超标都红 —— 三个上限分开设，是因为它们由**不同的东西**决定
 *      （glibc 版本 vs 编译器版本），绑在一起就等于没有其中一条。
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
 * 版本号比较。三条都是踩过的：
 *   ① **必须按数字比** —— 字符串比会把 `2.9` 判成大于 `2.34`，
 *      于是一个完全合规的产物被报成超标（假红同样是谎）。
 *   ② **段数不固定** —— 真 objdump 里既有 `GLIBC_2.34` 也有 `GLIBC_2.2.5` / `GLIBC_2.3.4`。
 *      按两段写的正则会**静默跳过**三段的那些；这里它们都远低于阈值所以无害，
 *      但"无害地漏掉"正是下一个人接手时最容易信错的东西。
 *   ③ ★ **`GLIBCXX_` 是三段的，而且第三段会跑过 9**（`3.4.29` / `3.4.35` 都是真值）。
 *      于是这里同时有两个坑：`'3.4.29' < '3.4.9'`（字符串比，'2'<'9'）**和**
 *      `parseFloat('3.4.29') === 3.4`（浮点比，第三段整个被吃掉）——
 *      两种偷懒写法都会把一个超标的产物判成合规，也就是**静默放行**。
 *      逐段取整数比是唯一对的写法；`selftest-elf-glibc.mjs` ⑦⑧ 两条钉的就是它。
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

/* ═══════════════════════════════════════════════════════════════════════════════════
 * C++ 那两条上限的**默认值是怎么定的** —— 以及哪一段是实测、哪一段我证不出来
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * 想要的性质：默认值应当是「glibc 2.34 那条基线的 C++ 对应物」。
 * 麻烦在于这条对应关系是四跳 —— glibc 版本 → 发行版 → 该发行版的 GCC → GLIBCXX 版本 ——
 * 而**后两跳我在这台机器上证不出来**：
 *
 *   `[本机实测]` 这台是 Debian 13：`libstdc++6 16.1.0-3` → `libstdc++.so.6.0.35`，
 *       最高提供 `GLIBCXX_3.4.35`；`/root/trixie-rv` 的 riscv sysroot 是
 *       `libstdc++.so.6.0.33` → 最高 `GLIBCXX_3.4.33`。两个数据点都满足
 *       **`libstdc++.so.6.0.N` ⇔ 最高 `GLIBCXX_3.4.N`** —— 这条对用户是可操作的
 *       （下面超标时的报错就是照这条说的：“你的 .so.6.0.N 里 N 要 ≥ 29”）。
 *   `[未验证]` **GCC 11 ⇔ GLIBCXX_3.4.29 那一跳。** 本机只有 gcc-15/16 一代，
 *       装不到 gcc-11、也没有 21.10/22.04 的 libstdc++ 可以 dump。
 *       D-17 §3.5 与 `coordination/inbox/prebuilt.md` 都写着「3.4.29 = GCC 11 / Ubuntu 21.04+」，
 *       但那是**仓内既有结论，我没在本机复核过**，所以这里不拿它当依据；
 *       也不照抄一张凭记忆写下来的 GCC↔GLIBCXX 对照表 —— 那正是本仓禁的"编版本号"。
 *
 * 所以默认值取的是**本仓自己要发的产物实测需要多少**，不是从映射推出来的：
 *
 *   `[实测 2026-08-08 · objdump 2.47 · 逐个 objdump -T]` linux-x64 要进包的原生件：
 *     better-sqlite3@13.0.2  prebuilds/linux-x64.node   GLIBC_2.34  GLIBCXX_3.4.29  CXXABI_1.3.9
 *     sherpa-onnx-linux-x64@1.13.4  sherpa-onnx.node    GLIBC_2.14  GLIBCXX_3.4.29  CXXABI_1.3.9
 *     …/libsherpa-onnx-c-api.so                         GLIBC_2.16  GLIBCXX_3.4.18  CXXABI_1.3.7
 *     …/libonnxruntime.so                               GLIBC_2.16  GLIBCXX_3.4.19  CXXABI_1.3.7
 *     …/libsherpa-onnx-cxx-api.so                       GLIBC_2.14  GLIBCXX_3.4.14  CXXABI_1.3
 *
 *   **两个互相独立的上游包同时落在 `3.4.29 / 1.3.9` 这一对上**，其余四项都更低。
 *   → 默认 `--max-glibcxx 3.4.29` / `--max-cxxabi 1.3.9`：**贴着实测值卡的棘轮**。
 *     今天一条都不红；而任何一次"换台机器编、换个上游版本就悄悄涨一格"会立刻红。
 *     这跟 `--max 2.34` 是同一种取法（2.34 也是 Ubuntu 22.04 上编出来的实测值，
 *     不是查表查来的）。
 *
 * `UNKNOWN` —— whisper.cpp 那几个包（`libggml-*.so` / `whisper-cli` / `openmemo-probe`）
 *   的 C++ 下限**本轮没量到**：它们只存在于运行时数据目录里，本次作业不许碰那个目录；
 *   /tmp 下同名的几份是别的用例留下的 **0 字节**桩，量不出东西。
 *   它们由 `buildbox.Dockerfile` 的 `BASE_IMAGE=ubuntu:22.04` 编出，按上面那条
 *   **证不出的**映射*推测*也在 3.4.29 一线 —— 但那是推测，不是依据。
 *   → 万一 CI 上这条新门槛把 whisper 包报红：**先把它当成真发现去读那几个符号名**，
 *     不要先去调高默认值。调高上限是把结论改成想要的样子。
 *
 * 为什么只加这两族、没顺手加 `GCC_x.y`（libgcc_s）：
 *   `[实测]` 上面五个产物引用到的最高 `GCC_` 版本是 `GCC_4.0.0`（libonnxruntime.so），
 *   better-sqlite3 的 `.node` 一条 `GCC_` 都没有。离任何现役发行版都远到没有意义 ——
 *   **加一条永远不会红的守卫等于加噪音**。哪天真有产物引到 `GCC_7` 以上，
 *   照 FAMILIES 的形状加第四族即可（这也是把三族写成表而不是写死三段的原因）。
 * ═══════════════════════════════════════════════════════════════════════════════════ */

/**
 * 被查的三个符号版本族。加一族 = 往这张表里加一行 + 加一条 `--max-*`。
 *
 * `check` 的正则形状是共用的（见 VER_LINE），这里只记「叫什么、从哪个 flag 取上限、
 * 默认多少、超标时该说什么」。`hint` 是超标时打给人看的那段 —— 两族的后果不同形，
 * 所以不能共用一句话：glibc 那条是 dlopen 静默失败，C++ 这条是 symbol lookup error。
 */
const FAMILIES = [
  {
    key: 'GLIBC',
    flag: 'max',
    def: '2.34',
    /** 历史行为：`--max` 一直只收两段。不放宽，避免把 `--max 2.34.0` 这种写法悄悄变成合法。 */
    shape: /^\d+\.\d+$/,
    shapeHint: '2.34',
  },
  {
    key: 'GLIBCXX',
    flag: 'max-glibcxx',
    def: '3.4.29',
    /** GLIBCXX 真实取值既有两段（`3.4`）也有三段（`3.4.29`），所以收 1 段以上任意。 */
    shape: /^\d+(?:\.\d+)+$/,
    shapeHint: '3.4.29',
  },
  {
    key: 'CXXABI',
    flag: 'max-cxxabi',
    def: '1.3.9',
    shape: /^\d+(?:\.\d+)+$/,
    shapeHint: '1.3.9',
  },
];

/**
 * 一条 `objdump -T` 输出行里的「**引用到的**符号版本」。
 *
 * ★ 交替分支必须**长的在前**（`GLIBCXX` 在 `GLIBC` 之前）。反过来写虽然靠回溯也能
 *   碰对，但那是在赌引擎的行为；写成长在前，`(GLIBCXX_3.4.29)` 被算进 GLIBC 族这件事
 *   在**读代码**这一层就不可能发生。`selftest-elf-glibc.mjs` ⑩ 钉的就是这条。
 *
 * ★ 只认**带括号**的形式，这是有意的：`[实测]` objdump -T 里带括号的 `(VER)` 是
 *   "这个文件要用到的版本"，不带括号的是"这个文件自己提供的版本"。
 *   拿 `/usr/lib/x86_64-linux-gnu/libstdc++.so.6` 量：194 行带括号，其中 167 行是 `*UND*`
 *   （真引用），另外 27 行是它自己的**兼容版本**定义（全部是 `GLIBCXX_3.4` / `3.4.11`，
 *   远低于它的最高值 3.4.35）。也就是说：即便把一个 libstdc++ 本体扫进来，
 *   读出的也是低值，**不会造成假红**。
 */
const VER_LINE = /\((GLIBCXX|CXXABI|GLIBC)_(\d+(?:\.\d+)+)\)\s+(\S+)\s*$/;

/** 每一族的上限：从 `--max-*` 取，缺省用表里的默认值，形状不对就当场红。 */
const maxOf = {};
for (const fam of FAMILIES) {
  const v = args.get(fam.flag) ?? fam.def;
  if (!fam.shape.test(v)) die(`--${fam.flag} 形如 ${fam.shapeHint}，得到 ${v}`);
  maxOf[fam.key] = v;
}
/** 保留原名：底下的输出串与 lint/文档里引用的都是这个值。 */
const maxAllowed = maxOf.GLIBC;

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
  /* GLIBC 那格的初值刻意保留 `'0.0'`：一个 GLIBC 引用都没有时，第一行照旧打
   * “实测最高 GLIBC_0.0”，与历史输出逐字一致（inbox 里好几份记录抄的是这一行）。
   * 新加的两族没有历史包袱，用 null，打成 `(无)` 更诚实 —— “0.0” 会被读成一个版本号。 */
  const worst = { GLIBC: '0.0', GLIBCXX: null, CXXABI: null };
  for (const f of files) {
    let stdout = '';
    try {
      ({ stdout } = await run('objdump', ['-T', f], { maxBuffer: 64 * 1024 * 1024 }));
    } catch (err) {
      die(`objdump -T 在 ${f} 上失败：${String(err)}`);
    }
    /** family -> Map<版本, 符号名[]>。一次遍历同时收三族，objdump 仍然只跑一次。 */
    const byFamily = new Map(FAMILIES.map((fam) => [fam.key, new Map()]));
    for (const line of stdout.split('\n')) {
      const m = VER_LINE.exec(line.trimEnd());
      if (!m) continue;
      const table = byFamily.get(m[1]);
      if (table === undefined) continue;
      const list = table.get(m[2]) ?? [];
      list.push(m[3]);
      table.set(m[2], list);
    }
    const row = { file: f, top: {}, symbols: {} };
    for (const fam of FAMILIES) {
      const table = byFamily.get(fam.key);
      const top = [...table.keys()].sort(cmpVer).pop() ?? null;
      row.top[fam.key] = top;
      row.symbols[fam.key] = top === null ? [] : (table.get(top) ?? []);
      if (top !== null && (worst[fam.key] === null || cmpVer(top, worst[fam.key]) > 0)) {
        worst[fam.key] = top;
      }
    }
    rows.push(row);
  }

  /** 某一族里超标的行。三族各判各的 —— 一族绿不能替另一族背书。 */
  const overIn = (key) => rows.filter((r) => r.top[key] !== null && cmpVer(r.top[key], maxOf[key]) > 0);
  const over = { GLIBC: overIn('GLIBC'), GLIBCXX: overIn('GLIBCXX'), CXXABI: overIn('CXXABI') };
  const overFiles = new Set(FAMILIES.flatMap((fam) => over[fam.key].map((r) => r.file)));

  // 第一行**逐字保留原格式**：inbox / D-17 / runner-migrate 里多处抄了它，
  // 改格式等于让那些历史记录对不上号。C++ 那两族另起一行，不挤进这一行。
  console.log(`check-elf-glibc: ${files.length} 个 ELF，上限 GLIBC_${maxAllowed}，实测最高 GLIBC_${worst.GLIBC}`);
  const shown = (key) => (worst[key] === null ? '(无)' : `${key}_${worst[key]}`);
  console.log(
    `check-elf-glibc: C++ 运行时上限 GLIBCXX_${maxOf.GLIBCXX} / CXXABI_${maxOf.CXXABI}，` +
      `实测最高 ${shown('GLIBCXX')} / ${shown('CXXABI')}`,
  );
  for (const r of rows) {
    const mark = overFiles.has(r.file) ? '\x1b[31m✘\x1b[0m' : '\x1b[32m✔\x1b[0m';
    const glibcCell = r.top.GLIBC === null ? '(无 GLIBC 引用)'.padEnd(8) : `GLIBC_${r.top.GLIBC}`.padEnd(12);
    const cxxCell = r.top.GLIBCXX === null ? '(无)'.padEnd(16) : `GLIBCXX_${r.top.GLIBCXX}`.padEnd(16);
    const abiCell = r.top.CXXABI === null ? '(无)'.padEnd(14) : `CXXABI_${r.top.CXXABI}`.padEnd(14);
    console.log(`  ${mark} ${glibcCell} ${cxxCell} ${abiCell} ${r.file}`);
  }

  if (over.GLIBC.length > 0) {
    console.error('');
    console.error('\x1b[31m✘ 以下产物的 glibc 下限高于基线：\x1b[0m');
    for (const r of over.GLIBC) {
      console.error(`  ${r.file}  需要 GLIBC_${r.top.GLIBC}`);
      // 点名具体符号，这让结论不是推测 —— D-11 §8.2 就是靠这三个符号名定的性。
      for (const s of [...new Set(r.symbols.GLIBC)].sort().slice(0, 12)) {
        console.error(`      (GLIBC_${r.top.GLIBC}) ${s}`);
      }
    }
    console.error('');
    console.error(`发行版对照：Ubuntu 22.04 = 2.35 · Debian 12 = 2.36 · Ubuntu 24.04 = 2.39 · Debian 13 = 2.41`);
    console.error(`后果是**静默的**：GGML_BACKEND_DL 下 dlopen 失败只是"后端没注册上"，`);
    console.error(`whisper 照常用 CPU 跑完 —— 装得上、校验过、自检看得见的那一层全绿。`);
  }

  for (const fam of FAMILIES.filter((x) => x.key !== 'GLIBC')) {
    if (over[fam.key].length === 0) continue;
    console.error('');
    console.error(`\x1b[31m✘ 以下产物的 C++ 运行时（libstdc++）下限高于基线（${fam.key}）：\x1b[0m`);
    for (const r of over[fam.key]) {
      console.error(`  ${r.file}  需要 ${fam.key}_${r.top[fam.key]}`);
      // 与 glibc 那段同一条纪律：点名符号，结论才不是推测。
      // 名字是 mangled 的（`_ZSt28__throw_bad_array_new_lengthv`）—— `c++filt` 或 `objdump -TC` 可读。
      for (const s of [...new Set(r.symbols[fam.key])].sort().slice(0, 12)) {
        console.error(`      (${fam.key}_${r.top[fam.key]}) ${s}`);
      }
    }
  }

  if (over.GLIBCXX.length > 0 || over.CXXABI.length > 0) {
    console.error('');
    console.error(
      `libstdc++ 对照：\`[本机实测，两个数据点]\` libstdc++.so.6.0.N 提供到 GLIBCXX_3.4.N` +
        `（Debian 13 的 .so.6.0.35 → 3.4.35；trixie riscv sysroot 的 .so.6.0.33 → 3.4.33）。`,
    );
    console.error(
      `→ 我们承诺给用户的地板是「libstdc++.so.6.0.N 里 N ≥ ${maxOf.GLIBCXX.split('.').pop()}」；` +
        `上面这些产物要的比它高，等于**把地板悄悄抬走了**。`,
    );
    console.error(`GCC↔GLIBCXX 的完整对照表 \`[未验证]\`（本机只有 gcc-15/16 一代，证不出 GCC 11 那一跳），`);
    console.error(`所以默认上限取的是本仓产物的**实测值**而不是查表值 —— 详见本文件顶部那段注释。`);
    console.error(`后果同样查不到：\`.node\` 加载失败是一条 symbol lookup error，`);
    console.error(`而它只出现在**用户的机器上**，我们的 CI 与构建机上永远不会出现。`);
  }

  if (overFiles.size > 0) process.exit(1);

  console.log(
    `\x1b[32m✔\x1b[0m 全部 ≤ GLIBC_${maxAllowed} · GLIBCXX_${maxOf.GLIBCXX} · CXXABI_${maxOf.CXXABI}`,
  );
};

main().catch((e) => die(String(e)));
