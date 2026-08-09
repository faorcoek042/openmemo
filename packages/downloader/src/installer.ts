/**
 * Install orchestration — the layer that turns a manifest entry into installed files.
 *
 * Serves BOTH models and GPU backend packs (ADR-003 decision 6). They differ only in
 * which manifest they came from and where the result is linked; download, verify,
 * resume, mirror failover and GC are identical, so they share one implementation.
 *
 * Order of operations, and why:
 *   1. disk pre-check      — fail before transferring gigabytes
 *   2. download each file  — resumable, mirror-failing-over
 *   3. verify each file    — SHA-256; nothing is installed until this passes
 *   4. blob lands in store — atomic rename
 *   5. hardlink by-name    — human/native-tool visible path
 *   6. write manifest LAST — so a crash leaves a reclaimable orphan blob, never a
 *                            manifest pointing at a file that does not exist
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ArtifactFile, PlatformSelector } from '@openmemo/shared';
import { DownloadError, type DownloadSource, downloadFile } from './download.js';
import { type ProbeOutcome, type ProbeTarget, orderSourcesForDownload } from './probe.js';
import type { ArtifactStore, StoreKind } from './store.js';
import { toPortableRecord } from './store.js';
import { unpackArchive } from './unpack.js';

export interface InstallTarget {
  id: string;
  kind: StoreKind;
  displayName: string;
  files: ArtifactFile[];
}

export interface InstallOptions {
  store: ArtifactStore;
  target: InstallTarget;
  /** User's pinned provider, or "auto" / null for probe-ranked ordering. */
  pinnedProvider?: string | null;
  /** Latest probe results used to rank mirrors. */
  probes?: ProbeOutcome[];
  /** Current platform, used to filter platform-specific files. */
  platform?: PlatformSelector;
  /** Optional file roles to include beyond the required set. */
  includeOptional?: string[];
  signal?: AbortSignal;
  token?: string;
  maxParts?: number;
  /**
   * Expand the archive into this directory instead of `by-name/<bucket>/`,
   * relative to `dataRoot`.
   *
   * ⚠️ **This REPLACES the directory.** Extraction is made atomic by unpacking to a temp
   * directory, deleting the target, then renaming into place — so whatever was there
   * before is gone.
   *
   * Therefore it must never point at a directory that two packs share. This was almost
   * wired up to the manifests' `bin/ext`, which all eleven SQLite-extension packs
   * declare: installing libsimple and then sqlite-vec would have deleted libsimple, with
   * a successful job, a matching checksum and no error anywhere. Extensions that must
   * coexist are LINKED into place afterwards (`BackendPack.linkInto` +
   * `materializeSqliteExtensions`), which adds files rather than replacing a directory.
   *
   * The name is deliberately not `installPath`: "install path" reads as "where this pack
   * lives", which is exactly the reading that makes the destructive mistake look correct.
   */
  unpackInto?: string;
  /** Root that `unpackInto` is relative to. Defaults to the models root's parent. */
  dataRoot?: string;
  onProgress?: (p: {
    completedBytes: number;
    totalBytes: number;
    speedBps: number;
    etaSeconds: number | null;
    fileIndex: number;
    fileCount: number;
    currentFile: string;
    phase: string;
    provider: string;
    /** 解包比例（0–1）。只有 `phase === 'unpacking'` 时给，且**分母是真的**。 */
    unpackedRatio?: number;
  }) => void;
  onFileDone?: (f: InstalledFileRecord) => void;
}

export interface InstalledFileRecord {
  role: string;
  name: string;
  sha256: string;
  sizeBytes: number;
  /** Root for `relPath`. Portable across data-directory moves. */
  root: 'models';
  /** Path relative to the models root, POSIX separators. */
  relPath: string;
  /**
   * @deprecated Absolute path, emitted only so consumers that have not migrated keep
   * working. Read via `resolveInstalledFile()` instead.
   */
  path: string;
  provider: string;
  cached: boolean;
}

export interface InstallResult {
  id: string;
  files: InstalledFileRecord[];
  totalBytes: number;
  bytesTransferred: number;
  /** Absolute directory an archive was expanded into, when one was. */
  installedTo?: string;
}

/** Does this file apply to the current platform? */
export function fileAppliesTo(f: ArtifactFile, platform?: PlatformSelector): boolean {
  if (!f.platforms || f.platforms.length === 0) return true;
  if (!platform) return true;
  return f.platforms.some(
    (p) =>
      p.os === platform.os &&
      p.arch === platform.arch &&
      (p.backend == null || p.backend === platform.backend),
  );
}

export function selectFiles(
  files: ArtifactFile[],
  platform?: PlatformSelector,
  includeOptional: string[] = [],
): ArtifactFile[] {
  return files.filter((f) => {
    if (!fileAppliesTo(f, platform)) return false;
    if (f.optional && !includeOptional.includes(f.role)) return false;
    return true;
  });
}

/** Free bytes on the volume holding `dir`. Returns null when the platform cannot report it. */
export async function freeSpaceBytes(dir: string): Promise<number | null> {
  try {
    const st = await fs.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

export async function install(opts: InstallOptions): Promise<InstallResult> {
  const { store, target } = opts;
  await store.init();

  const files = selectFiles(target.files, opts.platform, opts.includeOptional);
  if (files.length === 0) {
    throw new DownloadError(
      `No files applicable to this platform for ${target.id}`,
      'NOT_FOUND',
      false,
    );
  }

  // Only count what we actually have to fetch — an already-present blob costs nothing.
  let needBytes = 0;
  for (const f of files) {
    if (!(await store.hasBlob(f.sha256))) needBytes += f.sizeBytes;
  }

  // Disk pre-check with 10% headroom for the concurrent .partial + final file.
  const free = await freeSpaceBytes(store.root);
  if (free != null && free < needBytes * 1.1) {
    throw new DownloadError(
      `Not enough disk space: need ~${Math.ceil((needBytes * 1.1) / 1e6)} MB, ${Math.floor(free / 1e6)} MB free`,
      'DISK_FULL',
      false,
    );
  }

  const totalBytes = files.reduce((a, f) => a + f.sizeBytes, 0);
  const records: InstalledFileRecord[] = [];
  let completedBefore = 0;
  let bytesTransferred = 0;
  let expandedTo: string | undefined;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];

    const targets: ProbeTarget[] = f.mirrors.map((m) => ({
      provider: m.provider,
      url: m.url,
      official: m.official,
    }));
    const ordered = orderSourcesForDownload(targets, opts.probes ?? [], opts.pinnedProvider);
    const sources: DownloadSource[] = ordered.map((t) => ({
      provider: t.provider,
      url: t.url,
      official: t.official,
    }));

    /*
     * ★ 逐步打点（`OPENMEMO_TIMING=1` 打开）。
     *
     * 用户 `[真机 2026-08-09]`：「其他组件都能下，只是卡在验证校验值那一步」，
     * 且**连 2.3 MB 的也卡** —— 2.3 MB 算 sha256 是毫秒级，
     * **所以慢的一定不在哈希上**。而它最终会完成，**所以是"久"不是"死"**。
     * 也就是说时间花在「校验之后、完成之前」的某一步，而界面全程不吭声。
     *
     * 在拿到每一步的真实毫秒数之前，任何修法都是猜。打点只加观测、不改行为。
     */
    const TIMING = process.env['OPENMEMO_TIMING'] === '1';
    const t0 = Date.now();
    let tMark = t0;
    const mark = (label: string): void => {
      if (!TIMING) return;
      const now = Date.now();
      console.log(`[timing] ${f.name} · ${label}: ${now - tMark}ms (累计 ${now - t0}ms)`);
      tMark = now;
    };

    const res = await downloadFile({
      sha256: f.sha256,
      sizeBytes: f.sizeBytes,
      sources,
      blobDir: store.blobDir,
      signal: opts.signal,
      token: opts.token,
      maxParts: opts.maxParts,
      onProgress: (p) => {
        opts.onProgress?.({
          completedBytes: completedBefore + p.completedBytes,
          totalBytes,
          speedBps: p.speedBps,
          etaSeconds: p.etaSeconds,
          fileIndex: i,
          fileCount: files.length,
          currentFile: f.name,
          phase: p.phase,
          provider: p.provider,
        });
      },
    });

    bytesTransferred += res.bytesTransferred;
    completedBefore += f.sizeBytes;

    mark('下载+校验（downloadFile 内含 sha256 与比对）');
    const linked = await store.linkByName(target.kind, f.sha256, f.name);
    mark('硬链接 linkByName');

    // Archives are expanded only after their digest has been verified — never unpack
    // unverified bytes.
    //
    // Extraction goes to a TEMP directory and is renamed into place only on success.
    //
    // Why: a failure partway through used to leave a half-extracted directory behind.
    // That state is worse than no state at all — the blob is already verified and cached,
    // so a retry skips the download, sees the directory exists, and the user is stuck
    // permanently at "installed but unusable" with clicking again changing nothing.
    // Observed for real: a 43-entry tarball left 3 files after aborting on the first
    // symlink entry, and whisper-cli was simply absent with no way to recover from the UI.
    // Temp-then-rename makes a partial directory impossible, so "directory exists" is
    // once again a truthful signal that the install completed.
    if (f.unpack) {
      // Honour an explicit unpack target when given; otherwise keep the by-name layout.
      const finalDir = opts.unpackInto
        ? path.resolve(opts.dataRoot ?? path.join(store.root, '..'), opts.unpackInto)
        : path.join(store.byNameDir(target.kind), unpackDirName(f.name));
      const tmpDir = `${finalDir}.tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
        /*
         * ★ 解包期间必须播报，否则界面上显示的是**上一档** `verifying`
         * —— 而那句话是不实的：产品这时在解包，不在校验。
         * 用户已经因此误报过一次原因（"卡在验证校验值"）。
         *
         * ⚠️ **节流在这里，不在 `unpack.ts` 里**：与下载那条同一个理由
         * （8MB/s 不节流会打满渲染循环；解包几千个小文件同样能打满），
         * 也同一个速率（~4 Hz）。在 unpack 内部节流会让"解包走到哪了"不可观测。
         */
        let lastUnpackEmit = 0;
        await unpackArchive(linked, tmpDir, f.unpack, {
          signal: opts.signal,
          onProgress: (done, total, unit) => {
            const now = Date.now();
            if (now - lastUnpackEmit < 250) return;
            lastUnpackEmit = now;
            /*
             * `pct` 只在有真分母时给 —— 两种格式都给得出（zip 条目数 / tar 字节数），
             * 所以这里不会出现编造的百分比。`total<=0` 时宁可不报比例。
             */
            const ratio = total > 0 ? done / total : 0;
            opts.onProgress?.({
              completedBytes: completedBefore + f.sizeBytes,
              totalBytes,
              speedBps: 0,
              etaSeconds: null,
              fileIndex: i,
              fileCount: files.length,
              currentFile: unit === 'entries' ? `${f.name}（${done}/${total}）` : f.name,
              phase: 'unpacking',
              provider: 'local',
              unpackedRatio: ratio,
            });
          },
        });
        mark('解包 unpackArchive');
        // Replace any previous (possibly incomplete) install atomically.
        await fs.rm(finalDir, { recursive: true, force: true });
        await fs.mkdir(path.dirname(finalDir), { recursive: true });
        /*
         * ★ 归档自带一层同名顶层目录时，把它压掉（见 `collapseRedundantTopLevel` 的说明）。
         * 不压的话结果是 `<X>/<X>/…`，外层是个空壳 —— 而消费方按 `<X>/…` 去找。
         */
        const source = await collapseRedundantTopLevel(tmpDir, path.basename(finalDir));
        await fs.rename(source, finalDir);
        mark('落位 rename');
        if (source !== tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
        expandedTo = finalDir;
      } catch (e) {
        /*
         * Leave nothing NEW behind: no temp dir, no by-name link to the archive (a dangling
         * link makes "is this installed?" ambiguous for both the UI and the GC scan).
         * The blob itself stays: it is verified, and keeping it makes the retry free.
         *
         * ★ T-157 ②：**这里原来还有一句 `fs.rm(finalDir)`，删掉了 —— 它会毁掉用户
         * 当前能用的那一份安装。**
         *
         * 那句是 temp-then-rename 之前留下的：当时解包直接写进 `finalDir`，失败会留下
         * 半个目录，所以要清。改成"先解到 temp、成功了才换入"之后，
         * **失败时 `finalDir` 里躺着的是上一版完整的安装，不是半成品** ——
         * 而它照样被删了。于是「更新一次，解包失败」= 组件从"旧版可用"直接变成"没装"。
         *
         * 逐条走一遍现在还需不需要清它：
         *   · `unpackArchive` 抛      → 还没走到 `rm(finalDir)`，旧目录完整，**不该动**；
         *   · `rm(finalDir)` 自己抛   → 旧目录还在（或部分删除，此时删也删不掉）；
         *   · `collapse`/`rename` 抛  → `finalDir` 已经不存在了，删它是 no-op。
         * 三条里没有一条需要它。**它唯一确定会做成的事，就是删掉那份还能用的安装。**
         *
         * 这条与 T-157 ② 拿掉"一键回滚"是同一件事的两半：回滚要救的是
         * "更新成功但新版本坏了"，而"更新失败"本就不该需要回滚 —— 它不该破坏任何东西。
         */
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
        await fs.rm(linked, { force: true }).catch(() => undefined);
        throw new DownloadError(
          `Archive extraction (${f.unpack}) failed for ${f.name}: ${(e as Error).message}`,
          'UNPACK_FAILED',
          // Retryable: the bytes are verified, so a retry is cheap and may well succeed
          // (transient FS error, disk pressure). Marking it terminal would strand the user.
          true,
        );
      }
    }

    /*
     * A standalone executable has to be marked executable, or installing it is a no-op.
     *
     * Blobs are written by `downloadFile` with the default 0644, and `linkByName` is a
     * hardlink — it shares the inode, so the by-name view inherits 0644 too. Every
     * consumer that looks for a native tool goes through `isExecutable()`
     * (`access(X_OK)`), so a pack whose payload is a bare binary rather than an archive
     * would download, verify, hardlink, write its manifest, report success — and then be
     * invisible to tool discovery, forever, with no error anywhere. This is the same
     * shape as T-093's "all packs installed, extension still not loaded".
     *
     * Archives are excluded on purpose: `unpackArchive` already restores each entry's
     * recorded mode, and chmod'ing the archive blob itself would be meaningless.
     *
     * Windows has no exec bit; `access(X_OK)` there does not gate on one, so skipping is
     * correct rather than a gap. (chmod on Windows can only toggle read-only.)
     */
    if (!f.unpack && f.role === 'binary' && process.platform !== 'win32') {
      await fs.chmod(linked, 0o755);
      mark('chmod');
    }

    const portable = toPortableRecord(linked, store.root);
    const rec: InstalledFileRecord = {
      role: f.role,
      name: f.name,
      sha256: res.sha256,
      sizeBytes: res.sizeBytes,
      root: portable.root,
      relPath: portable.relPath,
      // Kept during the migration window; see InstalledFile.path in @openmemo/shared.
      path: linked,
      provider: res.provider,
      cached: res.cached,
    };
    records.push(rec);
    opts.onFileDone?.(rec);
  }

  if (process.env['OPENMEMO_TIMING'] === '1') {
    console.log(`[timing] install() 整个返回前 —— 循环外的收尾已完成`);
  }
  return { id: target.id, files: records, totalBytes, bytesTransferred, installedTo: expandedTo };
}

/**
 * The directory an archive is expanded into, under `by-name/<kind>/`.
 *
 * ── Why this is exported (T-162) ──────────────────────────────────────────────────────
 * This is the ONLY agreement between the installer and tool discovery. The installer
 * creates the directory from it (`finalDir` above); `findInBackendPacks()` runs it the
 * other way — an installed record names the archive (`InstalledBackendPack.files[].name`),
 * and this function turns that name into the directory to look for, which is how a
 * directory on disk gets attributed back to the pack that produced it.
 *
 * Two implementations of the same rule would diverge on the extension list, and the list
 * is not guessable: `.tar.xz` is deliberately NOT stripped, so jellyfin's macOS ffmpeg
 * really does unpack into a directory whose name ends in `.tar.xz`
 * (`[实测]` pack-publish §2.3, and `verify-offline.mjs [12]` builds that exact layout).
 * A resolver that "cleaned that up" would attribute zero directories to any pack.
 */
export function unpackDirName(name: string): string {
  return name.replace(/\.(zip|tar\.gz|tgz)$/i, '');
}

/**
 * Collapse `tmp/<name>/…` down to `tmp/…` when the archive shipped a redundant
 * same-named top-level directory. Returns the directory that should be renamed into
 * place — `tmpDir` itself when there is nothing to collapse.
 *
 * ─── 这是一个真 bug，不是整洁问题（T-146 §3.3 #1 → T-153）─────────────────────────
 *
 * `install()` 把 `<X>.mlmodelc.zip` 解到 `by-name/asr/<X>.mlmodelc/`（目录名由
 * `unpackDirName(f.name)` 得到）。而上游那个 zip **内部自带一层同名顶层目录**，
 * 于是磁盘上真实结构是：
 *
 *     by-name/asr/ggml-large-v3-encoder.mlmodelc/
 *                 └── ggml-large-v3-encoder.mlmodelc/
 *                     ├── coremldata.bin
 *                     └── …
 *
 * whisper.cpp 从 `-m` 参数推出来的路径是**外层**那个（`whisper.cpp:3326-3348`），
 * 而外层是个只含一个子目录的空壳 → CoreML 加载失败。
 * 加载失败之后 **`WHISPER_COREML_ALLOW_FALLBACK=ON` 会打一行 ERROR 然后照常跑**
 * （`whisper.cpp:3440-3452`），而那行 ERROR 被 `--no-prints` 关掉的日志通道吞了
 * （`whisperCpp.ts:101` → `cli.cpp:1039-1040`）。
 * 结果就是**装了 ANE 却没变快，且没有任何地方会说话** —— 本仓最贵的那类 bug。
 * （`packages/runtime` 的 `asr.coreml` 自检项现在会把这个空壳报成 `fail`，
 *  所以它至少不再是静默的；这里修的是让它根本不发生。）
 *
 * ─── 判据为什么收得这么窄 ────────────────────────────────────────────────────────
 *
 * 只在**三个条件同时成立**时才压：顶层恰好一个条目、它是目录、且它的名字**逐字等于**
 * 我们要落地的目录名。任何更宽的规则（比如"只有一个目录就压"）都会改变别的包的布局 ——
 * 比如一个正当地把所有内容放在 `bin/` 下的后端包，压掉之后 `providesFiles` 里
 * 记的路径就全错了，而且同样不会有任何东西报错。
 * **这条修复必须只对它真正要修的那个形状生效。**
 *
 * 归档没有这层冗余目录时它是彻底的 no-op，所以对既有包零影响。
 *
 * ═══ T-168：上面这条判据**没错，但它的前提是错的** ═══════════════════════════════
 *
 * 写下这条判据时默认了一件没人验过的事：**"顶层条目"都是载荷**。
 * 真归档不是这样。`ggml-large-v3-encoder.mlmodelc.zip` 的中央目录（`[实测]`，
 * HTTP Range 从镜像读回，共 9 条）顶层有**两个**条目：
 *
 *     ggml-large-v3-encoder.mlmodelc/…                          ← 载荷
 *     __MACOSX/ggml-large-v3-encoder.mlmodelc/._metadata.json   ← macOS 打包副产物
 *
 * 于是 `entries.length !== 1`，压不掉，装出来还是空壳 ——
 * **这条修复上线后一直没生效，而 CI 直到 macOS 那一发（run 31163897527）才撞出来。**
 * 修法不在这个函数里：`unpack.ts` 的 `isMacArchiveJunk` 让垃圾根本不落盘，
 * 落到这里的顶层条目于是**真的都是载荷**，这条判据的前提才第一次成立。
 *
 * 两件事**故意分成两处**：「这条目是不是载荷」只看名字，与目的地无关；
 * 「层级对不对」要知道消费方去哪儿找。判据不同 ⇒ 不该由同一段代码决定。
 *
 * ─── 通用规则 vs 逐包声明：这次的判断（连同理由一起留下）─────────────────────────
 *
 * **清垃圾 → 通用。** 判据是归档内在的、逐条目可判的，且不存在"某个包需要 `__MACOSX`"
 * 这种情形。所以它是 `unpack.ts` 里的一条无条件规则。
 *
 * **压顶层 → 不通用，维持窄规则。** 因为"冗余包装" 与 "有意义的目录" 在归档里
 * **长得一模一样**：`ggml-…-encoder.mlmodelc/` 和 `bin/` 都是"顶层唯一的目录"，
 * 区别只在消费方期待什么 —— 那个信息不在归档里。所以"只有一个目录就压"不是
 * 更聪明的规则，是**在猜**，而猜错的形态正是本仓最贵的那类（装了、没报错、不工作）。
 *
 * 名字逐字相等是唯一**不需要猜**的情形：名字既然与目的地一字不差，
 * 这层包装就确实没携带任何目的地不知道的信息。所以窄规则留着，**不放宽**。
 *
 * ─── 放宽会撞上什么（`[实测]`，别把它当假想）────────────────────────────────────
 *
 * 同一个上游家族 11 个 encoder 包全部用 Range 读过中央目录，顶层形态有三种：
 *
 *   · 9 个：顶层唯一目录，名字与包名一致           → 窄规则命中
 *   · large-v3 / turbo：多一个 `__MACOSX`          → 清垃圾之后命中
 *   · **large-v2：包名 `ggml-large-v2-encoder.mlmodelc.zip`，
 *      顶层目录却叫 `ggml-large-encoder.mlmodelc`** → 名字不等，**窄规则不命中**
 *
 * 最后这个形状（当前清单里没有）**只能逐包声明**：从归档本身无法区分它与
 * "这个包本来就该有一层 `bin/`"。所以正确的下一步是给 `ArtifactFile` 加一条显式声明，
 * 而**不是**把这里放宽 —— 但清单里没有消费者之前不该先建机制（本仓 `check:orphans`
 * 正是在管这个）。在那之前，这种形状会被 `selfcheck` 的 `asr.coreml` 判成 `fail`
 * 并让审计变红（T-168 ④），**是响的，不是静默的** —— 这才是"下次不中招"的实际含义。
 */
async function collapseRedundantTopLevel(tmpDir: string, finalName: string): Promise<string> {
  let entries;
  try {
    entries = await fs.readdir(tmpDir, { withFileTypes: true });
  } catch {
    return tmpDir;
  }
  if (entries.length !== 1) return tmpDir;
  const only = entries[0];
  if (!only || !only.isDirectory() || only.name !== finalName) return tmpDir;
  return path.join(tmpDir, only.name);
}
