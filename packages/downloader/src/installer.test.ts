/**
 * T-153 ② —— **CoreML encoder 解包多出一层同名目录**（`pack-publish` T-146 §3.3 断点 #1）。
 *
 * ## 这条钉的后果，不是钉一个函数
 *
 * `install()` 把 `<X>.mlmodelc.zip` 解到 `by-name/asr/<X>.mlmodelc/`，
 * 而上游那个 zip **内部自带一层同名顶层目录**，于是真实结构是
 * `<X>.mlmodelc/<X>.mlmodelc/coremldata.bin` —— **外层是个空壳**。
 *
 * whisper.cpp 从 `-m` 推出来的路径是外层那个（`whisper.cpp:3326-3348`），
 * 加载失败后 `WHISPER_COREML_ALLOW_FALLBACK=ON` **打一行 ERROR 然后照常跑**
 * （`whisper.cpp:3440-3452`），而那行 ERROR 被 `--no-prints` 关掉的日志通道吞掉
 * （`whisperCpp.ts:101` → `cli.cpp:1039-1040`）。
 * 净效果：**装了 ANE，没有变快，没有任何地方说话。**
 *
 * 所以断言不是"目录层数对不对"，是 **`asr.coreml` 那一项要找的那个文件
 * （`<X>.mlmodelc/coremldata.bin`）真的在它该在的位置**。
 * 判据与 `packages/runtime/src/selfcheck.ts` 的 `checkCoreMl()` **逐字同一个**。
 *
 * ## 为什么走真的 `install()`
 *
 * 中间隔着 `downloadFile` → sha256 校验 → `linkByName` → `unpackArchive` → 原子换入
 * 五个环节，其中任何一环都可能把布局改掉。测一个内部函数只能证明那个函数对，
 * 证明不了**用户装完之后磁盘上长什么样** —— 而后者才是坏掉的那件事。
 * （HANDOFF ⑤ 规矩 3：验收某性质时必须走产品的真实路径。）
 *
 * 桩服务器绑 `:0`（由 OS 分配端口），不占任何固定端口。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';

import { unpackArchive } from './unpack.js';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { install } from './installer.js';
import { ArtifactStore } from './store.js';

/* ─────────────────── 最小 ZIP 写入器（只为造夹具，不进产品） ─────────────────── */

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * 手写一个合法的 ZIP。仓库禁止为这种事引依赖（ADR-001），而 `unpack.ts` 本来
 * 就是手写解析器 —— 这里是它的对偶，**刻意不复用它的任何代码**，
 * 否则两边同一个理解错误会互相"证实"。
 */
function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const comp = deflateRawSync(e.data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(8, 8); // method: deflate
    lfh.writeUInt32LE(0, 10); // time/date
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(e.data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);
    locals.push(lfh, name, comp);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(0x031e, 4); // version made by: unix
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(8, 10);
    cdh.writeUInt32LE(0, 12);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(comp.length, 20);
    cdh.writeUInt32LE(e.data.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    // 外部属性：unix mode 在高 16 位。⚠️ 不能写 `<< 16` —— JS 位运算是 32 位有符号，
    // `0o100644 << 16` 会溢出成负数，writeUInt32LE 当场 ERR_OUT_OF_RANGE（第一版就是这么红的）。
    cdh.writeUInt32LE(0o100644 * 0x10000, 38);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, name);

    offset += lfh.length + name.length + comp.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (const b of buf) c = (c >>> 8) ^ (CRC_TABLE[(c ^ b) & 0xff] as number);
  return (c ^ -1) >>> 0;
}

/* ─────────────────────────── 桩源（不出网，端口由 OS 分配） ─────────────────────────── */

let server: Server;
let origin = '';
const served = new Map<string, Buffer>();

before(async () => {
  server = createServer((req, res) => {
    const body = served.get(req.url ?? '');
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    // 刻意**不**声明 accept-ranges：`download.ts:299` 会优雅退化成单流，
    // 走的仍然是产品的真实下载路径。
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  origin = `http://127.0.0.1:${String(addr.port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function installZip(
  name: string,
  entries: ZipEntry[],
  reuseStore?: ArtifactStore,
): Promise<{ dir: string }> {
  const zip = makeZip(entries);
  const sha = createHash('sha256').update(zip).digest('hex');
  served.set(`/${name}`, zip);

  const store =
    reuseStore ?? new ArtifactStore(join(await mkdtemp(join(tmpdir(), 'om-installer-')), 'models'));
  const out = await install({
    store,
    target: {
      id: 'asr/test-model',
      kind: 'asr',
      displayName: 'test',
      files: [
        {
          role: 'coreml-encoder',
          name,
          sizeBytes: zip.length,
          sha256: sha,
          unpack: 'zip',
          mirrors: [{ provider: 'custom', url: `${origin}/${name}`, official: true }],
        },
      ],
    },
    maxParts: 1,
  });
  assert.ok(out.installedTo, `install() 没有报告解包目录：${JSON.stringify(out)}`);
  return { dir: out.installedTo! };
}

const ENC = 'ggml-large-v3-turbo-encoder.mlmodelc';

describe('T-153 ② CoreML encoder：解包不许多出一层同名目录', () => {
  it('★ zip 自带一层同名顶层目录时，coremldata.bin 必须落在 <X>.mlmodelc/ 的**第一层**', async () => {
    const { dir } = await installZip(`${ENC}.zip`, [
      { name: `${ENC}/coremldata.bin`, data: Buffer.from('coreml-data') },
      { name: `${ENC}/model.espresso.net`, data: Buffer.from('{}') },
    ]);

    /*
     * 判据与 `packages/runtime/src/selfcheck.ts` 的 `checkCoreMl()` 逐字同一个：
     * 它 `readdir(<X>.mlmodelc)` 然后看 `entries.includes('coremldata.bin')`。
     * 不修的话这里是 `['ggml-large-v3-turbo-encoder.mlmodelc']` —— 一个空壳。
     */
    const entries = await readdir(dir);
    assert.equal(
      entries.includes('coremldata.bin'),
      true,
      `<X>.mlmodelc 里没有 coremldata.bin，whisper 会**静默回退**到 Metal/CPU。实际内容：${JSON.stringify(entries)}`,
    );
    // 内容也要对得上 —— 目录在、文件名对、内容错，同样是静默回退
    assert.equal(await fs.readFile(join(dir, 'coremldata.bin'), 'utf8'), 'coreml-data');
    // 而且不许留下一个空的中间层
    assert.equal(entries.includes(ENC), false, `还套着一层同名目录：${JSON.stringify(entries)}`);
  });

  it('zip 本来就是平铺的（没有那层冗余目录）→ 行为完全不变', async () => {
    const { dir } = await installZip(`flat-${ENC}.zip`, [
      { name: 'coremldata.bin', data: Buffer.from('flat') },
    ]);
    assert.deepEqual(await readdir(dir), ['coremldata.bin']);
  });

  it('★ 顶层只有一个目录、但**名字不同** → 绝不许压掉（那会改坏别的包的布局）', async () => {
    /*
     * 这条是这次修复的**安全边界**。一个正当地把内容放在 `bin/` 下的后端包，
     * 如果被"只有一个目录就压掉"的规则命中，`providesFiles` 里记的路径会全错，
     * 而且同样不会有任何东西报错。所以判据必须是"名字逐字相同"，
     * 而不是"顶层只有一个目录"。
     */
    const { dir } = await installZip('some-backend-pack.zip', [
      { name: 'bin/whisper-cli', data: Buffer.from('ELF') },
      { name: 'bin/libggml.so', data: Buffer.from('ELF') },
    ]);
    assert.deepEqual(await readdir(dir), ['bin']);
    assert.deepEqual(await readdir(join(dir, 'bin')), ['libggml.so', 'whisper-cli']);
  });

  it('顶层有两个条目（其中一个同名）→ 也不许压：那不是"冗余顶层目录"这个形状', async () => {
    const { dir } = await installZip(`two-${ENC}.zip`, [
      { name: `two-${ENC}/coremldata.bin`, data: Buffer.from('x') },
      { name: 'README.txt', data: Buffer.from('hi') },
    ]);
    assert.deepEqual((await readdir(dir)).sort(), ['README.txt', `two-${ENC}`]);
  });
});

/**
 * T-168 ① —— **上面那组测试全绿，而线上仍然是坏的。**
 *
 * ## 差在哪
 *
 * 上面每个夹具的顶层条目都是**载荷**。真归档不是：macOS 上打的包会多一个
 * `__MACOSX/`，于是 `entries.length !== 1`，T-153 那条修复**一次都没生效过**。
 * macOS CI（run 31163897527）装完 1.17 GB 的 encoder，磁盘上是
 * `<X>.mlmodelc/{__MACOSX, <X>.mlmodelc}` —— 空壳，whisper 静默回退到 Metal/CPU。
 *
 * **教训不是"再加一条判据"，是"夹具要照着真归档造"。**
 * 所以下面的条目名不是编的：它们逐字取自上游 zip 的中央目录
 * （用 HTTP Range 只读回中央目录，没下那 1.17 GB）。
 *
 * ## 判据
 *
 * 与 `selfcheck.ts` 的 `checkCoreMl()` 逐字同一条：
 * `readdir(<X>.mlmodelc)` 里必须**直接**有 `coremldata.bin`。
 */
describe('T-168 ① 真归档形状：__MACOSX 不许废掉层级修复', () => {
  const V3 = 'ggml-large-v3-encoder.mlmodelc';

  it('★ large-v3 的真条目表（同名顶层目录 + __MACOSX）→ coremldata.bin 必须在第一层', async () => {
    const { dir } = await installZip(`${V3}.zip`, [
      { name: `${V3}/metadata.json`, data: Buffer.from('{}') },
      // ↓ 真归档里就是这一条，171 字节，它一个人废掉了整条修复
      { name: `__MACOSX/${V3}/._metadata.json`, data: Buffer.from('applédouble') },
      { name: `${V3}/model.mil`, data: Buffer.from('mil') },
      { name: `${V3}/coremldata.bin`, data: Buffer.from('COREML-DATA') },
      { name: `${V3}/weights/weight.bin`, data: Buffer.from('weights') },
      { name: `${V3}/analytics/coremldata.bin`, data: Buffer.from('analytics') },
    ]);

    const entries = (await readdir(dir)).sort();
    assert.equal(
      entries.includes('coremldata.bin'),
      true,
      `<X>.mlmodelc 里没有 coremldata.bin —— whisper 会**静默回退**。实际内容：${JSON.stringify(entries)}`,
    );
    assert.equal(await fs.readFile(join(dir, 'coremldata.bin'), 'utf8'), 'COREML-DATA');
    // 垃圾不许跟着进来（`__MACOSX` 落盘时正是它让 collapse 压不掉）
    assert.equal(
      entries.includes('__MACOSX'),
      false,
      `__MACOSX 落盘了：${JSON.stringify(entries)}`,
    );
    // 也不许还套着一层
    assert.equal(entries.includes(V3), false, `还套着一层同名目录：${JSON.stringify(entries)}`);
    // 载荷的子目录一个都不许少
    assert.deepEqual(entries, [
      'analytics',
      'coremldata.bin',
      'metadata.json',
      'model.mil',
      'weights',
    ]);
  });

  it('★ turbo（macOS CI 实测的那一个）同形状 → 同样必须落对', async () => {
    const { dir } = await installZip(`${ENC}.zip`, [
      { name: `${ENC}/coremldata.bin`, data: Buffer.from('T') },
      { name: `__MACOSX/${ENC}/._coremldata.bin`, data: Buffer.from('ad') },
      { name: `${ENC}/model.mil`, data: Buffer.from('mil') },
    ]);
    assert.deepEqual((await readdir(dir)).sort(), ['coremldata.bin', 'model.mil']);
  });

  it('★ 安全边界没被这次放宽带走：同名目录 + 一个**真**兄弟文件，照旧不许压', async () => {
    /*
     * 这条与上一条只差一个字节：兄弟是 `README.txt`（载荷）还是 `__MACOSX/…`（垃圾）。
     * 判据因此确实是"是不是载荷"，而不是"顶层有几个条目"——
     * 后者才是 T-153 栽的那一跤。
     */
    const S = 'sib-encoder.mlmodelc';
    const { dir } = await installZip(`${S}.zip`, [
      { name: `${S}/coremldata.bin`, data: Buffer.from('x') },
      { name: 'README.txt', data: Buffer.from('hi') },
    ]);
    assert.deepEqual((await readdir(dir)).sort(), ['README.txt', S]);
  });

  it('★ 后端包的 bin/ 不许被压（清垃圾之后这条仍然成立）', async () => {
    const { dir } = await installZip('backend-with-junk.zip', [
      { name: 'bin/whisper-cli', data: Buffer.from('ELF') },
      { name: 'bin/.DS_Store', data: Buffer.from('finder') },
      { name: 'lib/libggml.so', data: Buffer.from('ELF') },
    ]);
    assert.deepEqual((await readdir(dir)).sort(), ['bin', 'lib']);
    assert.deepEqual((await readdir(join(dir, 'bin'))).sort(), ['whisper-cli']);
  });
});

/**
 * T-157 ② —— **更新失败绝不许毁掉当前能用的那份安装。**
 *
 * ## 为什么这条测试是这次改动的核心
 *
 * 组件页那句「旧版本会保留，出问题可以一键回滚」是假的（`stashForRollback` 零调用方）。
 * 把它换成实话时要先确认：**剩下那半句是不是真的？**
 * 追下去发现也不是 —— `install()` 的 catch 里有一句 `fs.rm(finalDir)`，
 * 那是 temp-then-rename **之前**留下的清理逻辑。当时 `finalDir` 里可能是半个目录，
 * 该清；改成"先解到 temp、成功才换入"之后，那里躺着的是**上一版完整的安装**。
 *
 * 于是「更新一次、解包失败」= 组件从"旧版可用"直接变成"没装"，
 * 而用户以为自己只是更新失败了。
 *
 * 判据是**旧文件的字节还在不在**，不是"抛没抛错"——抛错在缺陷状态下也照样发生。
 */
describe('T-157 ② 更新失败不许破坏当前版本', () => {
  it('★ 解包失败时，上一版的文件必须原封不动', async () => {
    const root = await mkdtemp(join(tmpdir(), 'om-keepold-'));
    const store = new ArtifactStore(join(root, 'models'));
    const NAME = 'keepold-pack.zip';

    // ① 先装一版能用的
    const { dir } = await installZip(
      NAME,
      [{ name: 'bin/whisper-cli', data: Buffer.from('V1-GOOD') }],
      store,
    );
    assert.equal(await fs.readFile(join(dir, 'bin/whisper-cli'), 'utf8'), 'V1-GOOD');

    /*
     * ② 同一个包名再装一次，但归档是坏的 —— 用一个越界条目名让 `unpackArchive` 拒掉。
     *    包名相同 ⇒ `stripExt` 得到同一个 finalDir，这正是"更新"在磁盘上的形态。
     */
    let threw: unknown = null;
    try {
      await installZip(NAME, [{ name: '../escaped.txt', data: Buffer.from('EVIL') }], store);
    } catch (e) {
      threw = e;
    }
    assert.notEqual(threw, null, '坏归档本该让 install() 失败 —— 不失败的话这条用例什么都没验');

    // ③ 判据：旧文件的字节还在
    const survived = await fs.readFile(join(dir, 'bin/whisper-cli'), 'utf8').catch(() => null);
    assert.equal(
      survived,
      'V1-GOOD',
      '更新失败把上一版删掉了 —— 用户从"旧版可用"直接掉到"没装"，而他以为只是更新没成功',
    );

    // ④ 顺带：不许留下 .tmp- 残骸（它会被工具发现的两层扫描看见）
    const byName = await readdir(store.byNameDir('asr'));
    assert.deepEqual(
      byName.filter((n) => n.includes('.tmp-')),
      [],
      `留下了临时目录：${JSON.stringify(byName)}`,
    );
  });
});

/**
 * 解包进度（zip）：**分母必须是真的**（2026-08-09 裁决 ①）。
 *
 * 判据不是"有没有回调"，是**分母是不是真值**。zip 的真值在 EOCD 里
 * （`entriesTotal`，解包前就已知），所以这里断言它**恒等于真实条目数** ——
 * 一个编出来的分母（固定 100 / 按体积估）会让进度走到 80% 然后跳完，
 * 那和没有进度一样不可信，只是更难被发现。
 *
 * 放在本文件而不是 `unpack.test.ts`：手写 ZIP 的 `makeZip()` 在这边，
 * **不为此再抄一份 zip 写入器**。
 */
describe('解包进度（zip）：分母来自 EOCD，不是猜的', () => {
  it('★ total 恒等于真实条目数，且每个条目都被计到（含被跳过的分支）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zip-prog-'));
    const names = ['one.txt', 'two.txt', 'three.txt', 'dir/four.txt'];
    const zip = makeZip(names.map((n) => ({ name: n, data: Buffer.from(`x-${n}`) })));
    const src = join(dir, 'p.zip');
    await fs.writeFile(src, zip);

    const seen: Array<{ done: number; total: number; unit: string }> = [];
    await unpackArchive(src, join(dir, 'out'), 'zip', {
      onProgress: (done, total, unit) => seen.push({ done, total, unit }),
    });

    assert.ok(seen.length > 0, '★ 一次都没报进度 —— 解包期间界面会停在上一档 verifying');
    assert.equal(seen[0]?.unit, 'entries', 'zip 报的是条目数');
    assert.equal(
      seen[0]!.total,
      names.length,
      '★ 分母不等于真实条目数 —— 说明它是估的/编的，而 EOCD 里明明有真值',
    );
    assert.equal(seen.at(-1)!.done, names.length, '★ 最后一条没走到 total，进度会停在中途');
    for (let i = 1; i < seen.length; i++) {
      assert.equal(
        seen[i]!.done,
        seen[i - 1]!.done + 1,
        '★ 条目计数跳号 —— 循环里有 continue 分支被漏计（目录/软链/mac 垃圾）',
      );
    }
  });
});


/* ============ ★ T-63 —— 校验阶段的 1795 ms 黑窗（三处只有一处漏传参数）============ */

/**
 * `[已核实]` 量模型安装路径时抓到的：1.66 GB 模型的安装过程里有一段
 * **1795 ms 的黑窗**（耗时 > 1s 且 0 条事件），落在 `verifying → installing` 之间。
 *
 * 成因是**一个漏传的参数**，不是设计问题 —— 同一个 `verifyFile`，三个调用点：
 *
 * ```
 * models.ts:681  校验已装模型   传了进度回调 ✔
 * models.ts:817  导入本地模型   传了进度回调 ✔（走 sha256File）
 * download.ts    安装           undefined   ✘
 * ```
 *
 * 校验就是把整个文件读一遍算 sha256，它**天然有进度可报**。不报的那 1.8 秒里，
 * 进度条还停在下载结束时的满格 —— **"正在校验"和"卡住了"长得一模一样**。
 *
 * 判据钉的是**后果**：校验期间必须有多于一条事件，而且数值必须真的在前进。
 * 只断言"传了参数"是没用的（那是形式）；只断言"有 verifying 事件"也不够 ——
 * 漏传参数的旧版本**也会发一条** `verifying` 事件（满格那条），
 * 所以下面专门有一条断言排除"只有满格那一条"。
 */
describe('★ T-63 校验阶段必须报进度（1795 ms 黑窗）', () => {
  it('★ verifying 阶段的事件不止一条，且 completedBytes 真的在前进', async () => {
    // 必须大于 sha256File 的 4 MB highWaterMark，否则整个文件只有一个 chunk、
    // 只会回调一次 —— 那样这条用例就分不出"有进度"和"只有起点那一条"。
    const body = Buffer.alloc(9 * 1024 * 1024, 0x41);
    const sha = createHash('sha256').update(body).digest('hex');
    served.set('/big.bin', body);

    const store = new ArtifactStore(
      join(await mkdtemp(join(tmpdir(), 'om-verifyprog-')), 'models'),
    );
    const seen: Array<{ phase: string; done: number; total: number }> = [];

    await install({
      store,
      target: {
        id: 'asr/verify-progress',
        kind: 'asr',
        displayName: 'verify progress',
        files: [
          {
            role: 'weights',
            name: 'big.bin',
            sizeBytes: body.length,
            sha256: sha,
            mirrors: [{ provider: 'custom', url: `${origin}/big.bin`, official: true }],
          },
        ],
      },
      maxParts: 1,
      onProgress: (p) => seen.push({ phase: p.phase, done: p.completedBytes, total: p.totalBytes }),
    });

    const verifying = seen.filter((e) => e.phase === 'verifying');
    assert.ok(
      verifying.length >= 2,
      `★ 校验期间只报了 ${verifying.length} 条事件 —— 那 1.8 秒的黑窗就是这么来的：` +
        JSON.stringify(seen.slice(-8)),
    );

    // 真的在前进：非递减，且最后一条走到了满格
    for (let i = 1; i < verifying.length; i++) {
      assert.ok(
        verifying[i]!.done >= verifying[i - 1]!.done,
        `★ 校验进度回退了：${JSON.stringify(verifying)}`,
      );
    }
    assert.equal(
      verifying[verifying.length - 1]!.done,
      body.length,
      '★ 最后一条应当是整个文件都算完了',
    );

    /*
     * ★ 排除"只有满格那一条"：漏传参数的旧版本会发**恰好一条** completedBytes=total
     * 的 verifying 事件，然后原地不动 1.8 秒。所以必须存在至少一条**严格小于**满格的，
     * 否则这条用例就退化成了"有 verifying 事件就算数"。
     */
    assert.ok(
      verifying.some((e) => e.done < body.length),
      `★ 全部 verifying 事件都是满格 —— 进度条会停在 100% 一动不动：${JSON.stringify(verifying)}`,
    );
  });
});
