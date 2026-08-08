#!/usr/bin/env node
/**
 * 模拟用户动作：**从浏览器下载 → 按系统默认方式解压 → 双击 → 能不能看到界面。**
 *
 * ## 为什么需要它（它与 verify-bundle.sh / cold-start-audit 的区别）
 *
 * 已有的两条腿跑的都是 `start.sh --port … --data-dir …`：
 * **从一个已经存在的 shell 里、带着参数、由脚本驱动**。
 * 它们证明的是「这个包能被脚本跑起来」，**不是「人能不能双击打开它」**。
 *
 * 2026-08-08 用户在真机上撞到的三件事，那两条腿一件都测不到：
 *   · Windows 双击 `.cmd` 出错，窗口一闪就关，**用户连错误信息都看不到**
 *   · macOS 被 Gatekeeper 拦住，**没有任何窗口打开**
 *   · 控制台里只有一个裸 URL，**没有一句人能照着做的话**
 *
 * 差别在于**入口**：脚本驱动的入口带着参数、继承着环境、错误落在 CI 日志里；
 * 双击的入口没有参数、没有环境、错误落在一个一秒后就消失的窗口里。
 *
 * ## 两种模式
 *
 *   --mode diagnose  尽量多地把**事实**打出来，永远 exit 0。用于复现与取证。
 *   --mode guard     把已经定案的性质变成断言，任一条不成立 exit 1。用于长期守护。
 *
 * `diagnose` 不是 `guard` 的弱化版 —— 它回答的是「现在到底发生了什么」，
 * 而 `guard` 回答「已经定案的那几条还成立吗」。**先有前者才写得出后者。**
 *
 * ## ⚠️ 哪些是"模拟"而不是"实测"（本文件里逐处标注，不许含糊）
 *
 * 无头 runner 上**没有浏览器、没有 Finder、没有 Explorer 的交互会话**。
 * 所以「浏览器给下载文件打标记」这一步是我们**手工写入同一个标记**来模拟的。
 * 标记本身（Windows 的 `Zone.Identifier` ADS / macOS 的 `com.apple.quarantine` xattr）
 * 是真的，**打标记的那个动作**是模拟的。凡是模拟出来的，输出里一律带 `[模拟]`。
 * 由此往下的一切（传播、拦截、报错原文）都是**真实测**，带 `[实测]`。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

/* ── 参数 ──────────────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
function arg(name, def = undefined) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const MODE = arg('--mode', 'diagnose');
const ARCHIVE_DIR = resolve(arg('--archive-dir', 'dl'));
const EXPLICIT_ARCHIVE = arg('--archive', null);
/** 双击路径**不带参数**，所以端口只能是产品的默认值。这一点本身就是被测性质之一。 */
const DEFAULT_PORT = 17650;

const failures = [];
const notes = [];
function fail(msg) {
  failures.push(msg);
  console.log(`   ✘ ${msg}`);
}
function ok(msg) {
  console.log(`   ✔ ${msg}`);
}
function info(msg) {
  console.log(`     ${msg}`);
}
/**
 * **已知事实，不是回归。**
 *
 * 有些结论是真的、也是坏的，但**修它需要用户本人拍板**（例如清除 Gatekeeper
 * 隔离属性属于 Security Weaken）。把这类事实写成 `fail()` 会让 build-bundles
 * 永远红着 —— 而一条永远红的门禁等于没有门禁：人会开始忽略它，
 * 于是它再也挡不住**真正的**回归。
 *
 * 所以它们走这条通道：**照样打印、照样刺眼，但不判定失败。**
 * 判据与 `check-bundle-macos-floors.mjs` 那次分层是同一条：
 * 已知事实不该每次都伪装成新问题。
 */
function known(msg) {
  notes.push(msg);
  console.log(`   ⚠️ [已知事实·待用户裁决] ${msg}`);
}
function hdr(t) {
  console.log(`\n══════ ${t} ══════`);
}

/**
 * 跑一条命令。
 *
 * ⚠️ **一律带超时。** `[CI 实测 run 31246584116]` macOS 腿卡到 30 分钟超时。
 *
 * ★ 我一开始归因给了 `log show`（扫日志归档，确实慢）。**那个归因是错的。**
 *   翻日志才看到：最后一条跑完的是"直接执行带 quarantine 的 node"，
 *   卡住的是**下一条** —— `sh -c '"OpenMemo.command" --version | head -20'`。
 *   `--version` 不是提前退出的旗标，于是它**真的把 daemon 起起来了**，
 *   daemon 长驻不退、`head -20` 又永远等不到第 20 行，管道就再也不关。
 *
 * > 两条教训，第二条更贵：
 * > ① **最贵的测量不该排在无上限的步骤后面**（所以关键测量已前移）；
 * > ② **"我猜是哪一条慢"和"日志里最后一条是什么"是两回事** ——
 * >    我差点把一个错误归因写进文档，而那正是本轮在修的那类东西。
 *
 * 那条 `--version` 已删（它对结论没有贡献，却会起一个 daemon）。
 */
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    ...opts,
  });
  return {
    code: r.status,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
    error: r.error,
  };
}
/** 打印一条命令的**完整原始输出** —— 复现阶段最贵的东西就是原话。 */
function dump(label, r) {
  console.log(`   $ ${label}`);
  console.log(`     exit=${r.code}${r.error ? ` error=${r.error.message}` : ''}`);
  if (r.stdout) console.log(r.stdout.replace(/^/gm, '     | '));
  if (r.stderr) console.log(r.stderr.replace(/^/gm, '     ! '));
}

function findArchive(patternExts) {
  if (EXPLICIT_ARCHIVE) return resolve(EXPLICIT_ARCHIVE);
  if (!existsSync(ARCHIVE_DIR)) return null;
  const hit = readdirSync(ARCHIVE_DIR).find(
    (f) => f.startsWith('openmemo-') && patternExts.some((e) => f.endsWith(e)),
  );
  return hit ? join(ARCHIVE_DIR, hit) : null;
}

/**
 * 共用断言：**用户在窗口里读到的那段文字**，本身就是被测对象。
 *
 * 这三条都是 2026-08-08 用户实测报回来的，逐条对应一次真实的误解：
 *   · 鉴权关着却打 token → 「怎么还有 token？不是早都删除了吗」
 *   · 只有一个裸 URL     → 双击进来的人不知道该干什么
 *   · 报错文本混进来      → 「双击运行提示出错」
 */
function assertBannerIsHumanReadable(out) {
  if (!out) return;
  /*
   * `OPENMEMO_AUTH` 默认是 `none`，此时那串 token **不承担任何作用**，
   * 出现在最显眼的位置只会让人以为还要过一道验证。
   */
  if (out.includes('#t='))
    fail('启动横幅里仍然带 `#t=<token>` —— 而默认鉴权是 none，这串东西不起任何作用');
  else ok('启动横幅不含 token（鉴权关闭时不该出现）');

  if (/浏览器/.test(out)) ok('横幅里有一句人能照着做的话（提到"浏览器"）');
  else fail('横幅里只有一个裸 URL，没有一句告诉用户该做什么的话');

  if (/is not recognized as an internal or external command/i.test(out))
    fail('输出里混进了 cmd.exe 的报错 —— 用户会读成"双击运行提示出错"');
}

/** 包根目录必须有一份**不需要执行任何东西就能读到**的说明。 */
function assertReadMeFirst(root) {
  if (existsSync(join(root, 'READ-ME-FIRST.txt')))
    ok('包内有 READ-ME-FIRST.txt（Gatekeeper 拦住时用户唯一读得到的东西）');
  else
    fail(
      '包内没有 READ-ME-FIRST.txt —— macOS 上 Gatekeeper 拦住 .command 时，' +
        '写在脚本里的解法用户一个字也看不到（v0.2.0 正是如此）',
    );
}

/* ── 共用：启动器跑起来之后，界面到底在不在 ──────────────────────────────────────
 *
 * 判据是「人能不能看到 OpenMemo 的界面」，所以这里问的是 **HTTP 根路径返回了什么**，
 * 而不是「进程还活着吗」。进程活着但网页是白页，用户看到的仍然是"打不开"。
 */
function httpGet(port, path, timeoutMs = 3000) {
  return new Promise((resolvePromise) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () =>
        resolvePromise({ status: res.statusCode, body: body.slice(0, 400), headers: res.headers }),
      );
    });
    req.on('timeout', () => {
      req.destroy();
      resolvePromise({ status: 0, body: 'TIMEOUT' });
    });
    req.on('error', (e) => resolvePromise({ status: 0, body: `ERR ${e.code ?? e.message}` }));
  });
}

async function waitForUi(port, seconds = 90) {
  for (let i = 0; i < seconds; i++) {
    const r = await httpGet(port, '/');
    if (r.status && r.status !== 0) return r;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  return { status: 0, body: 'never came up' };
}

/**
 * 跑一次"双击等价"的启动，收集**用户会看到的那些字节**（stdout+stderr 合并，
 * 因为控制台窗口里两者是混在一起的），然后探测界面。
 */
async function runLauncher({
  label,
  cmd,
  args,
  cwd,
  env,
  port = DEFAULT_PORT,
  waitSec = 90,
  verbatim = false,
}) {
  console.log(`   ▶ ${label}`);
  console.log(`     spawn: ${cmd} ${args.map((a) => JSON.stringify(a)).join(' ')}`);
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    /*
     * ⚠️ Windows 上**必须**用 verbatim。
     * `[CI 实测 run 31245628148]` 第一版没用，Node 自己的 Windows 引号规则把
     * `cmd.exe /c "…start.cmd"` 改写成了别的东西，结果拿到的是
     *   '"C:\…\start.cmd"' is not recognized as an internal or external command
     * —— 那是**我这条命令写错了**，不是 start.cmd 的错。
     * 这正是 ADR-003 §7.2 那条"没有对照组的阴性结果等于没测"的同一族陷阱：
     * 一个自己写坏的探针，会伪装成被测对象的缺陷。
     */
    windowsVerbatimArguments: verbatim,
  });
  let out = '';
  let exited = null;
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  child.on('exit', (code, sig) => (exited = { code, sig }));

  const ui = await waitForUi(port, waitSec);
  const health = ui.status ? await httpGet(port, '/api/health') : { status: 0, body: '-' };

  /*
   * 收尾：**只杀我们自己 spawn 的那棵进程树**（按 pid，不许 pkill -f，见 PROTOCOL）。
   *
   * Windows 上 `child.kill()` 只杀 cmd.exe，**杀不掉它下面的 node.exe** ——
   * 留下来的 node 会一直占着 17650，于是下一轮测量拿到的是"单实例锁"，
   * 而那会被误读成"启动失败"。`taskkill /T` 按 pid 收整棵树，仍然不是模式匹配。
   */
  try {
    if (exited === null) {
      if (process.platform === 'win32') {
        sh('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      } else {
        child.kill('SIGTERM');
      }
    }
  } catch {
    /* 已经退了 */
  }
  await new Promise((r) => setTimeout(r, 2500));
  try {
    if (exited === null) child.kill('SIGKILL');
  } catch {
    /* ignore */
  }

  console.log(`     ── 用户在窗口里会看到的全部输出（原文）──`);
  console.log(out.trim() ? out.trim().replace(/^/gm, '     > ') : '     > (空)');
  console.log(`     ── 结束 ──`);
  console.log(
    `     进程: ${exited ? `已退出 code=${exited.code} sig=${exited.sig}` : '仍在运行'} · ` +
      `界面 GET / => ${ui.status || 'unreachable'} · health => ${health.status || '-'}`,
  );
  return { out, exited, ui, health };
}

/* ════════════════════════════════════════════════════════════════════════════════
 * Windows
 * ════════════════════════════════════════════════════════════════════════════════ */
async function windows() {
  const zip = findArchive(['.zip']);
  if (!zip) {
    fail('找不到 win-x64 的 .zip');
    return;
  }
  hdr('① 下载标记 Mark-of-the-Web');
  /*
   * [模拟] 浏览器下载完文件后，由 Attachment Execution Service 写入这个 ADS。
   * runner 上没有浏览器，所以**我们自己写同一个流**。ZoneId=3 = Internet，
   * 这正是浏览器给互联网下载物打的值。
   */
  const ads = `${zip}:Zone.Identifier`;
  writeFileSync(
    ads,
    '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://github.com/\r\nHostUrl=https://objects.githubusercontent.com/\r\n',
  );
  info(`[模拟] 已写入 ${basename(zip)}:Zone.Identifier （ZoneId=3 = 互联网区域）`);
  try {
    info(`[实测] 回读该流: ${JSON.stringify(readFileSync(ads, 'utf8'))}`);
  } catch (e) {
    fail(`回读 Zone.Identifier 失败: ${e.message} —— 说明这台机器的 ADS 探针不可信`);
  }

  hdr('② 解压：走 Explorer「全部解压缩」自己那条代码路径');
  /*
   * 用户不会用 tar/7z，他会右键「全部解压缩」。那条路径是 Shell.Application COM
   * （`CopyHere`），**和命令行解压不是同一个实现** —— 关键区别正是它会不会把
   * Mark-of-the-Web 传播给解出来的文件。
   */
  const dest = join(process.env['USERPROFILE'] ?? tmpdir(), 'Downloads', 'omsim');
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const ps = `
$ErrorActionPreference='Stop'
$shell = New-Object -ComObject Shell.Application
$src = $shell.NameSpace('${zip.replace(/'/g, "''")}')
$dst = $shell.NameSpace('${dest.replace(/'/g, "''")}')
# 16 = "Yes to All"，等价于用户在解压对话框里一路点确定
$dst.CopyHere($src.Items(), 16)
# CopyHere 是异步的：等它把东西铺完
$deadline = (Get-Date).AddMinutes(8)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  $n = (Get-ChildItem -Recurse -Force '${dest.replace(/'/g, "''")}' | Measure-Object).Count
  Start-Sleep -Seconds 3
  $m = (Get-ChildItem -Recurse -Force '${dest.replace(/'/g, "''")}' | Measure-Object).Count
  if ($n -eq $m -and $n -gt 100) { break }
}
Write-Output "extracted_items=$((Get-ChildItem -Recurse -Force '${dest.replace(/'/g, "''")}' | Measure-Object).Count)"
`;
  dump(
    'Shell.Application CopyHere（= 右键「全部解压缩」）',
    sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]),
  );

  const roots = existsSync(dest) ? readdirSync(dest) : [];
  info(`解压后顶层: ${JSON.stringify(roots)}`);
  const root = roots.length === 1 ? join(dest, roots[0]) : dest;
  const launcher = join(root, 'start.cmd');
  const nodeExe = join(root, 'runtime', 'node.exe');
  info(`start.cmd 存在: ${existsSync(launcher)} · runtime\\node.exe 存在: ${existsSync(nodeExe)}`);

  hdr('③ Mark-of-the-Web 有没有传播给解出来的文件');
  for (const f of [launcher, nodeExe]) {
    if (!existsSync(f)) continue;
    try {
      const v = readFileSync(`${f}:Zone.Identifier`, 'utf8');
      info(`[实测] ${basename(f)} **带** MOTW: ${JSON.stringify(v)}`);
    } catch (e) {
      info(`[实测] ${basename(f)} 没有 MOTW（${e.code}）`);
    }
  }

  hdr('④ 双击 .cmd 时 Windows 实际执行的是什么');
  dump('cmd /c assoc .cmd', sh('cmd', ['/c', 'assoc', '.cmd']));
  dump('cmd /c ftype cmdfile', sh('cmd', ['/c', 'ftype', 'cmdfile']));
  dump('chcp（本机当前 OEM 代码页）', sh('cmd', ['/c', 'chcp']));

  hdr('⑤ start.cmd 在真实代码页下被 cmd.exe 怎么解析');
  if (existsSync(launcher)) {
    const raw = readFileSync(launcher);
    info(
      `字节数 ${raw.length} · BOM=${raw.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))} · CRLF=${(raw.toString('latin1').match(/\r\n/g) ?? []).length} · LF=${(raw.toString('latin1').match(/\n/g) ?? []).length}`,
    );
    // 只把**可执行行**（非 rem/空行）里的非 ASCII 字节挑出来 —— 那才是会炸的东西
    const lines = raw.toString('latin1').split('\n');
    let high = 0;
    lines.forEach((l, i) => {
      const isComment = /^\s*(rem\b|::)/i.test(l);
      const n = [...l].filter((c) => c.charCodeAt(0) >= 0x80).length;
      high += n;
      if (n > 0) {
        info(`  L${i + 1} 非ASCII字节=${n} ${isComment ? '（rem 注释行）' : '★（可执行行！）'}`);
      }
    });
    /*
     * ★★ 这一条是本轮最重要的断言。
     *
     * `[CI 实测 run 31246584116]` v0.2.0 的 start.cmd 在**代码页 936**（中文 Windows）
     * 下双击，用户看到的第一行是：
     *     'm' is not recognized as an internal or external command,
     * 而在 437 下没有 —— **代码页是唯一变量**。
     *
     * 成因不是"换行被吞"（GBK 的 trail byte 是 0x40–0xFE，0x0A 不可能被吞），
     * 而是 GBK 解码器在中文 rem 注释里**错位配对**，把 `rem` 的 `r`/`e` 吃掉，
     * 剩下一个 `m` 漏出来当命令执行。
     *
     * 判据因此不是"注释行里的中文无所谓"，而是 **.cmd 文件必须整体纯 ASCII**。
     */
    if (high === 0) ok('start.cmd 纯 ASCII —— 任何 OEM 代码页都不会把它解坏');
    else
      fail(
        `start.cmd 含 ${high} 个非 ASCII 字节。cmd.exe 按 OEM 代码页解析 .cmd，` +
          `cp936 下会错位配对并漏出命令片段（实测："'m' is not recognized…"）`,
      );
  }

  hdr('⑥ 双击等价路径：cmd /c "<path>\\start.cmd"，分别在 437 与 936 代码页下');
  /*
   * 双击的真实形态是 `cmdfile="%1" %*`（④ 实测），也就是**直接执行该文件**。
   * 要同时控制代码页，最干净的办法是生成一个 wrapper .bat：
   *   chcp <cp> ; call "<launcher>"
   * 这样就不必把引号嵌进 `cmd /c "…"`（第一版正是栽在那里）。
   */
  for (const cp of ['437', '936']) {
    const wrapper = join(root, `__sim_cp${cp}.bat`);
    writeFileSync(wrapper, `@echo off\r\nchcp ${cp} >nul\r\ncall "${launcher}"\r\n`, 'latin1');
    const r = await runLauncher({
      label: `代码页 ${cp} 下双击 start.cmd（经 wrapper 设代码页）`,
      cmd: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${wrapper}"`],
      verbatim: true,
      cwd: root,
      waitSec: 100,
    });
    if (r.ui.status === 200) ok(`代码页 ${cp}: 界面可达 (HTTP 200)`);
    else fail(`代码页 ${cp}: 界面不可达 (${r.ui.body})`);
    assertBannerIsHumanReadable(r.out);
  }
  assertReadMeFirst(root);

  hdr('⑦ 结尾有没有 pause —— 出错时窗口会不会一闪就关');
  if (existsSync(launcher)) {
    const txt = readFileSync(launcher, 'utf8');
    if (/\bpause\b/i.test(txt)) ok('有 pause：出错信息会停在屏幕上');
    else
      fail(
        '结尾没有 pause：双击时一旦出错，控制台窗口随进程退出而关闭，**用户连错误信息都读不到**',
      );
  }
}

/* ════════════════════════════════════════════════════════════════════════════════
 * macOS
 * ════════════════════════════════════════════════════════════════════════════════ */
async function macos() {
  const tgz = findArchive(['.tar.gz']);
  if (!tgz) {
    fail('找不到 darwin-arm64 的 .tar.gz');
    return;
  }

  hdr('① quarantine 探针的阴性 / 阳性对照（ADR-003 §7.2 要求，缺了结论无效）');
  /*
   * ⚠️ 对照是**必需的**：`xattr -p` 在"这台机器压根不打 quarantine"和
   * "这个文件没被打"两种情况下输出一样。没有对照组的阴性结果等于没测。
   */
  const neg = sh('xattr', ['-p', 'com.apple.quarantine', tgz]);
  dump(`阴性对照 · gh/curl 下载的归档（预期：没有该属性）`, neg);
  if (neg.code === 0) {
    info('[实测] ⚠️ 命令行下载的文件**竟然带** quarantine —— 与预期相反，需重新解释下面全部结论');
  } else {
    info('[实测] 命令行下载不打 quarantine（符合预期）');
  }

  const probe = join(tmpdir(), 'om-quarantine-probe.bin');
  writeFileSync(probe, 'probe');
  const stamp = Math.floor(Date.now() / 1000).toString(16);
  const uuid = sh('uuidgen', []).stdout || '00000000-0000-0000-0000-000000000000';
  sh('xattr', ['-w', 'com.apple.quarantine', `0083;${stamp};Safari;${uuid}`, probe]);
  const pos = sh('xattr', ['-p', 'com.apple.quarantine', probe]);
  dump('阳性对照 · 手工打上 quarantine 后回读（预期：读得到）', pos);
  if (pos.code === 0) ok('探针有效：这台机器上 quarantine 属性写得进、读得出');
  else fail('探针失效：连我们自己写进去的 quarantine 都读不到 —— 下面的阴性结果全部无意义');

  hdr('② 路径①：浏览器下载 + 解压，quarantine 会不会传播给解出来的文件');
  /*
   * [模拟] 浏览器那一步：runner 上没有 Safari/Chrome，所以我们**手工给归档打上**
   * 浏览器会打的那个属性（`0083;<time>;Safari;<uuid>`）。属性是真的，动作是模拟的。
   * [实测] 从这里往下 —— 解压器传不传播、Gatekeeper 拦不拦 —— 全部是真实测。
   */
  sh('xattr', ['-w', 'com.apple.quarantine', `0083;${stamp};Safari;${uuid}`, tgz]);
  const q = sh('xattr', ['-p', 'com.apple.quarantine', tgz]);
  info(`[模拟] 归档已打上 quarantine: ${q.stdout || '(写入失败)'}`);

  const base = join(tmpdir(), 'om-launch-sim');
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });

  /** 三种解压方式：命令行 tar / ditto / 访达双击用的 Archive Utility。 */
  const ways = [
    {
      id: 'tar',
      label: '命令行 tar xzf（用户照 README 敲的那条）',
      run: (d) => sh('tar', ['xzf', tgz, '-C', d]),
    },
    {
      id: 'ditto',
      label: 'ditto -x（Apple 自己的解压库）',
      run: (d) => sh('ditto', ['-x', '-z', tgz, d]),
    },
    {
      id: 'archiveutil',
      label: 'Archive Utility（★ 访达里双击 .tar.gz 走的就是它）',
      run: (d) => {
        const copy = join(d, basename(tgz));
        sh('cp', ['-p', tgz, copy]);
        /*
         * ⚠️ **不能加 `-W`**。`[CI 实测 run 31245628148]` 第一版用了 `-W`
         * （等被打开的 app 退出），而 Archive Utility 解完并不退出 ——
         * 于是这一步**永远不返回**，整条腿挂到 30 分钟超时。
         * 改成不等待 + 轮询产物，并给一个明确的上限。
         */
        const r = sh('open', ['-b', 'com.apple.archiveutility', copy]);
        for (let i = 0; i < 40; i++) {
          const kids = existsSync(d) ? readdirSync(d) : [];
          if (kids.some((k) => k !== basename(tgz) && existsSync(join(d, k, 'OpenMemo.command'))))
            break;
          sh('sleep', ['3']);
        }
        return r;
      },
    },
  ];
  const extracted = {};
  for (const w of ways) {
    const d = join(base, w.id);
    mkdirSync(d, { recursive: true });
    const r = w.run(d);
    console.log(`   ── ${w.label}`);
    console.log(`      exit=${r.code} ${r.stderr ? `stderr=${r.stderr.slice(0, 300)}` : ''}`);
    const kids = existsSync(d) ? readdirSync(d) : [];
    console.log(`      产物: ${JSON.stringify(kids)}`);
    const rootDir = kids
      .map((k) => join(d, k))
      .find((p) => existsSync(join(p, 'OpenMemo.command')));
    if (!rootDir) {
      console.log(`      ✘ 没解出可用的目录（该解压方式在无头 runner 上不可用 → 记 UNKNOWN）`);
      continue;
    }
    extracted[w.id] = rootDir;
    for (const rel of [
      'OpenMemo.command',
      'runtime/node',
      'app/node_modules/sherpa-onnx-darwin-arm64',
    ]) {
      const p = join(rootDir, rel);
      if (!existsSync(p)) continue;
      const qq = sh('xattr', ['-p', 'com.apple.quarantine', p]);
      console.log(
        `      [实测] ${rel}: ${qq.code === 0 ? `**带 quarantine** → ${qq.stdout}` : `无 quarantine (${qq.stderr || 'No such xattr'})`}`,
      );
    }
  }

  hdr('③ Gatekeeper 到底拦在哪一步、原话是什么');
  const tree = extracted['archiveutil'] ?? extracted['ditto'] ?? extracted['tar'];
  if (!tree) {
    fail('没有任何一种解压方式产出可用目录，③④ 无法进行');
    return;
  }
  info(`用于检查的目录: ${tree}`);
  // 若该目录本身没有 quarantine（比如 tar 解的），显式打上——否则测的是另一个问题
  const treeQ = sh('xattr', ['-p', 'com.apple.quarantine', join(tree, 'OpenMemo.command')]);
  if (treeQ.code !== 0) {
    info('[模拟] 该目录未继承 quarantine，手工整棵打上，以复现"访达解压"的状态');
    sh('xattr', ['-w', '-r', 'com.apple.quarantine', `0083;${stamp};Safari;${uuid}`, tree]);
  }

  dump(
    'codesign -dvvv runtime/node（Node 官方签名还在不在）',
    sh('codesign', ['-dvvv', join(tree, 'runtime', 'node')]),
  );
  dump(
    'spctl -a -vvv -t exec runtime/node',
    sh('spctl', ['-a', '-vvv', '-t', 'exec', join(tree, 'runtime', 'node')]),
  );
  dump(
    'spctl -a -vvv -t open --context context:primary-signature OpenMemo.command',
    sh('spctl', [
      '-a',
      '-vvv',
      '-t',
      'open',
      '--context',
      'context:primary-signature',
      join(tree, 'OpenMemo.command'),
    ]),
  );
  dump(
    '直接执行带 quarantine 的 node（看内核/Gatekeeper 给的原话）',
    sh(join(tree, 'runtime', 'node'), ['-e', 'console.log("node-ran-ok")']),
  );
  /*
   * ⚠️ 这里**曾经**有一条 `"OpenMemo.command" --version | head -20`。已删。
   *   `--version` 不是提前退出的旗标 —— 它会**真的把 daemon 起起来**并长驻，
   *   `head -20` 永远等不到第 20 行，于是整条腿卡死 28 分钟
   *   （`[CI 实测 run 31246584116]`）。它对结论也没有任何贡献：
   *   Gatekeeper 的判定原话上面三条 spctl/codesign 已经给全了。
   */

  assertReadMeFirst(tree);

  /*
   * ★ 顺序是有讲究的：**最贵的那次测量排在最前面。**
   *
   * `[CI 实测 run 31246584116]` 上一版把 quarantine 路径② 排在一条 `log show`
   * 之后，那条诊断跑了十几分钟、把整条腿拖到 30 分钟超时 ——
   * **于是本轮最该拿到的那个值，恰恰是唯一没拿到的。**
   * 现在：⑤ 路径②（便宜、不占端口）→ ④ 双击（会被拦，什么都不会起）
   *      → ⑥ 放行后（要占端口）→ 最后才是诊断日志。
   */
  hdr('⑤ 路径②：daemon 自己下载的文件会不会被打上 quarantine（ADR-003 §7.2 的正题）');
  /*
   * ADR-003 §7.6 裁决 (A)：先量一量。量的是**Node 写下去的文件**有没有 quarantine 位。
   * 这里用**包自带的那个 node**（不是 runner 的 node）去下载并落盘，
   * 因为路径②的定义就是"daemon 进程自己写的"。
   *
   * ⚠️ 阴性结果只有在 ① 的阳性对照成立时才有意义 —— 两者必须一起读。
   */
  const nodeBin = join(tree, 'runtime', 'node');
  const outFile = join(base, 'downloaded-by-node.bin');
  const dl = sh(nodeBin, [
    '-e',
    `const https=require('node:https');const fs=require('node:fs');
     https.get('https://raw.githubusercontent.com/nodejs/node/main/README.md',r=>{
       const w=fs.createWriteStream(${JSON.stringify(outFile)});r.pipe(w);
       w.on('finish',()=>console.log('written'));});`,
  ]);
  dump('用包自带的 node 下载并写盘', dl);
  // 落盘是异步的，给它一点时间
  for (let i = 0; i < 10 && !existsSync(outFile); i++) sh('sleep', ['1']);
  if (existsSync(outFile)) {
    const qd = sh('xattr', ['-p', 'com.apple.quarantine', outFile]);
    dump('xattr -p com.apple.quarantine <node 写的文件>', qd);
    if (qd.code !== 0)
      ok('[实测] 路径②：Node 写下去的文件**没有** quarantine 位 —— 与 ① 的阳性对照并读后成立');
    else fail('[实测] 路径②：Node 写下去的文件**带** quarantine 位');
  } else {
    info('UNKNOWN：下载没落盘（runner 网络受限？），路径② 这次取不到值 —— 不许据此下结论');
  }

  hdr('④ 双击等价路径：open OpenMemo.command');
  /*
   * ★★ 先证明端口是干净的，否则这一步的"成功"可能根本不是它带来的。
   *
   * `[CI 实测 run 31247860854]` 就栽了一次：③ 里一条 `--version` 步骤悄悄起了个
   * daemon 并泄漏下来，于是 ④ 报「界面可达 200」——**而那个 200 是泄漏进程answered 的**，
   * `open` 自己其实是 ETIMEDOUT。
   *
   * > **一个本该失败的测试，被一个无关的残留进程变成了"通过"。**
   * > 这比测试失败危险得多：它会让我去报告"macOS 双击是好的"，
   * > 而用户手里的包明明打不开。
   *
   * 所以：**先探端口，脏了就当场说清楚，别让后面的结论建立在它上面。**
   */
  const preflight = await httpGet(DEFAULT_PORT, '/');
  if (preflight.status && preflight.status !== 0) {
    fail(
      `④ 之前 ${DEFAULT_PORT} 端口上已经有人在应答（HTTP ${preflight.status}）——` +
        `本步骤的任何"可达"结论都不可信（有残留 daemon）。这次结果作废。`,
    );
  } else {
    ok(`端口 ${DEFAULT_PORT} 干净（没有残留 daemon），④ 的结论才有意义`);
  }
  dump('open OpenMemo.command（= 访达里双击）', sh('open', [join(tree, 'OpenMemo.command')]));
  info('等待 40s 看界面起没起来…');
  const ui = await waitForUi(DEFAULT_PORT, 40);
  info(`[实测] 双击后界面 GET / => ${ui.status || 'unreachable'} (${ui.body.slice(0, 120)})`);
  if (ui.status === 200) ok('双击后界面可达');
  else
    known(
      `双击（open）后界面不可达 —— 这正是用户 2026-08-08 说的"也没有窗口打开"。` +
        `成因是 Gatekeeper 拦在 LaunchServices 那一步（见 ③ 的 spctl 原话）。` +
        `修它要么买签名证书、要么清 quarantine（Security Weaken，需用户拍板），` +
        `所以这里**不判定为回归**，只如实记录。`,
    );

  hdr('⑥ 放行之后呢：用户过了 Gatekeeper 这一关，界面和横幅对不对');
  /*
   * ④ 量的是"被拦住"，这一步量的是"**放行之后**" —— 两者都要有结论。
   *
   * ⚠️ 这里的 `xattr -dr` 跑在**一次性 runner 的临时副本**上，用来模拟
   *   "用户右键→打开、或自己决定清掉隔离属性"之后的状态。
   *   **它不是产品行为**：产品里一行清 quarantine 的代码都没有，
   *   那属于 Security Weaken，必须用户本人拍板（ADR-003 §7.5）。
   */
  const clean = extracted['tar'];
  if (clean) {
    sh('xattr', ['-dr', 'com.apple.quarantine', clean]);
    const left = sh('xattr', ['-p', 'com.apple.quarantine', join(clean, 'OpenMemo.command')]);
    info(
      `[模拟] 已在临时副本上放行（xattr -dr）；回读: ${left.code === 0 ? left.stdout : '已无该属性'}`,
    );
    const r = await runLauncher({
      label: '放行后运行 OpenMemo.command（不带任何参数，= 双击）',
      cmd: '/bin/sh',
      args: ['-c', `"${join(clean, 'OpenMemo.command')}"`],
      cwd: clean,
      waitSec: 100,
    });
    if (r.ui.status === 200) ok('放行后界面可达 (HTTP 200)');
    else fail(`放行后界面仍不可达 (${r.ui.body}) —— 这就不是 Gatekeeper 的问题了`);
    assertBannerIsHumanReadable(r.out);
  } else {
    info('UNKNOWN：没有可用的干净副本，⑥ 取不到值');
  }

  /*
   * ⚠️ 这条是**诊断**，不是判据 —— Gatekeeper 的判定原话 ③ 的 spctl 已经给了。
   *   它扫系统日志归档，实测能跑十几分钟，所以：**排在所有测量之后 + 硬超时 60s**。
   */
  dump(
    'syspolicy 日志（Gatekeeper 判定的原话；诊断用，超时即放弃）',
    sh(
      'log',
      [
        'show',
        '--last',
        '2m',
        '--predicate',
        'subsystem == "com.apple.syspolicy"',
        '--style',
        'compact',
      ],
      { timeout: 60_000 },
    ),
  );
}

/* ════════════════════════════════════════════════════════════════════════════════
 * Linux
 * ════════════════════════════════════════════════════════════════════════════════ */
async function linux() {
  const txz = findArchive(['.tar.xz']);
  if (!txz) {
    fail('找不到 linux-x64 的 .tar.xz');
    return;
  }
  const base = join(tmpdir(), 'om-launch-sim-linux');
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  dump('tar xJf（GNOME「提取到此处」等价）', sh('tar', ['xJf', txz, '-C', base]));
  const roots = readdirSync(base);
  const root = join(base, roots[0]);
  info(`顶层: ${JSON.stringify(roots)}`);

  hdr('① 文件管理器里双击 start.sh 会发生什么（结构性判断 + 可测的那半）');
  const launcher = join(root, 'start.sh');
  const st = sh('stat', ['-c', '%A %n', launcher]);
  dump('可执行位', st);
  /*
   * GNOME Files 自 3.30 起**默认不执行**脚本（`show-run-in-terminal` 关闭），
   * 双击 `.sh` 走的是"用文本编辑器/默认应用打开"。`[报告]` —— 无头 runner 上
   * 没有 GNOME Files，这一条**测不到**，只能靠桌面环境的默认配置来说明。
   * 可测的那半是：**桌面环境认哪个后缀**。`.desktop` 才是 Linux 上"可双击"的东西。
   */
  info('[报告] GNOME Files ≥3.30 默认不执行脚本，双击 .sh = 用默认应用打开（测不到，无 GUI 会话）');
  info(`[实测] 包内有没有 .desktop 入口: ${existsSync(join(root, 'OpenMemo.desktop'))}`);
  dump('xdg-open 认不认 .sh', sh('sh', ['-c', 'command -v xdg-open || echo "no xdg-open"']));

  hdr('② 从一个干净 shell 里不带参数地跑 start.sh（最接近"双击"的可测形态）');
  const r = await runLauncher({
    label: '不带任何参数运行 ./start.sh',
    cmd: '/bin/sh',
    args: ['-c', `"${launcher}"`],
    cwd: root,
    waitSec: 100,
  });
  if (r.ui.status === 200) ok('界面可达 (HTTP 200)');
  else fail(`界面不可达 (${r.ui.body})`);
  assertBannerIsHumanReadable(r.out);
  assertReadMeFirst(root);
}

/* ── main ─────────────────────────────────────────────────────────────────────── */

/*
 * ★★ 这个脚本**只许在一次性 runner 上跑**，本机跑一次就会伤到用户。
 *
 * 理由是 PROTOCOL §9 那一条的直接推论：本脚本的**全部价值**在于
 * 「不带任何参数、不带任何环境变量地启动」—— 那正是双击的形态。
 * 而不带 `OPENMEMO_DATA_DIR` 启动的 daemon，会去读**机器级指针**
 * `~/.local/share/openmemo/datadir.json`，于是：
 *
 *   · 它会打开**用户 demo 的那个数据目录**（`/root/data-memo`）
 *   · 拿数据目录锁、可能跑 schema 迁移、可能与 `:10000` 上跑着的实例互斥
 *
 * 换句话说：**让它"真实"的那个性质，同时让它在共享机器上是危险的。**
 * 不能靠"记得别在本机跑" —— 判据照 PROTOCOL §7 补充那条：
 * **跑错了也不能造成后果**。所以在这里硬拦。
 *
 * `CI=true` 由 GitHub Actions 自动注入；本机没有。
 */
const DISPOSABLE = process.env['CI'] === 'true' || argv.includes('--yes-this-host-is-disposable');
if (!DISPOSABLE) {
  console.error(
    [
      '拒绝运行：本脚本会**不带任何环境变量**启动 daemon，',
      '因而会解析机器级指针 ~/.local/share/openmemo/datadir.json，',
      '在共享开发机上等于直接动用户的数据目录（PROTOCOL §9）。',
      '',
      '它只应在一次性 CI runner 上跑（那里 CI=true）。',
      '确实身处一次性环境时，显式加 --yes-this-host-is-disposable。',
    ].join('\n'),
  );
  process.exit(2);
}

const PLATFORM = process.platform;
console.log(`模拟用户动作 · platform=${PLATFORM} · mode=${MODE}`);
console.log(`归档目录: ${ARCHIVE_DIR}`);

const run = PLATFORM === 'win32' ? windows : PLATFORM === 'darwin' ? macos : linux;
run()
  .then(() => {
    hdr('小结');
    if (notes.length) notes.forEach((n) => console.log(`   · ${n}`));
    if (failures.length === 0) {
      console.log('   全部通过');
    } else {
      console.log(`   ${failures.length} 条不成立：`);
      failures.forEach((f) => console.log(`     ✘ ${f}`));
    }
    if (MODE === 'guard' && failures.length > 0) {
      console.log('\nmode=guard → exit 1');
      process.exit(1);
    }
    console.log(`\nmode=${MODE} → exit 0（diagnose 只取证，不判定）`);
    /*
     * ★ 显式退出。被测对象是**长驻服务**，它或它的子进程可能仍握着我们的管道，
     *   于是事件循环空不下来 —— 表现是"脚本跑完了但这一步永远不结束"。
     *   `[CI 实测 run 31245628148]` linux 腿正是这样挂到超时的。
     */
    process.exit(0);
  })
  .catch((e) => {
    console.error('脚本自身出错:', e);
    process.exit(MODE === 'guard' ? 1 : 0);
  });
