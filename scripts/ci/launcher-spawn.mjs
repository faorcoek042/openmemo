/**
 * 从**启动器**起 daemon —— 四条 e2e 腿共用的那一份。
 *
 * ## 为什么必须有这个东西
 *
 * 完成度审计查出第四类「CI 结构上看不见」：
 *
 * > **CI 直接起 `app/daemon/dist/main.js`，而用户双击的是启动器脚本
 * > （`start.cmd` / `OpenMemo.command` / `start.sh`）。
 * > 凡是只有启动器才做的事，CI 结构上都看不见。**
 *
 * 启动器**独有**的动作有五件（源码见 `scripts/build-bundle.mjs` 的 `posixBody` /
 * `LAUNCHERS['start.cmd']`）：
 *
 *   ① `OPENMEMO_WEB_DIST`          → 包内网页 bundle
 *   ② `OPENMEMO_EXT_DIR`           → 包内 SQLite 扩展
 *   ③ `OPENMEMO_BUNDLED_PROBE_DIR` → **随包出厂的最小探针运行时**
 *   ④ `cd "$DIR/app/daemon"`       → **工作目录**
 *   ⑤ 缺件预检 / macOS quarantine 那一整套外围
 *
 * 其中 ③ 是本轮的现场：`[grep 实测]` `OPENMEMO_BUNDLED_PROBE_DIR` 此前
 * **四条 e2e 腿一条都没有引用过**。也就是说探针进包那条修复（`5413369`）
 * 在启动器路径上是 `[未验证]` —— 而它恰恰**只通过启动器设的那个变量生效**。
 * 于是"三平台全绿"在启动器那一段上**没有效力**。
 *
 * 这是同一形状的第四次（前三次：CI 没执行过启动器 → 双击打不开；
 * CI 没经历过空数据目录 → 装不了组件；CI 没点过一下 → 按钮没反应），
 * 而且**它把前三次的修复也一起架空了**。
 *
 * ## 判据：测的必须是用户会走的那条路
 *
 * 所以这个模块**不接受调用方传 daemon 入口**。它只收 `bundleDir`，
 * 剩下的全从启动器那里来 —— 调用方**没有办法**绕过启动器还用上这个模块。
 * 「别再直接起 main.js」因此不是一条要记住的纪律，而是一件做不到的事。
 *
 * ## 三个平台的收尾（PROTOCOL §11：按 pid 收整棵进程树）
 *
 * **启动器的形状不一样，收尾也就不一样 —— 统一意图是对的，统一拼写是错的。**
 *
 * · **POSIX**（`start.sh` / `OpenMemo.command`）：正文最后一行是
 *   `exec "$DIR/runtime/node" dist/main.js "$@"` —— `exec` 让 shell **把自己换成**
 *   node，所以 `child.pid` **就是 daemon 的 pid**。再加 `detached: true` 单独成组，
 *   收尾时按**进程组**收（`kill(-pid)`），孙子进程一并带走。
 * · **Windows**（`start.cmd`）：批处理**没有 exec**，`cmd.exe` 会一直挂着当父进程，
 *   node.exe 是它的子进程。`child.kill()` 只结束 `cmd.exe`，**node 会活下来继续占端口**，
 *   于是下一轮的健康检查连上一个"不是我起的"东西（§11 点名的正是这个）。
 *   所以 Windows 必须 `taskkill /PID <pid> /T /F`。
 *
 * **两个平台都按 pid，绝不用 `pkill -f`** —— 模式匹配会打到别人的进程。
 * （Manager 2026-08-08 裁决：这条规则保持绝对，**`pkill -0 -f` 做存在性探测也不行**，
 *   它能挡住事故靠的正是它是一条没有判断空间的明线。）
 *
 * ## 刻意声明的两处"不是双击"
 *
 * 1. **传了 `--port` / `--data-dir`**。启动器自己写明支持这两个参数
 *    （`用法：./start.sh [--port 17650] [--data-dir /路径]`），而 e2e 腿必须端口
 *    可控、数据目录隔离（PROTOCOL §9：绝不碰机器级数据目录）。
 *    **不传参数的那条路由 `e2e-coldstart` 覆盖**（它专门验"产品自己算得出数据目录"）。
 * 2. **`OPENMEMO_OPEN_BROWSER=0`**。启动器默认设 1（双击的人没有控制台可读 URL），
 *    但无头 runner 上没有浏览器，开它只会多一个失败源。启动器写的是
 *    `if not defined` / `: "${VAR:=…}"`，**尊重调用方预设值**，所以设 0 走的仍然是
 *    产品自己的契约。真浏览器那一格归 `e2e-browser`。
 *
 * ⚠️ 除这两处以外，**调用方不许再预设 ①②③**：预设了就等于又把启动器架空了一次，
 *    而那正是这个模块存在的理由。下面 `assertNoLauncherOverrides()` 会当场拦下。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const IS_WIN = process.platform === 'win32';

/** 启动器**独有**的那几个变量：调用方预设任何一个，都等于绕过了启动器。 */
export const LAUNCHER_OWNED_ENV = [
  'OPENMEMO_WEB_DIST',
  'OPENMEMO_EXT_DIR',
  'OPENMEMO_BUNDLED_PROBE_DIR',
];

/** 这个平台上，用户双击/执行的是哪一个文件。 */
export function launcherName() {
  if (IS_WIN) return 'start.cmd';
  if (process.platform === 'darwin') return 'OpenMemo.command';
  return 'start.sh';
}

/** 包里的启动器绝对路径。 */
export function launcherPath(bundleDir) {
  return join(bundleDir, launcherName());
}

/**
 * 调用方不许预设启动器该自己设的那几个变量。
 * 预设了不会报错、只会让这条腿**看起来**在走启动器 —— 正是本模块要消灭的那种假覆盖。
 */
export function assertNoLauncherOverrides(env, allow = false) {
  /*
   * ★ `allow` 是给**变异验证**留的口子，不是给图省事留的。
   *
   *   `e2e-notes` 有一条最值钱的变异：把 `OPENMEMO_EXT_DIR` 指到一个空目录，
   *   证明"中文检索"那条断言真的会红。那是**故意**要覆盖启动器的值 ——
   *   与"忘了让启动器自己设"是两件相反的事，不能用同一条规则挡。
   *
   *   所以口子必须是**显式传参**才打开：调用方得写出 `allowLauncherOverrides: true`，
   *   而那五个字就是它在申明"我这次是故意的"。默认永远是拦。
   */
  if (allow) return;
  const bad = LAUNCHER_OWNED_ENV.filter((k) => env?.[k] !== undefined);
  if (bad.length > 0) {
    throw new Error(
      `这些变量必须留给启动器自己设，调用方不许预设：${bad.join(', ')}\n` +
        `      预设它们 = 这条腿只是"看起来"在走启动器，而启动器那一段仍然没被验到。\n` +
        `      （${launcherName()} 用 "已设则尊重" 的写法，所以预设会静默生效，不会报错。）`,
    );
  }
}

/**
 * 从启动器起 daemon。
 *
 * @param {object} o
 * @param {string} o.bundleDir  预编译包根目录（含 start.sh / start.cmd / OpenMemo.command）
 * @param {string[]} o.args     透传给启动器的参数（如 ['--port','19800','--data-dir',dir]）
 * @param {Record<string,string>} o.env  额外环境变量（**不许含 LAUNCHER_OWNED_ENV**）
 * @returns {{proc: import('node:child_process').ChildProcess, launcher: string, argv: string[]}}
 */
export function spawnViaLauncher({
  bundleDir,
  args = [],
  env = {},
  allowLauncherOverrides = false,
}) {
  const launcher = launcherPath(bundleDir);
  if (!existsSync(launcher)) {
    throw new Error(
      `包里没有启动器：${launcher}\n` +
        `      用户双击的就是它 —— 它不在，这个包对用户来说是打不开的。`,
    );
  }
  assertNoLauncherOverrides(env, allowLauncherOverrides);

  const childEnv = { ...process.env, ...env };
  // 无头 runner 上没有浏览器；启动器"已设则尊重"，所以这是走产品自己的契约。
  if (childEnv.OPENMEMO_OPEN_BROWSER === undefined) childEnv.OPENMEMO_OPEN_BROWSER = '0';

  let proc;
  let argv;
  if (IS_WIN) {
    /*
     * `.cmd` 不能直接 spawn（Node 从 CVE-2024-27980 起拒绝），要经 cmd.exe。
     * 拿到的 pid 是 **cmd.exe** 的，node.exe 是它的子进程 —— 所以收尾必须 /T。
     */
    argv = ['/d', '/s', '/c', launcher, ...args];
    proc = spawn(process.env.ComSpec ?? 'cmd.exe', argv, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } else {
    /*
     * POSIX：启动器最后是 `exec`，所以这个 pid 就是 daemon 的 pid。
     * `detached: true` 让它单独成组，收尾按组收（见 killTree）。
     */
    argv = [...args];
    proc = spawn('/bin/sh', [launcher, ...args], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  }
  return { proc, launcher, argv };
}

/**
 * 按 pid 收整棵进程树（PROTOCOL §11）。**绝不 `pkill -f`。**
 *
 * 返回一句人可读的说明，调用方应当打出来 —— 收尾方式在三个平台上不一样，
 * 而"我到底收干净了没有"是排查残留进程时第一个要看的东西。
 */
export function killTree(pid) {
  if (pid === undefined || pid === null) return '（没有 pid，无需收尾）';
  if (IS_WIN) {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 20_000 });
    return `taskkill /PID ${pid} /T /F → exit ${r.status}（cmd.exe 底下的 node.exe 必须靠 /T 带走）`;
  }
  try {
    // 负号 = 整个进程组。启动器 exec 之后组长就是 daemon 自己。
    process.kill(-pid, 'SIGTERM');
    return `kill(-${pid}, SIGTERM) —— 按进程组收（启动器 exec 之后组长就是 daemon）`;
  } catch (e) {
    try {
      process.kill(pid, 'SIGTERM');
      return `kill(${pid}, SIGTERM)（进程组不可用：${e.code}）`;
    } catch (e2) {
      return `进程已经不在了（${e2.code}）`;
    }
  }
}

/** SIGTERM 之后还赖着不走时的最后一手，同样按 pid。 */
export function killTreeHard(pid) {
  if (pid === undefined || pid === null) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 20_000 });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经没了 */
    }
  }
}

/**
 * 起 daemon 的**唯一**入口 —— 四条 e2e 腿都只调它。
 *
 * ## 为什么源码树那条回退也要收进来
 *
 * 几条腿支持"没有 `--bundle` 时跑源码树"（本机调试用）。源码树里**没有启动器**，
 * 所以那条路只能直接起 `dist/main.js`。
 *
 * 但只要这句 `main.js` 还写在**腿的源码里**，守卫就得靠"分辨这次是不是回退"
 * 来判断 —— 而那是一条靠措辞撑着的守卫，会静默停止工作。
 * 把回退收进本模块之后，**腿的源码里一次都不会出现 daemon 入口路径**，
 * 守卫于是可以用一条没有判断空间的断言：**腿里出现 daemon 入口 = 红**。
 *
 * ⚠️ 源码树模式**不是用户会走的路**，所以它每次都会把这句话打出来，
 *    避免有人拿源码树的绿去当"包能用"的证据（v0.2.0 正是这么过去的）。
 *
 * @returns {{proc, launcher: string|null, viaLauncher: boolean, note: string}}
 */
export function spawnDaemon({
  bundleDir,
  repoRoot,
  args = [],
  env = {},
  allowLauncherOverrides = false,
}) {
  if (bundleDir) {
    const { proc, launcher } = spawnViaLauncher({ bundleDir, args, env, allowLauncherOverrides });
    return {
      proc,
      launcher,
      viaLauncher: true,
      note: `经启动器 ${launcher}（= 用户双击的那个文件）`,
    };
  }
  if (!repoRoot) {
    throw new Error('既没有 bundleDir 也没有 repoRoot —— 没法起 daemon');
  }
  /*
   * 源码树回退：**唯一**允许直接起入口的地方，而且它在共享模块里、只有一处。
   */
  const entry = join(repoRoot, 'apps', 'daemon', 'dist', 'main.js');
  if (!existsSync(entry)) {
    throw new Error(`找不到 ${entry} —— 先跑 pnpm build:safe`);
  }
  assertNoLauncherOverrides(env, allowLauncherOverrides);
  const proc = spawn(process.execPath, [entry, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(IS_WIN ? {} : { detached: true }),
  });
  return {
    proc,
    launcher: null,
    viaLauncher: false,
    note:
      '⚠️ 源码树模式：**直接起的 dist/main.js，没有经过启动器** —— ' +
      '这一轮证明不了"用户双击那个包能用"，也验不到 WEB_DIST/EXT_DIR/BUNDLED_PROBE_DIR/工作目录。',
  };
}
