# inbox / runner-migrate

## [2026-08-07 12:10] T-163 SHARED-CHANGE 申报（动 manifest 之前）

`git status --short` 此刻有 30 个改动文件，全部是 `pack-select` 那一片
（`packages/pipeline/src/tools.ts`、`packages/runtime/src/selfcheck.ts`、
`apps/daemon/src/**`、`apps/web/src/**`）加上我自己的四条。
**`vendor/manifests/` 没有任何人的在途改动。**

我接下来要改：

| 文件 | 改什么 | 冲突风险 |
|---|---|---|
| `vendor/manifests/components.json` | 只改 `media-tools-macos-arm64` 一条：`v7.1.4-3` → `v8.1.2-2`（`pinnedVersion` / `releaseUrl` / `sizeBytes` / `sha256` / `sha256Provenance`），并把该条的 `stableOnly` 由 `true` 放松成 `false`、补 `tagPattern` | 低 |
| `vendor/manifests/backends.json` | 同上那条的 `engineVersion` / 文件名 / `sizeBytes` / `sha256` / mirror URL / `totalSizeBytes` | 低 |
| `.github/workflows/build-backends.yml` · `scripts/ci/*` · `package.json`（一行） | 我的地盘（T-163 ①） | 低 |

**`stableOnly` 只对这一条放开，不动全局**（其它 21 条一个字节不改）。理由写进
`sha256Provenance`，不是只翻一个布尔值 —— 见下一条回执 §2。

反向验证一律跑在 `/tmp/runner-migrate/` 的隔离副本上（PROTOCOL §10）。
