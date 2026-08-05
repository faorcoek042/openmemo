/**
 * `assetPaths` —— `media_assets.rel_path` 唯一那份解析规则的单元测试（T-136）。
 *
 * 这里钉的是**候选顺序**和**"读得到"的判据**，因为播放端（`/media/asset/<ulid>`）、
 * `/api/selfcheck`、路径迁移三处现在共用它：任何一处再各写各的基准，
 * 就会重演"文件在盘上、红灯说它被删了"。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { after, describe, it } from 'node:test';

import { assetCandidates, mediaAssetRoots, probeAssetFile } from './assetPaths.js';

const made: string[] = [];
after(async () => {
  for (const d of made) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function seed(files: Record<string, string>): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), 'om-ap-'));
  made.push(d);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(d, rel);
    await fs.mkdir(join(abs, '..'), { recursive: true });
    await fs.writeFile(abs, body);
  }
  return d;
}

/*
 * ★ T-147：这一组以前把期望值写成字面量 `'/d/media/a.wav'`。
 *
 * 产品代码用的是 `path.join`/`resolve`，所以在 Windows 上 `resolve('/d')` 是
 * `D:\d`（当前盘符），三条断言全部 `'/d/media/a.wav' !== 'D:\d\media\a.wav'` 变红
 * —— `[CI 实测]` ci-crossplatform run 31017923588，win32/x64 上就是这三条。
 *
 * 关键在于它们**不是"在 Windows 上失败"，是"在 Windows 上从来没测到过东西"**：
 * 把 `assetCandidates` 整个换成 `return []` 也是同样的红，两种红分不开。
 *
 * 修法不是 skip（skip 之后 Windows 就永远没人测了），是**让期望值也走同一套路径语义**：
 * `BASE` 用 `resolve()` 取本平台的绝对根，期望值用 `join()` 拼。
 * 这样断言钉住的仍然是**结构**（候选顺序、去重、越界剔除），而不是某平台的字符串长相。
 */
describe('assetCandidates —— 纯函数：展开候选并挡住越界', () => {
  /** 本平台上的一个绝对根：POSIX 上是 `/d`，Windows 上是 `<当前盘>:\d`。 */
  const BASE = resolve('/d');
  const roots = mediaAssetRoots(BASE);

  it('三个根的顺序就是优先级：media → tmp → dataDir', () => {
    assert.deepEqual(assetCandidates(roots, 'a.wav'), [
      join(BASE, 'media', 'a.wav'),
      join(BASE, 'tmp', 'a.wav'),
      join(BASE, 'a.wav'),
    ]);
  });

  it('绝对路径只有它自己一个候选，且必须落在根内', () => {
    const inside = join(BASE, 'media', 'x.wav');
    assert.deepEqual(assetCandidates(roots, inside), [inside]);
    assert.deepEqual(assetCandidates(roots, resolve('/elsewhere/x.wav')), []);
  });

  it('★ `..` 穿越出去的候选被剔除，剩下的仍然可用', () => {
    // <BASE>/media/../../etc/passwd → <BASE 的上一级>/etc/passwd（出界，剔除）
    // <BASE>/tmp/../../etc/passwd   → 同上
    // <BASE>/../etc/passwd          → 同上
    assert.deepEqual(assetCandidates(roots, '../../etc/passwd'), []);
    /*
     * `../jfk.wav`：从 media/ 和 tmp/ 退一级都落到 `<BASE>/jfk.wav`（去重后只剩一个），
     * 从 dataDir 退一级是 `<BASE>/..` 之外 —— 出界，剔除。
     */
    assert.deepEqual(assetCandidates(roots, '../jfk.wav'), [join(BASE, 'jfk.wav')]);
  });

  it('空路径 → 没有候选（否则候选会变成"根目录本身"）', () => {
    assert.deepEqual(assetCandidates(roots, ''), []);
  });

  /*
   * ★ 这条是新加的，专门钉住"期望值不许再退化成宿主写法"：
   * 三个候选**必须**以本平台的分隔符拼接。写死 `/` 的实现在 Windows 上
   * 会拼出 `D:\d/media/a.wav` 这种混合串 —— `resolve` 认得，
   * 而 `assetPaths.ts:35` 的 `startsWith(root + sep)` 越界判据不认得。
   */
  it('★ 候选用的是本平台的路径分隔符（Windows 上不许拼出 `/`）', () => {
    for (const c of assetCandidates(roots, 'a.wav')) {
      assert.equal(c.startsWith(BASE + sep), true, `${c} 不是从 ${BASE}${sep} 长出来的`);
    }
  });
});

describe('probeAssetFile —— 判据是"真的打开并读到字节"', () => {
  it('★ 命中第一个**真能打开**的候选，而不是第一个落在根内的', async () => {
    const d = await seed({ 'media/legacy/x.wav': 'DATA' });
    // 候选① `<d>/media/media/legacy/x.wav` 落在根内但不存在 —— 旧实现就停在这儿，
    // 于是这条记录永远 404，而文件明明在。
    const p = await probeAssetFile(mediaAssetRoots(d), 'media/legacy/x.wav');
    assert.equal(p.abs, join(d, 'media', 'legacy', 'x.wav'));
    assert.equal(p.note, Buffer.from('DATA').toString('hex'));
    assert.equal(p.tried[0], join(d, 'media', 'media', 'legacy', 'x.wav'));
  });

  it('同名时按根的顺序取，media 根优先', async () => {
    const d = await seed({ 'media/dup.wav': 'MEDI', 'dup.wav': 'ROOT' });
    const p = await probeAssetFile(mediaAssetRoots(d), 'dup.wav');
    assert.equal(p.abs, join(d, 'media', 'dup.wav'));
  });

  it('★ 一个都打不开 → abs 为 null，但 tried 列出全部找过的位置', async () => {
    const d = await seed({});
    const p = await probeAssetFile(mediaAssetRoots(d), 'gone.wav');
    assert.equal(p.abs, null);
    assert.deepEqual(p.tried, [
      join(d, 'media', 'gone.wav'),
      join(d, 'tmp', 'gone.wav'),
      join(d, 'gone.wav'),
    ]);
    assert.equal(p.note, 'ENOENT');
  });

  it('★ 悬空符号链接算读不到（`lstat` 对它照样成功 —— T-128 的那盏假绿灯）', async () => {
    const d = await seed({ 'media/keep': 'x' });
    await fs.symlink(join(d, 'media', 'nope.wav'), join(d, 'media', 'dangling.wav'));
    // 先证明它确实是条"看起来存在"的链接，否则这条用例钉的是零
    assert.equal((await fs.lstat(join(d, 'media', 'dangling.wav'))).isSymbolicLink(), true);
    const p = await probeAssetFile(mediaAssetRoots(d), 'dangling.wav');
    assert.equal(p.abs, null);
  });

  it('★ 0 字节文件：能打开，但 bytesRead 为 0（调用方据此区分"在"和"能播"）', async () => {
    const d = await seed({ 'media/empty.wav': '' });
    const p = await probeAssetFile(mediaAssetRoots(d), 'empty.wav');
    assert.equal(p.abs, join(d, 'media', 'empty.wav'));
    assert.equal(p.bytesRead, 0);
    assert.equal(p.note, '0 字节');
  });

  it('候选恰好是个目录 → 跳过它继续试下一个根', async () => {
    const d = await seed({ 'sub/a.wav': 'REAL' });
    await fs.mkdir(join(d, 'media', 'sub'), { recursive: true });
    const p = await probeAssetFile(mediaAssetRoots(d), 'sub');
    assert.equal(p.abs, null, '目录不是资产');
  });

  it('越界 → tried 为空（"越界"和"文件不在"是两码事）', async () => {
    const d = await seed({});
    const p = await probeAssetFile(mediaAssetRoots(d), '/etc/hostname');
    assert.deepEqual(p.tried, []);
    assert.equal(p.abs, null);
  });
});

/**
 * ★ T-143 ①：**词法剔除挡不住 `open()` 跟随符号链接。**
 *
 * 这一组的判据一律是**后果**：不是"有没有调用 realpath"、不是"note 里有没有某个词"，
 * 而是「**根外那份文件的字节有没有被交出来**」。所以每条用例都先把根外文件的内容
 * 写成一个独一无二的串，再断言它**没有**出现在返回值里 —— 守卫整段删掉时，
 * `abs` 会重新变成那条软链，`bytesRead` 会重新变成 4，两条断言同时变红。
 */
describe('probeAssetFile —— 符号链接不许把根外的内容交出来（T-143 ①）', () => {
  /** 造一个**在所有根之外**的秘密文件，返回它的绝对路径与内容。 */
  async function secretOutside(): Promise<{ path: string; body: string }> {
    const outside = mkdtempSync(join(tmpdir(), 'om-ap-OUTSIDE-'));
    made.push(outside);
    const body = 'SECRET-OUTSIDE-ROOT';
    const p = join(outside, 'secret.txt');
    await fs.writeFile(p, body);
    return { path: p, body };
  }

  it('★ 根内的软链指向根外 → 拒绝，且根外内容一个字节都不出来', async () => {
    const d = await seed({ 'media/keep': 'x' });
    const secret = await secretOutside();
    const link = join(d, 'media', 'escape.wav');
    await fs.symlink(secret.path, link);

    // 先证明这条链**真的能打开**、且打开的就是根外那份 —— 否则本用例钉的是零
    assert.equal(await fs.readFile(link, 'utf8'), secret.body);

    const p = await probeAssetFile(mediaAssetRoots(d), 'escape.wav');
    assert.equal(p.abs, null, '越界的软链不许被选中');
    assert.equal(p.bytesRead, 0, '一个字节都不许读出来');
    assert.deepEqual([...p.escaped], [link], '被拒的候选要如实列出来，供调用方报 403');
    // 根外内容不许出现在返回值的任何一处（note 里也不行）
    assert.equal(JSON.stringify(p).includes(Buffer.from(secret.body).toString('hex')), false);
  });

  it('★ 祖先**目录**是软链同样挡住（realpath 要跟完整条路，不是只看最后一段）', async () => {
    const d = await seed({ 'media/keep': 'x' });
    const secret = await secretOutside();
    await fs.symlink(join(secret.path, '..'), join(d, 'media', 'outdir'));

    assert.equal(await fs.readFile(join(d, 'media', 'outdir', 'secret.txt'), 'utf8'), secret.body);

    const p = await probeAssetFile(mediaAssetRoots(d), 'outdir/secret.txt');
    assert.equal(p.abs, null);
    assert.equal(p.bytesRead, 0);
    assert.deepEqual([...p.escaped], [join(d, 'media', 'outdir', 'secret.txt')]);
  });

  it('★ 越界候选之后还有能用的候选 → 不许因为前面那条被拒就整条记录失败', async () => {
    const d = await seed({ 'tmp/both.wav': 'GOOD', 'media/keep': 'x' });
    const secret = await secretOutside();
    await fs.symlink(secret.path, join(d, 'media', 'both.wav'));

    const p = await probeAssetFile(mediaAssetRoots(d), 'both.wav');
    assert.equal(p.abs, join(d, 'tmp', 'both.wav'), '应当继续试下一个根');
    assert.equal(p.note, Buffer.from('GOOD').toString('hex'));
    assert.deepEqual([...p.escaped], [join(d, 'media', 'both.wav')]);
  });

  it('★ 合法的两级相对软链照常解析（`libwhisper.so → .so.1 → .so.1.9.1`，T-128 那 8 条）', async () => {
    const d = await seed({ 'media/libwhisper.so.1.9.1': 'ELFW' });
    await fs.symlink('libwhisper.so.1.9.1', join(d, 'media', 'libwhisper.so.1'));
    await fs.symlink('libwhisper.so.1', join(d, 'media', 'libwhisper.so'));

    const p = await probeAssetFile(mediaAssetRoots(d), 'libwhisper.so');
    assert.equal(p.abs, join(d, 'media', 'libwhisper.so'), '按类型一刀切拒绝软链会把后端拆掉');
    assert.equal(p.note, Buffer.from('ELFW').toString('hex'), '顺着链真的读到了目标内容');
    assert.deepEqual([...p.escaped], []);
  });

  it('★ 指向根内**另一个根**的软链仍然放行（跨根不是越界）', async () => {
    const d = await seed({ 'tmp/real.wav': 'CROS', 'media/keep': 'x' });
    await fs.symlink(join(d, 'tmp', 'real.wav'), join(d, 'media', 'alias.wav'));
    const p = await probeAssetFile(mediaAssetRoots(d), 'alias.wav');
    assert.equal(p.abs, join(d, 'media', 'alias.wav'));
    assert.equal(p.note, Buffer.from('CROS').toString('hex'));
  });

  it('★ 数据目录本身经由软链访问时**不许全盘误杀**（macOS 的 /var → /private/var 形态）', async () => {
    const real = await seed({ 'media/a.wav': 'REAL' });
    const box = mkdtempSync(join(tmpdir(), 'om-ap-box-'));
    made.push(box);
    const viaLink = join(box, 'datadir'); // <box>/datadir → <real>
    await fs.symlink(real, viaLink);

    // 用**软链形式的 dataDir** 算根，候选的 realpath 会落在 <real> 下而不是 <viaLink> 下
    const p = await probeAssetFile(mediaAssetRoots(viaLink), 'a.wav');
    assert.equal(p.abs, join(viaLink, 'media', 'a.wav'), '根也要 realpath，否则整个媒体库全 403');
    assert.equal(p.note, Buffer.from('REAL').toString('hex'));
    assert.deepEqual([...p.escaped], []);
  });
});
