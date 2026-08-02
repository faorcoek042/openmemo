/**
 * 内置目录（`vendor/manifests/*.json`，ADR-001 C 类产物）的加载与校验。
 *
 * 这里读的是**仓库里 git 提交的真实 manifest**，不是 mock。加载时用
 * `@openmemo/shared` 的 zod schema 校验：manifest 里一个手打错的 sha256 或 sizeBytes
 * 会让用户在下载几 GB 之后才失败，在启动时就拒绝掉要便宜得多。
 */
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateBackendManifest,
  validateModelManifest,
  type BackendPack,
  type ModelEntry,
} from '@openmemo/shared';

/**
 * manifest 文档外壳。
 *
 * `packages/shared` 只导出了 zod schema、没有导出这个外层 interface，所以在这里补一个
 * **文件格式**类型（不是 API 响应形状，不违反"响应类型只从 shared 取"的约定）。
 */
interface ModelManifestDoc {
  schemaVersion: 1;
  catalogVersion: string;
  generatedAt: string;
  models: ModelEntry[];
}

interface BackendManifestDoc {
  schemaVersion: 1;
  catalogVersion: string;
  generatedAt: string;
  packs: BackendPack[];
}

export interface ModelCatalog {
  catalogVersion: string;
  models: ModelEntry[];
}

export interface BackendCatalog {
  catalogVersion: string;
  packs: BackendPack[];
}

const MODEL_MANIFEST_FILES = ['models-whisper.json', 'models-llm.json'];
const BACKEND_MANIFEST_FILE = 'backends.json';

/**
 * 定位 `vendor/manifests`。
 *
 * 顺序：环境变量 > 相对本模块的仓库路径（src 与 dist 层级相同，都是 5 层）> cwd。
 * 必须同步，因为 server.ts 的接线点没有 await 的余地。
 */
export function resolveManifestDir(): string {
  const fromEnv = process.env['OPENMEMO_MANIFEST_DIR'];
  if (fromEnv) return fromEnv;

  const here = path.dirname(fileURLToPath(import.meta.url));
  // apps/daemon/{src,dist}/http/rest → 仓库根
  const repoRelative = path.resolve(here, '..', '..', '..', '..', '..', 'vendor', 'manifests');
  if (existsSync(repoRelative)) return repoRelative;

  return path.join(process.cwd(), 'vendor', 'manifests');
}

async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function loadModelCatalog(manifestDir: string): Promise<ModelCatalog> {
  const models: ModelEntry[] = [];
  let catalogVersion = '0';

  for (const name of MODEL_MANIFEST_FILES) {
    const file = path.join(manifestDir, name);
    const raw = await readJsonFile(file);
    const checked = validateModelManifest(raw);
    if (!checked.ok) {
      throw new Error(`模型 manifest 校验失败 ${file}: ${checked.errors.slice(0, 5).join('; ')}`);
    }
    // zod 已按 shared 的 ModelEntrySchema 校验通过，schema 与 ModelEntry 同源，可以断言。
    const doc = raw as ModelManifestDoc;
    models.push(...doc.models);
    catalogVersion = doc.catalogVersion;
  }

  return { catalogVersion, models };
}

export async function loadBackendCatalog(manifestDir: string): Promise<BackendCatalog> {
  const file = path.join(manifestDir, BACKEND_MANIFEST_FILE);
  const raw = await readJsonFile(file);
  const checked = validateBackendManifest(raw);
  if (!checked.ok) {
    throw new Error(`后端 manifest 校验失败 ${file}: ${checked.errors.slice(0, 5).join('; ')}`);
  }
  const doc = raw as BackendManifestDoc;
  return { catalogVersion: doc.catalogVersion, packs: doc.packs };
}
