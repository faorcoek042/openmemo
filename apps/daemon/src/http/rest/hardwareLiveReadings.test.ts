/**
 * T-193 —— **`/api/runtime/hardware` 那份快照里，哪几格允许是旧的。**
 *
 * ## 这条钉的是什么
 *
 * `[用户真机实测 2026-08-09/10，:10000]` 装/升一个后端包的全过程中，
 * 这个端点回的 `detectedAt`、**磁盘可用空间**、内存、探测耗时**纹丝不动**；
 * 只有手工发 `?refresh=1` 才动 —— 而 `?refresh=1` 在整个网页里**唯一的调用点**
 * 是断路器 open→closed 的那一刻（`features/runtime/api.ts` 的 `useHardwareRefresh`）。
 * ⇒ **只要断路器不跳，那张卡上的数可以停在 daemon 第一次探测时的值，永远。**
 *
 * ## 判据：**用户在界面上看到的数是真的** —— 不是"缓存被打掉了"
 *
 * 所以下面**不断言任何函数被调用过**。断言的是：
 * 往磁盘里真写进去几百 MB 之后，**普通 GET**（不带 `?refresh=1`）回的那个数**真的变小了**。
 * 一个"断言 detectDisks 被调用了"的用例，在缓存回来的那天照样是绿的。
 *
 * ## 三条性质，各自独立
 *
 * 1. **环境读数是实时的** —— 磁盘/内存每次现算（`statfs` + `os.freemem()`，零 spawn）。
 * 2. **结构探测没有白跑** —— `detectedAt` 在上面那个过程中**不许变**。
 *    少了这一条，"把整份缓存关掉"也能让第 1 条变绿，而那会让每个请求 spawn 一次 probe
 *    （≤10 s）—— 把"缓存永不失效"换成"缓存永远无效"，同一枚硬币的另一面。
 * 3. **结构快照有真实的失效规则** —— 装/换/卸一个后端包，`detectedAt` 必须变。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { startDaemon } from '../../main.js';

let base = '';
let token = '';
let dataDir = '';
let stop: (() => Promise<void>) | undefined;

/** 写这么多字节进模型目录，模拟一次下载。远大于 `freeMB` 的取整粒度。 */
const WRITE_BYTES = 256 * 1024 * 1024;
/**
 * 允许的观测下限。**刻意远小于写入量**：这台机器上别的进程也在动磁盘，
 * 要求"正好等于写入量"会变成一条随机红的假红灯（⑤B）。
 * 而要打败 128 MB 的门槛，需要别的进程在同一瞬间释放 128 MB —— 那不是噪声。
 */
const MIN_OBSERVED_DROP_MB = 128;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'om-hw-live-'));
  /*
   * `detectDisks()` 对不存在的目录是**静默跳过**的（它 catch 掉 ENOENT），
   * 于是全新 dataDir 上 `disks` 会是 `[]`，下面每条断言都会落空而不是变红。
   * 先建出来 —— 这也是真实运行时的形态（装过任何东西的机器上它一定在）。
   */
  mkdirSync(join(dataDir, 'models'), { recursive: true });
  mkdirSync(join(dataDir, 'bin', 'runtime'), { recursive: true });
  // 19xxx 段（见 `testPorts.test.ts`），且与其它基数相隔 ≥30
  const port = 19_170 + Math.floor(Math.random() * 10);
  const d = await startDaemon({ port, dataDir, maxPort: port + 20 });
  base = `http://127.0.0.1:${d.port}`;
  token = d.token;
  stop = d.stop;
});

after(async () => {
  await stop?.();
  rmSync(dataDir, { recursive: true, force: true });
});

interface Snapshot {
  detectedAt: string;
  modelsFreeMB: number | null;
}

async function hardware(query = ''): Promise<Snapshot> {
  const r = await fetch(`${base}/api/runtime/hardware${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(r.status, 200, `GET /api/runtime/hardware${query} → ${String(r.status)}`);
  const body = (await r.json()) as {
    hardware: { detectedAt: string; disks: { pathFor: string; freeMB: number }[] };
  };
  const d = body.hardware.disks.find((x) => x.pathFor === 'models_root');
  return { detectedAt: body.hardware.detectedAt, modelsFreeMB: d ? d.freeMB : null };
}

describe('T-193 ① 磁盘/内存是实时读数，不进缓存', () => {
  it('前提自检：models_root 那一格真的报得出来（报不出来下面几条都会落空）', async () => {
    const s = await hardware();
    assert.notEqual(
      s.modelsFreeMB,
      null,
      'disks 里没有 models_root —— detectDisks 对不存在的目录是静默跳过的，' +
        '这条前提不成立时下面的断言钉的是零',
    );
  });

  it('★ 往磁盘里真写进 256 MB 之后，**普通 GET**（不带 ?refresh=1）回的可用空间必须变小', async () => {
    const before_ = await hardware();

    const blob = join(dataDir, 'models', 'om-hw-live-fixture.bin');
    writeFileSync(blob, Buffer.alloc(WRITE_BYTES));

    const after_ = await hardware();
    const dropMB = (before_.modelsFreeMB ?? 0) - (after_.modelsFreeMB ?? 0);

    assert.equal(
      dropMB >= MIN_OBSERVED_DROP_MB,
      true,
      `写进了 ${String(WRITE_BYTES / 1024 / 1024)} MB，而端点回的可用空间只降了 ${String(dropMB)} MB。\n` +
        `这一格是缓存的 —— 用户下了一个模型之后，运行时页上那个"还剩多少"是旧的，\n` +
        `而它恰恰是他决定要不要再下一个的依据。\n` +
        `（${String(before_.modelsFreeMB)} MB → ${String(after_.modelsFreeMB)} MB）`,
    );

    /*
     * ★ 与上一条同等重要：**结构探测不许跟着跑**。
     * 只有第一条的话，"把缓存整个关掉"也能让它变绿 —— 而那会让每个请求
     * spawn 一次 probe（ADR-003 决策 3 定的 10 s 上限），
     * 一个"看一眼硬件页就卡 10 秒"的产品并不比数字是旧的更好。
     */
    assert.equal(
      after_.detectedAt,
      before_.detectedAt,
      'detectedAt 跟着变了 —— 说明为了刷新一个 statfs 就重跑了整套探测（probe + nvidia-smi）',
    );

    rmSync(blob, { force: true });
  });

  it('★ 删掉之后必须涨回去 —— 单向的"只会变小"同样可以是假的', async () => {
    const blob = join(dataDir, 'models', 'om-hw-live-fixture2.bin');
    writeFileSync(blob, Buffer.alloc(WRITE_BYTES));
    const full = await hardware();
    rmSync(blob, { force: true });
    const freed = await hardware();
    assert.equal(
      (freed.modelsFreeMB ?? 0) - (full.modelsFreeMB ?? 0) >= MIN_OBSERVED_DROP_MB,
      true,
      `删掉 ${String(WRITE_BYTES / 1024 / 1024)} MB 之后没涨回去：` +
        `${String(full.modelsFreeMB)} MB → ${String(freed.modelsFreeMB)} MB`,
    );
  });
});

describe('T-193 ② 结构快照必须有真实的失效规则（不能只靠 ?refresh=1）', () => {
  const manifestPath = (id: string): string =>
    join(dataDir, 'models', 'manifests', 'backend', `${id}.json`);

  const writePack = (id: string, sha: string): void => {
    mkdirSync(join(dataDir, 'models', 'manifests', 'backend'), { recursive: true });
    writeFileSync(
      manifestPath(id),
      JSON.stringify({
        schemaVersion: 1,
        id,
        engine: 'whisper.cpp',
        engineVersion: 'v1.9.1',
        backend: 'cpu',
        installedAt: '2026-08-10T00:00:00.000Z',
        verifiedAt: null,
        integrity: 'ok',
        files: [{ name: 'a.so', sha256: sha, sizeBytes: 1, path: '/tmp/a.so' }],
        selfTest: null,
      }),
    );
  };

  it('★ 装上一个后端包 ⇒ 结构快照必须重算（此前只有 ?refresh=1 能做到）', async () => {
    const before_ = await hardware();
    writePack('om-hw-live-pack', 'aa');
    const after_ = await hardware();
    assert.notEqual(
      after_.detectedAt,
      before_.detectedAt,
      '装完一个后端包，硬件快照没有重算 —— 那排后端芯片会一直停在装之前的状态，' +
        '而用户刚做的就是为了让它们变绿',
    );
  });

  it('★ 同一个 id 换成不同的字节 ⇒ 也必须重算（T-191 那个洞：按 id 算就漏了）', async () => {
    const before_ = await hardware();
    writePack('om-hw-live-pack', 'bb');
    const after_ = await hardware();
    assert.notEqual(
      after_.detectedAt,
      before_.detectedAt,
      '同 id 不同内容没有让快照失效 —— 这正是 08-02 装的包被换掉之后' +
        '"六个后端全部 probe not found 而界面说已安装"的那条路径',
    );
  });

  it('★ 什么都没变时**不许**重算 —— 否则每个请求都 spawn 一次 probe', async () => {
    const a = await hardware();
    const b = await hardware();
    assert.equal(
      a.detectedAt,
      b.detectedAt,
      '两次连续请求探测了两次。失效规则太松与太紧同样是 bug：' +
        'ADR-003 决策 3 给 probe 的上限是 10 s，每请求跑一次等于把硬件页变成一个 10 秒的按钮',
    );
  });

  it('卸载（删掉安装记录）同样要重算', async () => {
    const before_ = await hardware();
    rmSync(manifestPath('om-hw-live-pack'), { force: true });
    const after_ = await hardware();
    assert.notEqual(after_.detectedAt, before_.detectedAt, '卸载之后快照没重算');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * ③ 同一个根的另一半：**卡片显示的是"目录说的"，不是"机器上的"**
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * `[用户真机实测 2026-08-09，:10000]` 更新之前那张卡片写着
 * `已安装 · ffmpeg n8.1.2-34-g9b6c8969e0 · 112 MB`，**而机器上跑的是 n7.1.5**。
 *
 * 「已安装」+ 一个它并不拥有的版本号 = 一句假话。唯一的提示只有旁边多出来的
 * 「更新」按钮，可那要求用户先想到"这个版本号说的不是我这台"。
 *
 * 与 ① ② 是同一个根：**界面在显示目录说的，而不是机器上的。** 所以一并治。
 *
 * 下面钉的是**数据那一半**（端点到底发了什么）。判据是"发出去的是机器上那一份"，
 * 不是"某个字段存在" —— 一个只断 `'installedEngineVersion' in pack` 的用例，
 * 在它被填成目录值的那天照样是绿的。
 */
describe('T-193 ③ /api/backends/catalog 必须说清"机器上那一份"是哪个版本', () => {
  /** 目录里真实存在的一个包；用它是为了走真实合并路径，不是造一个假 id。 */
  const PACK_ID = 'media-tools-linux-x64';
  /** 机器上装的是**旧**版本 —— 用户真机上的形态（目录已经换新了）。 */
  const INSTALLED_VERSION = 'n7.1.5-fake-old';
  const INSTALLED_BYTES = 12_345_678;

  const manifestPath = join(dataDir, 'models', 'manifests', 'backend', `${PACK_ID}.json`);

  const catalogPack = async (): Promise<Record<string, unknown>> => {
    const r = await fetch(`${base}/api/backends/catalog`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { packs: Record<string, unknown>[] };
    const p = body.packs.find((x) => x['id'] === PACK_ID);
    assert.ok(p, `目录里没有 ${PACK_ID} —— 这条用例没有被测对象了`);
    return p;
  };

  it('前提自检：没装的时候，这两格必须是 null（不是目录值，也不是缺失）', async () => {
    const p = await catalogPack();
    assert.equal(p['installed'], false, '这个包在测试机器上不该是已安装状态');
    assert.equal(p['installedEngineVersion'], null);
    assert.equal(p['installedSizeBytes'], null);
  });

  it('★ 装上一个**旧版本**之后，端点回的必须是机器上那个版本，不是目录里的', async () => {
    const catalogVersion = (await catalogPack())['engineVersion'];
    assert.notEqual(
      catalogVersion,
      INSTALLED_VERSION,
      '夹具的版本号与目录撞了 —— 这条断言此刻分不出两者',
    );

    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        id: PACK_ID,
        engine: 'ffmpeg',
        engineVersion: INSTALLED_VERSION,
        backend: 'cpu',
        installedAt: '2026-08-02T00:00:00.000Z',
        verifiedAt: null,
        integrity: 'ok',
        files: [
          { name: 'ffmpeg.tar.xz', sha256: 'oldsha', sizeBytes: INSTALLED_BYTES, path: '/tmp/x' },
        ],
        selfTest: null,
      }),
    );

    const p = await catalogPack();
    assert.equal(p['installed'], true);
    assert.equal(
      p['installedEngineVersion'],
      INSTALLED_VERSION,
      '端点仍然只发得出目录的版本 —— 卡片上「已安装 · <目录版本>」那句假话没有被修掉',
    );
    assert.equal(p['installedSizeBytes'], INSTALLED_BYTES, '体积也得是机器上那一份的');
    /*
     * 目录那两格**必须原样保留**：它们是"你点更新会拿到什么"，与"你现在有什么"
     * 是两个问题。把目录值覆盖掉是另一种丢信息。
     */
    assert.equal(p['engineVersion'], catalogVersion, '目录版本被覆盖了 —— 那是另一半信息');
    // 内容不同 ⇒ 这条正是「更新」按钮出现的依据，顺带确认两格是配套的
    assert.equal(p['updateAvailable'], true);
  });

  it('卸载之后回到 null —— "我没有"不许被渲染成"和目录一样"', async () => {
    rmSync(manifestPath, { force: true });
    const p = await catalogPack();
    assert.equal(p['installedEngineVersion'], null);
    assert.equal(p['installedSizeBytes'], null);
  });
});
