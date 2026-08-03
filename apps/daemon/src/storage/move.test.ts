/**
 * 数据目录移动的回归测试。
 *
 * 这里测的**不是"能搬成功"** —— 那是最容易过的一条。
 * 真正要钉住的是**失败路径**：搬砸了以后用户的数据还在不在。
 * 一个只测 happy path 的移动功能，等于没测。
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  findStaleLinks,
  looksLikeDataDir,
  measureTree,
  moveDataDir,
  planMove,
  verifyTreesMatch,
} from './move.js';

const roots: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `om-move-${prefix}-`));
  roots.push(d);
  return d;
}
after(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true }).catch(() => {});
});

/** 造一个像真数据目录的树（含中文文件名与嵌套）。 */
async function seed(dir: string): Promise<void> {
  await fs.mkdir(join(dir, 'media'), { recursive: true });
  await fs.mkdir(join(dir, 'models', 'by-name', 'asr'), { recursive: true });
  await fs.writeFile(join(dir, 'openmemo.db'), 'X'.repeat(4096));
  await fs.writeFile(join(dir, 'media', '会议录音.m4a'), 'A'.repeat(2048));
  await fs.writeFile(join(dir, 'models', 'by-name', 'asr', 'ggml-base.bin'), 'B'.repeat(1024));
}

/**
 * 后端目录的真实形状：**两级相对符号链接**。
 * 这不是编出来的构造 —— whisper.cpp 官方 tarball 里就是
 * `libwhisper.so → libwhisper.so.1 → libwhisper.so.1.9.1`，用户断掉的那 8 条正是这个样子。
 * 只测一级链会漏掉"第二跳被改写"的情况。
 */
const BACKEND_DIR = join('models', 'by-name', 'backend', 'whisper-bin-ubuntu-x64');
const SO_NAMES = ['libwhisper', 'libggml-base', 'libparakeet'] as const;

async function seedBackendSymlinks(dir: string): Promise<void> {
  const d = join(dir, BACKEND_DIR);
  await fs.mkdir(d, { recursive: true });
  await fs.writeFile(join(d, 'whisper-cli'), 'ELF'.repeat(64));
  for (const so of SO_NAMES) {
    await fs.writeFile(join(d, `${so}.so.1.9.1`), `${so}-REAL-BYTES`.repeat(16));
    // 两级链，全部**相对**（unpack.ts 写出来就是相对的，这一点是对的，别改它）
    await fs.symlink(`${so}.so.1.9.1`, join(d, `${so}.so.1`));
    await fs.symlink(`${so}.so.1`, join(d, `${so}.so`));
  }
}

/** 顺着两级链真读一次内容 —— 只看 `readlink` 不够，要的是"链还能用"。 */
async function soIsLoadable(dir: string, so: string): Promise<boolean> {
  try {
    const body = await fs.readFile(join(dir, BACKEND_DIR, `${so}.so`), 'utf8');
    return body.startsWith(`${so}-REAL-BYTES`);
  } catch {
    return false;
  }
}

describe('planMove —— 纯路径校验', () => {
  it('相同路径必须拒绝', () => {
    const p = planMove('/data/openmemo', '/data/openmemo');
    assert.equal(p.ok, false);
  });

  it('**目标在源内部**必须拒绝（否则复制会自我递归）', () => {
    const p = planMove('/data/openmemo', '/data/openmemo/sub');
    assert.equal(p.ok, false);
    assert.match(p.reason ?? '', /inside source/);
  });

  it('源在目标内部必须拒绝', () => {
    const p = planMove('/data/openmemo/sub', '/data/openmemo');
    assert.equal(p.ok, false);
    assert.match(p.reason ?? '', /inside target/);
  });

  it('**同前缀但不同目录必须放行**（/data 与 /data-backup 无关）', () => {
    // 这条是防"用字符串前缀判父子"的经典误伤：一次完全合法的移动被拒
    assert.equal(planMove('/data', '/data-backup').ok, true);
    assert.equal(planMove('/srv/om', '/srv/om2').ok, true);
  });

  it('正常的兄弟目录放行', () => {
    assert.equal(planMove('/a/openmemo', '/b/openmemo').ok, true);
  });
});

describe('verifyTreesMatch —— 敢不敢删源的依据', () => {
  it('完全一致时通过', async () => {
    const a = tmp('va');
    const b = tmp('vb');
    await seed(a);
    await fs.cp(a, b, { recursive: true });
    assert.equal((await verifyTreesMatch(a, b)).ok, true);
  });

  it('**少一个文件**必须报出来（总字节数可能碰巧对得上）', async () => {
    const a = tmp('ma');
    const b = tmp('mb');
    await seed(a);
    await fs.cp(a, b, { recursive: true });
    await fs.rm(join(b, 'media', '会议录音.m4a'));
    const v = await verifyTreesMatch(a, b);
    assert.equal(v.ok, false);
    assert.ok(v.mismatches.some((m) => m.includes('缺失')));
  });

  it('**文件被截断**必须报出来', async () => {
    const a = tmp('ta');
    const b = tmp('tb');
    await seed(a);
    await fs.cp(a, b, { recursive: true });
    await fs.writeFile(join(b, 'openmemo.db'), 'X'.repeat(10)); // 截断
    const v = await verifyTreesMatch(a, b);
    assert.equal(v.ok, false);
    assert.ok(v.mismatches.some((m) => m.includes('大小不一致')));
  });

  /*
   * ↓↓↓ T-128：符号链接必须被校验。
   * 这几条钉的是那个**假绿灯**本身 —— 从前 verifyTreesMatch 显式跳过符号链接，
   * 于是"链接被改写成绝对路径"这件事在校验里根本不存在，搬完必然报"两棵树一致"。
   */

  it('★ 符号链接被改写成绝对路径 → 必须报「链接目标不一致」（这正是 fs.cp 默认干的事）', async () => {
    const a = tmp('la');
    const b = tmp('lb');
    await seed(a);
    await seedBackendSymlinks(a);
    // 用 fs.cp 的**默认行为**复制 = 精确复现缺陷：相对链接被改写成指向源目录的绝对路径
    await fs.cp(a, b, { recursive: true, force: true, preserveTimestamps: true });

    const v = await verifyTreesMatch(a, b);
    assert.equal(v.ok, false, '符号链接被改写却报"一致" —— 假绿灯又回来了');
    // 两级链两跳都要被抓到，共 3 个 .so × 2 跳 = 6 条
    const targetMismatches = v.mismatches.filter((m) => m.includes('链接目标不一致'));
    assert.equal(targetMismatches.length, 6, `实际: ${targetMismatches.join(' | ')}`);
  });

  it('★ 原样复制（verbatimSymlinks）→ 校验必须通过', async () => {
    const a = tmp('lva');
    const b = tmp('lvb');
    await seed(a);
    await seedBackendSymlinks(a);
    await fs.cp(a, b, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    const v = await verifyTreesMatch(a, b);
    assert.deepEqual(v.mismatches, []);
    assert.equal(v.ok, true);
  });

  it('★ 链接被复制成了真文件（dereference）→ 必须报「类型不一致」', async () => {
    // 字节数甚至会"更对"（真文件比链接大），只比大小的校验会放行
    const a = tmp('da');
    const b = tmp('db');
    await seed(a);
    await seedBackendSymlinks(a);
    await fs.cp(a, b, { recursive: true, force: true, dereference: true });
    const v = await verifyTreesMatch(a, b);
    assert.equal(v.ok, false);
    assert.ok(v.mismatches.some((m) => m.includes('类型不一致')));
  });

  it('★ 目标少了一条符号链接 → 必须报「缺失」（从前是完全看不见的）', async () => {
    const a = tmp('lma');
    const b = tmp('lmb');
    await seed(a);
    await seedBackendSymlinks(a);
    await fs.cp(a, b, { recursive: true, verbatimSymlinks: true });
    await fs.unlink(join(b, BACKEND_DIR, 'libwhisper.so'));
    const v = await verifyTreesMatch(a, b);
    assert.equal(v.ok, false);
    assert.ok(v.mismatches.some((m) => m.includes('缺失') && m.includes('libwhisper.so')));
  });
});

describe('measureTree —— 符号链接不能当成不存在', () => {
  it('★ 链接单独计数，且不并进 files', async () => {
    const d = tmp('mt');
    await seed(d);
    await seedBackendSymlinks(d);
    const m = await measureTree(d);
    assert.equal(m.links, 6, '3 个 .so × 两级链 = 6 条'); // 从前这里是 0
    // 3 个普通文件（seed） + whisper-cli + 3 个 .so.1.9.1 = 7
    assert.equal(m.files, 7);
    assert.ok(m.bytes > 0);
  });

  it('★ 不跟随指向目录的链接（跟随会重复计数，指向父目录还会死循环）', async () => {
    const d = tmp('mtd');
    await seed(d);
    await fs.symlink('media', join(d, 'media-link')); // 指向同目录下的 media
    await fs.symlink('..', join(d, 'media', 'up')); // 指向父目录 —— 跟随即死循环
    const m = await measureTree(d);
    assert.equal(m.links, 2);
    assert.equal(m.files, 3); // 与不加链接时一致：目标没有被重复统计
  });
});

describe('findStaleLinks —— 搬完之后链接还指着旧位置吗', () => {
  it('★ 指向旧目录的绝对链接必须被找出来', async () => {
    const base = tmp('sl');
    const oldDir = join(base, 'old');
    const newDir = join(base, 'new');
    await fs.mkdir(join(newDir, 'models'), { recursive: true });
    await fs.symlink(join(oldDir, 'models', 'x.so.1'), join(newDir, 'models', 'x.so'));
    const stale = await findStaleLinks(newDir, oldDir);
    assert.equal(stale.length, 1);
    assert.equal(stale[0]?.rel, join('models', 'x.so'));
  });

  it('★ 同目录相对链接不算 stale（这是正确的形态，不能误报）', async () => {
    const base = tmp('sl2');
    const oldDir = join(base, 'old');
    const newDir = join(base, 'new');
    await fs.mkdir(newDir, { recursive: true });
    await seedBackendSymlinks(newDir);
    assert.deepEqual(await findStaleLinks(newDir, oldDir), []);
  });

  it('指向系统目录的链接不算 stale', async () => {
    const base = tmp('sl3');
    const newDir = join(base, 'new');
    await fs.mkdir(newDir, { recursive: true });
    await fs.symlink('/usr/lib/x86_64-linux-gnu/libm.so.6', join(newDir, 'libm.so'));
    assert.deepEqual(await findStaleLinks(newDir, join(base, 'old')), []);
  });
});

describe('moveDataDir', () => {
  it('同盘：rename 快路径，数据完整搬到新位置', async () => {
    const base = tmp('r');
    const from = join(base, 'src');
    const to = join(base, 'dst');
    await fs.mkdir(from, { recursive: true });
    await seed(from);
    const before = await measureTree(from);

    const r = await moveDataDir(from, to);
    assert.equal(r.ok, true);
    assert.equal(r.strategy, 'rename');
    assert.equal((await measureTree(to)).files, before.files);
    await assert.rejects(() => fs.access(from)); // 源已不在
    // 中文文件名必须原样保留
    await fs.access(join(to, 'media', '会议录音.m4a'));
  });

  it('**跨设备（forceCopy）：复制→校验→才删源**，数据完整', async () => {
    const base = tmp('c');
    const from = join(base, 'src');
    const to = join(base, 'dst');
    await fs.mkdir(from, { recursive: true });
    await seed(from);
    const before = await measureTree(from);

    const steps: string[] = [];
    const r = await moveDataDir(from, to, { forceCopy: true, onStep: (s) => steps.push(s) });
    assert.equal(r.ok, true);
    assert.equal(r.strategy, 'copy');
    assert.equal((await measureTree(to)).bytes, before.bytes);
    // 顺序必须是先校验后删源 —— 反过来就是"校验没过数据已经没了"
    assert.ok(steps.indexOf('verifying') < steps.indexOf('removing-source'));
  });

  it('★ 目标非空必须拒绝，且**源原封不动**', async () => {
    const base = tmp('ne');
    const from = join(base, 'src');
    const to = join(base, 'dst');
    await fs.mkdir(from, { recursive: true });
    await fs.mkdir(to, { recursive: true });
    await seed(from);
    await fs.writeFile(join(to, '别人的文件.txt'), 'keep me');
    const before = await measureTree(from);

    const r = await moveDataDir(from, to);
    assert.equal(r.ok, false);
    assert.equal(r.sourceIntact, true);
    assert.deepEqual(await measureTree(from), before); // 源一个字节没动
    await fs.access(join(to, '别人的文件.txt')); // 目标原有内容也没被吃掉
  });

  it('★ 空间不足必须**提前拒绝**，不留半个副本', async () => {
    const base = tmp('sp');
    const from = join(base, 'src');
    const to = join(base, 'dst');
    await fs.mkdir(from, { recursive: true });
    await seed(from);
    const before = await measureTree(from);

    // headroom 拉到天文数字 = 模拟"目标盘装不下"
    const r = await moveDataDir(from, to, { headroom: 1e12 });
    assert.equal(r.ok, false);
    assert.equal(r.sourceIntact, true);
    assert.match(r.errorZh ?? '', /空间不足/);
    assert.deepEqual(await measureTree(from), before);
    // 预检失败时不能留下一个空的目标目录冒充"搬过了"
    await assert.rejects(() => fs.access(to));
  });

  it('★ 目标在源内部必须拒绝，源不动', async () => {
    const base = tmp('in');
    const from = join(base, 'src');
    await fs.mkdir(from, { recursive: true });
    await seed(from);
    const before = await measureTree(from);

    const r = await moveDataDir(from, join(from, 'inner'));
    assert.equal(r.ok, false);
    assert.equal(r.sourceIntact, true);
    assert.deepEqual(await measureTree(from), before);
  });
});

/**
 * T-128 端到端：**搬完之后 whisper 后端还能不能加载**。
 *
 * 这一组是全套里唯一验「功能可用」而不是「文件在不在」的 —— 用户遇到的正是
 * 文件全在、字节数全对、自检全绿，而 `.so` 一条都读不出来。
 * 所以断言必须是「顺着两级链真的读到目标内容」，不能是「链接存在」。
 */
describe('★ T-128 移动数据目录不能弄坏符号链接', () => {
  for (const strategy of ['rename（同盘快路径）', 'copy（跨盘慢路径）'] as const) {
    const forceCopy = strategy.startsWith('copy');

    it(`★ ${strategy}：搬完源目录删掉后，两级 .so 链仍然可加载`, async () => {
      const base = tmp(forceCopy ? 'soc' : 'sor');
      const from = join(base, 'src');
      const to = join(base, 'dst');
      await fs.mkdir(from, { recursive: true });
      await seed(from);
      await seedBackendSymlinks(from);
      // 前提自检：搬之前它本来是好的（不然这个测试什么都证明不了）
      assert.equal(await soIsLoadable(from, 'libwhisper'), true, '测试前提不成立');

      const r = await moveDataDir(from, to, forceCopy ? { forceCopy: true } : {});
      assert.equal(r.ok, true);
      assert.equal(r.links, 6);
      await assert.rejects(() => fs.access(from), '源目录应已删除');

      for (const so of SO_NAMES) {
        // 第一跳必须仍是**相对**的：绝对路径指向的是已经不存在的旧位置
        const hop1 = await fs.readlink(join(to, BACKEND_DIR, `${so}.so`));
        assert.equal(hop1, `${so}.so.1`, `${so}.so 的链接目标被改写了`);
        const hop2 = await fs.readlink(join(to, BACKEND_DIR, `${so}.so.1`));
        assert.equal(hop2, `${so}.so.1.9.1`, `${so}.so.1 的链接目标被改写了`);
        // 真正要的结论：顺着链读得到内容
        assert.equal(await soIsLoadable(to, so), true, `${so}.so 在移动后已经断了`);
      }
      assert.deepEqual(r.staleLinks, [], '不该有指向旧位置的链接');
    });
  }

  it('★ 复制路径若把链接改写了，校验必须**拦下来并回滚**，源一个字节不动', async () => {
    // 直接对 verifyTreesMatch 施压：模拟"有人把 verbatimSymlinks 拿掉了"的产物
    const base = tmp('rb');
    const from = join(base, 'src');
    const to = join(base, 'dst');
    await fs.mkdir(from, { recursive: true });
    await seed(from);
    await seedBackendSymlinks(from);
    await fs.cp(from, to, { recursive: true, force: true, preserveTimestamps: true }); // 默认=会改写

    const v = await verifyTreesMatch(from, to);
    assert.equal(v.ok, false, '校验放行了一棵链接已被改写的树 —— 源就会被删掉');
    assert.ok(v.mismatches.some((m) => m.includes('链接目标不一致')));
  });

  it('★ 数据里本来就有**绝对路径**链接指向自己 → 搬完必须报出来（verbatim 修不了这种）', async () => {
    const base = tmp('abs');
    const from = join(base, 'src');
    const to = join(base, 'dst');
    await fs.mkdir(join(from, 'models'), { recursive: true });
    await seed(from);
    await fs.writeFile(join(from, 'models', 'libx.so.1'), 'REAL');
    // 绝对路径指向源目录内部：原样搬过去 → 两棵树逐字相同 → 校验必然通过 → 而链接是断的
    await fs.symlink(join(from, 'models', 'libx.so.1'), join(from, 'models', 'libx.so'));

    const r = await moveDataDir(from, to, { forceCopy: true });
    assert.equal(r.ok, true, '数据本身是搬成功的，不该因此回滚');
    assert.equal(r.staleLinks.length, 1, '指向旧位置的链接必须被报出来，不能静默绿灯');
    assert.equal(r.staleLinks[0]?.rel, join('models', 'libx.so'));
    assert.match(r.warningZh ?? '', /仍指向旧位置/);
    // 客观事实核对：它确实已经断了
    await assert.rejects(() => fs.readFile(join(to, 'models', 'libx.so')));
  });

  /**
   * ★ 算出来了还得**送出去**。
   *
   * `staleLinks`/`warningZh` 的全部价值就是让"链接断了"这件事不再静默。
   * 如果 HTTP 层不转发它，我们就只是把一盏假绿灯换成一盏**没接线的红灯** ——
   * 这个仓库已经栽过同一形状的跟头（`build` 字段后端返回了、前端手抄时漏掉；
   * `job.blocked` 的 toast 接收方一直在等一个没人发的事件）。
   *
   * ⚠️ 这是**源码级**断言，不是跑一次 HTTP。它能挡住"有人把字段从响应里删掉"，
   * 挡不住"字段名拼错但两边一致地错"。真实 HTTP 响应我另外对着真 daemon 验过一次
   * （输出贴在 inbox），两者合起来才算数；单独任何一条我都不会说它验过了。
   */
  it('★ HTTP 层必须把 staleLinks/warningZh 转发出去（算出来不送出去等于没修）', async () => {
    // ⚠️ 用 **cwd 相对路径**而不是 `import.meta.url`：测试跑的是 `dist/` 里的产物，
    // `import.meta.url` 会指到 `dist/storage/` 去，读不到源码。（第一版就这么写错了。）
    const src = await fs.readFile(`${process.cwd()}/src/http/rest/storage.ts`, 'utf8');
    // 用 includes 而不是 assert.match：断言失败时 match 会把整份源码打进报告，
    // 几百行噪音会把真正的那一句结论淹掉。
    assert.ok(src.includes('staleLinks: result.staleLinks'), '响应里没有 staleLinks');
    assert.ok(src.includes('result.warningZh'), '响应里没有 warningZh');
    assert.ok(src.includes('links: result.links'), '响应里没有链接计数');
  });

  it('★ rename 快路径也要查 stale 链接（它根本不调用 verifyTreesMatch）', async () => {
    const base = tmp('absr');
    const from = join(base, 'src');
    const to = join(base, 'dst');
    await fs.mkdir(join(from, 'models'), { recursive: true });
    await seed(from);
    await fs.writeFile(join(from, 'models', 'libx.so.1'), 'REAL');
    await fs.symlink(join(from, 'models', 'libx.so.1'), join(from, 'models', 'libx.so'));

    const r = await moveDataDir(from, to);
    assert.equal(r.strategy, 'rename');
    assert.equal(r.ok, true);
    assert.equal(r.staleLinks.length, 1);
  });
});

/**
 * ★ 「控制流位置」错误 —— 这一类**能不能被测试覆盖**？能。
 *
 * 起因：我把 `return await succeeded(...)` 写在了 `try` 里面。收尾一步一旦抛错，
 * 就会被那个 `catch` 接住，而 catch 做的是**破坏性回滚**（`fs.rm(to)`）——
 * 此刻源目录已经删了，于是回滚删掉的是**唯一一份数据**。
 * 后果比本任务原本要修的符号链接严重一个量级：那个是弄坏 `.so`，这个是清空用户的笔记。
 *
 * 我最初是**复读代码**发现它的，不是测试。但复读发现 ≠ 只能靠复读：
 * `MoveOptions.onStep` 本来就是一个回调，**它就是现成的故障注入点** ——
 * 让它在指定步骤抛错，就能精确构造"收尾阶段失败"这个此前无法到达的状态。
 *
 * 所以这两条测试钉的不是某个字段的值，而是一条不变量：
 *   **过了「校验通过」这条线之后，无论再发生什么，`to` 里的数据都必须还在。**
 */
describe('★ 收尾阶段抛错时，绝不能把已经搬好的数据删掉', () => {
  /** 在指定步骤抛错的 onStep —— 故障注入。 */
  const throwAt = (target: string) => (s: string) => {
    if (s === target) throw new Error(`注入故障 @ ${target}`);
  };

  it('★ rename 成功后收尾抛错 → 新位置的数据必须完好（不能掉进复制路径）', async () => {
    const base = tmp('fi-r');
    const from = join(base, 'src');
    const to = join(base, 'dst');
    await fs.mkdir(from, { recursive: true });
    await seed(from);
    await seedBackendSymlinks(from);

    // 收尾（checking-links）抛错。写在 try 里时，catch 会把它当成"rename 失败"
    // 而落进复制路径 —— 可源目录此刻已经不存在了。
    await moveDataDir(from, to, { onStep: throwAt('checking-links') }).catch(() => undefined);

    // 唯一真正要紧的事：数据还在不在
    await fs.access(join(to, 'openmemo.db'));
    await fs.access(join(to, 'media', '会议录音.m4a'));
    assert.equal(await soIsLoadable(to, 'libwhisper'), true, '后端链接也得完好');
  });

  it('★ copy 校验通过后收尾抛错 → 新位置的数据必须完好（回滚会毁掉唯一一份）', async () => {
    const base = tmp('fi-c');
    const from = join(base, 'src');
    const to = join(base, 'dst');
    await fs.mkdir(from, { recursive: true });
    await seed(from);

    await moveDataDir(from, to, {
      forceCopy: true,
      onStep: throwAt('checking-links'),
    }).catch(() => undefined);

    await fs.access(join(to, 'openmemo.db'));
    assert.equal((await measureTree(to)).files, 3, '复制出来的文件一个都不能少');
  });

  /**
   * 同一形状的**第二处**（复读时一并找出来的，不是同一个 bug）：
   * `fs.rm(from)` 原本也在那个会回滚的 try 里。删源删到一半失败（权限 / 文件被占用），
   * catch 就会 `fs.rm(to)` —— **源缺了一半，目标被删光，两份都毁**。
   * 现在删源移到了 try 外，失败只降级成一条警告。
   */
  it('★ 删源失败只能降级成警告，绝不能反过来删掉新位置', async () => {
    const base = tmp('fi-rm');
    const from = join(base, 'src');
    const to = join(base, 'dst');
    await fs.mkdir(from, { recursive: true });
    await seed(from);

    const r = await moveDataDir(from, to, {
      forceCopy: true,
      onStep: throwAt('removing-source'),
    }).catch(() => undefined);

    // 数据在新位置，完整
    await fs.access(join(to, 'openmemo.db'));
    assert.equal((await measureTree(to)).files, 3);
    // 而且源目录也还在（删源那一步根本没执行）—— 没有"两边各一半"
    await fs.access(join(from, 'openmemo.db'));
    if (r) assert.equal(r.ok, true, '删源失败不该把整次迁移判成失败');
  });
});

describe('looksLikeDataDir —— 区分"我们自己的目录"与"别人的东西"', () => {
  it('含 openmemo.db 的目录 → 是', async () => {
    const d = tmp('is');
    await seed(d);
    assert.equal(await looksLikeDataDir(d), true);
  });

  it('★ 非空但没有 openmemo.db → 不是（必须保护用户的别的文件）', async () => {
    const d = tmp('not');
    await fs.mkdir(join(d, 'sub'), { recursive: true });
    await fs.writeFile(join(d, '我的论文.docx'), 'x');
    assert.equal(await looksLikeDataDir(d), false);
  });

  it('空目录 → 不是', async () => {
    assert.equal(await looksLikeDataDir(tmp('empty')), false);
  });

  it('★ openmemo.db 是 0 字节（半途失败的残留）→ 不当作有效数据目录', async () => {
    const d = tmp('zero');
    await fs.writeFile(join(d, 'openmemo.db'), '');
    assert.equal(await looksLikeDataDir(d), false);
  });

  it('目录不存在 → 不是（不抛）', async () => {
    assert.equal(await looksLikeDataDir('/definitely/not/here'), false);
  });
});
