#!/usr/bin/env node
/**
 * 「包里必须提供它自己**导入表**所要求的每一个非系统库」—— 收集 + 守卫，同一份判据。
 *
 * ## 这个文件存在的理由（一条确定坏掉的产物）
 *
 * `[实测 2026-08-09]` 我们自己的两个 CUDA 包**装得上、加载不了**：
 *
 * ```
 * ggml-cuda.dll 的 PE 导入表：cublas64_12.dll · cudart64_12.dll · nvcuda.dll · ggml-base.dll · …
 * libggml-cuda.so 的 DT_NEEDED：libcudart.so.12 · libcublas.so.12 · libcuda.so.1 · …
 *
 * whispercpp-cuda-win-x64    19 个文件 —— 无 cudart64 / cublas64 / cublasLt64
 * whispercpp-cuda-linux-x64  24 个文件 —— 无 libcudart.so.12 / libcublas.so.12
 * ```
 *
 * 成因是 `build-whisper.sh` 里那句
 * `copy_if_exists "${BIN_DIR}/cudart64_"*.dll …`：
 *
 *   ① 它只在**构建输出目录**里找，而 CMake 不会把 toolkit 的 DLL 拷到 `bin/Release`；
 *   ② Linux 侧那几个 glob 还是 **Windows 命名**（`cudart64_*.dll`），永远匹配不到；
 *   ③ `copy_if_exists` 的语义是「有就拷、没有就算」——**它一声不吭**。
 *
 * ③ 才是要害，它属于本仓记账里的「**静默 no-op**」那一族
 * （同族：`git commit -- <pathspec>` 对未跟踪文件是静默 no-op，PROTOCOL §12）。
 * 而后果落在最贵的那一族上：`GGML_BACKEND_DL=ON` 下 `dlopen` 失败**不是错误**，
 * 只是"这个后端没注册上" → whisper 照常用 CPU 跑完 → 用户只觉得"装了 CUDA 包但没变快"。
 *
 * ## 判据：**问二进制自己，不问手写清单**
 *
 * 需要哪些库，是从 ELF 的 `DT_NEEDED` / PE 的导入表**反推**出来的 ——
 * 手写清单会和现实漂移（上面那条就是"清单写的是 Windows 名字"），而导入表是二进制自己说的。
 * 而且是**传递闭包**：拷进来一个 `libcublas.so.12` 之后会再问它一遍，
 * 于是 `libcublasLt.so.12` 被自动带上，**不需要有人知道它的存在**。
 *
 * 唯一手写的是下面那张**例外表**：哪些名字由操作系统/显卡驱动提供。
 * 它必须手写（"谁提供"不写在二进制里），所以每一条都带理由和出处，且**分类是封闭的**：
 * 不在例外表里 = 必须随包。**没有"默认放过"这一档。**
 *
 * ## 用法
 *
 *   # 收集：把缺的非系统依赖从 --search 里拷进 --dir，做到不动点；拷不到就红
 *   node scripts/ci/pack-native-deps.mjs --collect --dir <stage> --search <d1>[:<d2>...]
 *
 *   # 守卫：只检查，不改动。缺任何一个必需件就红
 *   node scripts/ci/pack-native-deps.mjs --verify --dir <stage>
 *
 * 纯 Node，零依赖，不调 `objdump`/`dumpbin`：构建 job 刻意不跑 `pnpm install`，
 * 而 Windows runner 上没有 binutils —— 一个"只在 Linux 上跑得起来的守卫"
 * 等于在 Windows 上什么都没断言（D-11 §3.3 那一族）。
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  copyFileSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';

// =======================================================================================
// 例外表 —— 唯一手写的部分。每一条都要有理由，改动它等于改变"什么算自包含"。
// =======================================================================================

/**
 * `os`：随操作系统出厂。
 * `driver`：随显卡驱动出厂，**且我们不该也不能随包分发**
 *           （NVIDIA CUDA EULA 的 Attachment A 把 `libcuda.so` 列在
 *            "NVIDIA CUDA Driver Libraries"；`nvcuda.dll` 根本不在可再分发表里。
 *            上游 whisper.cpp 的 678 MB 包里也确实没有它 —— 这一点我们和上游都做对了）。
 * `known-gap`：**不是系统件，我们今天确实没带** —— 已立案、有出处、有计数，
 *              打印为警告而不是红。见下面 `KNOWN_GAPS` 的注释。
 */
const OS_PROVIDED_ELF = [
  // glibc / gcc 运行时：任何 Linux 发行版都有。真正的下限由 check-elf-glibc.mjs 守。
  /^ld-linux.*\.so\.\d+$/,
  /^linux-vdso\.so\.\d+$/,
  /^libc\.so\.\d+$/,
  /^libm\.so\.\d+$/,
  /^libdl\.so\.\d+$/,
  /^librt\.so\.\d+$/,
  /^libpthread\.so\.\d+$/,
  /^libresolv\.so\.\d+$/,
  /^libstdc\+\+\.so\.\d+$/,
  /^libgcc_s\.so\.\d+$/,
  /^libgomp\.so\.\d+$/,
];

const OS_PROVIDED_PE = [
  /^KERNEL32\.dll$/i,
  /^KERNELBASE\.dll$/i,
  /^USER32\.dll$/i,
  /^GDI32\.dll$/i,
  /^ADVAPI32\.dll$/i,
  /^SHELL32\.dll$/i,
  /^SHLWAPI\.dll$/i,
  /^ole32\.dll$/i,
  /^OLEAUT32\.dll$/i,
  /^WS2_32\.dll$/i,
  /^bcrypt\.dll$/i,
  /^CRYPT32\.dll$/i,
  /^dbghelp\.dll$/i,
  /^VERSION\.dll$/i,
  /^POWRPROF\.dll$/i,
  /^SETUPAPI\.dll$/i,
  /^CFGMGR32\.dll$/i,
  /^IMM32\.dll$/i,
  /^WINMM\.dll$/i,
  // Universal CRT —— Windows 10 起随系统出厂。
  /^api-ms-win-.*\.dll$/i,
  /^ucrtbase\.dll$/i,
];

/**
 * 显卡驱动提供的。**这一类永远不收集** —— 不是"忘了带"，是"不许带"。
 *   nvcuda.dll / libcuda.so.1  : CUDA Driver API，随 NVIDIA 显示驱动安装
 *                                （docs.nvidia.com/deploy/cuda-compatibility：
 *                                 "The driver package includes both the user mode
 *                                  CUDA driver (libcuda.so) and kernel mode components"）
 *   vulkan-1.dll / libvulkan.so.1 : Vulkan loader，随显卡驱动 / 系统的 Vulkan 运行时安装
 */
const DRIVER_PROVIDED = [
  /^nvcuda\.dll$/i,
  /^libcuda\.so\.\d+$/,
  /^nvml\.dll$/i,
  /^libnvidia-ml\.so\.\d+$/,
  /^vulkan-1\.dll$/i,
  /^libvulkan\.so\.\d+$/,
];

/**
 * ⚠️ **已立案、今天确实没带的缺口** —— 打印为警告，不判红。
 *
 * `MSVCP140.dll` / `VCRUNTIME140*.dll` = VC++ 2015-2022 可再发行组件。
 * **它不随干净 Windows 出厂**，所以严格说这也是"缺件"。
 * 但它是 D-11 §8.3 立过案的**既有债**，覆盖**我们全部**自建 Windows 原生产物
 * （不只是 CUDA 包，CPU 包同样），处置方式是产品级决定（装 redist / 静态链接 CRT），
 * 不属于"补齐 CUDA 运行库"这一次改动。
 *
 * **把它算成红会做两件坏事**：① 让一条与本次改动无关的既有债阻断 CUDA 的修复；
 * ② 让人为了让 CI 绿而去放宽这张表 —— 那才是真正的滑坡。
 * 所以它单列一档：**有名字、有出处、有计数、每次都打印**，而不是被默默归进 `os`。
 *
 * 判据：这一档**只能**装这四个名字。往里加任何别的东西都需要在这里写下理由。
 */
const KNOWN_GAPS = [
  {
    re: /^MSVCP140(_\d+)?\.dll$/i,
    why: 'VC++ 2015-2022 可再发行组件（D-11 §8.3，既有债，覆盖全部自建 Windows 产物）',
  },
  { re: /^VCRUNTIME140(_\d+)?\.dll$/i, why: '同上' },
  { re: /^CONCRT140\.dll$/i, why: '同上' },
  { re: /^MSVCP140_ATOMIC_WAIT\.dll$/i, why: '同上' },
  // ★ 这一条是**这个守卫自己查出来的**（2026-08-09 第一次跑）：上游的 `ggml-base.dll`
  //   导入 `VCOMP140.DLL`（OpenMP 运行时），它同属 VC++ 可再发行组件，我们同样没带。
  //   在此之前**没有任何一处提过它** —— D-11 §8.3 只点了 MSVCP140 / VCRUNTIME140*。
  {
    re: /^VCOMP140(_\d+)?\.DLL$/i,
    why: 'OpenMP 运行时，同属 VC++ 可再发行组件。★ 本守卫首次运行时新发现，D-11 §8.3 原来没列它',
  },
];

/**
 * ★★ **随包分发第三方二进制 ⇒ 同一个包里必须带它的许可证文本。**
 *
 * 这张表是**法律事实**，导不出来 —— 二进制自己不会说"我需要附一份 EULA"。
 * 所以它手写，但**失败方向是关的**：触发了却找不到文本 = 红。
 *
 * NVIDIA CUDA Toolkit EULA（deb 装出来是 `/usr/share/doc/cuda-<组件>-12-4/copyright` 的全文，
 * 也就是 docs.nvidia.com/cuda/eula 的同一份），我逐条读过原文之后，
 * 与"打包"直接相关的是这两条：
 *
 *   §1.1.2(5) "The terms under which you distribute your application must be
 *              consistent with the terms of this Agreement…"
 *              → 把 EULA 全文放进包里，是让这一条可核验的最小做法。
 *   §2.3      "…may be copied and redistributed … **provided that the object code
 *              files are not modified in any way** (except for unzipping of
 *              compressed files)."
 *              → 所以这些库**绝不能被 strip**。见下面 `--record` / `--assert-unmodified`：
 *                收集时记下源文件 sha256，出厂前再比一次，**改过就是红**。
 *
 * ⚠️ 覆盖面按**实际带了什么**算：我们只带 cudart + cublas + cublasLt 三个，
 *    `nvrtc` / `nvblas` 虽然也在 Attachment A 里，但我们不带，也就不在清单上。
 */
const LICENSE_REQUIRED = [
  {
    name: 'NVIDIA CUDA Toolkit EULA',
    // 真实文件名：libcublas.so.12 / libcublasLt.so.12 / libcudart.so.12 /
    //             cublas64_12.dll / cublasLt64_12.dll / cudart64_12.dll
    trigger: /^(lib)?(cublasLt|cublas|cudart|nvrtc|nvblas)(64_\d+\.dll|\.so(\.\d+)*|\.dylib)$/i,
    file: 'LICENSE-NVIDIA-CUDA-EULA.txt',
    url: 'https://docs.nvidia.com/cuda/eula/index.html',
    spdx: 'LicenseRef-NVIDIA-CUDA-EULA',
  },
];

const classify = (name) => {
  if (OS_PROVIDED_ELF.some((r) => r.test(name)) || OS_PROVIDED_PE.some((r) => r.test(name)))
    return 'os';
  if (DRIVER_PROVIDED.some((r) => r.test(name))) return 'driver';
  const gap = KNOWN_GAPS.find((g) => g.re.test(name));
  if (gap) return 'known-gap';
  return 'must-ship';
};
const gapReason = (name) => KNOWN_GAPS.find((g) => g.re.test(name))?.why ?? '';

// =======================================================================================
// 二进制解析 —— 纯 Node
// =======================================================================================

const isElf = (b) =>
  b.length > 16 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;
/**
 * ⚠️ **Mach-O 只认得出、读不了 —— 这是本守卫已知的覆盖面缺口，必须打印出来。**
 *
 * 读 macOS 的 `LC_LOAD_DYLIB` 我写得出来，但**这台机器上没有任何 Mach-O 可以拿来核对**
 * （ELF 那一半是与 `objdump -p` 交叉核对过的，PE 那一半有现造的最小 PE）。
 * 把一个**没验过**的解析器放进一条**当前是绿的**构建腿，风险大于收益：
 * 它红了会挡住 macOS 出包，而它"绿得不对"更糟 —— 那就是一个假装在检查的守卫。
 *
 * 所以这里的处置是：**认出来、数出来、每次都打印**，而不是安静地当成"没有二进制"。
 * （安静地当成没有 = 下面那条"数到 0 个就红"会把 macOS 腿打红，
 *   而那条红指向的是错的原因 —— 比不检查更坏。）
 */
const isMachO = (b) => {
  if (b.length < 4) return false;
  const m = b.readUInt32BE(0);
  // 32/64 位、大小端、以及 universal（fat）四种魔数
  return (
    m === 0xfeedface ||
    m === 0xfeedfacf ||
    m === 0xcefaedfe ||
    m === 0xcffaedfe ||
    m === 0xcafebabe ||
    m === 0xbebafeca
  );
};

const isPe = (b) => {
  if (b.length < 0x40 || b[0] !== 0x4d || b[1] !== 0x5a) return false;
  const off = b.readUInt32LE(0x3c);
  return off > 0 && off + 4 <= b.length && b.toString('ascii', off, off + 4) === 'PE\0\0';
};

/** ELF 的 DT_NEEDED 列表。DT_STRTAB 是**虚拟地址**，要用 PT_LOAD 翻回文件偏移。 */
function elfNeeded(buf) {
  const cls = buf[4]; // 1=ELF32 2=ELF64
  if (cls !== 2) throw new Error('只支持 ELF64（本仓产物全是 x86_64 / arm64）');
  if (buf[5] !== 1) throw new Error('只支持小端 ELF');
  const phoff = Number(buf.readBigUInt64LE(0x20));
  const phentsize = buf.readUInt16LE(0x36);
  const phnum = buf.readUInt16LE(0x38);
  const loads = [];
  let dyn = null;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    const type = buf.readUInt32LE(o);
    const off = Number(buf.readBigUInt64LE(o + 8));
    const vaddr = Number(buf.readBigUInt64LE(o + 16));
    const filesz = Number(buf.readBigUInt64LE(o + 32));
    if (type === 1) loads.push({ off, vaddr, filesz }); // PT_LOAD
    if (type === 2) dyn = { off, filesz }; // PT_DYNAMIC
  }
  if (dyn === null) return { needed: [], soname: null };
  const v2o = (v) => {
    for (const l of loads) if (v >= l.vaddr && v < l.vaddr + l.filesz) return l.off + (v - l.vaddr);
    return -1;
  };
  let strtab = -1;
  const neededOff = [];
  let sonameOff = -1;
  for (let p = dyn.off; p + 16 <= dyn.off + dyn.filesz; p += 16) {
    const tag = Number(buf.readBigInt64LE(p));
    const val = Number(buf.readBigUInt64LE(p + 8));
    if (tag === 0) break; // DT_NULL
    if (tag === 1) neededOff.push(val); // DT_NEEDED  (offset into strtab)
    if (tag === 5) strtab = v2o(val); // DT_STRTAB  (virtual address)
    if (tag === 14) sonameOff = val; // DT_SONAME
  }
  if (strtab < 0) return { needed: [], soname: null };
  const str = (off) => {
    let e = strtab + off;
    while (e < buf.length && buf[e] !== 0) e++;
    return buf.toString('utf8', strtab + off, e);
  };
  return {
    needed: neededOff.map(str).filter(Boolean),
    soname: sonameOff >= 0 ? str(sonameOff) : null,
  };
}

/** PE 的导入 DLL 名列表。 */
function peImports(buf) {
  const peOff = buf.readUInt32LE(0x3c);
  const optOff = peOff + 24;
  const magic = buf.readUInt16LE(optOff);
  const plus = magic === 0x20b;
  const nSec = buf.readUInt16LE(peOff + 6);
  const optSize = buf.readUInt16LE(peOff + 20);
  const impRva = buf.readUInt32LE(optOff + (plus ? 112 : 96) + 8);
  if (impRva === 0) return [];
  const secOff = optOff + optSize;
  const secs = [];
  for (let i = 0; i < nSec; i++) {
    const o = secOff + i * 40;
    secs.push({
      va: buf.readUInt32LE(o + 12),
      vs: buf.readUInt32LE(o + 8),
      raw: buf.readUInt32LE(o + 20),
      rs: buf.readUInt32LE(o + 16),
    });
  }
  const r2o = (rva) => {
    for (const s of secs)
      if (rva >= s.va && rva < s.va + Math.max(s.vs, s.rs)) return s.raw + (rva - s.va);
    return -1;
  };
  const out = [];
  let q = r2o(impRva);
  if (q < 0) return [];
  // 20 字节一条 IMAGE_IMPORT_DESCRIPTOR，全零结束
  for (let guard = 0; guard < 4096; guard++) {
    if (q + 20 > buf.length) break;
    const nameRva = buf.readUInt32LE(q + 12);
    if (nameRva === 0) break;
    const no = r2o(nameRva);
    if (no < 0) break;
    let e = no;
    while (e < buf.length && buf[e] !== 0) e++;
    out.push(buf.toString('ascii', no, e));
    q += 20;
  }
  return out;
}

/** 返回 `{kind, needed, soname}`；不是二进制就返回 null。 */
function inspect(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return null;
  }
  try {
    if (isElf(buf)) {
      const { needed, soname } = elfNeeded(buf);
      return { kind: 'elf', needed, soname };
    }
    if (isPe(buf)) return { kind: 'pe', needed: peImports(buf), soname: null };
    if (isMachO(buf)) return { kind: 'macho', needed: [], soname: null, unreadable: true };
  } catch (e) {
    // `cause` 必须挂上：解析失败时原始栈是唯一能说清"哪个字段读崩了"的东西，
    // 而这个脚本是构建链上的守卫 —— 它自己出错时最不该做的就是把线索吞掉。
    throw new Error(`解析 ${path} 失败：${String(e && e.message ? e.message : e)}`, { cause: e });
  }
  return null;
}

// =======================================================================================
// 主流程
// =======================================================================================

function die0(msg) {
  console.error(`\x1b[31mpack-native-deps: ${msg}\x1b[0m`);
  process.exit(1);
}
const die = die0;

const args = new Map();
/**
 * `--search` **可以给多次**，刻意不做 `:` / `;` 拼接：
 * Windows 的路径本身就带 `C:`，用分隔符拼会在最需要它工作的那个平台上切错，
 * 而切错的表现是"找不到 → 红"，看起来像别的问题。
 */
const searchArgs = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const n = process.argv[i + 1];
  const hasVal = n !== undefined && !n.startsWith('--');
  if (k === 'search') {
    if (!hasVal) die0('--search 后面要跟一个目录');
    searchArgs.push(n);
    i++;
    continue;
  }
  if (hasVal) {
    args.set(k, n);
    i++;
  } else args.set(k, 'true');
}

const dir = args.get('dir');
if (!dir) die('缺少 --dir <包目录>');
const doCollect = args.get('collect') === 'true';
const doVerify = args.get('verify') === 'true';
if (doCollect === doVerify) die('必须且只能给一个：--collect 或 --verify');

const listFiles = (d) => {
  const out = [];
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...listFiles(join(d, e.name)));
    else if (e.isFile()) out.push(join(d, e.name));
  }
  return out;
};

/** 包里现有的"可被 DT_NEEDED / 导入表引用到"的名字集合（basename + SONAME）。 */
function providedNames(files) {
  const set = new Set();
  for (const f of files) {
    set.add(basename(f));
    const info = inspect(f);
    if (info && info.soname) set.add(info.soname);
  }
  return set;
}

/** 扫一遍包，算出「还缺哪些必需件」。 */
function scan() {
  const files = listFiles(dir);
  if (files.length === 0) {
    die(`${dir} 底下一个文件都没有 —— 这不是"没问题"，是"什么都没检查"。`);
  }
  const provided = providedNames(files);
  const binaries = [];
  const machos = [];
  const missing = new Map(); // name -> Set(谁要的)
  const gaps = new Map();
  for (const f of files) {
    const info = inspect(f);
    if (info === null) continue;
    if (info.unreadable === true) {
      machos.push(basename(f));
      continue;
    }
    binaries.push({ path: f, ...info });
    for (const n of info.needed) {
      const cls = classify(n);
      if (cls === 'os' || cls === 'driver') continue;
      if (provided.has(n)) continue;
      const bucket = cls === 'known-gap' ? gaps : missing;
      const s = bucket.get(n) ?? new Set();
      s.add(basename(f));
      bucket.set(n, s);
    }
  }
  return { files, binaries, machos, provided, missing, gaps };
}

const searchDirs = searchArgs.map((x) => x.trim()).filter(Boolean);

/** 在 --search 里找一个名字；解引用软链（DT_NEEDED 要的是内容，不是链）。 */
function findInSearch(name) {
  for (const d of searchDirs) {
    const p = join(d, name);
    try {
      const st = statSync(p);
      if (st.isFile()) return realpathSync(p);
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

const first = scan();
console.log(
  `pack-native-deps: ${first.binaries.length} 个二进制 / ${first.files.length} 个文件  @ ${dir}`,
);

if (doCollect) {
  if (searchDirs.length === 0) die('--collect 需要至少一个 --search <目录>（可给多次）');
  console.log(`  搜索路径：${searchDirs.join('  ')}`);
  const copied = [];
  // 不动点：拷进来的库自己还会带依赖（libcublas → libcublasLt 就是这么被发现的，
  // 不需要任何人知道它的存在）。
  for (let round = 1; round <= 16; round++) {
    const { missing } = scan();
    if (missing.size === 0) break;
    let progressed = false;
    for (const [name, who] of missing) {
      const src = findInSearch(name);
      if (src === null) {
        die(`需要 ${name}（被 ${[...who].join(', ')} 引用），但 --search 里找不到它。
  搜索过：${searchDirs.join('  ')}
  **这一步不许"找不到就算了"** —— 那正是这个包坏掉的原因（静默 no-op）。`);
      }
      copyFileSync(src, join(dir, name)); // 目标名 = DT_NEEDED/导入表里的那个名字
      const bytes = statSync(src).size;
      copied.push({
        name,
        src,
        bytes,
        sha256: createHash('sha256').update(readFileSync(src)).digest('hex'),
        by: [...who].join(', '),
      });
      progressed = true;
    }
    if (!progressed) break;
    if (round === 16) die('依赖闭包 16 轮还没收敛 —— 大概率是解析出错，不再继续');
  }
  if (copied.length === 0) console.log('  没有缺件，什么都没拷');
  const recordPath = args.get('record');
  if (recordPath !== undefined) {
    // 记下**源文件**的 sha256。出厂前再比一次（--assert-unmodified），
    // 就把 NVIDIA EULA §2.3「object code files are not modified in any way」
    // 从"记得别在收集之后再 strip"变成"改了会当场红"。
    writeFileSync(
      recordPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          files: copied.map(({ name, src, bytes, sha256 }) => ({ name, src, bytes, sha256 })),
        },
        null,
        2,
      ),
    );
    console.log(`  记录写入 ${recordPath}（${copied.length} 条，出厂前会逐个复算）`);
  }
  for (const c of copied)
    console.log(
      `  + ${c.name.padEnd(28)} ${String(c.bytes).padStart(12)} B   （${c.by} 要的）  ← ${c.src}`,
    );
}

// --collect 之后同样跑一遍守卫：收集与验证用同一份判据，不给"拷完就当过了"留缝。
const { binaries, machos, missing, gaps } = scan();

for (const [name, who] of gaps)
  console.log(
    `  \x1b[33m⚠\x1b[0m 已立案缺口：${name}（${[...who].join(', ')} 要的）—— ${gapReason(name)}`,
  );

if (machos.length > 0) {
  console.log(
    `  \x1b[33m⚠\x1b[0m Mach-O ${machos.length} 个：**本守卫读不了它们的 LC_LOAD_DYLIB** —— ` +
      `macOS 这一格没有被覆盖，不是"检查过了没问题"。`,
  );
  console.log(
    `      ${machos.slice(0, 8).join(', ')}${machos.length > 8 ? ` …（共 ${machos.length}）` : ''}`,
  );
}

if (binaries.length === 0 && machos.length === 0) {
  die(`${dir} 里一个可解析的二进制都没有 —— 守卫等于没在检查（ci-prep C5 那一族）。`);
}

// ── ★ 第三方二进制不许被改动（NVIDIA EULA §2.3）────────────────────────────────────────
const recordPath = args.get('record');
if (recordPath !== undefined && existsSync(recordPath)) {
  const rec = JSON.parse(readFileSync(recordPath, 'utf8'));
  const bad = [];
  for (const f of rec.files ?? []) {
    const p = join(dir, f.name);
    if (!existsSync(p)) {
      bad.push(`${f.name}：收集过，出厂前不见了`);
      continue;
    }
    const now = createHash('sha256').update(readFileSync(p)).digest('hex');
    if (now !== f.sha256)
      bad.push(
        `${f.name}：与源文件不再逐字节相同（${f.sha256.slice(0, 12)}… → ${now.slice(0, 12)}…）`,
      );
  }
  if (bad.length > 0) {
    console.error('');
    console.error('\x1b[31m✘ 随包分发的第三方二进制被改动过：\x1b[0m');
    for (const b of bad) console.error(`    ${b}`);
    console.error('');
    console.error('NVIDIA CUDA EULA §2.3 原文："…may be copied and redistributed for use in');
    console.error('accordance with this Agreement, **provided that the object code files are not');
    console.error('modified in any way** (except for unzipping of compressed files)."');
    console.error('最常见的成因：`strip` 扫过了整个 stage —— 收集必须排在 strip **之后**。');
    process.exit(1);
  }
  console.log(
    `  \x1b[32m✔\x1b[0m ${(rec.files ?? []).length} 个第三方二进制与源文件逐字节相同（EULA §2.3：不得修改）`,
  );
}

// ── ★ 带了别人的二进制，就得带别人的许可证 ──────────────────────────────────────────
{
  const namesInPack = new Set(listFiles(dir).map((f) => basename(f)));
  const licMissing = [];
  for (const L of LICENSE_REQUIRED) {
    const hits = [...namesInPack].filter((n) => L.trigger.test(n));
    if (hits.length === 0) continue;
    const lic = join(dir, L.file);
    const okFile = existsSync(lic) && statSync(lic).size > 1024;
    if (okFile) {
      console.log(
        `  \x1b[32m✔\x1b[0m ${L.name}：包里带了 ${L.file}（${statSync(lic).size} B），覆盖 ${hits.join(', ')}`,
      );
    } else {
      licMissing.push({ L, hits });
    }
  }
  if (licMissing.length > 0) {
    console.error('');
    console.error('\x1b[31m✘ 包里有第三方可再分发二进制，却没有随附它的许可证文本：\x1b[0m');
    for (const { L, hits } of licMissing) {
      console.error(`    ${L.name} —— 触发它的文件：${hits.join(', ')}`);
      console.error(`      需要包内有 ${L.file}（> 1 KB），SPDX ${L.spdx}，出处 ${L.url}`);
    }
    console.error('');
    console.error(
      '**把二进制放进包的那一刻，我们就是再分发方了。** 许可证必须和二进制同一次进包 ——',
    );
    console.error('分两步做，中间就存在一个"已经在分发、但没带许可证"的状态。');
    process.exit(1);
  }
}

if (missing.size > 0) {
  console.error('');
  console.error('\x1b[31m✘ 这个包缺少它自己导入表要求的库：\x1b[0m');
  for (const [name, who] of missing) console.error(`    ${name}   ← ${[...who].join(', ')} 要的`);
  console.error('');
  console.error('判据是二进制自己说的（ELF DT_NEEDED / PE 导入表），不是手写清单。');
  console.error('后果是静默的：GGML_BACKEND_DL 下 dlopen 失败不是错误，只是"后端没注册上" ——');
  console.error('用户会装成功、校验通过、自检看得见文件，然后**照常用 CPU 跑完**。');
  process.exit(1);
}

console.log(
  `\x1b[32m✔\x1b[0m 检查了 ${binaries.length} 个 ELF/PE，非系统依赖全部在包里` +
    `（已立案缺口 ${gaps.size} 项、未覆盖的 Mach-O ${machos.length} 个，见上）`,
);
