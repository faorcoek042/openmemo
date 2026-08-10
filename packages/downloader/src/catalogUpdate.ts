/**
 * "检测更新"编排 —— D-20 §11.3 / §17 的三条前提在这里被拼成一个可调用、生产安全的函数。
 *
 * ══ 硬约束（D-20 §11.3 末尾一行）══════════════════════════════════════════════════
 *
 * > 在这三条落地之前，"检测更新"应当只做到「告诉用户有新版本」，不自动改任何东西。
 *
 * 本文件里没有任何写文件系统 / 入下载队列 / 触发安装的代码 —— `checkForUpdates()` 的
 * 返回值就是它的全部产出，调用方（`apps/daemon/src/http/rest/updates.ts`）也只把它
 * 序列化成 JSON 回给前端。这不是一条需要人肉审查遵守的规矩，是**这个函数结构上做不到
 * 别的事**：它没有拿到任何 `ArtifactStore` / `DownloadQueue` 之类的写入句柄。
 *
 * ══ 三条前提逐条对应 ══════════════════════════════════════════════════════════════
 *
 * 1. **签名 + 客户端钉死公钥** —— `resolveConfiguredCatalogPublicKey()`
 *    （`signature.ts`）+ `verifyCatalogSignatureSafe()`（`manifest.ts`）。
 * 2. **验不过回退到包内那份，而不是"没有目录"** —— 本函数的每一个失败分支（未配置 /
 *    host 不在白名单 / 拉取失败 / 无密钥 / 验签不过 / JSON 解析失败）都返回
 *    `newOrChanged: []`，**从不返回一个"目录不存在"的错误**，也**从不触碰**调用方
 *    已经加载好的本地/包内目录（`local*Catalog`）—— 那份目录是调用方在调用本函数
 *    之前就已经用 `loadModelCatalog()`/`loadBackendCatalog()` 读出来的，本函数拿到的
 *    只是其中的条目列表做只读比对，从不重新加载、不替换它。调用方（`updates.ts`）
 *    据此原样把本地目录继续端给前端，"有没有更新"只是叠加的一层信息。
 * 3. **只增不改已钉死的** —— `checkBundledIntegrity()`：远端条目的 id 若在
 *    `bundledIds`（调用方传入 `BUNDLED_MODEL_IDS`）里，且它的文件级 sha256（`files[].
 *    sha256`——`ModelEntry` 没有单一顶层 sha256，`modelReconcile.ts:145-166` 校验的也是
 *    这一层）与本地记录的不一致，直接丢弃该条（记入 `rejectedBundledTampering`），
 *    不采纳、不覆盖、不合并。不在钉死集合里的新 id 不受限制，允许被视为"新增"。
 */

import { verifyCatalogSignatureSafe } from './manifest.js';
import { resolveConfiguredCatalogPublicKey } from './signature.js';

export interface BundledIntegrityViolation {
  readonly id: string;
  readonly reason: string;
}

export interface BundledIntegrityResult<T> {
  readonly accepted: readonly T[];
  readonly rejected: readonly BundledIntegrityViolation[];
}

/** 拿来做"内容有没有变"比对的最小文件形状 —— `ArtifactFile`/`InstalledFile` 的子集。 */
export interface CatalogUpdateFile {
  readonly name: string;
  readonly sha256: string;
}

/**
 * 逐文件比对两份 `files` 列表内容是否完全一致（同名同 sha256、数量也一致）。
 * 顺序无关：远端/本地的生成顺序没有约定过一致，比的是内容而不是排列。
 */
function sameFiles(a: readonly CatalogUpdateFile[], b: readonly CatalogUpdateFile[]): boolean {
  if (a.length !== b.length) return false;
  const byName = new Map(a.map((f) => [f.name, f.sha256]));
  for (const f of b) {
    if (byName.get(f.name) !== f.sha256) return false;
  }
  return true;
}

/**
 * D-20 §11.3 前提 3 的落点：远端目录允许新增条目，**绝不允许**改一个已钉死
 * （`bundledIds`）的 id 的文件内容（按 `files[].name`+`files[].sha256` 逐个比对）。
 * 不一致的钉死条目被丢弃而不是"以远端为准覆盖" —— 被丢弃的条目只出现在 `rejected`
 * 里，绝不会出现在 `accepted` 里，调用方不需要自己再判一遍。
 */
export function checkBundledIntegrity<
  T extends { id: string; files: readonly CatalogUpdateFile[] },
>(
  remoteEntries: readonly T[],
  localById: ReadonlyMap<string, { files: readonly CatalogUpdateFile[] }>,
  bundledIds: ReadonlySet<string>,
): BundledIntegrityResult<T> {
  const accepted: T[] = [];
  const rejected: BundledIntegrityViolation[] = [];
  for (const entry of remoteEntries) {
    if (bundledIds.has(entry.id)) {
      const local = localById.get(entry.id);
      if (local && !sameFiles(local.files, entry.files)) {
        rejected.push({
          id: entry.id,
          reason:
            '远端文件内容（名字/sha256）与已内置的不一致 —— ' +
            '已钉死的 id 不允许被远端改写，该条目被丢弃，不采纳',
        });
        continue;
      }
    }
    accepted.push(entry);
  }
  return { accepted, rejected };
}

export type CatalogUpdateSource =
  | 'not-configured'
  | 'host-not-allowed'
  | 'fetch-failed'
  | 'no-key-configured'
  | 'verify-failed'
  | 'parse-failed'
  | 'verified';

export interface CatalogUpdateEntry {
  readonly id: string;
  readonly files: readonly CatalogUpdateFile[];
}

export interface CatalogUpdateChange {
  readonly id: string;
  readonly reason: string;
}

export interface CatalogUpdateResult {
  readonly source: CatalogUpdateSource;
  readonly checkedAt: string;
  /** 人可读的一句话，用于前端直接展示 / 调用方日志。 */
  readonly detail: string;
  /** 只在 `source === 'verified'` 时可能非空 —— 纯信息，不含"已安装/已应用"这类字段。 */
  readonly newOrChanged: readonly CatalogUpdateChange[];
  /** 前提 3 拦下的条目，便于调用方/用户看到"远端试图改钉死项"这件事本身。 */
  readonly rejectedBundledTampering: readonly BundledIntegrityViolation[];
}

export interface CheckForUpdatesOptions<T extends CatalogUpdateEntry> {
  /** 未设（undefined/null/空串）即视为"这台机器没有可问的远端"，非错误。 */
  readonly catalogUrl: string | null | undefined;
  readonly signatureUrl: string | null | undefined;
  /** 调用方已经加载好的本地/包内目录条目 —— 本函数只读，从不重新加载它。 */
  readonly localEntries: readonly T[];
  /** D-20 §11.3 前提 3 的钉死集合（daemon 侧传 `BUNDLED_MODEL_IDS`）。 */
  readonly bundledIds: ReadonlySet<string>;
  /** 把已验签的原始 JSON 转成条目数组；结构不对返回 null（视为 parse-failed）。 */
  readonly parseCatalog: (raw: unknown) => readonly T[] | null;
  readonly publicKey?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly allowedHosts?: readonly string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

const EMPTY = {
  newOrChanged: [] as readonly CatalogUpdateChange[],
  rejectedBundledTampering: [] as readonly BundledIntegrityViolation[],
};

/**
 * 唯一的编排入口。**只读、只网络、只返回数据** —— 不写数据目录、不入下载队列、
 * 不触发安装。任何一步失败都落到"回退"分支：`newOrChanged` 为空、`source` 说明原因，
 * 从不抛出、从不产出"没有目录"这种结果（那句话专属于本地目录加载失败，与本函数无关，
 * 见调用方 `updates.ts` 对 `loadError` 的单独处理）。
 */
export async function checkForUpdates<T extends CatalogUpdateEntry>(
  opts: CheckForUpdatesOptions<T>,
): Promise<CatalogUpdateResult> {
  const checkedAt = nowIso();

  if (!opts.catalogUrl || !opts.signatureUrl) {
    return {
      source: 'not-configured',
      checkedAt,
      detail:
        '未配置远端目录地址（OPENMEMO_CATALOG_UPDATE_URL / _SIG_URL 未设）—— ' +
        '这不是失败，是这台机器还没有可问的远端；本地/包内目录不受影响',
      ...EMPTY,
    };
  }

  let catalogHost: string;
  let sigHost: string;
  try {
    catalogHost = new URL(opts.catalogUrl).hostname;
    sigHost = new URL(opts.signatureUrl).hostname;
  } catch {
    return {
      source: 'host-not-allowed',
      checkedAt,
      detail: '目录/签名 URL 不是合法 URL —— 回退，不下载',
      ...EMPTY,
    };
  }
  const allowed = opts.allowedHosts;
  if (allowed && (!allowed.includes(catalogHost) || !allowed.includes(sigHost))) {
    return {
      source: 'host-not-allowed',
      checkedAt,
      detail: `host 不在白名单内（${catalogHost} / ${sigHost}）—— 回退到包内目录，不下载`,
      ...EMPTY,
    };
  }

  const doFetch = opts.fetchImpl ?? fetch;
  let catalogBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    const [catalogRes, sigRes] = await Promise.all([
      doFetch(opts.catalogUrl),
      doFetch(opts.signatureUrl),
    ]);
    if (!catalogRes.ok || !sigRes.ok) {
      throw new Error(`HTTP ${String(catalogRes.status)}/${String(sigRes.status)}`);
    }
    catalogBytes = new Uint8Array(await catalogRes.arrayBuffer());
    signatureBytes = new Uint8Array(await sigRes.arrayBuffer());
  } catch (e) {
    return {
      source: 'fetch-failed',
      checkedAt,
      detail:
        `拉取远端目录失败：${e instanceof Error ? e.message : String(e)} —— ` +
        `回退到包内目录，不是"没有目录"`,
      ...EMPTY,
    };
  }

  const publicKey =
    opts.publicKey !== undefined ? opts.publicKey : resolveConfiguredCatalogPublicKey();
  if (publicKey == null) {
    return {
      source: 'no-key-configured',
      checkedAt,
      detail:
        '没有配发签名公钥（OPENMEMO_CATALOG_PUBLIC_KEY_HEX 未设、也未编译进二进制）—— ' +
        'fail-closed，回退到包内目录',
      ...EMPTY,
    };
  }

  const verified = verifyCatalogSignatureSafe(catalogBytes, signatureBytes, publicKey);
  if (!verified) {
    return {
      source: 'verify-failed',
      checkedAt,
      detail: '签名校验未通过 —— 拒绝这份远端目录，回退到包内目录，不是"没有目录"',
      ...EMPTY,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(catalogBytes).toString('utf8'));
  } catch (e) {
    return {
      source: 'parse-failed',
      checkedAt,
      detail: `远端目录不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
      ...EMPTY,
    };
  }
  const remoteEntries = opts.parseCatalog(raw);
  if (remoteEntries === null) {
    return { source: 'parse-failed', checkedAt, detail: '远端目录结构校验未通过', ...EMPTY };
  }

  const localById = new Map(opts.localEntries.map((e) => [e.id, { files: e.files }]));
  const { accepted, rejected } = checkBundledIntegrity(remoteEntries, localById, opts.bundledIds);

  const newOrChanged: CatalogUpdateChange[] = [];
  for (const entry of accepted) {
    const local = localById.get(entry.id);
    if (!local) {
      newOrChanged.push({ id: entry.id, reason: '本地未安装（新增项）' });
    } else if (!sameFiles(local.files, entry.files)) {
      newOrChanged.push({ id: entry.id, reason: '本地已装但文件内容不同（有更新）' });
    }
  }

  return {
    source: 'verified',
    checkedAt,
    detail: `已验签，远端 ${String(accepted.length)} 项，其中 ${String(newOrChanged.length)} 项是新增/有更新`,
    newOrChanged,
    rejectedBundledTampering: rejected,
  };
}
