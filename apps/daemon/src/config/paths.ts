/**
 * 数据目录解析（D-02 §6.1 各 OS 根目录）。
 *
 * 优先级：`OPENMEMO_DATA_DIR` > `--data-dir` > OS 默认。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

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

export function resolvePaths(override?: string): AppPaths {
  const dataDir = process.env['OPENMEMO_DATA_DIR'] ?? override ?? defaultDataDir();
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
    modelsDir: join(dataDir, 'models'),
    extensionsDir: process.env['OPENMEMO_EXT_DIR'] ?? join(dataDir, 'bin', 'ext'),
  };
}
