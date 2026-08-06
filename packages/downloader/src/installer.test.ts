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

async function installZip(name: string, entries: ZipEntry[]): Promise<{ dir: string }> {
  const zip = makeZip(entries);
  const sha = createHash('sha256').update(zip).digest('hex');
  served.set(`/${name}`, zip);

  const root = await mkdtemp(join(tmpdir(), 'om-installer-'));
  const store = new ArtifactStore(join(root, 'models'));
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
    assert.equal(
      entries.includes(ENC),
      false,
      `还套着一层同名目录：${JSON.stringify(entries)}`,
    );
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
