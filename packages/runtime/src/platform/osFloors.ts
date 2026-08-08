/**
 * 上游二进制的**系统版本下限**，以及它在自检里怎么说出来。
 *
 * ── 这个文件存在的理由：一整类「装得上、跑不了、自检看不见」──────────────────────
 *
 * 我们的包里混着**我们自己编的**和**上游预编译的**二进制，而后者的部署目标
 * （macOS 的 `minos` / Windows 的 VC++ 运行时）**可以高于我们对外承诺的下限**。
 * 高出来的那一段就是一个洞：系统装得上、包也解得开、文件都在，
 * **一加载就失败，而且失败是静默的** —— 用户只会觉得"这功能坏了"或者"我配错了"。
 *
 * `[CI 实测 2026-08-08 run 31204790920]` macOS arm64 包里量出来的：
 *
 * | 二进制                        | minos      | 坏了丢什么              |
 * | ----------------------------- | ---------- | ----------------------- |
 * | `libonnxruntime*.dylib`       | **15.5.0** | 流式 ASR / VAD（sherpa）|
 * | `sherpa-onnx.node`            | 14.0.0     | 同上                    |
 * | `ext/vec0.dylib`              | **14.0.0** | 语义 / 混合检索         |
 * | node / better-sqlite3 / libsimple | 11.0.0 | （核心，低于承诺，没问题）|
 *
 * 而 README 承诺的是 **macOS arm64 ≥ 13.3**。于是 13.3 ≤ 系统 < 14.0 的那台 Mac：
 * 转写、播放、笔记、中文全文检索**全都好使**，但语义检索和流式 ASR **静默不可用**。
 *
 * ── 为什么不是"把承诺抬到 15.5" ────────────────────────────────────────────────
 *
 * Manager 2026-08-08 裁定：**保留 13.3 的承诺，把静默变响亮。**
 *
 * > 把承诺抬到 15.5 会**把一台 13.3 的 Mac 挡在门外，而它其实能用核心功能**。
 * > **问题不在版本号，在"静默"两个字。**
 *
 * 判据是本仓反复用的那条：
 * **「装得上、跑不了、自检看不见」是最坏的一档；至少要让它变成「装得上、跑不了、
 * 自检说得出为什么」。**
 *
 * ── 档位：`warn`，不是 `fail` ──────────────────────────────────────────────────
 *
 * 在一台 13.3 的 Mac 上「语义检索不可用」**是事实，不是故障**。
 * 而 CLI 的退出码规则是 `status === 'fail' && required`
 * （`scripts/selfcheck.mjs`）—— 报 `fail` 会让一台**完全符合我们承诺**的机器
 * 自检退出码变 1，那是一条会常态变红的门禁，等于训练所有人忽略它。
 * 所以：**低于下限 → `warn` + `required:false`**，达标 → `ok`。
 *
 * ── 版本取不到时说什么 ────────────────────────────────────────────────────────
 *
 * **不猜。** 取不到就报 `unknown` 并如实说"没能取到系统版本"，
 * 而不是假设它够新（那会把洞盖回去）或假设它太旧（那会造一个假警报）。
 */
import os from 'node:os';

import { run } from '../detect/system.js';

/** 一条「上游下限高于我们的承诺」的记录。 */
export interface OsFloor {
  /** 自检项 id。 */
  readonly id: string;
  readonly labelZh: string;
  readonly label: string;
  /** 最低可用的系统版本（`major.minor`）。 */
  readonly floor: string;
  /** 达不到时**具体丢什么功能**。文案要让用户认得出他刚才没用成的那个东西。 */
  readonly losesZh: string;
  readonly loses: string;
  /** 谁把下限抬上去的 —— 让下一个人能核。中英都要有：英文文案里嵌中文是本仓栽过的坑。 */
  readonly sourceZh: string;
  readonly source: string;
}

/**
 * macOS arm64 的可降级下限。
 *
 * ⚠️ **与 `scripts/ci/check-bundle-macos-floors.mjs` 的 `DEGRADABLE` 表是同一组数**。
 * 那边在**打包时**拦"上游又抬高了"，这边在**运行时**告诉用户"你这台低于它"。
 * 两处都改才算改完 —— 数字对不上时，以 CI 那张表为准（它是从真产物量出来的）。
 */
export const MACOS_FLOORS: readonly OsFloor[] = [
  {
    id: 'os.macos.semanticSearch',
    labelZh: '语义 / 混合检索（sqlite-vec）',
    label: 'semantic / hybrid search (sqlite-vec)',
    floor: '14.0',
    losesZh: '语义检索与混合检索用不了（关键词全文检索不受影响，仍然可用）',
    loses: 'semantic and hybrid search are unavailable (keyword full-text search still works)',
    sourceZh: 'sqlite-vec v0.1.9 官方 macos-aarch64 产物的 minos = 14.0.0',
    source: 'the official sqlite-vec v0.1.9 macos-aarch64 build has minos = 14.0.0',
  },
  {
    id: 'os.macos.streamingAsr',
    labelZh: '流式 ASR 与 VAD（sherpa-onnx）',
    label: 'streaming ASR and VAD (sherpa-onnx)',
    floor: '15.5',
    losesZh: '录音实时字幕用不了（录完之后的整段转写不受影响，仍然可用）',
    loses: 'live captions while recording are unavailable (batch transcription still works)',
    sourceZh: 'libonnxruntime*.dylib 的 minos = 15.5.0（sherpa-onnx.node 是 14.0.0，取其高者）',
    source:
      'libonnxruntime*.dylib has minos = 15.5.0 (sherpa-onnx.node is 14.0.0; the higher one wins)',
  },
];

export type OsFloorVerdict = 'ok' | 'below-floor' | 'unknown';

export interface OsFloorResult {
  readonly floor: OsFloor;
  readonly verdict: OsFloorVerdict;
  /** 实测到的系统版本；取不到就是 `null`。 */
  readonly productVersion: string | null;
}

/**
 * 比较 `major.minor[.patch]` 形式的版本号。
 *
 * 刻意不引依赖：这里只需要数字段逐段比，而 semver 的预发布/构建元数据规则
 * 在"系统版本"这个语境里根本不适用（`15.5` 不是 semver）。
 * 解析不出数字的段按 0 处理，但**整串解析不出来时调用方会拿到 `null`**（见下）。
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10));
  const pb = b.split('.').map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? (pa[i] as number) : 0;
    const y = Number.isFinite(pb[i]) ? (pb[i] as number) : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 一个字符串像不像系统版本号（至少一段数字）。用来把 `sw_vers` 的垃圾输出挡掉。 */
function looksLikeVersion(v: string): boolean {
  return /^\d+(\.\d+)*$/.test(v.trim());
}

/**
 * **纯函数**：给一个 macOS 产品版本号，算出每条下限的判定。
 *
 * 纯的理由不是洁癖 —— 是**这段逻辑必须能在 Linux 的 CI 上被测到**。
 * 真机那一格（"13.3 的 Mac 上自检确实这么说"）在托管 runner 上结构性验不了，
 * 只能标 `[未验证:需真 Mac]`；但"喂 13.3 进去应该得到什么"这件事必须有测试守着。
 */
export function evaluateOsFloors(
  floors: readonly OsFloor[],
  productVersion: string | null,
): OsFloorResult[] {
  const usable =
    productVersion !== null && looksLikeVersion(productVersion) ? productVersion : null;
  return floors.map((floor) => ({
    floor,
    productVersion: usable,
    verdict:
      usable === null ? 'unknown' : compareVersions(usable, floor.floor) < 0 ? 'below-floor' : 'ok',
  }));
}

/**
 * Darwin 内核大版本 → macOS 产品大版本。
 *
 * **只列已知的**，未知一律回 `null` —— 因为这个映射**不是公式**：
 * Apple 在 Darwin 25 那一代把产品号从 16 跳到了 **26**，任何"加 11"之类的算法
 * 都会在那里算错，而算错的结果是**一个看起来很确定的错版本号**。
 * 宁可回 `null` 让上层如实说"取不到"，也不要猜一个。
 */
const DARWIN_TO_MACOS: Readonly<Record<string, string>> = {
  '21': '12',
  '22': '13',
  '23': '14',
  '24': '15',
  '25': '26',
};

/** 从 `os.release()`（Darwin 版本，如 `23.6.0`）反推 macOS 大版本。未知回 `null`。 */
export function macosFromDarwinRelease(release: string): string | null {
  const major = release.split('.')[0];
  return major !== undefined ? (DARWIN_TO_MACOS[major] ?? null) : null;
}

/**
 * 取本机 macOS 产品版本。**非 darwin 一律 `null`。**
 *
 * 优先 `sw_vers -productVersion`（每台 Mac 都有，且是权威答案）；
 * 它失败时退回 Darwin 内核版本映射，**再失败就回 `null`，不猜**。
 * `run()` 自带 5s 硬超时与 `killSignal`（PROTOCOL §11：一切外部命令带超时）。
 */
export async function detectMacosProductVersion(
  platform: string = process.platform,
  release: string = os.release(),
): Promise<string | null> {
  if (platform !== 'darwin') return null;
  const r = await run('sw_vers', ['-productVersion']);
  if (r.ok) {
    const v = r.stdout.trim();
    if (looksLikeVersion(v)) return v;
  }
  return macosFromDarwinRelease(release);
}
