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

/*
 * ⚠️ **不要再写死文件名清单**（ADR-014）。
 *
 * 曾经这里是 `['models-whisper.json','models-llm.json']`，于是磁盘上真实存在的
 * `models-asr-support.json`（VAD / Paraformer / 标点）与 `sqlite-ext.json`（中文分词器）
 * **从来没被加载过** —— 上游把东西加进目录了，下游看不见，
 * 表现成"网页上根本没有 VAD 这一项"，排查时会怀疑上游没做，其实是这一行挡的。
 *
 * 改为**列目录**：manifest 目录下所有 `*.json` 都尝试加载，按内容判类型。
 * 这样上游加文件，下游自动看见，不需要两边同步改。
 */

/** 文件名 → 类型的判定不靠命名约定，靠内容里有没有 `models` / `packs` 数组。 */
type ManifestKind = 'model' | 'backend' | 'unknown';

function classifyManifest(raw: unknown): ManifestKind {
  if (!raw || typeof raw !== 'object') return 'unknown';
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o['models'])) return 'model';
  if (Array.isArray(o['packs'])) return 'backend';
  return 'unknown';
}

/** 列出 manifest 目录里所有 `*.json`（排除 schema.json 这类非目录文件）。 */
async function listManifestFiles(manifestDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(manifestDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json') && n !== 'schema.json')
    .sort()
    .map((n) => path.join(manifestDir, n));
}

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
  const seen = new Set<string>();
  let catalogVersion = '0';

  for (const file of await listManifestFiles(manifestDir)) {
    const raw = await readJsonFile(file);
    if (classifyManifest(raw) !== 'model') continue; // 后端目录/其它文件跳过
    const checked = validateModelManifest(raw);
    if (!checked.ok) {
      throw new Error(`模型 manifest 校验失败 ${file}: ${checked.errors.slice(0, 5).join('; ')}`);
    }
    // zod 已按 shared 的 ModelEntrySchema 校验通过，schema 与 ModelEntry 同源，可以断言。
    const doc = raw as ModelManifestDoc;
    for (const m of doc.models) {
      // 多个文件里出现同一个 id 时以先读到的为准，避免目录里出现重复项
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      models.push(m);
    }
    catalogVersion = doc.catalogVersion;
  }

  return { catalogVersion, models };
}

export async function loadBackendCatalog(manifestDir: string): Promise<BackendCatalog> {
  const packs: BackendPack[] = [];
  const seen = new Set<string>();
  let catalogVersion = '0';

  for (const file of await listManifestFiles(manifestDir)) {
    const raw = await readJsonFile(file);
    if (classifyManifest(raw) !== 'backend') continue;
    const checked = validateBackendManifest(raw);
    if (!checked.ok) {
      throw new Error(`后端 manifest 校验失败 ${file}: ${checked.errors.slice(0, 5).join('; ')}`);
    }
    const doc = raw as BackendManifestDoc;
    for (const p of doc.packs) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      packs.push(p);
    }
    catalogVersion = doc.catalogVersion;
  }

  return { catalogVersion, packs };
}
