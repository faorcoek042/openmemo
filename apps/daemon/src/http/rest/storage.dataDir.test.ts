/**
 * `POST /api/settings/data-dir` —— **用户表达的"不要搬"必须真的到达执行方。**
 *
 * ## 这份测试守的是一次实测出来的数据事故，不是一个风格问题
 *
 * 前端一直发 `moveExisting`，本路由一直读 `move`，缺省 `body?.move !== false` = **搬**。
 * 起一个真的 http server、造两个真的数据目录、发前端逐字节一样的那个请求，
 * 今天（修复前）实际发生的是：
 *
 * ```
 * >>> POST /api/settings/data-dir {"moveExisting":false,"path":"<新位置>"}
 * <<< 202 {"ok":true,"moved":true,"strategy":"rename","files":9,…,"messageZh":"已移动 9 个文件…"}
 * 源目录：被清空       新位置：openmemo.db / secrets.json / media/*.m4a / models/*.bin 全在那儿
 * ```
 *
 * 也就是那个复选框**在传输层上根本不存在** —— 勾与不勾产生逐字节相同的结果。
 *
 * ## 判据取"文件系统里发生了什么"，不取"响应里写了什么"
 *
 * 只断言 `moved:false` 是不够的：本项目栽过的正是"字段算出来了但没送到"这一类。
 * 所以每条用例都在请求前后各扫一遍两个目录的真实内容（路径 + 大小 + 内容哈希），
 * 断言的是**源目录一个文件都没少**。响应里的 `moved` 只是附带核对。
 *
 * ## PROTOCOL §9 / §9-bis：这份测试绝不许碰机器级指针
 *
 * 这条路由成功时**会写指针**（`writeDataDirPointer`）。指针默认在
 * `~/.local/share/openmemo/datadir.json`，是**全机器共享的一份**：
 * 写它就等于把用户 demo 的数据目录改掉，几小时后重启才显形
 * （已经发生过一次：用户的 key、模型、转写记录在界面上"全部消失"）。
 *
 * 所以 `OPENMEMO_POINTER_FILE` 在**模块顶层**就被指到本次的临时目录 —— 窗口为零，
 * 不放 `before()`（那还剩"模块加载到 before 之间"这一段），也**不写清理代码**
 * （node:test 一个文件一个子进程，进程一退就没了；而"清理代码"正是 §9-bis 认定
 * 靠不住的那个东西 —— `after()` 只在正常结束时跑，`kill -9` 就留下坏状态）。
 * 下面第一组用例专门守着这条重定向本身。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { openAppDatabase, type AppDatabase } from '@openmemo/db';

import { pointerFile } from '../../config/paths.js';
import { createStorageRoutes, externalFiles, parseChangeRequest } from './storage.js';

const made: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `om-dd-${prefix}-`));
  made.push(d);
  return d;
}

/** ★ 见文件头：模块顶层，窗口为零。 */
process.env['OPENMEMO_POINTER_FILE'] = join(tmp('pointer'), 'datadir.json');

const pointerPath = pointerFile();

after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe('★ 本测试文件绝不能碰到用户机器上那份指针', () => {
  it('★ 指针路径必须落在临时目录里，且不在 $HOME 底下', () => {
    assert.equal(
      pointerPath.startsWith(tmpdir()),
      true,
      `指针指向 ${pointerPath} —— 它不在临时目录里，这个测试会写用户的机器级状态`,
    );
    assert.equal(
      pointerPath.startsWith(homedir()),
      false,
      `指针指向 ${pointerPath} —— 它在 $HOME 底下，会把用户 demo 的数据目录改掉`,
    );
  });

  it('★ pointerFile() 回读到的必须就是我们设的那个（重定向真的生效了）', () => {
    assert.equal(pointerFile(), process.env['OPENMEMO_POINTER_FILE']);
  });
});

// ─────────────────────────────────────────────────────────────
// 纯函数：意图解析
// ─────────────────────────────────────────────────────────────

describe('parseChangeRequest —— 破坏性开关的缺省方向与形状校验', () => {
  it('★ 字段缺席 = 不搬（缺省绝不解释成不可逆操作）', () => {
    const r = parseChangeRequest({ path: '/x' });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.move, false, '没有表达过的意图被当成了"搬"');
  });

  it('★ 前端真实发的 moveExisting:false 必须被读到（这就是那个 bug）', () => {
    const r = parseChangeRequest({ path: '/x', moveExisting: false });
    assert.equal(r.ok && r.move, false);
  });

  it('moveExisting:true 照常搬 —— 修复不许把功能一起关掉', () => {
    const r = parseChangeRequest({ path: '/x', moveExisting: true });
    assert.equal(r.ok && r.move, true);
  });

  it('旧别名 move 仍然认（daemon 自己的补救载荷曾经发它，不能反手丢掉）', () => {
    assert.equal(parseChangeRequest({ path: '/x', move: true }).ok && true, true);
    const t = parseChangeRequest({ path: '/x', move: true });
    assert.equal(t.ok && t.move, true);
    const f = parseChangeRequest({ path: '/x', move: false });
    assert.equal(f.ok && f.move, false);
  });

  it('★ 不认识的字段 → 400，绝不静默忽略（忽略 = 让缺省替用户决定）', () => {
    const r = parseChangeRequest({ path: '/x', moveExsiting: false });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'UNKNOWN_FIELD');
    assert.equal(
      r.ok === false && r.message.includes('moveExsiting'),
      true,
      '报错里必须点名是哪个字段，否则调用方无从改起',
    );
  });

  it('★ 形状不对 → 400，不做真值转换（"false" 字符串曾经等于"搬"）', () => {
    for (const bad of ['false', 0, 1, null, {}]) {
      const r = parseChangeRequest({ path: '/x', moveExisting: bad });
      assert.equal(r.ok, false, `moveExisting=${JSON.stringify(bad)} 应当被拒绝`);
      assert.equal(r.ok === false && r.code, 'BAD_MOVE_FLAG');
    }
  });

  it('两个名字给了相反的值 → 400，不挑一个信', () => {
    const r = parseChangeRequest({ path: '/x', moveExisting: false, move: true });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'CONFLICTING_MOVE_FLAG');
  });

  it('两个名字给了相同的值 → 放行', () => {
    const r = parseChangeRequest({ path: '/x', moveExisting: true, move: true });
    assert.equal(r.ok && r.move, true);
  });

  it('dryRun 必须是布尔（形状校验对齐，别留一个宽松的洞）', () => {
    assert.equal(parseChangeRequest({ path: '/x', dryRun: 'yes' }).ok, false);
    assert.equal(parseChangeRequest({ path: '/x', dryRun: true }).ok, true);
  });
});

describe('externalFiles —— 中英必须成对（判据同 T-135）', () => {
  it('每条都同时有 purpose/purposeZh 与 risk/riskZh', () => {
    const list = externalFiles();
    assert.ok(list.length >= 1, '一条都没有，八成拿错了对象');
    for (const e of list) {
      for (const k of ['purpose', 'purposeZh', 'risk', 'riskZh', 'whyOutside', 'whyOutsideZh']) {
        assert.equal(
          (e[k] ?? '').trim().length > 0,
          true,
          `${e['path']} 缺 ${k} —— 那个语言下前端没有任何可回落的东西`,
        );
      }
    }
  });

  it('★ 指针文件必须在列表里 —— 它是"删了数据目录还剩什么"的唯一答案', () => {
    assert.equal(
      externalFiles().some((e) => e['path'] === pointerFile()),
      true,
    );
  });
});

// ─────────────────────────────────────────────────────────────
// 真发 HTTP：判据是文件系统里发生了什么
// ─────────────────────────────────────────────────────────────

/** 相对路径 -> `size:sha256(前 4KB)`。比对的是内容，不是文件名。 */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const h = createHash('sha256').update(readFileSync(p).subarray(0, 4096)).digest('hex');
        out.set(relative(root, p), `${statSync(p).size}:${h.slice(0, 16)}`);
      }
    }
  };
  walk(root);
  return out;
}

/** 造一个像真的数据目录：真 sqlite 库 + 用户认得出来的文件。 */
function makeDataDir(tag: string): string {
  const d = tmp(tag);
  openAppDatabase({ filename: join(d, 'openmemo.db') }).close();
  for (const sub of ['media', 'logs', 'models']) mkdirSync(join(d, sub), { recursive: true });
  writeFileSync(join(d, 'media', 'recording-001.m4a'), Buffer.alloc(64 * 1024, 0x41));
  writeFileSync(join(d, 'models', 'ggml.bin'), Buffer.alloc(32 * 1024, 0x43));
  writeFileSync(join(d, 'secrets.json'), '{"deepseekKey":"sk-USER-REAL-KEY"}');
  return d;
}

let server: Server | undefined;
let db: AppDatabase | undefined;
let base = '';
let src = '';
const restarts: unknown[] = [];
/** 关库/重开的调用顺序 —— 「搬迁必须发生在库关着的时候」靠它来钉。 */
const dbEvents: string[] = [];

/** 每条用例换一套目录：搬迁是破坏性的，共用会互相污染。 */
async function mount(dataDir: string): Promise<void> {
  const { resolvePaths } = await import('../../config/paths.js');
  const paths = resolvePaths(dataDir);
  db = openAppDatabase({ filename: paths.dbFile });
  dbEvents.length = 0;
  const routes = createStorageRoutes({
    paths,
    db: db.db,
    runningJobs: () => 0,
    /*
     * ★ 搬迁期间关库 —— Windows 上不关就删不掉源（`FILE_SHARE_DELETE`）。
     *   这里如实照做，顺便把调用顺序记下来给 `dbEvents` 那条用例断言。
     */
    closeDatabase: () => {
      dbEvents.push('close');
      db?.close();
      db = undefined;
    },
    reopenDatabase: (dataDir) => {
      dbEvents.push(`reopen:${dataDir}`);
      db = openAppDatabase({ filename: join(dataDir, 'openmemo.db') });
      return db.db;
    },
    requestRestart: (reason, opts) => restarts.push({ reason, opts }),
  });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void routes
      .handle(req, res, url, req.method ?? 'GET')
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end('unrouted');
        }
      })
      .catch((e: unknown) => {
        res.writeHead(500);
        res.end(String(e));
      });
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
}

async function unmount(): Promise<void> {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  db?.close();
  server = undefined;
  db = undefined;
}

/** 发前端逐字节一样的那个请求。 */
async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/settings/data-dir`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('POST /api/settings/data-dir —— 「不要搬」必须真的不搬（判据是文件系统）', () => {
  it('★★ 前端那个请求：{moveExisting:false} + 全新目标 → 一个文件都不许动', async () => {
    src = makeDataDir('src');
    const dst = join(tmp('holder'), 'newloc');
    const beforeSrc = snapshot(src);
    assert.ok(beforeSrc.size >= 4, '前提不成立：源目录是空的');

    await mount(src);
    const { status, json } = await post({ path: dst, moveExisting: false });
    await unmount();

    const afterSrc = snapshot(src);
    /*
     * 目标不是一个数据目录，所以"只改指向"这一档会被 NOT_A_DATA_DIR 拦下 ——
     * 那正是**正确的失败方式**：一个字节没动，并且把原因说清楚。
     * 修复前这里是 202 + 源目录被清空。
     */
    assert.equal(status, 409, `期望 409 NOT_A_DATA_DIR，实际 ${status} ${JSON.stringify(json)}`);
    assert.deepEqual(
      [...afterSrc.entries()].sort(),
      [...beforeSrc.entries()].sort(),
      '★ 用户选了"不要搬"，源目录却变了 —— 这正是本轮要修的那件事',
    );
    assert.equal(existsSync(dst), false, '目标位置被创建了 —— 说明还是走了搬迁那条路');
  });

  it('★★ 补救按钮那一发：{moveExisting:false} + 目标已经是数据目录 → 202 且不搬', async () => {
    src = makeDataDir('src2');
    const dst = makeDataDir('dst2');
    const beforeSrc = snapshot(src);
    const beforeDst = snapshot(dst);

    await mount(src);
    const { status, json } = await post({ path: dst, moveExisting: false });
    await unmount();

    /*
     * 修复前这里是 **409 TARGET_ALREADY_DATA_DIR** —— 也就是用户点「直接使用此目录」
     * 之后看到的还是刚才那条错误，这个按钮从上线起一次都没成功过。
     */
    assert.equal(status, 202, `期望 202，实际 ${status} ${JSON.stringify(json)}`);
    assert.equal(json['moved'], false, '响应说搬了 —— 但用户选的是不搬');
    assert.deepEqual(
      [...snapshot(src).entries()].sort(),
      [...beforeSrc.entries()].sort(),
      '源目录被动过',
    );
    assert.deepEqual(
      [...snapshot(dst).entries()].sort(),
      [...beforeDst.entries()].sort(),
      '目标目录被动过',
    );
  });

  it('★ 缺省（完全不给这个字段）也不搬', async () => {
    src = makeDataDir('src3');
    const dst = join(tmp('holder3'), 'newloc');
    const beforeSrc = snapshot(src);

    await mount(src);
    const { status } = await post({ path: dst });
    await unmount();

    assert.equal(status, 409, '缺省走到了搬迁那条路');
    assert.deepEqual([...snapshot(src).entries()].sort(), [...beforeSrc.entries()].sort());
    assert.equal(existsSync(dst), false);
  });

  it('★ 拼错字段名 → 400 UNKNOWN_FIELD，而不是"照缺省搬走"', async () => {
    src = makeDataDir('src4');
    const dst = join(tmp('holder4'), 'newloc');
    const beforeSrc = snapshot(src);

    await mount(src);
    const { status, json } = await post({ path: dst, moveExsiting: false });
    await unmount();

    assert.equal(status, 400);
    assert.equal((json['error'] as Record<string, unknown>)['code'], 'UNKNOWN_FIELD');
    assert.deepEqual([...snapshot(src).entries()].sort(), [...beforeSrc.entries()].sort());
    assert.equal(existsSync(dst), false);
  });

  it('★ 阴性对照：moveExisting:true 必须照常搬（别把功能一起关掉）', async () => {
    src = makeDataDir('src5');
    const dst = join(tmp('holder5'), 'newloc');
    const beforeSrc = snapshot(src);

    await mount(src);
    const { status, json } = await post({ path: dst, moveExisting: true });
    await unmount();

    assert.equal(status, 202, `搬迁被误伤了：${status} ${JSON.stringify(json)}`);
    assert.equal(json['moved'], true);
    assert.equal(snapshot(src).size, 0, '说搬了，源目录却还有文件');
    const afterDst = snapshot(dst);
    for (const [rel, sig] of beforeSrc) {
      assert.equal(afterDst.get(rel), sig, `${rel} 没有原样到达新位置`);
    }
  });

  it('★ dryRun 必须回 willMove —— 动手之前要能看见"这一发会不会搬"', async () => {
    src = makeDataDir('src6');
    const dst = join(tmp('holder6'), 'newloc');
    const beforeSrc = snapshot(src);

    await mount(src);
    const off = await post({ path: dst, moveExisting: false, dryRun: true });
    const on = await post({ path: dst, moveExisting: true, dryRun: true });
    await unmount();

    assert.equal(off.status, 200);
    assert.equal(off.json['willMove'], false);
    assert.equal(on.json['willMove'], true);
    assert.deepEqual(
      [...snapshot(src).entries()].sort(),
      [...beforeSrc.entries()].sort(),
      '试算动了文件',
    );
  });

  it('★ 409 的补救载荷必须发前端真正会读的那个键名', async () => {
    src = makeDataDir('src7');
    const dst = makeDataDir('dst7');

    await mount(src);
    const { status, json } = await post({ path: dst, moveExisting: true });
    await unmount();

    assert.equal(status, 409);
    const rem = (json['error'] as Record<string, unknown>)['remediation'] as Record<
      string,
      unknown
    >;
    const params = rem['params'] as Record<string, unknown>;
    assert.equal(rem['action'], 'useExistingDataDir');
    assert.equal(
      params['moveExisting'],
      false,
      '★ 补救载荷用的还是前端读不到的键名 —— 那个按钮会永远点不成',
    );
    assert.equal('move' in params, false, '同一件事不许再出现第二个名字');
  });

  /*
   * ★★ 这条钉的是 Windows 上那个"必然发生"的缺陷的修法。
   *
   * `[CI 实测 run 31296921806, windows-2025]` 搬迁本身在 Windows 上没问题，
   * 卡住的是 `openmemo.db` 还开着：POSIX 允许 unlink 已打开的文件，
   * 而 **Windows 的 SQLite 共享模式不含 `FILE_SHARE_DELETE`** → 删源必然失败。
   *
   * ⚠️ 所以**这条断言在 Linux 上永远不会因为"忘了关库"而变红** ——
   * 文件系统层面看不出区别。因此它断言的不是结果，是**顺序**：
   * 关库必须发生在搬迁之前，重开必须落在**新位置**。
   * 顺序错了在任何平台上都当场红，而不必等到有人在 Windows 上试。
   */
  it('★★ 搬迁必须发生在库关着的时候，且搬完在新位置重开（顺序，不是结果）', async () => {
    src = makeDataDir('src8');
    const dst = join(tmp('holder8'), 'newloc');

    await mount(src);
    const { status } = await post({ path: dst, moveExisting: true });
    await unmount();

    assert.equal(status, 202, '搬迁应当成功');
    assert.deepEqual(
      dbEvents,
      ['close', `reopen:${dst}`],
      '★ 期望「先关库 → 搬 → 在新位置重开」；顺序不对就是 Windows 上删不掉源的那个成因',
    );
    assert.equal(existsSync(join(dst, 'openmemo.db')), true, '库文件应当在新位置');
    assert.equal(existsSync(src), false, '源目录应当已被删掉');
  });
});

before(() => {
  restarts.length = 0;
});
