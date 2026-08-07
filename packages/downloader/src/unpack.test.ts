/**
 * `unpack.ts` 的路径边界 —— **一次真实的沙箱逃逸的护栏**（T-157 ①）。
 *
 * ## 这条缺陷的形状
 *
 * 校验软链目标用的是 `path.resolve`，**它按字面折叠 `..`**；而内核**先跟随软链再折叠**。
 * 同一个字符串，两者给出相反的答案：
 *
 * ```
 * destRoot/s     -> "."                  词法 = destRoot 自己       → 放行
 * destRoot/evil  -> "s/../OUTSIDE.txt"   词法 = destRoot/OUTSIDE.txt → 放行
 *                                        内核 = <destRoot 的父目录>/OUTSIDE.txt  🔴
 * ```
 *
 * `[实测]` 在修复前的产物上，这**不只是越界读**：归档里再放一个同名的普通文件条目 `evil`，
 * `fs.writeFile` 会**穿过那条软链**，把 destRoot 之外的文件覆盖掉。**任意文件写。**
 *
 * ## 这些用例钉的是"后果"，不是"错误信息"
 *
 * 判据一律是 **destRoot 外那个文件的字节有没有变** / **通过链接读到的是不是外面的内容**，
 * 用一个独一无二的串（`SECRET-OUTSIDE-DESTROOT`）反查。不匹配错误文案 ——
 * 文案改一个字用例就会假绿/假红，而它跟安全性质没有关系。
 *
 * ## 顺序是攻击者选的，所以两侧都要有用例
 *
 * 「创建时检查」和「解包后复查」各自都不够：
 *   - `s` 在 `evil` **之前** → 创建 `evil` 那一刻就能算出它指向外面（创建时检查抓得住）
 *   - `s` 在 `evil` **之后** → 创建 `evil` 时 `s` 还不存在，它**真的**指向内部；
 *     是后面那条 `s` 把它改指到外面的（只有解包后复查抓得住）
 * 两组用例分别对应，删掉任何一半都会有一半的用例变红。
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { promises as fs, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  UnpackError,
  isMacArchiveJunk,
  lexicalEntryPath,
  lexicalLinkTarget,
  unpackArchive,
  unpackTarGz,
} from './unpack.js';

/* ------------------------------ tar 构造器 -------------------------------- */
// 手搓 512 字节头：本包不许引入新依赖，而且恶意归档本来也不是任何 tar 库愿意产出的东西。

const BLOCK = 512;
type Entry = { name: string; type?: '0' | '2' | '5'; linkname?: string; data?: string; mode?: number };

function tarHeader(e: Entry, size: number): Buffer {
  const b = Buffer.alloc(BLOCK, 0);
  b.write(e.name, 0, 100, 'utf8');
  b.write((e.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  b.write('0000000\0', 108, 8, 'ascii');
  b.write('0000000\0', 116, 8, 'ascii');
  b.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  b.write('00000000000\0', 136, 12, 'ascii');
  b.write('        ', 148, 8, 'ascii'); // checksum 先填空格，按规范这样算
  b.write(e.type ?? '0', 156, 1, 'ascii');
  b.write(e.linkname ?? '', 157, 100, 'utf8');
  b.write('ustar\0', 257, 6, 'ascii');
  b.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return b;
}

function makeTarGz(dest: string, entries: Entry[]): string {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const isFile = (e.type ?? '0') === '0';
    const data = Buffer.from(e.data ?? '');
    parts.push(tarHeader(e, isFile ? data.length : 0));
    if (isFile) {
      const rem = data.length % BLOCK;
      parts.push(rem === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rem, 0)]));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  writeFileSync(dest, gzipSync(Buffer.concat(parts)));
  return dest;
}

/* ------------------------------- 沙箱脚手架 ------------------------------- */

const SECRET = 'SECRET-OUTSIDE-DESTROOT';
const tmpRoots: string[] = [];

/** `base/` 里放一个 destRoot 之外的"机密文件"，解包目标是 `base/dest`。 */
function sandbox(): { base: string; destRoot: string; outside: string } {
  const base = mkdtempSync(path.join(os.tmpdir(), 'om-unpack-'));
  tmpRoots.push(base);
  const destRoot = path.join(base, 'dest');
  const outside = path.join(base, 'OUTSIDE.txt');
  writeFileSync(outside, SECRET);
  return { base, destRoot, outside };
}

afterEach(() => {
  while (tmpRoots.length) rmSync(tmpRoots.pop() as string, { recursive: true, force: true });
});

async function expectRejected(fn: () => Promise<unknown>): Promise<UnpackError> {
  try {
    await fn();
  } catch (e) {
    assert.equal(e instanceof UnpackError, true, `期望 UnpackError，实际是 ${String(e)}`);
    return e as UnpackError;
  }
  throw new assert.AssertionError({ message: '★ 解包本该被拒，却成功返回了' });
}

/* ============================ ① 逃逸必须被挡住 ============================ */

describe('T-157 ① unpack 软链逃逸 —— 词法判定说"在里面"，内核读到的是外面', () => {
  it('★ 中间软链 + `..`（s 在前）：destRoot 外的文件一个字节都不许被改写', async () => {
    const { base, destRoot, outside } = sandbox();
    const tgz = makeTarGz(path.join(base, 'a.tar.gz'), [
      { name: 's', type: '2', linkname: '.' },
      { name: 'evil', type: '2', linkname: 's/../OUTSIDE.txt' },
      { name: 'evil', data: 'PWNED-BY-ARCHIVE' },
    ]);

    /*
     * 先证明这条用例钉的不是零：**就地复刻修复前那一版的判据**，确认它会放行。
     * 少了这一步，用例可能只是"因为正确的结果、错误的理由"通过
     * （path-guard 在 T-143 ④ 记过同一件事）。
     */
    const legacyVerdict = ((): boolean => {
      const root = path.resolve(destRoot);
      const resolved = path.resolve(path.dirname(path.resolve(root, 'evil')), 's/../OUTSIDE.txt');
      return resolved === root || resolved.startsWith(root + path.sep);
    })();
    assert.equal(legacyVerdict, true, '修复前的词法判据本应放行这条链接（否则这组用例没有意义）');

    const err = await expectRejected(() => unpackTarGz(tgz, destRoot));
    assert.equal(err.code, 'SYMLINK_REJECTED');
    assert.equal(readFileSync(outside, 'utf8'), SECRET);
  });

  it('★ 条目顺序颠倒（evil 在前、s 在后）—— 只有"解包后复查"抓得住', async () => {
    const { base, destRoot, outside } = sandbox();
    const tgz = makeTarGz(path.join(base, 'b.tar.gz'), [
      { name: 'evil', type: '2', linkname: 's/../OUTSIDE.txt' },
      { name: 's', type: '2', linkname: '.' },
      { name: 'evil', data: 'PWNED-BY-ARCHIVE' },
    ]);
    await expectRejected(() => unpackTarGz(tgz, destRoot));
    assert.equal(readFileSync(outside, 'utf8'), SECRET);
  });

  it('★ 解包"成功"但留下一扇门：不写穿、只留一条指向外面的软链，也必须被拒', async () => {
    const { base, destRoot } = sandbox();
    // 没有第三条写穿的条目 —— 修复前这份归档解包会**正常返回**，
    // 而 destRoot 里从此有一条通往外面的软链，之后任何遍历包目录的代码都会跟过去。
    const tgz = makeTarGz(path.join(base, 'd.tar.gz'), [
      { name: 'evil', type: '2', linkname: 's/../OUTSIDE.txt' },
      { name: 's', type: '2', linkname: '.' },
    ]);
    const err = await expectRejected(() => unpackTarGz(tgz, destRoot));
    assert.equal(err.code, 'SYMLINK_REJECTED');
  });

  it('★ 借软链目录把 mkdir 打到 destRoot 外面', async () => {
    const { base, destRoot } = sandbox();
    const tgz = makeTarGz(path.join(base, 'c.tar.gz'), [
      { name: 's', type: '2', linkname: '.' },
      { name: 'evil', type: '2', linkname: 's/../PWNED' },
      { name: 'evil/x.txt', data: 'MKDIR-ESCAPE' },
    ]);
    await expectRejected(() => unpackTarGz(tgz, destRoot));
    let strayExists = true;
    try {
      await fs.stat(path.join(base, 'PWNED'));
    } catch {
      strayExists = false;
    }
    assert.equal(strayExists, false, 'destRoot 外不许多出一个目录');
  });

  it('绝对目标（老形态）照旧被拒', async () => {
    const { base, destRoot } = sandbox();
    const tgz = makeTarGz(path.join(base, 'e.tar.gz'), [
      { name: 'evil', type: '2', linkname: '/etc/passwd' },
    ]);
    const err = await expectRejected(() => unpackTarGz(tgz, destRoot));
    assert.equal(err.code, 'SYMLINK_REJECTED');
  });

  it('条目名里的 `..`（zip-slip 原始形态）照旧被拒', async () => {
    const { base, destRoot, outside } = sandbox();
    const tgz = makeTarGz(path.join(base, 'f.tar.gz'), [
      { name: '../OUTSIDE.txt', data: 'PWNED-BY-ARCHIVE' },
    ]);
    const err = await expectRejected(() => unpackTarGz(tgz, destRoot));
    assert.equal(err.code, 'PATH_TRAVERSAL');
    assert.equal(readFileSync(outside, 'utf8'), SECRET);
  });
});

/* ====================== ② 合法的链接一条都不许被误杀 ====================== */

describe('T-157 ① 不许误杀 —— 产品自己的后端包就靠这些链接', () => {
  it('★ 两级同目录 `.so` 版本链（whisper.cpp 上游 tarball 的真实形状）照常解析', async () => {
    const { base, destRoot } = sandbox();
    const tgz = makeTarGz(path.join(base, 'ok.tar.gz'), [
      { name: 'lib/libwhisper.so.1.9.1', data: 'ELFWHISPER' },
      // ⚠️ 链接**先于**目标出现，这是 tar 的常态：守卫必须容忍"目标还不存在"
      { name: 'lib/libwhisper.so.1', type: '2', linkname: 'libwhisper.so.1.9.1' },
      { name: 'lib/libwhisper.so', type: '2', linkname: 'libwhisper.so.1' },
      { name: 'bin/whisper-cli', data: 'BIN', mode: 0o755 },
    ]);
    await unpackTarGz(tgz, destRoot);
    assert.equal(readFileSync(path.join(destRoot, 'lib/libwhisper.so'), 'utf8'), 'ELFWHISPER');
    assert.equal(readlinkSync(path.join(destRoot, 'lib/libwhisper.so')), 'libwhisper.so.1');
  });

  it('★ 带 `../..` 的相对链（数据目录里 `bin/ext/*` 就是这个形状）照常解析', async () => {
    const { base, destRoot } = sandbox();
    const tgz = makeTarGz(path.join(base, 'rel.tar.gz'), [
      { name: 'bin/ext/dict', type: '2', linkname: '../../lib/dictdir' },
      { name: 'lib/dictdir/jieba.dict', data: 'DICT' },
    ]);
    await unpackTarGz(tgz, destRoot);
    assert.equal(readFileSync(path.join(destRoot, 'bin/ext/dict/jieba.dict'), 'utf8'), 'DICT');
  });

  it('★ 目标经由软链访问 + 目录里已有一条绝对软链 → 不许把整棵树误判成越界', async () => {
    /*
     * 这条钉的是 `resolveRoot()`：**根必须和候选走同一套解析规则。**
     *
     * 拿"解析过的候选"去比"没解析过的根"，只要数据目录自己是经由软链访问的
     * （macOS 的 `/var → /private/var`、`/home → /mnt/home` 这类布局），
     * 整个包会当场全部被判越界 —— 一个把产品自己拆掉的"安全修复"。T-143 ① 踩过一次。
     *
     * ⚠️ 只做"根是软链"还不够：`walk()` 从给定的根出发、不回头解析它，两边**恰好**
     * 都停在软链那一侧，比较照样成立。要让两边真的分叉，路径中必须出现一条**绝对**软链
     * —— 跟随它会得到解析后的真实路径，而根还停在软链那一侧。
     * （第一版用例没有这一步，把 `resolveRoot` 拆掉时它照样绿 —— 变异体当场揭穿了它，
     *   这正是"反向验证"要防的那种"因为正确的结果、错误的理由通过"。）
     */
    const { base } = sandbox();
    const realDest = path.join(base, 'real-dest');
    await fs.mkdir(path.join(realDest, 'sub'), { recursive: true });
    await fs.symlink(realDest, path.join(base, 'via-link'));
    await fs.symlink(path.join(realDest, 'sub'), path.join(realDest, 'p')); // 绝对目标
    const tgz = makeTarGz(path.join(base, 'abs.tar.gz'), [{ name: 'p/x.txt', data: 'INSIDE' }]);

    await unpackTarGz(tgz, path.join(base, 'via-link'));
    assert.equal(readFileSync(path.join(realDest, 'sub', 'x.txt'), 'utf8'), 'INSIDE');
  });

  it('解包目标本身是一条软链时照常工作（macOS /var → /private/var 的基本形态）', async () => {
    // 这是加这类守卫最容易自伤的一步：拿"解析过的候选"去比"没解析过的根"，
    // 只要数据目录自己是软链，整个包会当场全部被判越界。T-143 ① 踩过一次。
    const { base } = sandbox();
    const realDest = path.join(base, 'real-dest');
    await fs.mkdir(realDest, { recursive: true });
    const viaLink = path.join(base, 'via-link');
    await fs.symlink(realDest, viaLink);
    const tgz = makeTarGz(path.join(base, 'g.tar.gz'), [
      { name: 'lib/libwhisper.so.1.9.1', data: 'ELFWHISPER' },
      { name: 'lib/libwhisper.so', type: '2', linkname: 'libwhisper.so.1.9.1' },
    ]);
    await unpackTarGz(tgz, viaLink);
    assert.equal(readFileSync(path.join(realDest, 'lib/libwhisper.so'), 'utf8'), 'ELFWHISPER');
  });
});

/* ================= ③ 词法那一半：platform 是入参，Windows 语义在 Linux 上就能测 ================= */

describe('T-157 ① 词法判定的 platform 入参 —— win32 分支在 Linux 上第一次被执行', () => {
  const WIN_ROOT = 'C:\\Users\\me\\dest';

  /*
   * ⚠️ 写这组用例时先撞了一次「因为错误的理由通过」，如实记在这里：
   *
   * 我最初拿**条目名** `a\..\..\Windows\win.ini` 当 win32 用例，它确实被拒了 ——
   * 但拒它的是 `assertSafeEntryName`，那一段**按设计对两种分隔符都切、与平台无关**，
   * posix 上同样会拒。也就是说那条用例根本没有执行到 platform 分支。
   *
   * → **条目名这条路上，platform 入参能改变的行为很少**（那是刻意的：宁可在 Linux 上
   *   也把 Windows 形态的名字当危险）。**真正需要它的是链接目标** ——
   *   `lexicalLinkTarget` 不走 `assertSafeEntryName`，`..` 是不是分隔符完全由平台决定。
   */

  it('条目名里的 `..` 与平台无关地被拒 —— 这正是"条目名不需要 platform 入参"的原因', () => {
    for (const platform of ['win32', 'linux'] as const) {
      assert.throws(
        () => lexicalEntryPath(WIN_ROOT, 'a\\..\\..\\Windows\\win.ini', platform),
        (e: unknown) => e instanceof UnpackError && e.code === 'PATH_TRAVERSAL',
      );
    }
  });

  it('★ 链接目标 `..\\..\\Windows\\win.ini`：win32 规则下逃逸 → 拒；posix 规则下只是个怪文件名', () => {
    assert.throws(
      () => lexicalLinkTarget(WIN_ROOT, 'x', '..\\..\\Windows\\win.ini', 'win32'),
      (e: unknown) => e instanceof UnpackError && e.code === 'SYMLINK_REJECTED',
    );
    // 同一个字符串在 posix 下不含分隔符 → 是根内一个名字很怪的文件。
    // 这半句写成用例而不是注释：免得下一个人只读到上面那条就以为 Linux 上也有洞。
    assert.equal(
      lexicalLinkTarget('/tmp/dest', 'x', '..\\..\\Windows\\win.ini', 'linux'),
      '/tmp/dest/..\\..\\Windows\\win.ini',
    );
  });

  it('★ 分隔符边界：`C:\\Users\\me\\dest-backup` 不许被算成 dest 里面', () => {
    // `move.ts:82` 的注释亲口写过这个坑：`/data` 与 `/data-backup` 前缀相同但毫无关系。
    // 判据必须是 `root + sep`；把守卫改成 `startsWith(root)` 这条会当场红。
    assert.throws(
      () => lexicalLinkTarget(WIN_ROOT, 'x', '..\\dest-backup\\evil.dll', 'win32'),
      (e: unknown) => e instanceof UnpackError && e.code === 'SYMLINK_REJECTED',
    );
  });

  it('★ win32 规则下合法的子路径仍然放行（守卫不许把一切都拒掉）', () => {
    assert.equal(
      lexicalLinkTarget(WIN_ROOT, 'lib\\a.dll', 'b.dll', 'win32'),
      'C:\\Users\\me\\dest\\lib\\b.dll',
    );
    assert.equal(lexicalEntryPath(WIN_ROOT, 'lib\\whisper.dll', 'win32'), 'C:\\Users\\me\\dest\\lib\\whisper.dll');
  });

  it('盘符绝对目标被拒（与平台无关，两套规则下都拒）', () => {
    for (const platform of ['win32', 'linux'] as const) {
      assert.throws(
        () => lexicalLinkTarget(WIN_ROOT, 'x', 'C:\\Windows\\win.ini', platform),
        (e: unknown) => e instanceof UnpackError && e.code === 'SYMLINK_REJECTED',
      );
    }
  });

  it('默认参数 = 宿主平台：不传 platform 时行为与旧实现逐字一致', () => {
    const root = process.platform === 'win32' ? 'C:\\dest' : '/tmp/dest';
    assert.equal(lexicalEntryPath(root, 'lib/a.so'), path.resolve(root, 'lib/a.so'));
  });
});

/* ================== ④ macOS 打包副产物一律不落盘（T-168 ①） ================== */

describe('T-168 ① macOS 打包副产物：判定纯粹由名字决定', () => {
  it('★ 三种真实形态都算垃圾', () => {
    for (const n of [
      '__MACOSX/',
      '__MACOSX/ggml-large-v3-encoder.mlmodelc/._metadata.json', // 真归档里就是这一条
      'ggml-tiny-encoder.mlmodelc/._coremldata.bin', // macOS tar 的形态：边车直接放在旁边
      '.DS_Store',
      'a/b/.DS_Store',
      '__MACOSX\\x\\._y', // 反斜杠形态（Windows 上写出来的归档）
    ]) {
      assert.equal(isMacArchiveJunk(n), true, `应判为垃圾：${n}`);
    }
  });

  it('★ 守卫不许过宽 —— 这些是载荷，一个都不许被吞', () => {
    /*
     * ⚠️ 这张表第一版漏掉了**点开头的普通文件**（`.keep` / `.gitkeep` / `.env.example`）。
     * 反向验证把判据改成 `base.startsWith('.')`（"隐藏文件都算垃圾"）时，
     * 这一条**没有变红** —— 表里当时只有 `.config/keep.json`，而它的 basename
     * 是 `keep.json`，压根不触发那条过宽的规则。
     * 一张"看起来覆盖了隐藏文件"的表，实际一个隐藏文件名都没测到。
     */
    for (const n of [
      'ggml-large-v3-encoder.mlmodelc/coremldata.bin',
      'bin/whisper-cli',
      '.config/keep.json', // 隐藏目录不等于垃圾
      'bin/.keep', // ← 点开头的**文件**，是载荷
      '.gitkeep',
      'conf/.env.example',
      'lib/libggml.so',
      '__MACOSX_NOT_REALLY/x.bin', // 前缀相同但不是那个目录名
      'a/_.bin', // 与 `._` 只差一个字符
      'weights/weight.bin',
    ]) {
      assert.equal(isMacArchiveJunk(n), false, `不该被判为垃圾：${n}`);
    }
  });
});

describe('T-168 ① tar：垃圾不落盘，载荷一个不少', () => {
  it('★ `._x` / `.DS_Store` / `__MACOSX/` 都不写进磁盘，且不计入 files', async () => {
    const { destRoot } = sandbox();
    const src = makeTarGz(path.join(mkdtempSync(path.join(os.tmpdir(), 'om-junk-')), 'a.tar.gz'), [
      { name: 'ggml-tiny-encoder.mlmodelc/', type: '5' },
      { name: 'ggml-tiny-encoder.mlmodelc/coremldata.bin', data: 'COREML' },
      { name: 'ggml-tiny-encoder.mlmodelc/._coremldata.bin', data: 'applédouble' },
      { name: 'ggml-tiny-encoder.mlmodelc/.DS_Store', data: 'finder' },
      { name: '__MACOSX/ggml-tiny-encoder.mlmodelc/._metadata.json', data: 'ad' },
    ]);
    const res = await unpackTarGz(src, destRoot);

    assert.deepEqual(
      (await fs.readdir(destRoot)).sort(),
      ['ggml-tiny-encoder.mlmodelc'],
      '顶层出现了不该有的东西 —— `__MACOSX` 落盘就会让 collapseRedundantTopLevel 压不掉',
    );
    assert.deepEqual(
      (await fs.readdir(path.join(destRoot, 'ggml-tiny-encoder.mlmodelc'))).sort(),
      ['coremldata.bin'],
    );
    // 载荷内容没被动过
    assert.equal(
      await fs.readFile(path.join(destRoot, 'ggml-tiny-encoder.mlmodelc/coremldata.bin'), 'utf8'),
      'COREML',
    );
    // 返回的 files 也不许把垃圾算进去（调用方会拿它记账）
    assert.equal(
      res.files.some((f) => f.includes('._') || f.includes('.DS_Store') || f.includes('__MACOSX')),
      false,
      `files 里混进了垃圾：${JSON.stringify(res.files)}`,
    );
  });

  it('★ 垃圾名字里藏穿越 → 仍然当场被拒，不许被"跳过"悄悄咽下去', async () => {
    /*
     * 这条守的是**跳过与验名的顺序**。先跳后验的话，
     * `__MACOSX/../../evil` 会安静地什么都不做 —— 归档"解包成功"，
     * 而它其实是一次被吞掉的攻击。攻击被无声处理，与攻击成功一样坏。
     */
    const { destRoot } = sandbox();
    const src = makeTarGz(path.join(mkdtempSync(path.join(os.tmpdir(), 'om-junk-')), 'b.tar.gz'), [
      { name: '__MACOSX/../../evil/._x', data: 'EVIL' },
    ]);
    const err = await expectRejected(() => unpackTarGz(src, destRoot));
    assert.equal(err.code, 'PATH_TRAVERSAL');
  });
});

/**
 * C-19 / B-4 —— `unpackArchive` 的**失败契约**：它不自清，而且这一点是故意的。
 *
 * ## 为什么要给"它不自清"写测试
 *
 * 审计把这一条记成「两份测试零『失败后 destDir 干净』断言」。回代码核下来，
 * **用户可见的那半其实已经被钉住了** —— `installer.test.ts` 的 T-157 ②
 * 「解包失败时上一版必须原封不动」+「不许留下 .tmp- 残骸」正是它。
 *
 * 真正没人守的是**另一半**：`unpackArchive` 自己的契约。它在签名上一个字都没写，
 * 于是「失败后 destDir 是什么状态」这个问题，谁读谁自己猜 ——
 * 而两种猜法（自清 / 不自清）会导出完全相反的调用写法：
 *   · 猜"自清" → 直接把 destDir 指向用户正在用的目录，失败就毁掉它；
 *   · 猜"不自清" → 解到临时目录再换入（`install()` 就是这么做的）。
 *
 * 这个仓库反复栽的正是这一族：**注释/直觉描述了一个不存在的行为**。
 * 所以这里把真实行为钉死，让 `unpack.ts` 上那段契约**有东西替它作证**。
 *
 * ⚠️ 如果哪天有人真把 `unpackArchive` 改成失败自清，这条会红 ——
 *    那是**要求他连 `unpack.ts` 的契约段一起改**，不是说自清不许做。
 */
describe('C-19 unpackArchive 失败契约：不自清，原子性由调用方负责', () => {
  it('★ 中途失败时，已经写下去的条目**留在 destDir 里**（所以调用方绝不能把它指向用户在用的目录）', async () => {
    const { destRoot } = sandbox();
    /*
     * 顺序是关键：先一个正常条目，再一个越界条目。
     * 提取是边读边写的，所以第一个条目会真的落盘，然后第二个把整件事拒掉。
     */
    const src = makeTarGz(
      path.join(mkdtempSync(path.join(os.tmpdir(), 'om-c19-')), 'partial.tar.gz'),
      [
        { name: 'good-1.txt', data: 'WRITTEN-BEFORE-THE-FAILURE' },
        { name: '../escaped.txt', data: 'EVIL' },
      ],
    );

    const err = await expectRejected(() => unpackArchive(src, destRoot, 'tar.gz'));
    assert.equal(err.code, 'PATH_TRAVERSAL', '这条用例要的是"中途被拒"，不是别的失败');

    const left = await fs.readdir(destRoot);
    assert.equal(
      left.includes('good-1.txt'),
      true,
      '契约说它不自清，实际却清了 —— 请把 unpack.ts 上那段失败契约一起改掉。' +
        `实际残留：${JSON.stringify(left)}`,
    );
  });

  it('不认识的归档类型必须抛 UNSUPPORTED，而不是悄悄返回一个空结果', async () => {
    const { destRoot } = sandbox();
    const src = makeTarGz(
      path.join(mkdtempSync(path.join(os.tmpdir(), 'om-c19b-')), 'x.tar.gz'),
      [{ name: 'a.txt', data: 'A' }],
    );
    const err = await expectRejected(() =>
      unpackArchive(src, destRoot, 'rar' as unknown as 'zip'),
    );
    assert.equal(err.code, 'UNSUPPORTED');
  });
});
