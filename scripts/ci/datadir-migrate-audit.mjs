#!/usr/bin/env node
/**
 * 数据目录搬迁的三平台审计腿。
 *
 * ## 为什么需要它
 *
 * 用户 2026-08-09 明确决定：数据目录**保持 OS 默认位置**，
 * 「设置 → 数据目录」那条搬迁路径因此从"锦上添花"变成**他唯一的搬家手段**。
 *
 * 而这条路径在 Windows 上刚出过事（`[CI 实测 2026-08-08 run 31250730491]`）：
 * `copy` 走完后 `fs.rm(源)` 失败（Windows 删不掉仍被 daemon 打开的 `openmemo.db`），
 * 界面却照说「已移动 54 个文件」—— 数据其实被**复制**了一份留在原地，
 * 里面有明文 `secrets.json`。那条已改成如实告知，
 * **但"Windows 上到底能不能真的移动"从来没有被回答过。这条腿就是来回答它的。**
 *
 * ## 判据（Manager 2026-08-08 裁定）
 *
 * **不是**"让 Windows 也用 rename"（跨卷 rename 本来就会失败，copy 是必要退路），
 * **而是"界面说的和实际发生的必须一致"**。
 *
 * ## §11：跳过不许渲染成成功
 *
 * 跨卷那格在某些 runner 上确实做不到（没有第二个卷）。做不到就**明确报 SKIP
 * 并在汇总里单列**，而不是悄悄不跑然后一片绿。`--require-crossvol` 可以把
 * "跳过"升级成失败，供以后 runner 具备条件时钉死。
 */
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir, stat } from 'node:fs/promises';
import { existsSync, openSync, closeSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, platform } from 'node:os';
import { join, dirname, resolve as resolvePath, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.env['REPO_ROOT'] ?? process.cwd();
const distUrl = (p) => pathToFileURL(join(REPO, p)).href;
const MV = await import(distUrl('apps/daemon/dist/storage/move.js'));
const ST = await import(distUrl('apps/daemon/dist/http/rest/storage.js'));

const IS_WIN = platform() === 'win32';
const REQUIRE_CROSSVOL = process.argv.includes('--require-crossvol');

/*
 * ── PROTOCOL §9 的结构性守卫，不是礼貌提醒 ────────────────────────────────────
 *
 * C7 走的是**产品自己的那条路**，而那条路会 `writeDataDirPointer()` ——
 * 指针是**全机器共享的一份**。这个脚本要是在没重定向指针的情况下跑起来，
 * 就会把跑它那台机器上的数据目录指针改掉；而症状要等下一次重启才显形
 * （用户的 key、模型、转写记录看起来"全没了"，其实一个字节没丢）。
 *
 * 判据照 §9-bis：**不是"记得设"，是"没设就跑不起来"**。
 */
{
  const pf = process.env['OPENMEMO_POINTER_FILE'];
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
  if (!pf) {
    console.error(
      '::error::OPENMEMO_POINTER_FILE 没设 —— 本脚本会走产品路径写指针，拒绝在真实指针上跑',
    );
    process.exit(2);
  }
  /*
   * 判据是「**它是不是那一份机器级指针**」，不是「它在不在 $HOME 底下」。
   *
   * 第一版写成了后者，`[CI 实测 run 31298064458]` 当场误伤：
   * GitHub runner 的 `$RUNNER_TEMP` 就是 `/home/runner/work/_temp` ——
   * 一个完全合法的临时目录，却被判成"机器级指针本身"，linux/macOS 两条腿直接 exit 2
   * （Windows 侥幸过关，只因为它的 `RUNNER_TEMP` 在 D: 盘）。
   * 一条**过宽**的安全检查和一条不生效的安全检查一样有害：它逼下一个人去绕开它。
   *
   * 现在按 `defaultDataDir()` 的同一套规则算出真实位置，逐一比对。
   */
  const realPointers = [];
  if (home) {
    if (IS_WIN) {
      const appData = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
      realPointers.push(join(appData, 'OpenMemo', 'datadir.json'));
    } else if (platform() === 'darwin') {
      realPointers.push(join(home, 'Library', 'Application Support', 'OpenMemo', 'datadir.json'));
    } else {
      const xdg = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
      realPointers.push(join(xdg, 'openmemo', 'datadir.json'));
    }
  }
  if (realPointers.some((r) => resolvePath(r) === resolvePath(pf))) {
    console.error(`::error::OPENMEMO_POINTER_FILE 指向的正是机器级指针（${pf}）—— 拒绝`);
    process.exit(2);
  }
  console.log(`指针已重定向：${pf}`);
  console.log(`（本机机器级指针在：${realPointers.join(', ') || '未知'}，全程不碰）`);
}

const results = [];
const rec = (id, name, status, detail) => {
  results.push({ id, name, status });
  console.log(`[${status}] ${id} ${name}`);
  if (detail) for (const l of String(detail).split('\n')) console.log(`        ${l}`);
};

/* ── 造一个五类数据齐全的数据目录（含两级符号链接） ── */
async function makeDataDir(root) {
  await mkdir(join(root, 'media'), { recursive: true });
  await mkdir(join(root, 'models', 'by-name', 'backend'), { recursive: true });
  await mkdir(join(root, 'bin', 'ext'), { recursive: true });
  await mkdir(join(root, 'runtime'), { recursive: true });
  await writeFile(join(root, 'openmemo.db'), 'DB'.repeat(500));
  await writeFile(join(root, 'secrets.json'), '{"key":"sk-PLAINTEXT"}');
  await writeFile(join(root, 'media', 'a.mp3'), 'AUDIO'.repeat(50));
  await writeFile(join(root, 'models', 'by-name', 'backend', 'ggml.bin'), 'M'.repeat(300));
  await writeFile(join(root, 'bin', 'ext', 'libwhisper.so.1.9.1'), 'ELF'.repeat(80));
  // Windows 上非管理员建不了符号链接 —— 建不成就跳过这两条，但要说出来
  try {
    await symlink('libwhisper.so.1.9.1', join(root, 'bin', 'ext', 'libwhisper.so.1'));
    await symlink('libwhisper.so.1', join(root, 'bin', 'ext', 'libwhisper.so'));
  } catch (e) {
    console.log(`        (符号链接未建成: ${e.code} —— 该平台/权限下不支持，链接相关断言将不覆盖)`);
  }
  await writeFile(join(root, 'runtime', 'runtime.json'), '{"installed":[]}');
}
const FIVE = [
  ['数据库', 'openmemo.db'],
  ['媒体', 'media/a.mp3'],
  ['模型', 'models/by-name/backend/ggml.bin'],
  ['组件', 'bin/ext/libwhisper.so.1.9.1'],
  ['运行时', 'runtime/runtime.json'],
];
const missingOf = (root) => FIVE.filter(([, r]) => !existsSync(join(root, r))).map(([l]) => l);

/* ── 找第二个卷；找不到返回 null（由调用方报 SKIP） ── */
async function secondVolumeRoot() {
  const cands = [];
  if (IS_WIN) {
    for (const d of ['D:\\', 'E:\\']) cands.push(join(d, 'om-datadir-audit'));
  } else if (platform() === 'linux') {
    cands.push('/dev/shm/om-datadir-audit'); // tmpfs，与 $HOME 的磁盘不同设备
  }
  for (const c of cands) {
    try {
      await mkdir(c, { recursive: true });
      await writeFile(join(c, '.probe'), 'x');
      await rm(join(c, '.probe'));
      return c;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/* ── C1 同卷 ── */
const TMP = await mkdtemp(join(tmpdir(), 'ddaudit-'));
{
  const from = join(TMP, 'c1-from');
  const to = join(TMP, 'c1-to');
  await makeDataDir(from);
  const r = await MV.moveDataDir(from, to);
  const miss = missingOf(to);
  const ok = r.ok && r.sourceRemoved === true && !existsSync(from) && miss.length === 0;
  rec(
    'C1',
    '同卷搬迁：源必须消失、五类数据必须齐全',
    ok ? 'PASS' : 'FAIL',
    `strategy=${r.strategy} sourceRemoved=${r.sourceRemoved} 源还在=${existsSync(from)} 缺失=${miss.join(',') || '无'}`,
  );
}

/* ── C2 跨卷（真跨设备；没有第二个卷就 SKIP，不假装成功） ── */
{
  const vol = await secondVolumeRoot();
  if (vol === null) {
    rec(
      'C2',
      '跨卷搬迁',
      REQUIRE_CROSSVOL ? 'FAIL' : 'SKIP',
      `这台 runner 上找不到第二个可写卷（${IS_WIN ? '试过 D:\\ E:\\' : platform() === 'linux' ? '试过 /dev/shm' : 'macOS 未内置候选'}）。\n` +
        `需要什么才能做到：Windows 需要一台带第二个卷（D:）的 runner；\n` +
        `macOS 需要 hdiutil 建 RAM disk 并 newfs_hfs 挂载；Linux 需要 /dev/shm 可写或一个 loop 设备。`,
    );
  } else {
    const from = join(TMP, 'c2-from');
    const to = join(vol, 'dest-' + Date.now());
    await makeDataDir(from);
    // 先证明这两条路径**真的**跨设备：否则这一格测的还是同卷
    let realCross = false;
    try {
      const probeSrc = join(TMP, 'xdev-probe');
      await mkdir(probeSrc, { recursive: true });
      const { rename } = await import('node:fs/promises');
      await rename(probeSrc, join(vol, 'xdev-probe'));
      await rm(join(vol, 'xdev-probe'), { recursive: true, force: true });
    } catch (e) {
      realCross = e.code === 'EXDEV';
    }
    const r = await MV.moveDataDir(from, to);
    const miss = missingOf(to);
    const ok = r.ok && miss.length === 0 && r.strategy === 'copy';
    rec(
      'C2',
      `跨卷搬迁（真跨设备=${realCross}）：必须退化成 copy 且数据齐全`,
      ok ? 'PASS' : 'FAIL',
      `strategy=${r.strategy} sourceRemoved=${r.sourceRemoved} sourceIntact=${r.sourceIntact}\n` +
        `源还在=${existsSync(from)} 缺失=${miss.join(',') || '无'}\n` +
        `界面文案=${ST.moveMessageZh({ files: r.files, links: r.links, sourceRemoved: r.sourceRemoved }, from)}`,
    );
    await rm(vol, { recursive: true, force: true }).catch(() => {});
  }
}

/* ── C3 删源前的逐文件校验：五种坏法都要抓到 ── */
{
  const a = join(TMP, 'c3-a');
  const b = join(TMP, 'c3-b');
  const mk = async () => {
    await rm(b, { recursive: true, force: true });
    await makeDataDir(b);
  };
  await makeDataDir(a);
  const out = [];
  await mk();
  await rm(join(b, 'media', 'a.mp3'));
  out.push(['缺文件', await MV.verifyTreesMatch(a, b)]);
  await mk();
  await writeFile(join(b, 'EXTRA'), 'x');
  out.push(['多文件', await MV.verifyTreesMatch(a, b)]);
  await mk();
  await writeFile(join(b, 'openmemo.db'), 'SHORT');
  out.push(['文件截断', await MV.verifyTreesMatch(a, b)]);
  if (existsSync(join(b, 'bin', 'ext', 'libwhisper.so'))) {
    await mk();
    await rm(join(b, 'bin', 'ext', 'libwhisper.so'));
    await writeFile(join(b, 'bin', 'ext', 'libwhisper.so'), 'ELF'.repeat(80));
    out.push(['链接被deref成真文件', await MV.verifyTreesMatch(a, b)]);
  }
  const all = out.every(([, v]) => v.ok === false);
  rec(
    'C3',
    '删源前逐文件校验（路径集合+字节数+链接目标）',
    all ? 'PASS' : 'FAIL',
    out.map(([n, v]) => `${n}: 抓到=${!v.ok} 首条=${v.mismatches[0] ?? '(无)'}`).join('\n'),
  );
}

/* ── C4 ★核心★ 删源失败 → 目标必须保住 + 界面必须改口 ──
 *
 * ## 注入方式为什么必须是"真的 SQLite 句柄"
 *
 * 第一版用 `fs.openSync(db,'r+')` 保持打开，`[CI 实测 run 31296434416]`
 * **在 Windows 上没能拦住删除**（报了 SKIP，没有假绿）——
 * 因为 libuv 开文件时带 `FILE_SHARE_DELETE`，这种句柄不阻止删除。
 * 而产品里握着 `openmemo.db` 的是 **better-sqlite3**，SQLite 在 Windows 上
 * 用的共享模式**不含** `FILE_SHARE_DELETE` → 删不掉。
 * 所以要复现用户那次故障，就得握一个**真的** SQLite 句柄，别用等价物。
 *
 * ## 为什么 POSIX 上这一格结构上测不到
 *
 * POSIX 允许 unlink 一个仍被打开的文件（目录项先消失，inode 等最后一个 fd 关闭）。
 * 所以同样的注入在 Linux/macOS 上**必然删得掉** —— 这不是注入失败，
 * **这正是"为什么它只在 Windows 上出事"的答案**。这种情况报 SKIP 并说明原因。
 */
{
  const holder = await mkdtemp(join(TMP, 'c4-'));
  const from = join(holder, 'src');
  // ⚠️ 目标必须在 holder **之外**：第一版把它放在 holder 里，
  //    而 POSIX 分支又把 holder 设成只读 → `mkdir(to)` 先 EACCES，
  //    整条腿在 linux/macOS 上直接崩。`[CI 实测 run 31296434416]`
  //    那是**脚本的缺陷，不是产品的**。
  const to = join(TMP, 'c4-dst-' + Date.now());
  await makeDataDir(from);

  let db = null;
  try {
    // better-sqlite3 装在 packages/db 下，从那儿解析
    const { createRequire } = await import('node:module');
    const req = createRequire(pathToFileURL(join(REPO, 'packages/db/package.json')).href);
    const Database = req('better-sqlite3');
    // `makeDataDir` 放的是个占位文本文件，SQLite 会拒绝打开（file is not a database）。
    // 删掉让 SQLite 自己建一个**真的**库 —— 这一格要的就是真实句柄。
    await rm(join(from, 'openmemo.db'), { force: true });
    db = new Database(join(from, 'openmemo.db'));
    db.exec('CREATE TABLE IF NOT EXISTS notes(uid TEXT PRIMARY KEY)');
    db.prepare('INSERT OR IGNORE INTO notes(uid) VALUES (?)').run('n1');
  } catch (e) {
    rec('C4', '删源失败分支', 'SKIP', `打不开真实 SQLite 句柄，无法复现产品情形：${e.message}`);
    db = null;
  }

  if (db !== null) {
    try {
      const r = await MV.moveDataDir(from, to, { forceCopy: true });
      const miss = missingOf(to);
      /*
       * ★ 必须把整个 `r` 传进去（含 `sourceResidue`）—— 产品的路由传的就是整个 result。
       *   只挑三个字段会让这里印出来的文案**和用户真正看到的那句不一样**：
       *   `[CI 实测 run 31298064458]` 就出现过"记录里残留 models,openmemo.db，
       *   而文案说'里面已经空了'"这种自相矛盾 —— 那是本脚本的缺陷，不是产品的。
       */
      const msg = ST.moveMessageZh(r, from);
      if (r.sourceRemoved === true) {
        rec(
          'C4',
          '删源失败分支（注入：持有真实 better-sqlite3 句柄）',
          'SKIP',
          `这个平台允许删除仍被打开的文件（POSIX unlink 语义），源真的被删掉了。\n` +
            `这一格在本平台**结构上测不到** —— 而这正是"为什么它只在 Windows 上出事"。\n` +
            `不把它算作通过 —— PROTOCOL §11。`,
        );
      } else {
        const honest = !msg.includes('已移动') && msg.includes('已复制');
        const ok = r.ok === true && miss.length === 0 && honest;
        rec(
          'C4',
          '★ 删源失败 → 目标保住且界面改口（注入：真实 SQLite 句柄）',
          ok ? 'PASS' : 'FAIL',
          `ok=${r.ok} sourceRemoved=${r.sourceRemoved} sourceIntact=${r.sourceIntact}\n` +
            `目标缺失=${miss.join(',') || '无(完整)'}\n` +
            `界面文案=${msg}\n` +
            `【记录】源目录残留=${existsSync(from) ? (await readdir(from)).join(',') : '(已不存在)'}`,
        );
      }
    } finally {
      try {
        db.close();
      } catch {}
    }
  }
  await rm(holder, { recursive: true, force: true }).catch(() => {});
  await rm(to, { recursive: true, force: true }).catch(() => {});
}

/* ── C5 目标非空 → 拒绝，源与目标里别人的东西都不许动 ── */
{
  const from = join(TMP, 'c5-from');
  const to = join(TMP, 'c5-to');
  await makeDataDir(from);
  await mkdir(to, { recursive: true });
  await writeFile(join(to, 'SOMEONE_ELSE.txt'), 'do not touch');
  const r = await MV.moveDataDir(from, to);
  const ok =
    r.ok === false && missingOf(from).length === 0 && existsSync(join(to, 'SOMEONE_ELSE.txt'));
  rec(
    'C5',
    '目标非空 → 拒绝且两边都不动',
    ok ? 'PASS' : 'FAIL',
    `ok=${r.ok} errorZh=${r.errorZh} 源完好=${missingOf(from).length === 0} 别人的文件还在=${existsSync(join(to, 'SOMEONE_ELSE.txt'))}`,
  );
}

/* ── C6 "只切换不搬"：缺省与显式 false 都不许搬 ── */
{
  const cs = [
    ['只给 path', { path: '/x' }, false],
    ['moveExisting:false', { path: '/x', moveExisting: false }, false],
    ['moveExisting:true', { path: '/x', moveExisting: true }, true],
    ['旧别名 move:false', { path: '/x', move: false }, false],
  ];
  const lines = [];
  let ok = true;
  for (const [n, body, want] of cs) {
    const p = ST.parseChangeRequest(body);
    const got = p.ok === true ? p.move : `REJECT`;
    if (!(p.ok === true && got === want)) ok = false;
    lines.push(
      `${p.ok === true && got === want ? 'OK ' : 'BAD'} ${n}: move=${String(got)} 期望=${want}`,
    );
  }
  const conflict = ST.parseChangeRequest({ path: '/x', moveExisting: false, move: true });
  if (conflict.ok !== false) ok = false;
  lines.push(`${conflict.ok === false ? 'OK ' : 'BAD'} 新旧别名冲突 → 拒绝`);
  rec('C6', '"只切换不搬"：缺省 false、显式 false 都不搬', ok ? 'PASS' : 'FAIL', lines.join('\n'));
}

/* ── C7 ★★ 产品自己的那条路 ★★ ──────────────────────────────────────────────
 *
 * C1–C6 调的是 `moveDataDir` 这个底层函数；C4 的"删不掉源"是**注入**出来的。
 * 但用户点的是**界面上那个按钮**，走的是 `createStorageRoutes` →
 * 关库 → `moveDataDir` → 重开 → 迁 media_assets → 写指针 → 重启。
 *
 * **注入式复现不算数**：修完要回答的是「生产路径上，同卷/跨卷各自到底留不留旧目录」。
 * 所以这一格开一个**真的** SQLite 库（`openAppDatabase`，产品用的同一个入口），
 * 挂上真的路由，发一个和前端逐字节相同的请求，然后去看文件系统。
 */
{
  const { createStorageRoutes } = await import(distUrl('apps/daemon/dist/http/rest/storage.js'));
  const { resolvePaths } = await import(distUrl('apps/daemon/dist/config/paths.js'));
  const { openAppDatabase } = await import(distUrl('packages/db/dist/index.js'));
  const { createServer } = await import('node:http');

  /** 起一个真路由，发真请求，返回状态码 + 响应体。 */
  async function moveViaProduct(from, to) {
    const paths = resolvePaths(from);
    // `makeDataDir` 放的是占位文本；这一格要的是**真库**，让 openAppDatabase 自己建
    await rm(paths.dbFile, { force: true });
    let db = openAppDatabase({ filename: paths.dbFile });
    const events = [];
    const restarts = [];
    const routes = createStorageRoutes({
      paths,
      db: db.db,
      runningJobs: () => 0,
      closeDatabase: () => {
        events.push('close');
        db.close();
      },
      reopenDatabase: (dir) => {
        events.push(`reopen:${dir}`);
        db = openAppDatabase({ filename: join(dir, 'openmemo.db') });
        return db.db;
      },
      requestRestart: (reason, o) => restarts.push({ reason, dataDir: o?.dataDir }),
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void routes.handle(req, res, url, req.method ?? 'GET').then((h) => {
        if (!h) {
          res.writeHead(404);
          res.end('unrouted');
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const resp = await fetch(`http://127.0.0.1:${port}/api/settings/data-dir`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: to, moveExisting: true }),
    });
    const json = await resp.json().catch(() => ({}));
    await new Promise((r) => server.close(r));
    try {
      db.close();
    } catch {}
    return { status: resp.status, json, events, restarts };
  }

  // —— C7a 同卷 ——
  {
    const from = join(TMP, 'c7a-from');
    const to = join(TMP, 'c7a-to');
    await makeDataDir(from);
    const r = await moveViaProduct(from, to);
    const srcGone = !existsSync(from);
    const miss = missingOf(to);
    const ok = r.status === 202 && srcGone && miss.length === 0;
    rec(
      'C7a',
      '★★ 生产路径·同卷：旧目录必须不留',
      ok ? 'PASS' : 'FAIL',
      `HTTP ${r.status}  moved=${r.json.moved}  strategy=${r.json.strategy}\n` +
        `关库/重开顺序=${r.events.join(' → ')}\n` +
        `旧目录还在吗=${existsSync(from) ? '还在(!!)' : '已消失'}  新位置缺失=${miss.join(',') || '无'}\n` +
        `界面文案=${r.json.messageZh ?? '(无)'}`,
    );
  }

  // —— C7b 跨卷（真 EXDEV；没有第二个卷就 SKIP）——
  {
    const vol = await secondVolumeRoot();
    if (vol === null) {
      rec(
        'C7b',
        '生产路径·跨卷',
        REQUIRE_CROSSVOL ? 'FAIL' : 'SKIP',
        '这台 runner 上没有第二个可写卷 —— 跨卷的生产路径没测到（不是通过）。',
      );
    } else {
      const from = join(TMP, 'c7b-from');
      const to = join(vol, 'prod-' + Date.now());
      await makeDataDir(from);
      const r = await moveViaProduct(from, to);
      const srcGone = !existsSync(from);
      const miss = missingOf(to);
      const ok = r.status === 202 && srcGone && miss.length === 0;
      rec(
        'C7b',
        '★★ 生产路径·跨卷（真 EXDEV）：旧目录必须不留',
        ok ? 'PASS' : 'FAIL',
        `HTTP ${r.status}  moved=${r.json.moved}  strategy=${r.json.strategy}\n` +
          `关库/重开顺序=${r.events.join(' → ')}\n` +
          `旧目录还在吗=${existsSync(from) ? '还在(!!) 残留=' + (await readdir(from)).join(',') : '已消失'}\n` +
          `新位置缺失=${miss.join(',') || '无'}\n` +
          `界面文案=${r.json.messageZh ?? '(无)'}`,
      );
      await rm(vol, { recursive: true, force: true }).catch(() => {});
    }
  }
}

await rm(TMP, { recursive: true, force: true }).catch(() => {});

/* ── 汇总：SKIP 单列，绝不混进 PASS ── */
console.log('\n================ 汇总 ================');
for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.id}  ${r.name}`);
const fail = results.filter((r) => r.status === 'FAIL');
const skip = results.filter((r) => r.status === 'SKIP');
console.log(
  `\n平台=${platform()}  PASS=${results.filter((r) => r.status === 'PASS').length}  FAIL=${fail.length}  SKIP=${skip.length}`,
);
if (skip.length > 0) {
  console.log(`\n⚠️ 有 ${skip.length} 格没测到（不是通过）：`);
  for (const s of skip) console.log(`   - ${s.id} ${s.name}`);
}
process.exit(fail.length > 0 ? 1 : 0);
