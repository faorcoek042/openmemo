/**
 * 数据目录解析（D-02 §6.1 各 OS 根目录）。
 *
 * 优先级：`OPENMEMO_DATA_DIR` > `--data-dir` > OS 默认。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { resolveStoreRoot } from '@openmemo/pipeline';

export interface AppPaths {
  readonly dataDir: string;
  readonly dbFile: string;
  readonly runtimeDir: string;
  readonly runtimeJson: string;
  readonly backupsDir: string;
  readonly logsDir: string;
  readonly tmpDir: string;
  readonly mediaDir: string;
  readonly modelsDir: string;
  /** 原生扩展（libsimple / sqlite-vec）所在目录，由 T-012 的构建脚本产出。 */
  readonly extensionsDir: string;
}

export function defaultDataDir(): string {
  const home = homedir();
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
    return join(appData, 'OpenMemo');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'OpenMemo');
  }
  const xdg = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
  return join(xdg, 'openmemo');
}

/**
 * 数据目录指针文件的位置：**默认永远在 OS 默认位置**，不在数据目录里面。
 *
 * 鸡生蛋问题：用户把数据搬走之后，我们得先知道搬到哪了才能去读 ——
 * 所以这个指针不能跟着数据一起走，否则搬完就再也找不到了。
 *
 * ## 为什么它必须可以被 `OPENMEMO_POINTER_FILE` 覆盖（T-142，一次真实事故的第二条路径）
 *
 * 代价是：**它是全机器共享的一份**。任何进程写它，写的就是机器级状态 ——
 * 包括**测试进程**。而这条已经出过事：用户的 demo 指针被改到某个临时目录，
 * 几小时后重启，daemon 挂到一个空壳上，界面上他的 key、模型、转写记录**全部"消失"**
 * （数据一个字节没丢，但从界面完全看不出来）。
 *
 * 事故当时归因于"某个搬迁测试"，但**第二条路径是 `pnpm -r test` 本身**：
 * `storage/restart-datadir.test.ts` 要验"指针指向别处时普通重启不能被带偏"，
 * 就得让 daemon 真的读到一个指向别处的指针。它当时的做法是
 * **备份真指针 → 改成诱饵 → `after()` 还原**。还原是对的，但
 * **`after()` 只在正常结束时跑** —— 进程被 kill / 崩溃 / 超时，坏指针就永久留下。
 * 而 Manager 一天要跑十几次 `pnpm -r test`。
 *
 * **判据不是"还原得对不对"，是"被 kill 也不能留下坏状态"。**
 * 备份还原法在结构上做不到这一点（写下去到还原之间必然有窗口），
 * 所以正确的修法是**让它根本不写那个全局位置**：把位置变成可注入的。
 *
 * 这不是给测试开的后门 —— 它与 `OPENMEMO_DATA_DIR` / `OPENMEMO_EXT_DIR` /
 * `OPENMEMO_MODELS` 是同一套约定，同样服务于"一台机器上跑多个隔离实例"。
 * 优先级也一致：**env 覆盖一切**。
 */
export function pointerFile(): string {
  return process.env['OPENMEMO_POINTER_FILE'] ?? join(defaultDataDir(), 'datadir.json');
}

/** 读指针。坏了/没有都返回 undefined —— 绝不因为它让 daemon 起不来。 */
export function readDataDirPointer(): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(pointerFile(), 'utf8')) as { dataDir?: unknown };
    return typeof raw.dataDir === 'string' && raw.dataDir.length > 0 ? raw.dataDir : undefined;
  } catch {
    return undefined;
  }
}

/** 写指针（移动完成后调用）。 */
export function writeDataDirPointer(dataDir: string): void {
  const f = pointerFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ dataDir, updatedAt: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
}

export function resolvePaths(override?: string): AppPaths {
  // 优先级：环境变量 > 命令行 > **用户搬家后写下的指针** > OS 默认
  const dataDir =
    process.env['OPENMEMO_DATA_DIR'] ?? override ?? readDataDirPointer() ?? defaultDataDir();
  const runtimeDir = join(dataDir, 'runtime');
  return {
    dataDir,
    dbFile: join(dataDir, 'openmemo.db'),
    runtimeDir,
    runtimeJson: join(runtimeDir, 'runtime.json'),
    backupsDir: join(dataDir, 'backups'),
    logsDir: join(dataDir, 'logs'),
    tmpDir: join(dataDir, 'tmp'),
    mediaDir: join(dataDir, 'media'),
    /*
     * 用 `@openmemo/pipeline` 的 `resolveStoreRoot` —— **不要在这里再推导一遍**。
     *
     * 这里曾经是第 4 份各自为政的 storeRoot 推导，且**不读 `OPENMEMO_MODELS`**。
     * 目前它够不到产品路径（`setup.ts` 覆盖了），所以没造成故障 ——
     * 但"现在恰好没事"和"对"是两回事：留着就是下一次踩坑的种子，
     * 而这类不一致的代价已经付过（Windows 上 Roaming/Local 分叉让已装的包永远找不到）。
     */
    modelsDir: resolveStoreRoot(dataDir),
    extensionsDir: process.env['OPENMEMO_EXT_DIR'] ?? join(dataDir, 'bin', 'ext'),
  };
}
