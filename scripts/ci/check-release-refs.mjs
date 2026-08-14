#!/usr/bin/env node
/**
 * 「目录里还有没有地址指向某个 release」+「它们是不是还活着」。
 *
 * ## 为什么需要它（Manager 2026-08-09 裁决「从现在起不删 release」）
 *
 * 预编译包**内嵌** `vendor/manifests`（为的是修「组件页是空的」）。
 * 内嵌的代价是：**包出厂那一刻，它要下载的 URL 就被冻住了。**
 * 于是删掉一个 release，就**永久打死所有还指着它的、已经在用户机器上的包** ——
 * 用户看不到"某个 tag 没了"，他只看到「点安装没反应 / 下载失败」。
 *
 * `[实测 2026-08-09]` 这件事已经真的发生过一次：
 *   · 包 `openmemo-0.4.0`（commit 99995b8，01:00）内嵌清单指向 **v0.3.0**
 *   · `ddccef4`（03:58）把目录重指 v0.4.0；随后 **v0.3.0 被删**
 *   · `curl` 实测：v0.3.0 → **404**、v0.4.0 → 206
 *   · 结果：三平台 whisper.cpp 一族（含 GPU 加速包）全部装不上
 *
 * ## 判据不是"记得别删"
 *
 * 本仓立过一条：**"跑错了也不会造成后果"** 才算修好（PROTOCOL §7 补充）。
 * 一条要人时刻记住的规则，等价于一条迟早会被违反的规则。
 *
 * ⚠️ **但要如实说清这个守卫的边界**：删 release 是**人在本地敲的一条 `gh` 命令**，
 * 仓库里没有任何东西能在服务端拦住它（没有 release 的分支保护，也没有服务端钩子）。
 * 所以这个脚本做的是**另外两件真的做得到的事**：
 *
 *   ① `--tag <tag>`：删之前问一句「还有谁指着它」。有人指着就 **exit 1**，
 *      把"我以为没人用了"变成一个当场的、有名有姓的清单。
 *   ② `--assert-live`：**发包之前**把目录里指向我们自己 release 的地址逐个探一遍，
 *      死了一个就红。这一条不依赖任何人记得什么 —— 就算真有人删了，
 *      **它也会在包发出去之前就红**，而不是等用户装不上。
 *
 * ①是给人的，②是给机器的。**只有②满足"跑错了也不会造成后果"。**
 *
 * 用法：
 *   node scripts/ci/check-release-refs.mjs --assert-live          # 发布前闸门用
 *   node scripts/ci/check-release-refs.mjs --assert-availability  # pending-ci 的地址不许真的下得到
 *   node scripts/ci/check-release-refs.mjs --tag v0.3.0           # 删之前问一句
 *   node scripts/ci/check-release-refs.mjs --manifests <dir>      # 指定清单目录（默认仓库的）
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectReleaseRefs } from './e2e-allcomponents-assertions.mjs';
import { probeFollow as probe } from './probe-mirror.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const MANIFESTS = arg('--manifests', join(REPO, 'vendor', 'manifests'));
const TAG = arg('--tag', null);
const ASSERT_LIVE = argv.includes('--assert-live');
const ASSERT_AVAILABILITY = argv.includes('--assert-availability');

const say = (s = '') => console.log(s);

if (!existsSync(MANIFESTS)) {
  console.error(`✘ 清单目录不存在：${MANIFESTS}`);
  process.exit(2);
}

/** 读清单目录，收集所有 URL。 */
function readAllUrls(dir) {
  const urls = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    let j;
    try {
      j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    const push = (id, files) => {
      for (const file of files ?? []) {
        for (const m of file.mirrors ?? []) {
          if (m.url) urls.push({ id, file: file.name ?? '?', url: m.url });
        }
      }
    };
    for (const p of j.packs ?? []) push(p.id, p.files);
    for (const m of j.models ?? []) push(m.id, m.files);
  }
  return urls;
}

/*
 * ★★ #111 ①：这里原本有一份**自己手写的** `probe()`，现在直接用 `probe-mirror.mjs`
 *    的 `probeFollow()`。删掉的那份里有两个真 bug，而两个都是"今天无害"的：
 *
 *      const req = httpsRequest({ host: u.host, … })   // ← 删掉的原文
 *
 *    ① `host: u.host` —— **`URL.host` 含端口**，且这里根本没传 `port`。
 *       对 `https://github.com/...` 没事（默认端口不出现在 `u.host` 里），
 *       对 `http://127.0.0.1:41273/...` 就变成"去解析一个叫 `127.0.0.1:41273` 的主机名"
 *       ⇒ 一个请求都发不出去。
 *    ② 无论 `u.protocol` 是什么都走 `node:https` ⇒ `http:` 的地址必然连不上。
 *
 *    这是**同一形状的第二个实例**。第一个（`probe-mirror.mjs::probeUrl`）在 #108
 *    被自检当场抓出来：`[CI 实测 run 31695269578]` 12 条里 7 条一起红。
 *    它在真实清单上一直潜伏，是因为 release 地址不带端口、也全是 https ——
 *    **潜伏不是因为它对，是因为没有任何输入能让它错**。
 *
 *    所以修法不是"把这份改对"，而是**不再有第二份**：
 *    `probeUrl()` 已经有 `selftest-probe-mirror.mjs` 守着，那份自检起的是一个
 *    绑 `:0`、由 OS 分端口的桩上游 —— 也就是说，这条腿从此**继承**了
 *    唯一能让这个 bug 现形的那种输入。手写一份新的就等于退出那份自检的覆盖范围。
 *
 * ⚠️ 两处行为差异，都是划算的：
 *    · 每个地址取 64 KB（原来 1 KB）。发布前一次几十个地址，多几 MB，可忽略。
 *    · User-Agent 变成 `openmemo-e2e-allcomponents`（`probeUrl` 里写死的）。
 *      上游日志里两条腿从此不好分 —— 但换来的是判据只剩一份。
 *      `probe-mirror.mjs` 不在本次改动范围内，不为了这个去动它。
 *
 * 返回形状与原来那份兼容：`{ ok, status, reason }`（确定性失败时没有 `status`，
 * 下面的消费方本来就写的是 `res.status || res.reason`）。
 */

const all = readAllUrls(MANIFESTS);
const ours = collectReleaseRefs(all);

say(`清单目录：${MANIFESTS}`);
say(`共 ${all.length} 个下载地址，其中指向**我们自己 release** 的 ${ours.length} 个。`);

/* ── ①「删之前问一句」 ── */
if (TAG) {
  const hits = ours.filter((r) => r.tag === TAG);
  say('');
  say(`── 还有谁指着 ${TAG} ──`);
  if (hits.length === 0) {
    say(`   （没有）→ 删除 ${TAG} 不会打死任何还指着它的包。`);
    process.exit(0);
  }
  for (const h of hits) say(`   ${String(h.id).padEnd(34)} ${h.file}`);
  say('');
  say(
    `✘ **${hits.length} 个组件仍然指向 ${TAG}** —— 删掉它会永久打死所有内嵌了这份清单的已发出的包。`,
  );
  say('   （包出厂那一刻 URL 就冻住了：用户不会看到"tag 没了"，只看到"点安装没反应"。）');
  say('   Manager 2026-08-09 裁决：**从现在起不删 release。**');
  process.exit(1);
}

/* ── ②「发包之前，指向我们自己 release 的地址必须都活着」 ── */
if (ASSERT_LIVE) {
  if (ours.length === 0) {
    /*
     * ★ 空集必须出声。`[].every()` 恒真 —— "一个都没死"与"一个都没查"
     *   在输出里长得一模一样，本仓已经在别处栽过不止一次。
     */
    say('');
    say('✘ 前提不成立：清单里**一个**指向我们自己 release 的地址都没有。');
    say('   要么清单读错了，要么全都换成上游了 —— 无论哪种，这一轮都没有验到东西。');
    process.exit(1);
  }
  say('');
  say(`── 逐个探测（${ours.length} 个）──`);
  const dead = [];
  for (const r of ours) {
    const res = await probe(r.url);
    if (!res.ok) dead.push({ ...r, status: res.status, reason: res.reason });
    say(
      `   ${res.ok ? '✔' : '✘'} ${String(r.tag).padEnd(10)} ${String(r.id).padEnd(32)} ${res.ok ? res.status : `**${res.status || res.reason}**`}`,
    );
  }
  say('');
  if (dead.length > 0) {
    const tags = [...new Set(dead.map((d) => d.tag))];
    say(`✘ **${dead.length} 个地址已经死了**，涉及 tag：${tags.join(', ')}`);
    for (const d of dead) say(`     ${d.id} → ${d.url}（${d.status || d.reason}）`);
    say('');
    say('   这意味着：**所有内嵌了这份清单的已发出的包，这些组件永久装不上。**');
    say('   如果这个 tag 是被删掉的 —— 那正是 2026-08-09 那次事故的形状，请把它恢复回来。');
    process.exit(1);
  }
  say(`✔ ${ours.length} 个指向我们自己 release 的地址全部还活着。`);
  process.exit(0);
}

/* ── ③「标着 pending-ci、地址却真的能下」= 忘了翻标记 ── */
if (ASSERT_AVAILABILITY) {
  /*
   * ## 这条判据要抓的东西（T-196）
   *
   * `[用户真机 Windows v0.7.0]` 报「whisper.cpp Vulkan 后端没得下载安装使用」。
   * 真相不是下载失败 —— 是**按钮恒灰、从来没发出过请求**：
   * `whispercpp-vulkan-win-x64` 带着 `availability: "pending-ci"`，
   * 卡片据此把按钮 `disabled` 掉，文案写「尚未发布，暂不可安装」。
   * **而那个包早就在 v0.6.0 的架上了。**
   *
   * 标记在 `474c210`（2026-08-08）写下时是实话；那次提交自己的说明里就写着
   * 「发到 release 之后又用不带任何 token 的 curl 匿名重下复算，2/2 吻合」——
   * **发完了，标记没翻。** 从那一刻起清单上那句话就成了假话，
   * 而全仓没有任何一处判据会发现它。
   *
   * ## 为什么不是「pending-ci 不许带 URL」
   *
   * 那个写法会挡住正常流程：**包构建出来了、URL 已知、但还没上架**，
   * 正是 `pending-ci` 带 URL 的合法用法（`BackendPackSchema` 的 superRefine 允许它）。
   * 禁掉它等于逼人在"上架前不许写地址"和"上架后必须记得回来补地址"之间选一个 ——
   * 两个都靠人记得。
   *
   * 所以判据钉的是**后果**：`pending-ci` 说的是"你现在下不到"。
   * 那就去下一下 —— **真能下，这句话就是假的**。
   *
   * 与既有两条守卫的分工（它们都在**另一个方向**上）：
   *   · `BackendManifestSchema`（shared）：`published` ⇒ 必须有 URL
   *   · `merge-backend-manifest.mjs`：不许把 `published` 降级成 `pending-ci`
   *   · **本条**：`pending-ci` ⇒ 地址必须真的下不到
   */
  const pendingWithUrl = [];
  for (const f of readdirSync(MANIFESTS).filter((n) => n.endsWith('.json'))) {
    let j;
    try {
      j = JSON.parse(readFileSync(join(MANIFESTS, f), 'utf8'));
    } catch {
      continue;
    }
    for (const p of j.packs ?? []) {
      if (p.availability !== 'pending-ci') continue;
      for (const file of p.files ?? []) {
        for (const m of file.mirrors ?? []) {
          if (m.url) pendingWithUrl.push({ id: p.id, file: file.name ?? '?', url: m.url });
        }
      }
    }
  }

  say('');
  say(`── pending-ci 且写了地址的：${pendingWithUrl.length} 个 ──`);
  if (pendingWithUrl.length === 0) {
    /*
     * ★ 空集必须出声，但**不是失败**。
     * 「一个 pending-ci 都没有」是完全正常的状态（全都上架了），
     * 与 `--assert-live` 那边的空集不同 —— 那边空集意味着"这一轮什么都没验"。
     * 这里空集意味着"没有可疑对象"，是真结论。两者不能用同一个处置。
     */
    say('   （没有 —— 目录里没有任何标着 pending-ci 的包，这一条没有可疑对象。）');
    process.exit(0);
  }

  const lying = [];
  for (const r of pendingWithUrl) {
    const res = await probe(r.url);
    if (res.ok) lying.push({ ...r, status: res.status });
    say(
      `   ${res.ok ? '✘' : '✔'} ${String(r.id).padEnd(32)} ${res.ok ? `**HTTP ${res.status} —— 真的下得到**` : `下不到（${res.status || res.reason}）`}`,
    );
  }
  say('');
  if (lying.length > 0) {
    say(`✘ **${lying.length} 个包标着 pending-ci，地址却真的下得到** —— 是发完之后忘了翻标记。`);
    for (const d of lying) say(`     ${d.id} → ${d.url}`);
    say('');
    say('   后果不是"下载失败"，是**按钮恒灰、点不动、永远不发请求**');
    say(
      '   （`BackendPackCard.tsx` 的 `disabled={… || pendingCi}`，文案「尚未发布，暂不可安装」）。',
    );
    say('   用户看到的是"这个后端没得下载安装使用"，而东西一直在架上。');
    say('   → 把这些包的 `availability` 改成 `published`。');
    process.exit(1);
  }
  say(`✔ ${pendingWithUrl.length} 个 pending-ci 的地址确实都还下不到 —— 标记与事实一致。`);
  process.exit(0);
}

say('');
say('（没给 --tag / --assert-live / --assert-availability，只做了统计。）');
for (const t of [...new Set(ours.map((r) => r.tag))]) {
  say(`   ${t}: ${ours.filter((r) => r.tag === t).length} 个组件`);
}
