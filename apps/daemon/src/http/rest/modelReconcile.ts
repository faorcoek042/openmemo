/**
 * 首次运行对账：把随包出厂的模型字节"装"进 ArtifactStore（D-20 §11.2）。
 *
 * ══ 修的是哪个洞 ══════════════════════════════════════════════════════════════
 *
 * `[实测]` `grep -rn "BUNDLED_MODELS|bundledModels|resolveBundledModel"` 扫遍
 * `apps/daemon/src` 与所有 `packages` 下的 `src` → 0 命中；包内目录结构里
 * 也没有任何东西读 `<包根>/models/`。
 * **模型的唯一发现路径是 `ArtifactStore`**：它只认数据目录下的 `blobs/` + `manifests/`。
 * `smallestInstalledModel`、自检的 `model`、ASR 选型、`/api/models/catalog` 的
 * `installed` 全部只读那一处。也就是说：只把模型字节塞进包，产品一个都读不到，
 * 而且没有任何一处会报错——这是"东西在包里 ≠ 产品能找到它"这一族问题的第三次
 * （前两次：硬件探针在包里但自检看不见；`whisper-cli` 在包里但 `fromBundle` 解析
 * 只认环境变量，`packages/runtime/src/bundledRuntime.ts` 修的就是那次）。
 *
 * ══ 为什么不是第四条解析路径 ══════════════════════════════════════════════════
 *
 * D-20 §11 的结论：多一条解析路径就多一个"装没装"的答案（`installed:false` 却能用），
 * 而卸载 / 更新 / 自检 / 目录页每一处都要单独适配那条新路径。**落地方式采用
 * "首次运行把包内模型导入 ArtifactStore"**，与本文件同目录的 `backendReconcile.ts`
 * 已经是这个思路在后端包上的先例——本文件是同一套纪律在模型上的镜像，
 * 复用它的落点约定（`ArtifactStore.linkByName` / `writeManifest`），不发明第二套。
 *
 * ══ 双份共存，永不删包内那份（Manager 2026-08-09 裁决）══════════════════════════
 *
 * 用户定过的硬约束：「删掉整个数据目录不会弄坏程序本体——下次启动会重建一个空的」。
 * 首次运行后删掉包内那份的话，用户一删数据目录模型就永久没了，产品从"开箱即用"
 * 退回"要联网重下"，而且包会变成一次性的（解包第二次得到残包）。
 * `ArtifactStore.importBlob()` 因此是硬链接优先、跨盘退化为复制——同盘时零额外
 * 字节，且删掉任意一边另一边都还在。
 *
 * ══ 诚实性规则（与 backendReconcile.ts 相同的纪律）══════════════════════════════
 *
 * - **sha256 现算**，不信包内目录名/大小。算出来与目录声明的不一致就跳过——
 *   那说明包里躺着的是另一个版本，把它记成"已安装"是伪造证据。
 * - **`installedAt` 取那个文件本身的 mtime**，不是 `Date.now()`——它不是现在装的。
 * - `verifiedAt` 才是现在：我们刚刚逐字节校验过。
 * - `benchmark: null`——从没在这台机器上跑过基准。
 * - **已经装过的 role/id 组合绝不覆盖**：无论是这套机制之前装的，还是用户自己
 *   下载装的，一律跳过，不重复劳动也不覆盖用户可能升级过的同 id 记录。
 * - **只对"包内完全没有这个模型的痕迹"沉默**（`sawSomething=false`，例如开发树、
 *   或注入了只含部分模型的测试目录）；**包内有痕迹但对不上就必须出声**——
 *   静默的自愈与静默的降级是同一族。
 */
import { promises as fs, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256File, toPortableRecord, type ArtifactStore } from '@openmemo/downloader';
import {
  BUNDLED_MODEL_IDS,
  type BundledModelId,
  type InstalledFile,
  type InstalledModel,
  type ModelEntry,
} from '@openmemo/shared';

import { roleToStoreKind } from './roleMap.js';

export interface BundledModelImportReport {
  /*
   * ★ `modelId` 用 `BundledModelId` 而不是 `string`。
   *
   * 这份报告里的每一个 id 都来自 `for (const id of BUNDLED_MODEL_IDS)`——
   * 写成 `string` 时，**"随便哪个目录里的模型"也能被报进"随包出厂模型导入报告"**，
   * 而编译器一个字都不会说。这正是本文件头警告的那种漂移，只不过发生在读的那一侧。
   * 收窄之后，"这份报告只谈随包出厂的那几个 id"从注释变成编译期事实。
   *
   * `[门禁实测]` 这个类型此前是零引用导出（`check:orphans` 的 ✘）——
   * 它不是死代码，是**这一半没接上**：清单常量接了，由它派生的类型没接。
   */
  /** 成功导入的模型（附本次落地的字节数）。 */
  readonly imported: { readonly modelId: BundledModelId; readonly bytes: number }[];
  /**
   * 没导入的模型 + 原因。**只收"包内看起来有点东西、但不敢认"的那些**——
   * 包内完全没有该模型痕迹（例如开发树）不算异常，不会出现在这里。
   */
  readonly skipped: { readonly modelId: BundledModelId; readonly reason: string }[];
}

export interface BundledModelImportOptions {
  readonly store: ArtifactStore;
  /** 已加载的模型目录（`RestState.modelCatalog.models`）——按 id 查规格。 */
  readonly models: readonly ModelEntry[];
  /**
   * 覆盖自动探测的包内模型目录，测试用。`undefined` = 用
   * `resolveBundledModelsDir()`；显式传 `null` = 当作"这不是包内布局"。
   */
  readonly bundledModelsDir?: string | null;
}

/**
 * 随预编译包出厂的模型目录（`<包根>/models`）。
 *
 * 与 `resolveManifestDir()` / `resolveBundledWhisperDir()`（`manifests.ts`，同目录）
 * 完全相同的判据：**不依赖你从哪儿启动**。环境变量优先（`OPENMEMO_BUNDLED_MODELS_DIR`，
 * 未设时不检查是否存在，与那两个函数的约定一致），否则从本模块位置向上找 5 层——
 * 两种布局这一层数相同：
 *   包内   `app/daemon/dist/http/rest` → 包根   → `models` ✔
 *   仓库   `apps/daemon/dist/http/rest` → 仓库根 → `models`（不存在 → 返回 null，
 *          开发树本来就该走已安装/已下载的模型，不该有包内兜底）
 *
 * 返回 `null` 表示"这不是一个自带模型的布局"，调用方据此把这一步整体跳过。
 */
export function resolveBundledModelsDir(): string | null {
  const fromEnv = process.env['OPENMEMO_BUNDLED_MODELS_DIR'];
  if (fromEnv) return fromEnv;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const guess = path.resolve(here, '..', '..', '..', '..', '..', 'models');
  return existsSync(guess) ? guess : null;
}

export async function reconcileBundledModels(
  opts: BundledModelImportOptions,
): Promise<BundledModelImportReport> {
  const imported: { modelId: BundledModelId; bytes: number }[] = [];
  const skipped: { modelId: BundledModelId; reason: string }[] = [];

  const bundledDir =
    opts.bundledModelsDir !== undefined ? opts.bundledModelsDir : resolveBundledModelsDir();
  if (bundledDir === null) return { imported, skipped };

  for (const id of BUNDLED_MODEL_IDS) {
    const model = opts.models.find((m) => m.id === id);
    if (!model) {
      // 目录里没有这个 id：BUNDLED_MODEL_IDS 与 vendor/manifests 已经不同步。
      // 出声——这正是本机制存在的理由（同一份常量分裂成两份认知）。
      skipped.push({
        modelId: id,
        reason: '不在已加载的模型目录里（BUNDLED_MODEL_IDS 与 vendor/manifests 不同步）',
      });
      continue;
    }

    const kind = roleToStoreKind(model.role);
    if (await opts.store.readManifest<InstalledModel>(kind, model.id)) continue; // 已装，绝不覆盖

    const modelDir = path.join(bundledDir, id);
    const landedFiles: InstalledFile[] = [];
    let sawSomething = false;
    let mtimeMs = Number.POSITIVE_INFINITY;
    let totalBytes = 0;
    let reject: string | null = null;

    for (const f of model.files) {
      const src = path.join(modelDir, f.name);
      let st;
      try {
        st = await fs.stat(src);
      } catch {
        break; // 这个平台的包压根没带这个文件的痕迹——不是异常，本来就没装
      }
      sawSomething = true;
      if (!st.isFile()) {
        reject = `${f.name} 在包内不是一个文件`;
        break;
      }
      if (st.size !== f.sizeBytes) {
        reject = `${f.name} 大小是 ${String(st.size)}，目录说应当是 ${String(f.sizeBytes)} —— 包内是另一个版本`;
        break;
      }
      const digest = await sha256File(src);
      if (digest !== f.sha256) {
        reject = `${f.name} 的 sha256 与目录声明的不符 —— 包内是另一个版本，不能装成 ${model.id}`;
        break;
      }
      // blob 先落、manifest 最后写：中途崩溃只会留下可回收的孤儿 blob。
      await opts.store.importBlob(src, digest);
      const linked = await opts.store.linkByName(kind, digest, f.name);
      landedFiles.push({
        role: f.role,
        name: f.name,
        sha256: digest,
        sizeBytes: st.size,
        ...toPortableRecord(linked, opts.store.root),
        path: linked, // 旧读取方兼容，写法与 models.ts 的 startModelPull 一致
      });
      totalBytes += st.size;
      mtimeMs = Math.min(mtimeMs, st.mtimeMs);
    }

    if (reject !== null) {
      skipped.push({ modelId: id, reason: reject });
      continue;
    }
    if (!sawSomething) continue; // 包内完全没有这个模型——不是异常，静默跳过
    if (landedFiles.length !== model.files.length) {
      skipped.push({
        modelId: id,
        reason: '包内只有部分文件 —— 装到一半，不算完整，不能记成已安装',
      });
      continue;
    }

    const record: InstalledModel = {
      schemaVersion: 1,
      id: model.id,
      groupId: model.groupId,
      role: model.role,
      engines: model.engines,
      family: model.family,
      displayName: model.displayName,
      quantization: model.quantization,
      totalSizeBytes: model.totalSizeBytes,
      // 不是现在装的——用文件本身的 mtime，那是我们手上唯一真实的时间证据
      installedAt: new Date(mtimeMs).toISOString(),
      // 这一条才是"现在"：上面每个文件都刚被逐字节校验过
      verifiedAt: new Date().toISOString(),
      integrity: 'ok',
      files: landedFiles,
      requirements: model.requirements,
      ...(model.gguf ? { gguf: model.gguf } : {}),
      license: model.license,
      source: model.source,
      // null，直到用户在本机真跑一次基准（ADR-004 决策 3）——内置不等于测过
      benchmark: null,
      catalogVersion: model.catalogVersion,
    };
    await opts.store.writeManifest(kind, model.id, record);
    /*
     * 用循环变量 `id` 而不是 `model.id`：两者由上面 `find((m) => m.id === id)`
     * 保证相等，但只有 `id` 带着"它来自 BUNDLED_MODEL_IDS"这个出处。
     * `model.id` 是 `string`，用它就等于把出处丢掉，收窄也就白收了。
     */
    imported.push({ modelId: id, bytes: totalBytes });
  }

  return { imported, skipped };
}
