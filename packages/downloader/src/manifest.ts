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
 * ⚠️ **今天（截至上一段写下时）目录的实际完整性保障不是签名，是另外两件东西**：
 *   (a) 每个产物在 `vendor/manifests/*.json` 里带 git 提交过的 SHA-256，下载后强制校验；
 *   (b) 镜像 URL 被编译期 host 白名单钉死（见 `@openmemo/shared` 的 `schemas.ts`
 *       `ALLOWED_DOWNLOAD_HOSTS`）。
 *
 * ⚠️ **2026-08-10（D-20 §17）更新，别再当上面那段是全部真相**：用户裁定"检测更新"是
 * 一次合法的设计回摆（ADR-010 §附-A / ADR-012 §附-B 记录的删除决定被部分推翻，
 * 推翻范围与理由见那两份 ADR 各自新增的"被取代"附注）。`verifyCatalogSignature`
 * 现在**有真实生产调用方**：`apps/daemon/src/http/rest/updates.ts` 的
 * `GET /api/updates/check`，经 `./catalogUpdate.js` 的 `checkForUpdates()` 调用。
 * 但"生产从不联网加载目录"这句话的**核心结论没有变**——`vendor/manifests` 本身仍是
 * 随包出厂、`fs.readdir` 本地读盘；新增的只是一条**独立的、只读的、失败即回退**的
 * "有没有更新"旁路查询，从不替换/重新加载本地目录本身。见 `catalogUpdate.ts` 与
 * D-20 §17 的完整设计。
 */

import { resolveConfiguredCatalogPublicKey, verifyEd25519 } from './signature.js';

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
 * ⚠️ **2026-08-10 更新，下面这句话曾经是真的，现在不是**：~~它在生产路径上零调用方。~~
 * `apps/daemon/src/http/rest/updates.ts` 的 `GET /api/updates/check` 现在是**真实生产
 * 调用方**（经 `catalogUpdate.ts`）。但**编译进二进制的默认公钥依然是 `null`**
 * （从没有配发过密钥，见 `signature.ts` 的 `OPENMEMO_CATALOG_PUBLIC_KEY`），全仓也
 * **依然没有任何东西会产出 `.sig`** —— 用户还没有运行过 D-20 §17 那条 keygen+签名命令。
 * 所以调用方是真的，但"验证会成功"这件事在今天的默认配置下**仍然不会发生**：
 * 没设 `OPENMEMO_CATALOG_PUBLIC_KEY_HEX` 时，`checkForUpdates()` 在第一步就会因为
 * "没有配发密钥"提前返回 `source: 'no-key-configured'`，根本不会走到网络请求。
 *
 * ⚠️ 那份跑它的脚本 `verify-unpack.mjs` **没有任何自动调用方**（不在任何 package.json
 * scripts、不在任何 workflow）。所以本函数今天的真实覆盖是"有人手敲的时候才有"。
 *
 * Fail-closed by design: 调用方给了签名却没有配密钥（`publicKey` 参数与
 * `resolveConfiguredCatalogPublicKey()` 都是 null）时 **抛错**，而不是返回 `true` 或
 * 静默跳过。一个没人能验的签名绝不能被当成"已验证" —— 那比不验还糟，因为它看起来是
 * 安全的而实际是空操作。
 *
 * 默认参数从 2026-08-10 起改成 `resolveConfiguredCatalogPublicKey()`（原先是直接读
 * `OPENMEMO_CATALOG_PUBLIC_KEY` 常量）—— 这样一来，只要用户按 D-20 §17 的命令设了
 * `OPENMEMO_CATALOG_PUBLIC_KEY_HEX`，不用改代码/不用等下个发布，这个函数的默认行为
 * 就会用上真钥匙。两者在**没有设环境变量时行为完全相同**（都是 null，仍然 fail-closed）——
 * `verify-unpack.mjs:706` 断言 `OPENMEMO_CATALOG_PUBLIC_KEY === null` 钉的是编译进
 * 二进制的默认值本身，不受这次改动影响。
 */
export async function verifyCatalogSignature(
  catalogBytes: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array | string | null = resolveConfiguredCatalogPublicKey(),
): Promise<boolean> {
  if (publicKey == null) {
    throw new Error(
      'verifyCatalogSignature: a signature was supplied but no catalog signing key is ' +
        'configured (OPENMEMO_CATALOG_PUBLIC_KEY is null and OPENMEMO_CATALOG_PUBLIC_KEY_HEX ' +
        'is unset — no key has been provisioned yet). Failing closed rather than silently ' +
        'accepting an unverifiable signature.',
    );
  }
  return verifyEd25519(catalogBytes, signature, publicKey);
}

/**
 * Same crypto as `verifyCatalogSignature`, but **never throws** — every failure mode,
 * including "no key configured", collapses to `false`.
 *
 * `verifyCatalogSignature` must keep throwing on the no-key case: `verify-unpack.mjs`
 * §9 asserts on that exact throw (`errDefault != null`), and ADR-012 决策 6 / ADR-010
 * §附-A's "fail-closed, 不返回 true、不跳过" ruling is specifically about that function.
 * Changing its behavior would silently invalidate both.
 *
 * This wrapper exists for D-20 §17 precondition 2 ("验不过要回退到包内那一份") —
 * `catalogUpdate.ts`'s `checkForUpdates()` needs a plain boolean to branch on at each of
 * several failure points (network, host allowlist, missing key, bad signature) without a
 * try/catch around every one of them. A thrown exception and a "verification failed"
 * boolean must be handled identically by that caller (both mean "fall back to the bundled
 * catalog"), so collapsing them here removes a place that distinction could be dropped.
 */
export function verifyCatalogSignatureSafe(
  catalogBytes: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array | string | null = resolveConfiguredCatalogPublicKey(),
): boolean {
  if (publicKey == null) return false;
  return verifyEd25519(catalogBytes, signature, publicKey);
}
