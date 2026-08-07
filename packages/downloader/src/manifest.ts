/**
 * Catalog signature verification.
 *
 * ── 这个文件为什么叫 manifest.ts，里面却没有 manifest 加载 ────────────────────────
 *
 * 2026-08-07（T-171）之前，本文件是一个 `remote → cache → bundled` 三层降级的目录加载器
 * （`loadManifest` / `loadModelManifest` / `loadBackendManifest`，含全仓唯一一处取目录的
 * `fetch`）。**整族已被用户裁决删除**，理由见 ADR-010 §决策 4 订正 / ADR-012 §决策 6 订正：
 *
 *   · 生产**从来没有远端目录可加载**。目录是 `vendor/manifests/*.json`，git 跟踪、随仓库
 *     发布；daemon 走 `apps/daemon/src/http/rest/manifests.ts` 的 `fs.readdir` 本地读盘，
 *     全程不联网。那个分层加载器**零调用方、零测试**，两个月没动过。
 *   · 将来真要做远端目录，应当对着那时候的约束重新设计，而不是复活一份从未运行过的实现。
 *     **git 历史留着它**（删除前 HEAD `26fdd1f`）。
 *
 * 文件名保留不改，因为 `packages/downloader/scripts/verify-unpack.mjs:50` 用
 * `await import(dist/manifest.js)` 在**顶层**引它 —— 改名会让那份脚本在模块加载阶段就
 * `ERR_MODULE_NOT_FOUND`，连带 53 条解包安全断言全挂。要改名请连它一起改。
 *
 * ⚠️ **今天目录的实际完整性保障不是签名，是另外两件东西**，别看到本文件就以为目录被验签了：
 *   (a) 每个产物在 `vendor/manifests/*.json` 里带 git 提交过的 SHA-256，下载后强制校验；
 *   (b) 镜像 URL 被编译期 host 白名单钉死（见 `@openmemo/shared` 的 `schemas.ts`
 *       `ALLOWED_DOWNLOAD_HOSTS`）。
 * 签名这条线**没有密钥、没有签名产物、没有签名脚本**，见下面函数的文档注释。
 */

import { OPENMEMO_CATALOG_PUBLIC_KEY, verifyEd25519 } from './signature.js';

/**
 * Detached-signature verification for catalogs.
 *
 * ── 状态（老老实实写清楚）─────────────────────────────────────────────────────────
 *
 * 验签本体（Ed25519 via node:crypto，见 signature.ts）**是完整且正确的**，并且**真的被跑过**：
 * `packages/downloader/scripts/verify-unpack.mjs` 第 8/9 节共 13 条断言拿真实生成的
 * Ed25519 密钥对跑它 —— 真签名通过、篡改载荷返 false、异密钥返 false、无密钥抛错。
 * 所以它**不是**没跑过的加密代码。
 *
 * 但**同样老实**的是：它在**生产路径上零调用方**。`OPENMEMO_CATALOG_PUBLIC_KEY` 是 `null`
 * （从没有配发过密钥），全仓也**没有任何东西会产出 `.sig`**。原先"未来会把它接进远端取目录
 * 那条路"的说法已经过期 —— 那条路 T-171 已被删除（见文件头）。
 *
 * ⚠️ 那份跑它的脚本 `verify-unpack.mjs` **没有任何自动调用方**（不在任何 package.json
 * scripts、不在任何 workflow）。所以本函数今天的真实覆盖是"有人手敲的时候才有"。
 *
 * Fail-closed by design: 调用方给了签名却没有配密钥（`publicKey` 参数与模块默认值都是 null）
 * 时 **抛错**，而不是返回 `true` 或静默跳过。一个没人能验的签名绝不能被当成"已验证" ——
 * 那比不验还糟，因为它看起来是安全的而实际是空操作。
 */
export async function verifyCatalogSignature(
  catalogBytes: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array | string | null = OPENMEMO_CATALOG_PUBLIC_KEY,
): Promise<boolean> {
  if (publicKey == null) {
    throw new Error(
      'verifyCatalogSignature: a signature was supplied but no catalog signing key is ' +
        'configured (OPENMEMO_CATALOG_PUBLIC_KEY is null — no key has been provisioned yet). ' +
        'Failing closed rather than silently accepting an unverifiable signature.',
    );
  }
  return verifyEd25519(catalogBytes, signature, publicKey);
}
