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
 * ## 🔴 2026-09-06：这条判据此前**只有一格在验，而那一格已经坏了一个月**
 *
 * 复核发现两件事，都不是产品的毛病，是**这个脚本自己的**：
 *
 * 1. **C4 的 `honest` 恒为 false ⇒ 那一格无条件 FAIL。**
 *    判据读的是 `Array.isArray(r.sourceResidue)`，而产品在 `f21ca78`(#87) 把
 *    `SourceResidue` 改成了三态标签联合。`e2e-datadir` 最后一次运行在那之前
 *    （08-09），且只能手动触发 —— 于是没有任何人知道。
 *    判据本体已抽到 `datadir-migrate-assertions.mjs`，那次事故由
 *    `selftest-datadir-residue.mjs` 当夹具重放，**跑在推送门禁上**。
 *
 * 2. **上面那条判据，八格里只有 C4 在验；而 C4 在 POSIX 上结构上必然 SKIP。**
 *    也就是说 **linux 与 macOS 两条腿对它的断言次数是 0** —— 它们验的是
 *    "数据搬对了"，不是"界面说了真话"。C7a/C7b 把 `messageZh` 只打印不判。
 *
 * 现在：C4 按三态各自判（`unreadable` **不判红** —— 「我不知道」不是缺陷）；
 * C7a/C7b 用 `messageMatchesDisk()` **拿磁盘实况现算一句应该说的话**，
 * 要求上屏那句等于它（不比措辞，改文案不假红）。搬完还要**读回库里的一行**，
 * 并核对重启请求指向新目录。`secrets.json` 与两条符号链接也进了必查名单
 * —— 此前它们被造出来，却从来没有被任何一条判据看过。
 *
 * ## §11：跳过不许渲染成成功
 *
 * 跨卷那格在某些 runner 上确实做不到（没有第二个卷）。做不到就**明确报 SKIP
 * 并在汇总里单列**，而不是悄悄不跑然后一片绿。`--require-crossvol` 可以把
 * "跳过"升级成失败，供以后 runner 具备条件时钉死。
 */
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { judgeResidueHonesty } from './datadir-migrate-assertions.mjs';

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

/*
 * ── C4 的判据本体已经抽到 `datadir-migrate-assertions.mjs` ────────────────────
 *
 * ★ 抽出去的理由不是"分文件好看"，是**这个文件顶层执行 + `process.exit()`，
 *   import 不进来 ⇒ 没有任何东西能喂它一份"本该判红"的输入**。
 *   而这条判据**已经因为这件事吃过一次亏**：`2676e90`(08-10) 写成读数组、
 *   `f21ca78`(#87, 08-11) 把产品类型改成三态标签联合、这里没跟着改 ⇒
 *   `Array.isArray(对象)` 恒 false ⇒ **C4 无条件 FAIL 了整整一个月**，
 *   而 `e2e-datadir` 最后一次运行在断裂之前（08-09）且只能手动触发，没人知道。
 *
 *   现在那次事故被 `selftest-datadir-residue.mjs` **当夹具重放**，跑在推送门禁上。
 */

/*
 * 这台机器/这个权限下建不建得成符号链接。`null` = 还没试过。
 * Windows 非管理员建不成 —— 那时链接相关的判据整体不适用，不许假装验过。
 */
let LINKS_SUPPORTED = null;

/* ── 造一个数据齐全的数据目录（含两级符号链接） ── */
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
    LINKS_SUPPORTED = true;
  } catch (e) {
    LINKS_SUPPORTED = false;
    console.log(`        (符号链接未建成: ${e.code} —— 该平台/权限下不支持，链接相关断言将不覆盖)`);
  }
  await writeFile(join(root, 'runtime', 'runtime.json'), '{"installed":[]}');
}

/*
 * ── 搬完之后**必须逐个还在**的东西 ────────────────────────────────────────────
 *
 * ⚠️ `secrets.json` 是 2026-08-08 那次事故的主角（明文 API Key 被**复制**了一份
 *    留在旧目录），本文件头三次拿它当这条腿存在的理由 —— 而在此之前它
 *    **从来没有出现在任何一条判据里**。造它、却不查它。补上。
 *
 * ⚠️ 两条符号链接同样补上（T-128：`fs.cp` 不带 `verbatimSymlinks` 会把它们
 *    解析成指向**旧目录**的绝对路径，删源之后全部悬空，whisper 后端加载不了；
 *    用户身上真实发生过）。`existsSync` **跟随**链接，所以悬空链接在这里
 *    必然判红 —— 正是要的那个行为。
 *    建不成链接的平台（Windows 非管理员）自动不查，见 `LINKS_SUPPORTED`。
 */
const MUST_HAVE = [
  ['数据库', 'openmemo.db'],
  ['密钥', 'secrets.json'],
  ['媒体', 'media/a.mp3'],
  ['模型', 'models/by-name/backend/ggml.bin'],
  ['组件', 'bin/ext/libwhisper.so.1.9.1'],
  ['运行时', 'runtime/runtime.json'],
];
const LINK_ENTRIES = [
  ['组件链接·一级', 'bin/ext/libwhisper.so.1'],
  ['组件链接·顶层', 'bin/ext/libwhisper.so'],
];
const checkList = () => (LINKS_SUPPORTED ? [...MUST_HAVE, ...LINK_ENTRIES] : MUST_HAVE);
const missingOf = (root) =>
  checkList()
    .filter(([, r]) => !existsSync(join(root, r)))
    .map(([l]) => l);

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
        /*
         * ★ 传**整个** `r`（含 `sourceResidue`）—— 产品的路由传的就是整个 result。
         *   只挑三个字段会让这里印出来的文案和用户真正看到的那句**不一样**：
         *   少了 `sourceResidue` 就会渲染成「这一版没有报告里面还剩什么」，
         *   一句产品**永远不会**发给用户的话。C4 已经为同一个坑修过一次
         *   （`[CI 实测 run 31298064458]`），这一格当时漏了。
         */
        `界面文案=${ST.moveMessageZh(r, from)}`,
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

  /** 真实 SQLite 句柄；打不开就保持 null，由下面报 SKIP。 */
  let db;
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
    db = undefined;
  }

  if (db !== undefined) {
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
        /*
         * ★ 2026-08-10：不再读措辞，改为核对**数据**。
         *
         * 旧判据 `!msg.includes('已移动') && msg.includes('已复制')` 有两个方向都坏：
         *   · 产品改说「已搬迁」→ 第一项放行；改说「拷贝完成」→ 第二项**红**（假红）。
         *   · 也就是说它**同时**惩罚好文案、又放过换了说法的假话。
         * `[实测 A/B]` 事故数据（源还在、文案「已搬迁 N 个文件到新位置」）：
         *     旧判据 → !includes('已移动')=true，但 includes('已复制')=false → 红（**理由是错的**）
         *     换成「拷贝完成，旧目录仍在，里面还剩下：models、openmemo.db」：
         *     旧判据 → 红（假红，这是一句诚实的话）；新判据 → 绿
         *
         * 判据：源没删干净时，**剩下的东西必须被逐个念出来**。
         * 文件名是数据不是措辞 —— 句子怎么重写它们都得在，否则用户不知道去哪儿找。
         *
         * ★★ 2026-09-06：上面那条判据本身**断了整整一个月**（`sourceResidue` 早已不是
         *    数组，`Array.isArray` 恒 false ⇒ 恒 FAIL）。判据本体现在住在
         *    `datadir-migrate-assertions.mjs`，那次事故由
         *    `selftest-datadir-residue.mjs` 当夹具重放，跑在**推送门禁**上
         *    —— 这一格再断，不用等谁手动触发 e2e-datadir 才发现。
         */
        const onDisk = existsSync(from) ? (await readdir(from)).sort() : [];
        const {
          kind: residueKind,
          honest,
          why,
        } = judgeResidueHonesty({
          residue: r.sourceResidue,
          msg,
          onDisk,
          // 产品自己的格式化函数留在调用方 —— 判据模块不许 import 产品代码
          renderAsIfEmpty: () =>
            ST.moveMessageZh({ ...r, sourceResidue: { kind: 'read', entries: [] } }, from),
        });
        const ok = r.ok === true && miss.length === 0 && honest;
        rec(
          'C4',
          '★ 删源失败 → 目标保住且界面改口（注入：真实 SQLite 句柄）',
          ok ? 'PASS' : 'FAIL',
          `ok=${r.ok} sourceRemoved=${r.sourceRemoved} sourceIntact=${r.sourceIntact}\n` +
            `目标缺失=${miss.join(',') || '无(完整)'}\n` +
            `界面文案=${msg}\n` +
            `残留三态=${residueKind}\n` +
            why,
        );
      }
    } finally {
      try {
        db.close();
      } catch {
        /* 已经关掉了就没别的可做 */
      }
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
    /*
     * ★ 往真库里写一行，搬完再读回来。
     *
     *   在此之前 C7 全程**没写过一行、没读过一行** —— 于是「搬完之后库还能打开、
     *   用户的笔记还在」这件事一次都没被验过，验的只是"那个文件名还在"。
     *   而 C7 走的正是**关库 → 搬 → 重开**这条真路径（`f91ac5c` 就是修这一步的），
     *   库坏在这里正是它最该抓的事。0 字节的 `openmemo.db` 也能让文件名检查全绿。
     *
     *   用自己的表，不依赖产品 schema —— schema 改了不该让这条腿假红。
     */
    db.db.exec('CREATE TABLE IF NOT EXISTS om_audit_probe(uid TEXT PRIMARY KEY)');
    db.db.prepare('INSERT OR IGNORE INTO om_audit_probe(uid) VALUES (?)').run('probe-1');
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
    /*
     * ★ `requestRestart` 是路由用 `setTimeout(…, 50)` 发的（`storage.ts:706`）——
     *   响应一到手就去读 `restarts` **必然是空的**。等一下再读，
     *   否则下面那条「重启必须指向新目录」的判据只会假红。
     *   （这也是它此前只被收集、从没被判过的原因之一。）
     */
    await new Promise((r) => setTimeout(r, 400));
    /* 搬完之后：库必须能在**新位置**打开，而且刚才写的那一行还在。 */
    let rows;
    try {
      rows = db.db
        .prepare('SELECT uid FROM om_audit_probe')
        .all()
        .map((x) => x.uid);
    } catch (e) {
      rows = `读不回来：${e.message}`;
    }
    await new Promise((r) => server.close(r));
    try {
      db.close();
    } catch {
      /* 已经关掉了就没别的可做 */
    }
    return { status: resp.status, json, events, restarts, rows };
  }

  /*
   * ── 这一格自称的判据，此前 linux/macOS 一次都没验过 ──────────────────────────
   *
   * 本文件头 `:17-19` 写着判据是「**界面说的和实际发生的必须一致**」。
   * 而八格里**只有 C4 在验它** —— C4 又在 POSIX 上结构性 SKIP（unlink 语义）。
   * 也就是说：**linux 与 macOS 两条腿，对这条自称判据的断言次数是 0。**
   * 它们验的是"数据搬对了"，不是"界面说了真话"。C7 此前把 `messageZh` 只打印不判。
   *
   * 判据怎么写才不变成钉措辞：**拿磁盘实况现算一句应该说的话，要求上屏那句等于它。**
   * 用的是产品自己的 `moveMessageZh`，所以句子怎么重写都不会假红；
   * 而「源还在却说已移动」这种 08-08 事故形态**必然**被抓住 —— 那正是要守的东西。
   */
  async function messageMatchesDisk(json, from) {
    const gone = !existsSync(from);
    let onDisk = [];
    if (!gone) {
      try {
        onDisk = (await readdir(from)).sort();
      } catch (e) {
        return { ok: null, why: `旧目录还在但读不到（${e.message}）—— 本判据这一轮取不到实况` };
      }
    }
    const truth = {
      files: json.files,
      links: json.links,
      // ★ 这两项取**磁盘实况**，不取产品自己的说法 —— 否则就是拿它的话验它的话。
      sourceRemoved: gone,
      sourceResidue: { kind: 'read', entries: onDisk },
    };
    const expected = ST.moveMessageZh(truth, from);
    const actual = String(json.messageZh ?? '');
    return {
      ok: actual === expected,
      why:
        `旧目录实况=${gone ? '已消失' : `还在，里面有：${onDisk.join('、') || '(空)'}`}\n` +
        `按实况**应该**说：${expected}\n` +
        `实际上屏说的是：${actual}`,
    };
  }

  // —— C7a 同卷 ——
  {
    const from = join(TMP, 'c7a-from');
    const to = join(TMP, 'c7a-to');
    await makeDataDir(from);
    const r = await moveViaProduct(from, to);
    const srcGone = !existsSync(from);
    const miss = missingOf(to);
    const say = await messageMatchesDisk(r.json, from);
    const dbOk = Array.isArray(r.rows) && r.rows.includes('probe-1');
    const restartedTo = r.restarts.some(
      (x) => x.dataDir !== undefined && resolvePath(x.dataDir) === resolvePath(to),
    );
    const ok =
      r.status === 202 && srcGone && miss.length === 0 && say.ok === true && dbOk && restartedTo;
    rec(
      'C7a',
      '★★ 生产路径·同卷：旧目录必须不留、库要还能读、界面要说真话',
      ok ? 'PASS' : 'FAIL',
      `HTTP ${r.status}  moved=${r.json.moved}  strategy=${r.json.strategy}\n` +
        `关库/重开顺序=${r.events.join(' → ')}\n` +
        `旧目录还在吗=${existsSync(from) ? '还在(!!)' : '已消失'}  新位置缺失=${miss.join(',') || '无'}\n` +
        `搬完读回库=${Array.isArray(r.rows) ? `[${r.rows.join(',')}]${dbOk ? ' 那一行还在' : ' **写进去的行不见了**'}` : r.rows}\n` +
        `重启请求=${JSON.stringify(r.restarts)}${restartedTo ? '' : ' **没有一条指向新目录**'}\n` +
        `界面文案诚实吗=${say.ok === null ? '本轮取不到实况' : say.ok ? '是' : '**否**'}\n` +
        say.why,
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
      const say = await messageMatchesDisk(r.json, from);
      const dbOk = Array.isArray(r.rows) && r.rows.includes('probe-1');
      const restartedTo = r.restarts.some(
        (x) => x.dataDir !== undefined && resolvePath(x.dataDir) === resolvePath(to),
      );
      const ok =
        r.status === 202 && srcGone && miss.length === 0 && say.ok === true && dbOk && restartedTo;
      rec(
        'C7b',
        '★★ 生产路径·跨卷（真 EXDEV）：旧目录必须不留、库要还能读、界面要说真话',
        ok ? 'PASS' : 'FAIL',
        `HTTP ${r.status}  moved=${r.json.moved}  strategy=${r.json.strategy}\n` +
          `关库/重开顺序=${r.events.join(' → ')}\n` +
          `旧目录还在吗=${existsSync(from) ? '还在(!!) 残留=' + (await readdir(from)).join(',') : '已消失'}\n` +
          `新位置缺失=${miss.join(',') || '无'}\n` +
          `搬完读回库=${Array.isArray(r.rows) ? `[${r.rows.join(',')}]${dbOk ? ' 那一行还在' : ' **写进去的行不见了**'}` : r.rows}\n` +
          `重启请求=${JSON.stringify(r.restarts)}${restartedTo ? '' : ' **没有一条指向新目录**'}\n` +
          `界面文案诚实吗=${say.ok === null ? '本轮取不到实况' : say.ok ? '是' : '**否**'}\n` +
          say.why,
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
