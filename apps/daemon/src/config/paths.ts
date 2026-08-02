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
 * 数据目录指针文件的位置：**永远在 OS 默认位置**，不在数据目录里面。
 *
 * 鸡生蛋问题：用户把数据搬走之后，我们得先知道搬到哪了才能去读 ——
 * 所以这个指针不能跟着数据一起走，否则搬完就再也找不到了。
 */
export function pointerFile(): string {
  return join(defaultDataDir(), 'datadir.json');
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
