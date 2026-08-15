/**
 * ★★ **「删不掉」不许再被吞掉 —— 而且 `removed` 不许数它没删掉的东西。**（#113）
 *
 * ## 病的形状
 *
 * ```ts
 * await fs.rm(abs, { force: true }).catch(() => undefined);
 * removed += 1;                       // ← 抛了也照样加
 * ```
 *
 * ⇒ 用户点卸载 → 卡片消失 → 界面说成功 → **文件还在盘上**。
 * `[实证]` v0.7.3 发布跑：`e2e-runtime` 的 `A-UNINSTALL-BYTES-GONE` 在 win32 上
 * 如实报 UNKNOWN（盘上文件还在，而 `removed` 说删了）；linux 实删 24 MB、
 * darwin 7.5 MB 均 PASS。
 *
 * ## 🔴 三条一起才算数（缺一条都能被绕过）
 *
 *   ① **正常删除** ⇒ `removed` 数对、盘上真的少了；
 *   ② **越界记录** ⇒ 进 `refused`、字节还在 —— 那条腿在 `installRecordBounds.test.ts`
 *      与 `uninstallRefusalResponse.test.ts`，本文件**不重复**，只在 ④ 里核一遍
 *      「两档没有互相污染」；
 *   ③ **`rm` 真失败** ⇒ 进第三档，`removed` **不许加**，且外面读得出
 *      「没删掉 + 在哪儿 + 能做什么」。
 *
 * ## ⚠️⚠️ 「真失败」是**真的**造出来的，不是把 `fs.rm` 换成替身
 *
 * mock 掉 `fs.rm` 测的是替身：那样连"我们到底会不会走到 `fs.rm`"都证明不了，
 * 而这正是本轮要修的那一行所在的位置。所以下面两条走真实的文件系统：
 *
 * | 场景 | 怎么造 | errno | 跑在哪 |
 * |---|---|---|---|
 * | ① 记录说是文件、盘上是目录 | 真的建一个目录 | `ERR_FS_EISDIR` | **所有平台、所有用户**（root 也挡不住） |
 * | ② 父目录只读 | `chmod 0o500` | `EACCES` | POSIX **非 root**（GitHub 的 ubuntu/macos runner 就是） |
 *
 * ★ ① 是主腿，**任何环境下都会跑**：它不依赖 uid、不依赖平台，
 *   把 #113 的修法整个抽掉（`removed += 1` 无条件、失败吞掉）它当场红。
 * ★ ② 是更贴近真实成因的那一条（"系统不让删"），但 root 会绕过 DAC 检查，
 *   所以在 root 下**显式 skip**（node:test 会把它显示成 skipped，不是绿）。
 *
 * ⚠️ **`in_use`（EBUSY）这一档在 Linux 上造不出真实场景** —— unlink 一个正在被
 *   读写、甚至正在执行的文件在 Linux 上都是成功的，EBUSY 基本只出现在挂载点上
 *   （需要特权）。它是 **Windows 的那一档**，而单测跑不到那台机器。
 *   所以它只在 ③ 那组**纯函数**用例里钉住 —— 那组测的是
 *   `classifyRemovalFailure()` 的映射，**不是** `fs.rm` 的替身：
 *   「走到了 rm、rm 抛了、账要记对」这条链由 ①② 用真失败证完，
 *   ③ 只回答"拿到 EBUSY 时我们分到哪一档"。**这个区别是这份文件的判据之一，
 *   别把 ③ 读成"我们测过 Windows 了"。**
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * ⚠️ PROTOCOL §9-bis：模块顶层重定向，窗口为零。
 * `RestState.create()` 会 mkdir 模型根、读写 active.json —— 不重定向就会去动
 * 这台机器上真实的数据目录。
 */
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-removal-failure-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it } from 'node:test';

import { ArtifactStore } from '@openmemo/downloader';
import type { InstalledBackendPack, UninstallWithRefusalsResponse } from '@openmemo/shared';

import { SseHub } from '../sse.js';
import { createModelRoutes, type ModelRoutes } from './models.js';
import { RestState, classifyRemovalFailure } from './state.js';

/** 库内正常装着的那份 —— 内容独一无二，好让"它变了"与"它没了"分得开。 */
const STORE_OWNED = Buffer.from('bytes that live inside the artifact store\n');

/** root 会绕过 DAC 权限检查，`chmod 0o500` 挡不住它 —— 那条腿在 root 下无效。 */
const IS_ROOT = process.platform !== 'win32' && (process.getuid?.() ?? -1) === 0;
/** 只读父目录这一招是 POSIX 的；Windows 的 ACL 不是这么工作的。 */
const CHMOD_WORKS = process.platform !== 'win32';

/**
 * 一台干净的机器：空的数据目录 + 一份空的后端目录清单。
 *
 * ⚠️ 两个 `seed*` 各自照抄一份**已经跑通**的姿势，不合并成一个：
 * `RestState.create()` 与 `createModelRoutes()` 各自持有自己的 store，
 * 同一个 dataDir 上开两份是在测一件没人要的事。
 */
async function baseDirs(
  tag: string,
): Promise<{ dataDir: string; modelsRoot: string; manifestDir: string }> {
  const dataDir = mkdtempSync(join(TEST_ROOT, `${tag}-`));
  const modelsRoot = join(dataDir, 'models');
  process.env['OPENMEMO_MODELS'] = modelsRoot;

  const manifestDir = mkdtempSync(join(TEST_ROOT, `${tag}-manifests-`));
  await writeFile(
    join(manifestDir, 'backends.json'),
    JSON.stringify({
      schemaVersion: 1,
      catalogVersion: '2026.08.15',
      generatedAt: '2026-08-15T00:00:00.000Z',
      packs: [],
    }),
    'utf8',
  );
  return { dataDir, modelsRoot, manifestDir };
}

/** 函数层（`dropInstalledFiles()` 的返回值）—— 姿势同 `installRecordBounds.test.ts`。 */
async function seedState(tag: string): Promise<{ state: RestState; modelsRoot: string }> {
  const { dataDir, modelsRoot, manifestDir } = await baseDirs(tag);
  const state = await RestState.create({ sse: new SseHub(), dataDir, manifestDir });
  return { state, modelsRoot };
}

/**
 * HTTP 层 —— 姿势同 `uninstallRefusalResponse.test.ts`：走 `createModelRoutes()`
 * （`server.ts` 的接线点）。`RestState` 由它自己懒加载，所以安装记录必须在
 * **第一个请求之前**写好。
 */
async function seedRoutes(
  tag: string,
): Promise<{ routes: ModelRoutes; store: ArtifactStore; modelsRoot: string }> {
  const { dataDir, modelsRoot, manifestDir } = await baseDirs(tag);
  const store = new ArtifactStore(modelsRoot);
  await store.init();
  const routes = createModelRoutes({ sse: new SseHub(), dataDir, manifestDir });
  return { routes, store, modelsRoot };
}

/**
 * 一条**可移植形状**的后端安装记录：`root: 'models'` + `relPath`，路径就在库内。
 *
 * ⚠️ 刻意用界内的可移植记录，而不是遗留的绝对 `path`：越界那条路会在解析层
 * 就被拦下（进 `refused`），**根本走不到 `fs.rm`** —— 那样这个文件测的是另一件事。
 * 这里要的是「解析通过了、我们真的去删了、然后删不动」。
 */
function portableRecord(id: string, names: readonly string[]): InstalledBackendPack {
  return {
    schemaVersion: 1,
    id,
    engine: 'yt-dlp',
    engineVersion: '2026.07.04',
    backend: 'cpu',
    installedAt: '2026-07-01T00:00:00.000Z',
    verifiedAt: '2026-07-01T00:00:00.000Z',
    integrity: 'ok',
    source: 'downloaded',
    files: names.map((name) => ({
      role: 'binary',
      name,
      sha256: '',
      sizeBytes: STORE_OWNED.length,
      root: 'models',
      // ⚠️ 记录里一律 POSIX 分隔符（`toPortableRecord()` 的约定），别用 join()
      relPath: `by-name/backend/${name}`,
    })),
    selfTest: null,
  } as unknown as InstalledBackendPack;
}

/** 最小 `ServerResponse` 桩 —— `end` 必须收 Buffer（`sendJson` 写的是 Buffer）。 */
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

async function del(
  routes: ModelRoutes,
  apiPath: string,
): Promise<{ status: number; body: string }> {
  const cap = captureRes();
  const handled = await routes.handle(
    {} as IncomingMessage,
    cap.res,
    new URL(`http://127.0.0.1${apiPath}`),
    'DELETE',
  );
  assert.equal(handled, true, '路由根本没接住这个请求，后面的断言无意义');
  return { status: cap.status(), body: cap.body() };
}

/* ══════════════ ① 判据第 1 条：正常删除 —— removed 数对、盘上真的少了 ══════════════ */

describe('#113 ① 正常删除', () => {
  it('★★ 两个文件都删成 ⇒ removed === 2、failed 空、盘上真的没了', async () => {
    const { state, modelsRoot } = await seedState('ok');
    const id = 'ytdlp-ok';
    const names = ['ytdlp-a.bin', 'ytdlp-b.bin'];
    await mkdir(join(modelsRoot, 'by-name', 'backend'), { recursive: true });
    for (const n of names) await writeFile(join(modelsRoot, 'by-name', 'backend', n), STORE_OWNED);
    await state.store.writeManifest('backend', id, portableRecord(id, names));

    const report = await state.dropInstalledFiles(id, ['backend']);

    /*
     * 🔴 这一条是判据的**基线**，不是形式：没有它，「把 removed 恒置 0」
     * 也能让下面那条 `removed === 0` 绿 —— 于是那条什么都没证明。
     */
    assert.equal(report.removed, 2, `真删掉了两个却没数对：${JSON.stringify(report)}`);
    assert.deepEqual(report.failed, [], `一次干净的删除报出了"删不动"：${JSON.stringify(report)}`);
    assert.deepEqual(report.refused, [], `一次干净的删除报出了"拒绝"：${JSON.stringify(report)}`);
    for (const n of names) {
      await assert.rejects(
        () => readFile(join(modelsRoot, 'by-name', 'backend', n)),
        `报了删掉，文件却还在盘上：${n}`,
      );
    }
  });
});

/* ══════════════ ③ 判据第 3 条：rm 真失败 ⇒ 第三档，removed 不许加 ══════════════ */

describe('#113 ③ rm 真失败（真造出来的，不是 mock）', () => {
  /**
   * **场景 A：记录说它是个文件，盘上是个目录。**
   *
   * `fs.rm(abs, { force: true })` 没有 `recursive`，对目录会抛 `ERR_FS_EISDIR`
   * （`[实测 node 22/24]` `Path is a directory: rm returned EISDIR (is a directory) …`）。
   * `force: true` 只吞 `ENOENT`，别的照抛。
   *
   * ⚠️ 这不是"测了一个不会发生的事"：一次被打断的解包、或者一条旧布局的记录，
   * 都能让 `relPath` 指到一个目录上。
   *
   * ⚠️ 也**不要**顺手把那句 `fs.rm` 改成 `recursive: true` 来"修"它 ——
   * 那是另一个方向的行为改动（一条指错的记录会变成**递归删**），要自己的影响面
   * 分析，而且和本轮的问题无关：本轮要回答的是**删不掉时该说什么**。
   */
  it('★★ 场景 A（所有平台）：rm 抛了 ⇒ removed 不加、进 failed、字节还在、说得出三件事', async () => {
    const { state, modelsRoot } = await seedState('eisdir');
    const id = 'ytdlp-eisdir';
    // ⚠️ 名字不含 .zip/.tar.gz ⇒ `unpackDirName(name) === name` ⇒ 派生目录那一支
    //    会 `continue`，于是 `failed` 里恰好只有这一条，断言不会被邻居干扰。
    const name = 'ytdlp-as-dir.bin';
    const abs = join(modelsRoot, 'by-name', 'backend', name);
    // 记录说它是文件；盘上建成目录，而且里面真的有字节
    await mkdir(abs, { recursive: true });
    await writeFile(join(abs, 'inner.bin'), STORE_OWNED);
    await state.store.writeManifest('backend', id, portableRecord(id, [name]));

    const report = await state.dropInstalledFiles(id, ['backend']);

    /* ── 🔴 `removed` 不许数它没删掉的东西 —— 这就是 #113 那一行 ────────────── */
    assert.equal(
      report.removed,
      0,
      `rm 抛了，removed 却加了 —— 那正是 #113：用户拿到一个干净的成功，而文件还在盘上。` +
        `${JSON.stringify(report)}`,
    );

    /* ── 🔴 而且它必须**说出来**，不是静静地不计数 ───────────────────────────── */
    assert.equal(
      report.failed.length,
      1,
      `rm 失败被吞掉了 —— 外面读不到任何痕迹：${JSON.stringify(report)}`,
    );
    const f = report.failed[0]!;
    assert.equal(f.name, name, '对不到界面上那一行');
    /*
     * **在哪儿。** 这一档的用户动作是他自己去删，没有绝对路径就无从下手 ——
     * 而 `fs.rm` 抛的那串不保证带完整路径，所以契约里单列了这一格。
     */
    assert.equal(f.path, abs, `path 不是我们真的去删的那个绝对路径：${f.path}`);
    /*
     * **能做什么。** EISDIR 不在我们认得的两格里 ⇒ 必须如实落到 `unknown`，
     * 界面照着它说「没删掉、在这儿、原因我们没弄清」。
     * 🔴 断言是 `unknown` 而不是"随便哪一格"：把它硬塞进 `in_use`/`permission_denied`
     * 就是**编一个成因**，用户会照着一句没有用的建议去重启。
     */
    assert.equal(
      f.kind,
      'unknown',
      `一个我们不认识的 errno 被塞进了 "${f.kind}" —— 那是替一个没看懂的错误背书`,
    );
    // 系统原话：`unknown` 那一档它是我们唯一说得出的东西，不许是空的
    assert.ok(f.detail.trim().length > 0, 'detail 是空的 —— unknown 那一档就彻底没话说了');
    assert.ok(/EISDIR|directory/i.test(f.detail), `detail 没带上系统真正说的那句话：${f.detail}`);

    /* ── 而且字节**真的还在**：说"没删掉"就得真没删掉 ────────────────────────── */
    assert.deepEqual(
      await readFile(join(abs, 'inner.bin')).catch(() => null),
      STORE_OWNED,
      '报了"删不动"，其实删了 —— 那份报告是编的，比沉默更坏',
    );
  });

  /**
   * **场景 B：父目录只读 ⇒ `EACCES`。**
   *
   * 这是三格里唯一能在 POSIX 上真造出来、且**落进我们认得的一格**的成因。
   *
   * ⚠️ root 绕过 DAC 检查（`[实测]` uid=0 时 `chmod 0o500` 的父目录里 unlink 照样成功），
   * 所以在 root 下**显式 skip** —— node:test 会把它显示成 skipped。
   * 一条在 root 下"绿"的用例，测的是"我们是 root"，不是产品。
   * GitHub 的 `ubuntu-24.04` / `macos-26` runner 跑在非 root 的 `runner` 账号下，
   * 判决在那里拿得到（`.github/workflows/ci.yml` 没有 job 级 `container:`）。
   */
  it(
    '★★ 场景 B（POSIX 非 root）：EACCES ⇒ permission_denied、removed 不加、字节还在',
    {
      skip:
        !CHMOD_WORKS || IS_ROOT
          ? `这一招在这里造不出真实失败（platform=${process.platform}, root=${String(IS_ROOT)}）——` +
            `如实跳过，不报绿。主腿（场景 A）不依赖它，仍然跑到了`
          : false,
    },
    async () => {
      const { state, modelsRoot } = await seedState('eacces');
      const id = 'ytdlp-eacces';
      const name = 'ytdlp-locked.bin';
      const dir = join(modelsRoot, 'by-name', 'backend');
      const abs = join(dir, name);
      await mkdir(dir, { recursive: true });
      await writeFile(abs, STORE_OWNED);
      await state.store.writeManifest('backend', id, portableRecord(id, [name]));

      /*
       * 只读 + 可执行：进得去、读得到，就是不许在里面删东西。
       * ⚠️ 权限一定要还回去（`finally`），否则 TEST_ROOT 清不掉，
       * 而且后面的用例会撞上一个只读目录、红在一个跟它无关的地方。
       */
      await chmod(dir, 0o500);
      const report = await state
        .dropInstalledFiles(id, ['backend'])
        .finally(() => chmod(dir, 0o700));

      assert.equal(report.removed, 0, `rm 抛了 EACCES，removed 却加了：${JSON.stringify(report)}`);
      assert.equal(report.failed.length, 1, `失败被吞掉了：${JSON.stringify(report)}`);
      const f = report.failed[0]!;
      assert.equal(f.path, abs);
      /*
       * 🔴 落进 `permission_denied` 那一格 —— 而那一格的措辞里带着**可执行的建议**
       * （用有权限的账号删；Windows 上先关掉可能在用它的程序）。
       * 判成 `unknown` 会让用户拿到一句"我们不知道"，而我们其实知道。
       */
      assert.equal(
        f.kind,
        'permission_denied',
        `EACCES 没被分到 permission_denied，用户因此拿不到那句能照做的建议：${f.detail}`,
      );
      assert.ok(f.detail.trim().length > 0, 'detail 是空的');

      // 字节还在
      assert.deepEqual(await readFile(abs).catch(() => null), STORE_OWNED, '说没删，其实删了');
      // 前提自证：这一条真的走到了只读目录那一步（不然它测的是"文件本来就不在"）
      assert.equal((await stat(abs)).size, STORE_OWNED.length);
    },
  );
});

/* ══════════════ ③' 分档表 —— 纯函数，**不是 fs.rm 的替身** ══════════════ */

describe('#113 ③′ classifyRemovalFailure —— 拿到某个 errno 时分到哪一档', () => {
  /*
   * ⚠️ 这一组**只**回答"给定一个 errno，我们分到哪一格"。
   * 「会不会走到 rm」「抛了以后账记得对不对」由上面 ①③ 用**真失败**证完 ——
   * 那一半不许用这一组顶替，两者证明的不是同一件事。
   *
   * 它存在的理由只有一个：`EBUSY`（Windows 上那一档，也是唯一给得出
   * 「重启一次多半就好」这句建议的一档）在 Linux 上造不出真实场景 ——
   * unlink 一个正在被读写甚至正在执行的文件在 Linux 上都是成功的。
   * **说清楚它是什么，就不会有人把它读成"我们测过 Windows 了"。**
   */
  const cases: readonly (readonly [string, unknown, string])[] = [
    ['EBUSY —— 有别的东西握着它（Windows 句柄没释放的那一档）', { code: 'EBUSY' }, 'in_use'],
    ['ETXTBSY —— 正在执行的映像', { code: 'ETXTBSY' }, 'in_use'],
    ['EACCES —— 系统不让删', { code: 'EACCES' }, 'permission_denied'],
    ['EPERM —— 同上（Windows 上"被打开着"也报到这里）', { code: 'EPERM' }, 'permission_denied'],
    ['ERR_FS_EISDIR —— 认不出，不许猜', { code: 'ERR_FS_EISDIR' }, 'unknown'],
    ['ENOTDIR —— 认不出，不许猜', { code: 'ENOTDIR' }, 'unknown'],
    ['连 code 都没有的 Error', new Error('boom'), 'unknown'],
    ['根本不是 Error（某些原生抛法）', 'boom', 'unknown'],
    ['null', null, 'unknown'],
  ];

  for (const [why, err, expected] of cases) {
    it(`${why} ⇒ ${expected}`, () => {
      assert.equal(classifyRemovalFailure(err), expected);
    });
  }

  it('★ 前提自证：这张表不是恒返回 unknown（否则上面 6 条 unknown 什么都没证明）', () => {
    assert.equal(classifyRemovalFailure({ code: 'EBUSY' }), 'in_use');
    assert.notEqual(classifyRemovalFailure({ code: 'EACCES' }), 'unknown');
  });
});

/* ══════════════ ④ 那份账要走到 HTTP 上，且两档不许互相污染 ══════════════ */

describe('#113 ④ DELETE 的响应体', () => {
  it('★★ rm 失败 ⇒ 200 + filesFailedToRemove（四格齐全）、记录没了、filesNotRemoved 是空的', async () => {
    const { routes, store, modelsRoot } = await seedRoutes('http-failed');
    const id = 'ytdlp-http-failed';
    const name = 'ytdlp-http-as-dir.bin';
    const abs = join(modelsRoot, 'by-name', 'backend', name);
    await mkdir(abs, { recursive: true });
    await writeFile(join(abs, 'inner.bin'), STORE_OWNED);
    await store.writeManifest('backend', id, portableRecord(id, [name]));

    const r = await del(routes, `/api/backends/${id}`);

    /*
     * ① **204 是错的答案。** 它等于"全删干净了"，而实际上没有 ——
     *   而且这条路上一个字节都没走，界面因此一个字都不会说。
     */
    assert.notEqual(
      r.status,
      204,
      'rm 真的失败了，却回了一个沉默的 204 —— 用户看到卡片消失、磁盘没变小，' +
        '而产品从头到尾没说过一个字（#113 的整个形状）',
    );
    assert.equal(r.status, 200, `期望 200（"卸载成了，但有东西没走掉"那一档）：${r.body}`);

    const body = JSON.parse(r.body) as UninstallWithRefusalsResponse & { packId?: string };
    assert.equal(body.packId, id, `响应里没说这是哪个包：${r.body}`);
    assert.equal(typeof body.freedBytes, 'number', `freedBytes 缺了或不是数字：${r.body}`);

    /*
     * ② 🔴 **两档不许互相污染。** `filesNotRemoved`（我们不肯删）必须是**空的** ——
     *   这条记录完全在界内，没有任何东西被拒绝。把 rm 失败塞进那一格，
     *   界面会对用户说"记录指向了数据目录之外"，一句彻头彻尾的假话。
     */
    assert.deepEqual(
      body.filesNotRemoved,
      [],
      `"删不动"被塞进了"我们不肯删"那一格 —— 界面会因此说出一句假的成因：${r.body}`,
    );

    // ③ 第三档四格齐全 ——「没删掉 + 在哪儿 + 能做什么」缺一件都退回沉默
    assert.equal(body.filesFailedToRemove.length, 1, `200 却没逐条说清哪些没删动：${r.body}`);
    const f = body.filesFailedToRemove[0]!;
    assert.equal(f.name, name);
    assert.equal(f.path, abs, `路径没走到网线上，用户拿着这句话找不到那个文件：${r.body}`);
    assert.equal(f.kind, 'unknown');
    assert.ok(f.detail.trim().length > 0, `detail 空的：${r.body}`);

    /*
     * ④ **记录真的没了** —— 界面那句话向用户承诺的另一半（"不用再点一次"）。
     *   记录若还在，那句话就是假的，而用户再点会拿到第三种答案。
     */
    assert.equal(
      await store.readManifest('backend', id),
      null,
      '回了 200 说"记录已清"，而安装记录还在',
    );
    // ⑤ 字节还在
    assert.deepEqual(await readFile(join(abs, 'inner.bin')).catch(() => null), STORE_OWNED);
  });

  it('★★ 反面：全删干净时仍然是 204（两条路分不开，上一条就什么都没证明）', async () => {
    const { routes, store, modelsRoot } = await seedRoutes('http-clean');
    const id = 'ytdlp-http-clean';
    const name = 'ytdlp-http-clean.bin';
    await mkdir(join(modelsRoot, 'by-name', 'backend'), { recursive: true });
    await writeFile(join(modelsRoot, 'by-name', 'backend', name), STORE_OWNED);
    await store.writeManifest('backend', id, portableRecord(id, [name]));

    const r = await del(routes, `/api/backends/${id}`);

    assert.equal(
      r.status,
      204,
      `一条完全正常的卸载被改成了 200 —— 那等于对每一次卸载都说一句"有东西没走掉"：${r.body}`,
    );
    assert.equal(r.body, '', `204 不该带 body：${r.body}`);
  });
});
