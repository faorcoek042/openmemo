/**
 * 产品版本号的**唯一读取点**。
 *
 * ## 唯一事实来源 = 根 `package.json` 的 `version`
 *
 * 不是「之一」，是唯一。工作区里其余 9 个 `package.json` **没有 `version` 字段**
 * （不是同步成一样的值 —— 是根本没有那个字段），`scripts/check-version-sync.mjs`
 * 会在有人加回来时当场变红。
 *
 * 选根 `package.json` 而不是新开一个 `VERSION` 文件，理由只有一条：
 * 预编译产物的包名要带版本号，而那条链路读的就是 `package.json` 的 `version`。
 * 让权威值待在消费者已经会去读的地方，比另立一个文件再写个脚本同步过去少一次分叉。
 *
 * ## 为什么这个文件存在
 *
 * 因为有两个消费者：`gen-build-info.mjs`（烘焙进 daemon 产物）和
 * `check-version-sync.mjs`（守卫）。两个消费者各写一遍
 * `JSON.parse(readFileSync('package.json')).version`，就又是本仓吃过好几次亏的那个形状
 * （`%APPDATA%` vs `%LOCALAPPDATA%`、`libsimple.dll` vs `simple.dll`、`'CPU' !== 'cpu'`）。
 * 一个读取点，两边 import。
 *
 * ## 版本号规则见 `docs/design/D-12-versioning.md`
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根。本文件在 `scripts/lib/`，往上两级。 */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * `0.N.P` —— 只有 N 和 P 是活的：
 *
 * - `0.`  永远是 0。个人自用、没有下游消费者，"1.0 稳定了"这句话没有对象可以说。
 * - `N`   **第几个可用的东西**。递增 1 = 又交付了一个能跑的东西给用户。
 * - `P`   针对**已经交付出去的那个 N** 的修补。不是"又改了几行"，是"N 已经给出去了，
 *         但它坏了"。这是个事实判断，不是价值判断 —— 所以没人需要纠结该不该 +1。
 *
 * 语义化版本那套（破坏性/功能/修复）在这里**不适用**：判断"是不是破坏性"要有一个
 * 「被破坏的人」，而这个项目没有下游、不发 npm。留着那三档只会让人每次都得做一次
 * 无人受益的判断 —— 而无人受益的判断的结局，就是今天这个从没动过的 `0.1.0`。
 *
 * 三段式不是为了假装语义化，是因为 npm/pnpm 校验 `version` 字段必须是合法 semver，
 * 而下游的包名生成也预期 `X.Y.Z`。
 */
export const VERSION_RE = /^0\.(\d+)\.(\d+)$/;

/**
 * 版本号会被拼进**文件名**（预编译产物 `openmemo-<version>-<os>-<arch>.<ext>`）。
 * 所以它不能含 `/ \ : * ? " < > |`、空格、或任何需要转义的东西。
 * `VERSION_RE` 已经比这严得多，但这条单独存在是为了让"为什么不能加 `+build.1` 后缀"
 * 这个问题在代码里有答案 —— semver 允许 `+`，Windows 文件名和 URL 不欢迎它。
 */
export const FILENAME_SAFE_RE = /^[A-Za-z0-9.-]+$/;

/**
 * 产品版本的 git tag 形状：`v0.2.0`。
 *
 * 与 Releases 页上已有的 `backend-packs-2026.08.07b` / `model-mirror-2026.08.06`
 * **刻意长得不一样**：那两类是「产品运行时自己去取的后端包与模型镜像」，README 第 12 行
 * 明确告诉用户那些不是给他下的。它们是 `<种类>-<日期>`，没有 `v` 前缀。
 *
 * 产品版本是唯一一类「给人看的」版本，所以用最通用的 `v` + semver ——
 * 一眼就能和那两类分开，而 README 那句话继续成立（它点名的是那两个前缀）。
 *
 * ⚠️ tag ≠ GitHub Release。打 tag 不会让它出现在 Releases 页上。
 */
export function productTag(version) {
  return `v${version}`;
}

/** 读根 `package.json`（原文，供需要回写的调用方用）。 */
export function readRootPackageJson() {
  const path = join(REPO_ROOT, 'package.json');
  const text = readFileSync(path, 'utf8');
  const json = JSON.parse(text);
  // 读对文件了吗 —— 抄自 apps/web/src/lib/format/peaks.test.ts 的哨兵写法：
  // 先证明"我读的是我以为的那个文件"，再去信它里面的值。
  if (json.name !== 'openmemo') {
    throw new Error(`${path} 的 name 不是 "openmemo"（实得 ${JSON.stringify(json.name)}）—— 读错文件了`);
  }
  return { path, text, json };
}

/**
 * 产品版本号。格式不合规直接抛 —— **不回退到默认值**。
 *
 * 回退会让"版本号坏了"变成"版本号看起来正常"，而这正是今天要修的病：
 * 界面上那个 `v0.1.0` 从来没人怀疑过它，因为它长得很像一个真的版本号。
 */
export function readProductVersion() {
  const { path, json } = readRootPackageJson();
  const v = json.version;
  if (typeof v !== 'string' || !VERSION_RE.test(v)) {
    throw new Error(
      `${path} 的 version = ${JSON.stringify(v)}，不符合 0.N.P（见 docs/design/D-12-versioning.md）`,
    );
  }
  if (!FILENAME_SAFE_RE.test(v)) {
    throw new Error(`${path} 的 version = ${JSON.stringify(v)} 含有不能进文件名的字符`);
  }
  return v;
}
