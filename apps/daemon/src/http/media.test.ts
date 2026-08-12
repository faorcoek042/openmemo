/**
 * `/media/asset/<ulid>` 的路径解析 —— T-136 的回归测试。
 *
 * ─── 这条路径上曾经发生过什么 ────────────────────────────────────────────────────
 * `resolveAssetPath` 旧实现是「返回**第一个落在允许根内**的候选」。
 * 而候选①（`mediaRoot`）对任何相对路径**永远落在根内**，
 * 于是 `extraRoots`（`tmp/`、`dataDir`）**一次都没有被试过** —— 那个参数
 * 从加进来的那天起就是死代码，而且没有任何东西会报错。
 *
 * 实测后果（用户库 4 条资产）：`migrateAssets` 写出的 `media/legacy/x.wav`
 * 被拼成 `<dataDir>/media/media/legacy/x.wav`（**两个 media**），
 * `jfk.wav` 被拼成 `<dataDir>/media/jfk.wav`（文件其实在 `<dataDir>/jfk.wav`）——
 * **3 条播放直接 404，而 3 个文件都好好地躺在盘上。**
 *
 * 所以这里断言的不是"函数返回了个路径"，而是**真的把对的字节流回来了**：
 * 每份 fixture 内容都不同，用 body 反查它到底读了哪一个文件。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, promises as fs } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { AssetRow, Repos } from '../db/repos.js';
import { createMediaRoutes, parseRange, type MediaRepos } from './media.js';

// 编译期护栏：main.ts 塞进来的是真 `Repos`，它必须结构上满足收窄后的依赖接口
type Assert<T extends true> = T;
type _ReposFits = Assert<Repos extends MediaRepos ? true : false>;

const UID = '01KZ12PF4PSAM5W50PVM52YP63';

const made: string[] = [];
after(async () => {
  for (const d of made) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

/** 造一个数据目录，按 `<相对 dataDir 的路径> → 内容` 写入 fixture。 */
async function seedDataDir(files: Record<string, string>): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), 'om-media-'));
  made.push(d);
  await fs.mkdir(join(d, 'media'), { recursive: true });
  await fs.mkdir(join(d, 'tmp'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(d, rel);
    await fs.mkdir(join(abs, '..'), { recursive: true });
    await fs.writeFile(abs, body);
  }
  return d;
}

interface Fetched {
  status: number;
  body: string;
}

/** 起一次真 http server 跑真 handler —— 不走旁路，判据必须落在产品路径上。 */
async function get(dataDir: string, relPath: string, uid = UID): Promise<Fetched> {
  const asset: AssetRow = {
    id: 1,
    uid: UID,
    note_id: 1,
    role: 'original',
    rel_path: relPath,
    display_name: null,
    mime: null,
    bytes: null,
    duration_ms: null,
    sample_rate: null,
    channels: null,
    state: 'ready',
    /* `/media` 只读 rel_path/uid/mime 与盘上的 `stat()`，这一列对它没有任何影响。 */
    replaced_at: null,
  };
  const routes = createMediaRoutes({
    repos: { assetByUid: (u) => (u === UID ? asset : undefined) },
    mediaRoot: join(dataDir, 'media'),
    extraRoots: [join(dataDir, 'tmp'), dataDir],
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void routes.handle(req, res, url, req.method ?? 'GET').then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end('unhandled');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    return await new Promise<Fetched>((resolve, reject) => {
      const req = httpRequest(
        // agent:false —— 不然 keep-alive 的空闲连接会让 server.close() 干等 5 秒，
        // 一个纯路径解析的用例看起来像"慢得可疑"，那是噪音不是信号
        { host: '127.0.0.1', port, path: `/media/asset/${uid}`, method: 'GET', agent: false },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('★ T-136 媒体资产的三种历史路径形态都必须播得出来', () => {
  it('相对 media 根（transcribe.ts 写的形态）', async () => {
    const d = await seedDataDir({ 'media/N1/audio16k.wav': 'MEDIA-ROOT' });
    assert.deepEqual(await get(d, join('N1', 'audio16k.wav')), {
      status: 200,
      body: 'MEDIA-ROOT',
    });
  });

  it('★ 相对 dataDir（migrateAssets 写的形态）—— 修复前这里是 404', async () => {
    const d = await seedDataDir({ 'media/legacy/job-X-audio16k.wav': 'DATA-ROOT' });
    assert.deepEqual(await get(d, 'media/legacy/job-X-audio16k.wav'), {
      status: 200,
      body: 'DATA-ROOT',
    });
  });

  it('★ 裸文件名而文件在 dataDir 根上（用户库里的 jfk.wav）—— 修复前这里是 404', async () => {
    const d = await seedDataDir({ 'jfk.wav': 'AT-DATADIR' });
    assert.deepEqual(await get(d, 'jfk.wav'), { status: 200, body: 'AT-DATADIR' });
  });

  it('绝对路径（recorder.ts 写的形态）', async () => {
    const d = await seedDataDir({ 'media/recordings/r.wav': 'ABS' });
    assert.deepEqual(await get(d, join(d, 'media', 'recordings', 'r.wav')), {
      status: 200,
      body: 'ABS',
    });
  });

  it('★ 根的顺序即优先级：同名时 media 根赢，不因为"多试了几个根"而拿错文件', async () => {
    const d = await seedDataDir({ 'media/dup.wav': 'FROM-MEDIA', 'dup.wav': 'FROM-DATADIR' });
    assert.deepEqual(await get(d, 'dup.wav'), { status: 200, body: 'FROM-MEDIA' });
  });
});

describe('★ 越界与真丢失是两码事，不许混报', () => {
  it('指到所有根之外 → 403，而不是 404', async () => {
    const d = await seedDataDir({});
    const r = await get(d, '/etc/hostname');
    assert.equal(r.status, 403);
    assert.equal(JSON.parse(r.body).error.code, 'ASSET_OUT_OF_ROOT');
  });

  it('用 .. 穿越出去 → 403（纵深防御：DB 可能被手工改过）', async () => {
    const d = await seedDataDir({});
    const r = await get(d, '../../etc/hostname');
    assert.equal(r.status, 403);
    assert.equal(JSON.parse(r.body).error.code, 'ASSET_OUT_OF_ROOT');
  });

  it('★ 文件真的不在 → 404，且**把找过的每个位置都列出来**', async () => {
    const d = await seedDataDir({});
    const r = await get(d, 'gone.wav');
    assert.equal(r.status, 404);
    const err = JSON.parse(r.body).error;
    assert.equal(err.code, 'ASSET_FILE_MISSING');
    // 三个根都试过 —— 少列一个，用户就无从判断是"文件没了"还是"我们找错了地方"
    for (const root of [join(d, 'media'), join(d, 'tmp'), d]) {
      assert.ok(
        err.message.includes(join(root, 'gone.wav')),
        `404 没提到试过 ${join(root, 'gone.wav')}：${err.message}`,
      );
    }
    // 措辞不许断言"已被删除"
    assert.ok(!/删除/.test(err.messageZh), `不许断言文件被删除：${err.messageZh}`);
  });

  it('悬空符号链接 → 404（lstat 会说它存在，open 不会）', async () => {
    const d = await seedDataDir({});
    await fs.symlink(join(d, 'media', 'nope.wav'), join(d, 'media', 'dangling.wav'));
    assert.equal((await get(d, 'dangling.wav')).status, 404);
  });

  it('不存在的 asset uid → 404 ASSET_NOT_FOUND', async () => {
    const d = await seedDataDir({});
    const r = await get(d, 'x.wav', '01KZ12PF4PSAM5W50PVM52YP64');
    assert.equal(r.status, 404);
    assert.equal(JSON.parse(r.body).error.code, 'ASSET_NOT_FOUND');
  });
});

/**
 * ★ T-143 ①：**根内的一条软链就能把整台机器上的文件从这个端点流出去。**
 *
 * 候选路径的越界剔除是**纯字符串**运算，而 `open()` 走文件系统、**跟随符号链接** ——
 * 两者对 `<mediaRoot>/escape.wav -> /etc/passwd` 给出完全相反的答案。
 * 修复前这里返回 **200 + 根外文件的原始字节**。
 *
 * 判据钉的是**后果**：断言 body 里**没有**那串只存在于根外文件里的内容。
 * 光断言状态码不够 —— 状态码可以因为别的原因变对。
 */
describe('★ T-143 符号链接不许把数据目录外的文件流出去', () => {
  const SECRET = 'SECRET-OUTSIDE-THE-DATA-DIR';

  /** 在**所有根之外**造一份秘密文件。 */
  async function secretOutside(): Promise<string> {
    const outside = mkdtempSync(join(tmpdir(), 'om-media-OUTSIDE-'));
    made.push(outside);
    const p = join(outside, 'secret.txt');
    await fs.writeFile(p, SECRET);
    return p;
  }

  it('★ 资产本身是指向根外的软链 → 403，且一个字节都不许流出去', async () => {
    const d = await seedDataDir({});
    const secret = await secretOutside();
    await fs.symlink(secret, join(d, 'media', 'escape.wav'));
    // 先证明这条链真的能读到根外内容，否则本用例钉的是零
    assert.equal(await fs.readFile(join(d, 'media', 'escape.wav'), 'utf8'), SECRET);

    const r = await get(d, 'escape.wav');
    assert.equal(r.body.includes(SECRET), false, '根外内容被流出去了');
    assert.equal(r.status, 403);
    assert.equal(JSON.parse(r.body).error.code, 'ASSET_OUT_OF_ROOT');
  });

  it('★ 祖先目录是软链 → 同样 403（realpath 要跟完整条路）', async () => {
    const d = await seedDataDir({});
    const secret = await secretOutside();
    await fs.symlink(join(secret, '..'), join(d, 'media', 'outdir'));

    const r = await get(d, 'outdir/secret.txt');
    assert.equal(r.body.includes(SECRET), false);
    assert.equal(r.status, 403);
  });

  it('★ 越界必须报 403，**不许**报成"文件不存在"（文件明明在，⑤A-20 规矩 3）', async () => {
    const d = await seedDataDir({});
    await fs.symlink(await secretOutside(), join(d, 'media', 'escape.wav'));
    const err = JSON.parse((await get(d, 'escape.wav')).body).error;
    /*
     * ★ 2026-08-10：判据从"文案里别出现这几个词"改成**钉住错误码**。
     *
     * 旧判据 `/不存在|已删除|丢失/.test(messageZh) === false` 是一条**否定断言**，
     * 失败方向是**绿**：daemon 把话改成「找不到这个文件」「该媒体已不可用」——
     * 正则落空、断言通过，**而它正在说同一句假话**（文件明明在，只是不许从这里读）。
     *
     * 换成正向钉码有三重好处：
     *   ① `code` 是契约，不是措辞，重写句子改不动它；
     *   ② **用户看到的那句话本来就是从 code 推出来的**（`ErrorBlock` 走 `errors.<CODE>`
     *      查本地文案，服务端 message 只作未知 code 的兜底）——
     *      **钉住 code 就钉住了用户看到的语义**，比检查这一条 messageZh 覆盖面更宽；
     *   ③ 失败方向翻成红：daemon 若改回 404/换码，这里当场红。
     *
     * `assert.notEqual(code, 'ASSET_FILE_MISSING')` 保留 —— 它是这条用例的原始意图
     * （⑤A-20 规矩 3：不许把"不许读"说成"没有"），而正向断言把它变成了必然成立的推论。
     */
    assert.equal(err.code, 'ASSET_OUT_OF_ROOT', `越界必须报越界，实际：${JSON.stringify(err)}`);
    assert.notEqual(err.code, 'ASSET_FILE_MISSING');
  });

  it('★ 合法的相对软链照常 200（别把产品自己的链接一起杀了）', async () => {
    const d = await seedDataDir({ 'media/real.wav': 'REAL-CONTENT' });
    await fs.symlink('real.wav', join(d, 'media', 'alias.wav'));
    const r = await get(d, 'alias.wav');
    assert.equal(r.status, 200);
    assert.equal(r.body, 'REAL-CONTENT');
  });
});

describe('parseRange', () => {
  it('普通区间 / 尾部 N 字节 / 越界', () => {
    assert.deepEqual(parseRange('bytes=0-3', 100), { start: 0, end: 3 });
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
    assert.equal(parseRange('bytes=100-', 100), 'invalid');
    assert.equal(parseRange(undefined, 100), undefined);
  });
});
