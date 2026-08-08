/**
 * T-164 ⑥ —— **删模型不回收磁盘，还报一个假数字**。
 *
 * ## 缺陷原状（`progress-audit §1.3` 的复现，我在这里把它固化成用例）
 *
 * ```
 * 写 4 MiB blob → linkByName → 删 → collectGarbage 报 freedBytes: 4194304
 *                                    usedBytes() 归 0
 *                                    du -sb  仍是 4194304   ← 硬链还在
 * ```
 *
 * 成因两半，缺一不可：
 *   ① `dropInstalledRecord()` **只删 manifest**，`by-name/<kind>/<file>` 与
 *      `by-model/<id>/` 那些硬链原封不动；
 *   ② `findGarbage()` **只扫 `blobs/`**，所以它把 blob 删了就按 blob 的大小报数 ——
 *      而硬链与 blob 共用 inode，**只要还有一条链指着，磁盘一个字节都不会回收**。
 *
 * 用户侧：删掉一堆模型、看着"已用空间"一路下降、磁盘越来越满，没有任何地方对得上账。
 * 第二个后果更难查：`by-name/` 是**发现路径**（`resolveActiveModel` / `scanByName` /
 * `findInBackendPacks` 都按名字扫它），一个"已删除"的文件留在那儿会被当成还装着。
 *
 * ## 判据：**报出去的 freedBytes 必须等于磁盘上真的少掉的字节数**
 *
 * 不写成"by-name 下那个文件不存在了" —— 那是形式。形式可以用别的方式满足
 * （比如把链改个名），而用户关心的是 `df` 上的数字。
 * 所以这里自己按 **(dev, ino) 去重**算一次真实占用（`du` 的算法），删前删后各一次。
 * 在**缺陷版本**下这个差值恒为 0，而 `freedBytes` 报的是 blob 的大小 —— 当场对不上。
 */

/*
 * ⚠️ PROTOCOL §9-bis：**在模块顶层**把模型根与扩展目录钉进 tmp，窗口为零。
 * `RestState.create()` 会 mkdir 模型根、读写 `active.json` / `prefs.json` ——
 * 不重定向就会去动这台机器上真实的数据目录（用户的 demo 就在那儿）。
 * node:test 一个测试文件一个子进程，进程退了环境变量就没了，**不需要清理代码**
 * —— 而"清理代码"正是被 kill 之后靠不住的那个东西。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-reclaim-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { SseHub } from '../sse.js';
import { createModelRoutes } from './models.js';
import { RestState } from './state.js';

const REPO_ROOT = resolve(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..'),
);
const MANIFEST_DIR = join(REPO_ROOT, 'vendor', 'manifests');

const MODEL_ID = 'asr/reclaim-test-model';
const FILE_NAME = 'reclaim-test.bin';
const PAYLOAD_BYTES = 4 * 1024 * 1024; // 4 MiB —— 与 progress-audit 的复现同一个量级
const PAYLOAD = Buffer.alloc(PAYLOAD_BYTES, 7);
/*
 * 摘要**真的算一遍**，不写死一个好看的常量：`blobs/` 的文件名就是它（内容寻址），
 * 而 `findGarbage()` 靠 `/^sha256-([a-f0-9]{64})$/` 认它、靠 manifest 里的
 * `files[].sha256` 判它还有没有人引用。写死一个对不上的摘要，用例会在一个
 * 与产品无关的理由上通过或失败。
 */
const SHA256 = createHash('sha256').update(PAYLOAD).digest('hex');

/**
 * `du` 的算法：**按 (dev, ino) 去重**再求和。
 *
 * 这一步是整个用例的判据本身 —— 不去重的话硬链会被数两遍，
 * 删掉一条链就"看起来省了 4 MiB"，而那正是我们要证伪的那个假象。
 */
async function realBytes(root: string): Promise<number> {
  const seen = new Set<string>();
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      const st = await stat(p);
      const key = `${String(st.dev)}:${String(st.ino)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      total += st.size;
    }
  };
  await walk(root);
  return total;
}

/** 最小 `ServerResponse` 桩：只要够 `sendJson` / `writeHead+end` 用。 */
function captureRes(): { res: ServerResponse; status: () => number; body: () => string } {
  let status = 0;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number): ServerResponse {
      status = s;
      return res;
    },
    end(chunk?: Buffer | string): void {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    setHeader(): void {
      /* 不关心 */
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => Buffer.concat(chunks).toString('utf8') };
}

interface Seeded {
  state: RestState;
  routes: ReturnType<typeof createModelRoutes>;
  modelsRoot: string;
  dataDir: string;
  /** 路由内部那份 `RestState` 用的就是它 —— `model.removed` 从这里出来。 */
  hub: SseHub;
}

/**
 * 造一台"装过一个模型"的机器 —— **走 store 自己的 API**，不手工摆目录：
 * blob 落 `blobs/sha256-…`、`linkByName` 硬链进 `by-name/asr/`、
 * 再摊一份 `by-model/<id>/`（`materializeModelDir` 每次启动都会做的那一步），
 * 最后写一份与安装器同形的 manifest。
 */
async function seedInstalledModel(): Promise<Seeded> {
  const dataDir = mkdtempSync(join(TEST_ROOT, 'data-'));
  process.env['OPENMEMO_MODELS'] = join(dataDir, 'models');
  const state = await RestState.create({
    sse: new SseHub(),
    dataDir,
    manifestDir: MANIFEST_DIR,
  });
  const modelsRoot = state.store.root;

  await writeFile(state.store.blobPath(SHA256), PAYLOAD);
  await state.store.linkByName('asr', SHA256, FILE_NAME);

  // `by-model/<sanitized id>/<name>` —— T-160 ①附加的每模型独占目录
  const byModel = join(modelsRoot, 'by-model', MODEL_ID.replace(/[^a-zA-Z0-9._-]+/g, '_'));
  await mkdir(byModel, { recursive: true });
  await link(state.store.blobPath(SHA256), join(byModel, FILE_NAME));

  await state.store.writeManifest('asr', MODEL_ID, {
    schemaVersion: 1,
    id: MODEL_ID,
    groupId: 'asr/reclaim-test',
    role: 'asr',
    displayName: '回收测试模型',
    quantization: 'q5_1',
    totalSizeBytes: PAYLOAD_BYTES,
    installedAt: new Date().toISOString(),
    verifiedAt: null,
    integrity: 'ok',
    files: [
      {
        role: 'weights',
        name: FILE_NAME,
        sha256: SHA256,
        sizeBytes: PAYLOAD_BYTES,
        root: 'models',
        relPath: join('by-name', 'asr', FILE_NAME),
      },
    ],
    requirements: { ramRequiredMB: 1, vramRequiredMB: 0, diskRequiredMB: 4, cpuFeatures: [] },
    license: { id: 'MIT', gated: false, url: '' },
    source: { provider: 'custom', repo: 'test', revision: 'local' },
    benchmark: null,
    catalogVersion: 'test',
  });

  const hub = new SseHub();
  const routes = createModelRoutes({ sse: hub, dataDir, manifestDir: MANIFEST_DIR });
  return { state, routes, modelsRoot, dataDir, hub };
}

/** 真的走 `DELETE /api/models/:id`（产品路径，不是把 models.ts 那两行抄一遍）。 */
async function deleteViaHttp(
  routes: ReturnType<typeof createModelRoutes>,
  id: string,
): Promise<number> {
  const cap = captureRes();
  const url = new URL(`http://127.0.0.1/api/models/${encodeURIComponent(id)}`);
  const handled = await routes.handle({} as IncomingMessage, cap.res, url, 'DELETE');
  assert.equal(handled, true, 'DELETE /api/models/:id 没有被这套路由认领');
  assert.equal(cap.status(), 204, `删除没成功：${String(cap.status())} ${cap.body()}`);
  return cap.status();
}

describe('T-164 ⑥ —— 删模型必须真的回收磁盘，报出去的数字必须是真的', () => {
  it('★ 删完之后 models 根的真实占用（按 inode 去重）必须少掉整整那 4 MiB', async () => {
    const s = await seedInstalledModel();

    const before = await realBytes(s.modelsRoot);
    assert.equal(
      before >= PAYLOAD_BYTES,
      true,
      `种子没落成：models 根只有 ${String(before)} 字节，连一份 4 MiB 都装不下`,
    );
    // 前提自检：三条路径确实是**同一个 inode**（否则这条用例测的是别的东西）
    const blobIno = (await stat(s.state.store.blobPath(SHA256))).ino;
    const linkIno = (await stat(join(s.modelsRoot, 'by-name', 'asr', FILE_NAME))).ino;
    assert.equal(blobIno, linkIno, 'by-name 不是硬链 —— 这台机器上复现不出这个缺陷');

    await deleteViaHttp(s.routes, MODEL_ID);

    const after = await realBytes(s.modelsRoot);
    /*
     * 判据是 `>=` 而不是 `===`：manifest 那个 json 也一起没了，所以实际降幅会**多**几百字节。
     * 要钉住的是「那 4 MiB 真的从磁盘上消失了」。
     * 缺陷版本下降幅只有 manifest 那几百字节 —— 差着四个数量级，钉得很稳。
     */
    assert.equal(
      before - after >= PAYLOAD_BYTES,
      true,
      `磁盘只少了 ${String(before - after)} 字节，至少应当少 ${String(PAYLOAD_BYTES)} —— ` +
        `blob 删了但硬链还在，inode 不会被释放。这就是"删了一堆模型、磁盘反而越来越满"`,
    );
  });

  it('★ 事件里报的 freedBytes 必须等于磁盘上真的少掉的字节数', async () => {
    const s = await seedInstalledModel();
    /*
     * 用**同一个 sse**收事件：`model.removed` 的 `freedBytes` 就是界面上
     * "已释放 N MB"的来源。判据是它与实测差值相等 —— 相等才叫不撒谎，
     * 只断言"它大于 0"在缺陷版本下照样绿（缺陷版本报的正是 4194304）。
     */
    const freed: number[] = [];
    s.hub.observe((e) => {
      if (e.type === 'model.removed') freed.push(e.freedBytes);
    });

    const before = await realBytes(s.modelsRoot);
    await deleteViaHttp(s.routes, MODEL_ID);
    const after = await realBytes(s.modelsRoot);

    assert.equal(freed.length, 1, `model.removed 发了 ${String(freed.length)} 次`);
    /*
     * 不变量：**报出去的数字不许超过真的释放掉的**。
     * 少报是可以的（manifest 那几百字节没算进 freedBytes），多报就是撒谎 ——
     * 而缺陷版本恰恰是多报：它报 4 MiB，磁盘只掉了 manifest 那几百字节。
     */
    assert.equal(
      (freed[0] ?? -1) <= before - after,
      true,
      `界面会显示"已释放 ${String(freed[0])} 字节"，而磁盘实际只少了 ${String(before - after)} 字节`,
    );
    assert.equal(freed[0], PAYLOAD_BYTES, '报的数字连量级都不对');
  });

  it('★ by-name 与 by-model 两个视图都不许留下"已删除模型"的文件', async () => {
    /*
     * 这不是洁癖：`by-name/` 是发现路径。留一条链在那儿，
     * `resolveActiveModel` / `scanByName` 会继续把它当成一个装着的模型，
     * 于是"删掉了却还在用"—— 与 T-160 ①附那条 `tokens.txt` 互相顶掉同族。
     */
    const s = await seedInstalledModel();
    await deleteViaHttp(s.routes, MODEL_ID);

    const byName = await readdir(join(s.modelsRoot, 'by-name', 'asr')).catch(() => [] as string[]);
    assert.equal(byName.includes(FILE_NAME), false, `by-name/asr 里还留着 ${FILE_NAME}`);
    const byModel = await readdir(join(s.modelsRoot, 'by-model')).catch(() => [] as string[]);
    assert.equal(
      byModel.some((d) => d.includes('reclaim-test-model')),
      false,
      `by-model 里还留着 ${byModel.join(',')}`,
    );
  });

  it('删除之后 /api/models/installed 里不再有它（原有保证不许被这次改动破坏）', async () => {
    const s = await seedInstalledModel();
    assert.equal(
      (await s.state.listInstalled()).some((m) => m.id === MODEL_ID),
      true,
      '种子模型压根没被列出来 —— 上面几条也就不证明什么',
    );
    await deleteViaHttp(s.routes, MODEL_ID);
    const state2 = await RestState.create({
      sse: new SseHub(),
      dataDir: s.dataDir,
      manifestDir: MANIFEST_DIR,
    });
    assert.equal(
      (await state2.listInstalled()).some((m) => m.id === MODEL_ID),
      false,
      '记录还在 —— 用户会看到一个"删不掉"的模型',
    );
  });
});
