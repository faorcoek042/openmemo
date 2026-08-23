#!/usr/bin/env node
/**
 * 「**没有任何东西会自动跑它**」的那一类 workflow —— 逐个登记，并给挂起的那些一条
 * **机器判得了的过期判据**。
 *
 * ## 它治的病（两条，同一个形状）
 *
 * `[实测 2026-08-23]` 两条 workflow 红着挂了 12 天没有任何人知道，
 * 而同一段时间里主门禁 `ci.yml` 一直是绿的：
 *
 *   · `ci-crossplatform` run `31389910051`（2026-08-10 failure）
 *   · `proxy-coverage`   run `31424996163`（2026-08-10 failure）
 *
 * 两条都是 `workflow_dispatch:` only。**没有触发器 ⇒ 没有新判决 ⇒ 那面红旗停在
 * 它最后一次运行的那一天，而代码继续往前走。**
 *
 * ★ 而比"没人看"更坏的是：**陈旧的红会变成假话，并且看起来比真话还确凿。**
 *   `ci-crossplatform` 那面红旗宣称的红是两个未用 import —— 那条**在一天之内
 *   就被 `ci.yml` 拦下并修好了**。12 天后重跑，control 与 lint 三平台全绿，
 *   真正还红着的是完全另外两组。一个人点开 Actions 页面，看到的是
 *   「ci-crossplatform ✗ 2026-08-10」，而那一行的**每一个字都不再成立**。
 *   这是手动触发独有的失效形态：**陈旧的红和新鲜的红长得一模一样。**
 *
 * ## 为什么这道门必须存在（而不是"下次注意"）
 *
 * `proxy-coverage.yml` 把一条**写得非常好**的过期判据写在了文件头里：
 *
 *   > 到 v0.7.2 发布时，本 workflow 要么已被提升为自动跑的一格，
 *   > 要么连同脚本一起删除。**停在这里不算一个终态。**
 *
 * 它是可证伪的、有明确日期、有两条明确的出路。**然后仓库发了 0.7.2、0.7.3、0.7.4，
 * 三次，没有任何一次注意到它。** 原因不是没人负责，是：
 *
 *   **它写在一个没有任何守卫会去读的地方（YAML 注释），
 *     而 `version-bump.mjs`（发版动作本身）只写两个文件、不查任何登记。**
 *
 * 全仓搜过一遍：`check-doc-freshness.mjs` 是 **1 条**手写条目的表，
 * `check-pending-claims.mjs` 是 **5 条**手写条目的表 —— 两者都不是扫描器，
 * 谁没被手工加进去谁就不存在。`check-comment-facts.mjs` 的扫描范围是
 * `*.ts/tsx/mjs/js/sql` + `docs/**.md`，**`.yml` 不在里面**。
 * `lint-workflows.mjs` 读 workflow，但 YAML 注释在解析时就被丢掉了。
 *
 * → **本仓此前没有任何版本门 / 日期门形式的过期机制。** 这个文件是第一个。
 *
 * ## 判红的时机（⚠️ 与 `check-pending-claims.mjs` 刻意不同，别读混）
 *
 * `check-pending-claims.mjs` 的规矩是「**只在谓词取值变化时红**」——
 * 因为「这条待办还没做完」在今天是事实，不是故障，为它常态红会训练所有人忽略红灯。
 *
 * **这道门反过来，而且是有意的**：过了期就是红。区别在于主语不同 ——
 * 那边的主语是"一条待办"，这边的主语是"**一条自己写了「停在这里不算终态」的承诺**"。
 * 一条**带了截止版本**的承诺越过截止线还没兑现，那就**是**故障，不是现状。
 * 判据也不会常态红：兑现它只要二选一（给它一个自动触发器，或者删掉它并归档），
 * 两条路都是有限的活，不是"永远做不完"。
 *
 * 这也是为什么每条 `pending` 都必须写 `forks`：**说不出两条出路的挂起项，
 * 说明它还没想清楚，而那本身就是有用的信号**（这条思路抄自 `check-pending-claims.mjs`）。
 *
 * ## 怎么加一条
 *
 * 新建一个只有 `workflow_dispatch:` 的 workflow ⇒ 这道门**当场红**，让你二选一：
 *
 *   · `kind: 'deliberate'` —— 它就该永远手动。**必须给 `evidence`**：
 *     指向该文件里自己说明理由的那几行。理由写在文件里、登记只是索引 ——
 *     否则两处会漂，而漂掉的那半失效时看起来和从没有过一模一样。
 *   · `kind: 'pending'` —— 停在这里不是终态。**必须给 `expiresAt` + `forks`**。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { REPO_ROOT, readProductVersion, VERSION_RE } from '../lib/version.mjs';

const WF_DIR = join(REPO_ROOT, '.github', 'workflows');

/**
 * ★ 登记册。**主语是「没有任何自动触发器的 workflow」**，不是"所有 workflow"。
 *
 * `evidence` 的格式是 `文件:行号`，指向**该 workflow 自己**说明理由的地方。
 * 下面每一条的 `why` 都是从那几行里读出来的，不是在这里现编的。
 */
export const DARK_WORKFLOWS = [
  {
    file: 'build-backends.yml',
    kind: 'deliberate',
    evidence: 'build-backends.yml:62,69,73,88',
    why:
      'ADR-015（上游预编译优先）后已**降级为按需触发**，不再是默认路径；' +
      '只有上游确实缺失时才手动跑，而整份 dispatch 一次要烧 8 个 job（含两个 macOS runner）。',
  },
  {
    file: 'build-bundles.yml',
    kind: 'deliberate',
    evidence: 'build-bundles.yml:33-34,41-42,49',
    why:
      '一次全矩阵要烧三个 runner（含 macOS），冷启动那一步会真下载几百 MB 并真跑一次转写；' +
      '它产出的是**供其他腿按 run id 取用的包**，不是判决 —— 发布归 Manager（用户单独授权）。',
  },
  {
    file: 'cold-start-audit.yml',
    kind: 'deliberate',
    evidence: 'cold-start-audit.yml:24-27,49',
    why: '要真下载几百 MB 跑一次完整冷启动（macOS 那格还要多下约 1.7 GB 载体模型），不适合每次 push 都来一遍。',
  },
  {
    file: 'mirror-model-blobs.yml',
    kind: 'deliberate',
    evidence: 'mirror-model-blobs.yml:15-17,25-28',
    why:
      '要下 ~390 MiB，不适合每次 push 都跑；且刻意只给 read 权限 —— ' +
      '建 release 是对外动作，必须由人确认，"让 CI 代劳"会把那道闸悄悄绕过去。',
  },
  {
    file: 'probe-cold-timing.yml',
    kind: 'deliberate',
    evidence: 'probe-cold-timing.yml:18,27-30',
    why:
      '回答的是一个**一次性的事实问题**（darwin-arm64 上探针第一次 Metal 初始化多慢），' +
      '不是每次 push 要复核的性质；且「顺序是这个 workflow 的全部内容」，任何提前起 daemon 的步骤都会毁掉它。',
  },
  {
    file: 'release-upload.yml',
    kind: 'deliberate',
    evidence: 'release-upload.yml:29-34,62,66',
    why:
      '建 release 是要人确认的对外动作，本 workflow 只开"上传"这一格；' +
      '两个必填输入（已发布的 tag、产出 artifact 的 run id）都没有默认值，**结构上就无法被自动触发**。',
  },
  {
    file: 'tool-discovery-timing.yml',
    kind: 'deliberate',
    evidence: 'tool-discovery-timing.yml:19-22',
    why: '不设阈值、不会把 CI 弄红；一次性的事实问题（`discoverTools()` 在三平台上多贵），与 probe-cold-timing 同类。',
  },

  /* ───────────── 以下是 `pending`：停在这里**不算一个终态** ───────────── */

  /*
   * ── ✅ `proxy-coverage.yml` 曾经在这里，2026-08-23 **按出路 ① 兑现后移出** ────
   *
   * 这条登记的一生就是这套机制想要的样子，值得留个脚印：
   *   · 它的判据原本写在 `proxy-coverage.yml` 的 YAML 注释里（截止 v0.7.2），
   *     **滑过了 0.7.2 / 0.7.3 / 0.7.4 三次发版**，红旗挂了 13 天；
   *   · 搬进这个登记册（截止 v0.7.6）之后，同一天就被处理掉了 ——
   *     首跑那处吞掉自己错误的代码一修，真正的成因（`Unknown encoder 'libx264'`，
   *     LGPL 构建里没有 GPL 的 libx264）当场现形，换个编码器名字它就绿了
   *     （run 32656062961，七条路径 ①②③⑤⑥⑦ 全绿、④ 由别处守）。
   *   · 绿了 ⇒ 挂 cron（19:45 UTC）⇒ **它不再是一条"暗着的 workflow"**
   *     ⇒ 这条登记必须删掉，否则上面 ② 那条反向断言会红。
   *
   * ⚠️ 所以别把它加回来。要加回来的唯一情形是有人把那条 cron 摘了 ——
   *   而那时这道门会先替你红（"只有 workflow_dispatch，却没在 DARK_WORKFLOWS 里登记"）。
   */

  {
    file: 'ffmpeg-lgpl-verify.yml',
    kind: 'pending',
    expiresAt: '0.8.0',
    evidence: 'ffmpeg-lgpl-verify.yml',
    why:
      '只为补 D-20 §13 里 **Windows 那一格**的空白（Linux 已真跑 LGPL 构建 19/19，' +
      'Windows 只有「同 tag 同 commit 理论上应该一致」这个推断）。只测量、只交结果。',
    forks:
      '① 跑完、把 Windows 那一格的推断换成实测数、由用户拍板后归档判据；② 若结论是"永远只在改 ffmpeg 时手动跑"，改成 deliberate 并写明理由。',
  },
  {
    file: 'measure-install-phases.yml',
    kind: 'pending',
    expiresAt: '0.8.0',
    evidence: 'measure-install-phases.yml:23',
    why:
      '不是门禁、只测量不判红绿，用来把「Windows 上解包 + Defender 实时扫描要数十秒到数分钟」' +
      '这个推断变成数。文件自己写着「先有数，再谈判据」。',
    forks:
      '① 有数之后定出阈值并接进某条自动腿；② 判定阈值永远定不出来，改成 deliberate 并写明为什么。',
  },

  /* ── `unclear`：文件本身没交代为什么只能手动。**不许留着不问** ────────────────
   *
   * 这三条我没有替它们编理由 —— 它们的文件头写了判据、写了覆盖边界，
   * 唯独没写"为什么只有 workflow_dispatch"。**"没写"和"写了是刻意的"不是一回事**，
   * 而把前者登记成后者，正好是这道门要防的事。
   * 所以它们进 `pending`，出路是"补一句理由改成 deliberate"或"给它一个触发器"。
   */
  {
    file: 'bundle-launch-sim.yml',
    kind: 'pending',
    expiresAt: '0.8.0',
    evidence: 'bundle-launch-sim.yml',
    why:
      '模拟「浏览器下载 → 系统默认方式解压 → 双击 → 看得到界面」，为复现用户 2026-08-08 那三条' +
      '（Windows 双击出错 / mac 被安全性拦截 / 没有窗口打开）而建。**文件没有交代为什么只能手动。**' +
      '⚠️ 另有一处待查：它的 release tag 输入 `default: v0.2.0`，而仓库已在 0.7.4 —— ' +
      '默认 dispatch 测的是五个小版本以前的字节，正是 `e2e-record.yml:76-78` 反对的那个形状。',
    forks:
      '① 补一句"为什么只能手动"改成 deliberate（并处理那个 v0.2.0 默认值）；② 给它一个触发器。',
  },
  {
    file: 'e2e-coldstart.yml',
    kind: 'pending',
    expiresAt: '0.8.0',
    evidence: 'e2e-coldstart.yml',
    why:
      '补「CI 从没经历过一个空的数据目录」这一整类空白。**文件没有交代为什么只能手动**，' +
      '而它与六条已经带 cron 的 e2e 腿是同一族 —— 那六条铺 cron 的理由（坏了没人知道）同样适用于它。',
    forks: '① 照六条腿的先例铺 cron（20:00 UTC）；② 补一句理由说明它为什么不该定时跑。',
  },
  {
    file: 'e2e-datadir.yml',
    kind: 'pending',
    expiresAt: '0.8.0',
    evidence: 'e2e-datadir.yml',
    why:
      '回答「Windows 上到底能不能真的移动数据目录」，且开发机以 root 跑 C4 必 SKIP —— ' +
      '真正要拿结论的就是 CI 上的非 root 运行。**文件没有交代为什么只能手动。**',
    forks: '① 照六条腿的先例铺 cron（20:15 UTC）；② 补一句理由说明它为什么不该定时跑。',
  },
];

/** `0.N.P` → 可比较的三元组。格式由 `VERSION_RE` 保证，这里只做拆分。 */
function parseVersion(v) {
  if (!VERSION_RE.test(v)) throw new Error(`版本号 ${JSON.stringify(v)} 不符合 0.N.P`);
  return v.split('.').map(Number);
}

/** a >= b ? */
export function versionAtLeast(a, b) {
  const [, an, ap] = parseVersion(a);
  const [, bn, bp] = parseVersion(b);
  return an !== bn ? an > bn : ap >= bp;
}

/** 一个 workflow 有没有**自动**触发器。`workflow_dispatch` 不算 —— 它要人按。 */
export function isDark(doc) {
  const on = doc?.on ?? {};
  return on.push === undefined && on.pull_request === undefined && on.schedule === undefined;
}

async function collectDark(wfDir = WF_DIR) {
  const files = (await readdir(wfDir)).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const dark = [];
  for (const f of files.sort()) {
    const doc = parse(await readFile(join(wfDir, f), 'utf8'));
    if (isDark(doc)) dark.push(f);
  }
  return { files, dark };
}

/**
 * @param {{version: string, registry?: typeof DARK_WORKFLOWS, wfDir?: string}} o
 *
 * `wfDir` 是给自检用的：**判定机制的正确性不该依赖于今天登记册里恰好有哪几条**。
 * 上一版的自检拿 `proxy-coverage.yml` 当"过期"那一格的样本，
 * 而那一格**一旦被兑现（挂上 cron）就不再是暗的**，自检当场跟着坏 ——
 * 一条会被"把事情做对"弄坏的自检，等于在惩罚做对。所以样本改用 /tmp 里的夹具。
 */
export async function audit({ version, registry = DARK_WORKFLOWS, wfDir = WF_DIR } = {}) {
  const problems = [];
  const { files, dark } = await collectDark(wfDir);

  /* 空转防线：一个 workflow 都没扫到 = 这道门什么都没检查，却会报绿。 */
  if (files.length === 0) {
    problems.push(`${wfDir} 里一个 workflow 都没有 —— 这道门会因为"没东西可查"而永远绿`);
    return { problems, dark, files };
  }
  if (dark.length === 0) {
    problems.push(
      '一条只能手动触发的 workflow 都没扫到。这**可能**是好事，但更可能是 `isDark()` 的判据坏了 —— ' +
        '本仓 2026-08-23 实测有 13 条。真的清零了，请连同这条断言一起改掉。',
    );
  }

  const byFile = new Map(registry.map((e) => [e.file, e]));

  /* ① 每条 dark 都得登记。新建一个只能手动跑的 workflow ⇒ 在这里被逼着二选一。 */
  for (const f of dark) {
    if (!byFile.has(f)) {
      problems.push(
        `${f}: 只有 workflow_dispatch，却没在 DARK_WORKFLOWS 里登记。\n` +
          `    没有触发器 ⇒ 没有新判决 ⇒ 它的红会停在最后一次运行那天，而代码继续往前走\n` +
          `    （\`[实测]\` ci-crossplatform 与 proxy-coverage 各红了 12 天没人知道）。\n` +
          `    请二选一：kind:'deliberate' + evidence（指向该文件里说明理由的行），\n` +
          `    或 kind:'pending' + expiresAt + forks（两条出路）。`,
      );
    }
  }

  /* ② 反向：登记了却已经不 dark（或文件没了）的条目要红，否则这册子会变成只增不减的许可证。 */
  for (const e of registry) {
    if (!files.includes(e.file)) {
      problems.push(`DARK_WORKFLOWS 里的 ${e.file} 不存在了 —— 删掉这条登记`);
    } else if (!dark.includes(e.file)) {
      problems.push(
        `DARK_WORKFLOWS 里的 ${e.file} 已经有自动触发器了 —— 删掉这条登记。\n` +
          `    留着它等于给"下一次有人把触发器摘掉"预先发好了通行证。`,
      );
    }
  }

  /* ③ 形状：deliberate 要 evidence，pending 要 expiresAt + forks。 */
  for (const e of registry) {
    if (e.kind === 'deliberate') {
      if (!e.evidence) {
        problems.push(
          `${e.file}: kind:'deliberate' 必须给 evidence —— 理由要写在那个文件里，` +
            `这里只做索引。两处都写会漂，而漂掉的那半失效时看起来和从没有过一模一样。`,
        );
      }
      if (e.expiresAt) {
        problems.push(`${e.file}: kind:'deliberate' 不该有 expiresAt（它就该永远手动）`);
      }
    } else if (e.kind === 'pending') {
      if (!e.expiresAt) {
        problems.push(
          `${e.file}: kind:'pending' 必须给 expiresAt —— 没有截止线的"挂起"就是永久停车位`,
        );
      }
      if (!e.forks) {
        problems.push(
          `${e.file}: kind:'pending' 必须给 forks（两条出路）—— ` +
            `说不出出路的挂起项说明它还没想清楚，而那本身就是有用的信号`,
        );
      }
    } else {
      problems.push(
        `${e.file}: kind 只能是 'deliberate' 或 'pending'（实得 ${JSON.stringify(e.kind)}）`,
      );
    }
    if (!e.why) problems.push(`${e.file}: 缺 why`);
  }

  /* ④ ★ 过期判定 —— 这道门存在的理由。 */
  const expired = registry.filter(
    (e) => e.kind === 'pending' && e.expiresAt && versionAtLeast(version, e.expiresAt),
  );
  for (const e of expired) {
    problems.push(
      `🔴 ${e.file}: **过期判据已经触发** —— 登记的截止版本是 v${e.expiresAt}，` +
        `产品现在是 v${version}。\n` +
        `    ${e.why}\n` +
        `    两条出路（二选一，停在这里不算终态）：${e.forks}\n` +
        `    ⚠️ 别靠改大 expiresAt 让它闭嘴。上一次正是这样滑掉的：` +
        `proxy-coverage 的判据写在 YAML 注释里，仓库发了 0.7.2/0.7.3/0.7.4 三次都没人看见。\n` +
        `    真要顺延，请在登记里写清楚**这一轮变了什么，使得它不会再滑一次**。`,
    );
  }

  return { problems, dark, files, expired };
}

async function main() {
  const version = readProductVersion();
  const { problems, dark, files, expired } = await audit({ version });

  const reg = new Map(DARK_WORKFLOWS.map((e) => [e.file, e]));
  console.log(
    `══ check-workflow-expiry ══ ${files.length} 个 workflow，其中 ${dark.length} 条只能手动触发` +
      `（产品 v${version}）`,
  );
  for (const f of dark) {
    const e = reg.get(f);
    if (!e) continue;
    const tag =
      e.kind === 'deliberate'
        ? '刻意手动'
        : `挂起 → v${e.expiresAt}${expired?.some((x) => x.file === f) ? ' 🔴已过期' : ''}`;
    console.log(`   · ${f.padEnd(30)} ${tag}`);
  }

  if (problems.length > 0) {
    console.error(`\n✘ check-workflow-expiry: ${problems.length} 条\n`);
    for (const p of problems) console.error(`  ✘ ${p}\n`);
    process.exit(1);
  }
  const pend = DARK_WORKFLOWS.filter((e) => e.kind === 'pending').length;
  console.log(
    `\n✔ check-workflow-expiry: ${dark.length} 条只能手动触发的 workflow 全部登记在册` +
      `（${dark.length - pend} 条刻意手动 / ${pend} 条挂起且都还没到期）`,
  );
}

// 被 selftest import 时不自动跑。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
