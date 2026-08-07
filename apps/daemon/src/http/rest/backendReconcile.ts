/**
 * 启动对账：**盘上真的装着、却没有安装记录**的后端包，补一份记录。
 *
 * ══ 这修的是哪个用户症状 ══════════════════════════════════════════════════════
 *
 * `/runtime` 对**已经装好的** ffmpeg 显示「安装 119 MB」，点下去把 119 MB 重下一遍。
 * 用户亲眼看到过（`gates-fix §5.2`）。
 *
 * ══ 成因：全仓有两个互不相干的「已安装」════════════════════════════════════════
 *
 * | | 判据 | 谁读 |
 * |---|---|---|
 * | **A 盘上真的有文件** | `resolveBackendTool()` 扫 `by-name/backend/**` | `discoverTools()` → `/api/daemon/status` 的 `missing`；`/api/selfcheck` 的 `tool.ffmpeg`；流水线真正要跑的那个二进制 |
 * | **B 有一份安装 manifest** | `manifests/backend/<id>.json` 存在 | `/api/backends/catalog` 的 `installed` → `/runtime` 的按钮；`/api/components` 的 `installedVersion`；`DELETE /api/backends/:id`；`recordSelfTest()` 往哪写 |
 *
 * **B 的写入方全仓只有一处**：`startPackInstall()` 里那句 `writeManifest`。
 * 而安装器是**刻意**"blob 先落、manifest 最后写"的（中途崩只留可回收的孤儿 blob，
 * 绝不留指向不存在文件的 manifest）—— 所以「A 有 B 没有」**按设计就会发生**：
 * 装到一半崩在 `writeManifest` 之前、冷启动脚本、手工解包、旧版本的安装流程。
 * `resolveBackendTool()` 自己的排序规则里就为这种目录留了一档
 * （"没有安装清单的目录排最后"），也就是说 **A 这一侧早就知道 B 可能缺**。
 *
 * ══ 为什么选「启动对账」而不是「catalog 现算」════════════════════════════════════
 *
 * `gates-fix §5.2` 给了两条路，我选第 1 条，理由是**第 2 条会造出第三个答案**：
 *
 * 把 `/api/backends/catalog` 的 `installed` 改成「有 manifest **或** 文件都在」，
 * 那一格确实会变绿 —— 但同一台机器上：
 *   · `GET /api/backends/installed` 仍然列不出它（它列的是 manifest）；
 *   · `DELETE /api/backends/:id` 仍然 **404**「未安装该后端包」
 *     → 用户看到「已安装」，点卸载，被告知没装；
 *   · `/api/components` 的 `installedVersion` 仍然是 `null`（`readInstalledVersions` 读 manifest）；
 *   · `recordSelfTest()` 仍然写不进去（它按 id 找 manifest）→ 自检结果照样落不了地。
 * 也就是说：那样只是把「装没装」从两个答案变成**三个**，而 Manager 给的判据是
 * **"同一台机器上，装没装只准有一个回答的人"**。
 *
 * 补一份记录则相反：B 被补齐之后，上面五个读取方**同时**变对，
 * 而且「唯一的事实来源仍然是 manifest」这条不变 —— 没有引入任何新的判据。
 * 顺带还多修一件事：`resolveBackendTool()` 的排序要从安装记录里读 `backend` 与
 * `priority`，没有记录的目录一律落到最后一档；补上之后**用户选的加速后端才真的排得上**
 * （T-162 那条修复对这类目录此前是空转的）。
 *
 * ⚠️ **没有再写一个"扫盘找已安装"的实现**（那就是第三份 A）。
 * 判据全部是**安装器精确落点的查表**，用的是安装器与发现侧共用的那份约定
 * （`unpackDirName`，`@openmemo/downloader` 导出、`resolveBackendTool` 反向用它归属目录）。
 *
 * ══ 补出来的记录必须诚实 ══════════════════════════════════════════════════════
 *
 * 「补记录」很容易变成"照着目录抄一份"，那就成了**发明一条不成立的证据** ——
 * 比 `installed:false` 坏得多（`recordSelfTest` 的认领防线是同一条原则）。所以：
 *
 * - **sha256 是现算的**，不是从目录里抄的。`by-name/backend/<name>` 是安装器
 *   `linkByName()` 建的硬链，指向内容寻址的 blob 本身 —— 它就是那份归档的字节。
 *   算出来与目录声明的**不一致就不补**：那说明盘上躺着的是**另一个版本**
 *   （`[实测 :10000]` 就有这一格：盘上是 ffmpeg 7.1.5，目录已经升到 8.1.2）。
 *   把它记成"已安装 media-tools"是把"版本不对"伪装成"一切正常"。
 * - **`installedAt` 取那条链的 mtime**，不是 `Date.now()` —— 它不是现在装的。
 * - `verifiedAt` 才是现在：我们**刚刚**逐字节校验过，这一条是真的。
 * - `selfTest: null` —— 从来没跑过。
 * - **只对得上本机 os/arch 的包**才参与。不加这条的话，三个 `ytdlp-*` 包
 *   在 `backends.json` 里**归档文件名逐字相同**（`yt-dlp`），
 *   补一个 linux 的 yt-dlp 会顺带把 macOS / arm64 那两个也宣布成已安装。
 */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';

import { unpackDirName, type ArtifactStore } from '@openmemo/downloader';
import type { BackendPack, InstalledBackendPack, PlatformSelector } from '@openmemo/shared';

import { toInstalledRecord } from './backends.js';

export interface ReconcileReport {
  /** 补出记录的包（附本次实测的字节数）。 */
  readonly reconciled: { readonly packId: string; readonly bytes: number }[];
  /**
   * 没补的包 + 原因。**只收"盘上看起来有点东西、但我们不敢认"的那些** ——
   * 目录里几百个别的平台的包不会进来刷屏。
   */
  readonly skipped: { readonly packId: string; readonly reason: string }[];
}

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export interface ReconcileOptions {
  readonly store: ArtifactStore;
  readonly packs: readonly BackendPack[];
  readonly platform: PlatformSelector;
}

export async function reconcileBackendManifests(opts: ReconcileOptions): Promise<ReconcileReport> {
  const byName = opts.store.byNameDir('backend');
  const reconciled: { packId: string; bytes: number }[] = [];
  const skipped: { packId: string; reason: string }[] = [];

  for (const pack of opts.packs) {
    if (pack.os !== opts.platform.os || pack.arch !== opts.platform.arch) continue;
    if (await opts.store.readManifest<InstalledBackendPack>('backend', pack.id)) continue;

    const files: { name: string; sha256: string; sizeBytes: number; path: string }[] = [];
    let mtimeMs = Number.POSITIVE_INFINITY;
    let reject: string | null = null;
    /** 这个包**在这台机器上留下过痕迹**吗（否则连"跳过"都不必报，它本来就没装）。 */
    let sawSomething = false;

    for (const f of pack.files) {
      const link = path.join(byName, f.name);
      let st;
      try {
        st = await fs.stat(link);
      } catch {
        reject = null; // 完全没有痕迹 = 本来就没装，不是异常
        break;
      }
      sawSomething = true;
      if (!st.isFile()) {
        reject = `${f.name} 在 by-name 里不是一个文件`;
        break;
      }
      if (st.size !== f.sizeBytes) {
        reject = `${f.name} 大小是 ${String(st.size)}，目录说应当是 ${String(f.sizeBytes)} —— 盘上是另一个版本`;
        break;
      }
      /*
       * 归档包：解包目录必须**已经在最终位置上**。
       * 安装器是"解到 temp、成功了才 rename 进来"，所以"目录在" ⇒ 解包跑完了
       * （它自己的注释写着：temp-then-rename makes a partial directory impossible,
       * so "directory exists" is once again a truthful signal that the install completed）。
       */
      if (f.unpack) {
        const dir = path.join(byName, unpackDirName(f.name));
        try {
          if (!(await fs.stat(dir)).isDirectory()) {
            reject = `${f.name} 的解包目录不是目录`;
            break;
          }
        } catch {
          reject = `${f.name} 的归档在，解包目录 ${unpackDirName(f.name)} 不在 —— 装到一半，没装完`;
          break;
        }
      }
      const digest = await sha256File(link);
      if (digest !== f.sha256) {
        reject = `${f.name} 的 sha256 与目录声明的不符 —— 盘上是另一个版本，不能记成"已安装 ${pack.id}"`;
        break;
      }
      files.push({ name: f.name, sha256: digest, sizeBytes: st.size, path: link });
      mtimeMs = Math.min(mtimeMs, st.mtimeMs);
    }

    if (reject !== null) {
      skipped.push({ packId: pack.id, reason: reject });
      continue;
    }
    if (!sawSomething || files.length !== pack.files.length) continue;

    const record: InstalledBackendPack = {
      ...toInstalledRecord(pack, files),
      // 它不是现在装的 —— 用那条链的 mtime，那是我们手上唯一真实的时间证据
      installedAt: new Date(mtimeMs).toISOString(),
      // 这一条才是"现在"：上面每个文件都刚被逐字节校验过
      verifiedAt: new Date().toISOString(),
      integrity: 'ok',
    };
    await opts.store.writeManifest('backend', pack.id, record);
    reconciled.push({ packId: pack.id, bytes: files.reduce((a, f) => a + f.sizeBytes, 0) });
  }

  return { reconciled, skipped };
}
