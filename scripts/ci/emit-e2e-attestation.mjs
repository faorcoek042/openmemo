#!/usr/bin/env node
/**
 * 发一张**「这条 e2e 腿对着某一批包跑绿过」**的凭证。
 *
 * ## 这张凭证要解决的事故（已经发生过一次）
 *
 * `v0.3.0` 发出去之后才发现：四条 e2e 腿此前跑的**都是更早的包**
 * （head `b76c6b6c` / `0303e536` / `0853b8e4` / `2ff6c453`，全在 `aa92cba3` 之前）。
 * 是用户追问「确定各平台都验过了吗」才查出来的。
 *
 * 成因不是谁偷懒，是**判据没有对准交付物**：
 *
 * > **e2e 腿测的是「包」，不是「树」。**
 * > 它绿，只说明**那一批包**好；不说明 HEAD 好。
 * > 反过来，HEAD 修好了它也**不会自己变绿** —— 得先重新出包。
 *
 * 于是「跑过 e2e」与「要发的这批包」之间**没有任何机器可查的联系**，
 * 全靠人记得。而本仓已经立过这条判据：
 * **「一个需要人记得去填的参数，等价于一个迟早不会被填的参数。」**
 *
 * ## 判定为什么落在 **artifact 名字**上
 *
 * 与 `bundles-complete` 同一形状同一理由（PROTOCOL §11：绿灯必须能追溯到
 * **这次 run 真的产出的东西**）：
 *
 *   · 凭证 = artifact **名字** `e2e-attest-<leg>-<bundleRunId>` 存在与否。
 *   · 消费方**不需要下载、不需要解析、不需要相信文件里写了什么** —— 问名字在不在就够了。
 *   · 名字里带 `bundleRunId`，所以它**天然绑定到那一批包**，
 *     换一批包 = 换一个名字 = 旧凭证自动失效。这正是上面那次事故缺的东西。
 *
 * 文件内容（平台清单、commit、e2e run id）只用于**事后审计**，不参与判定 ——
 * 一个需要读内容才能判定的凭证，迟早会有人读错。
 *
 * ★ 2026-08-10 补一句，免得上面那段被读成"内容永远没人看"：
 *   **判定**仍然只看名字（一个字没改）；但闸门现在会**把内容读出来念一遍覆盖面**
 *   （`undecided` / `mode`）。理由：一条腿可以三平台全绿却带着几条没验到的断言，
 *   而"名字在不在"讲不出这件事。**读出来 ≠ 参与判定** —— 要不要因此拒绝放行，
 *   是 Manager 的裁决，不是这个脚本的。
 *
 * ## 发凭证的 job 必须 `needs:` 全部平台，且**不带任何 `if:`**
 *
 * 任何一个平台失败或被跳过 → 这个 job 自己被跳过 → **那个 artifact 根本不存在**。
 * 「部分跑」的 run 里不会出现一张说了半句真话的凭证。
 * （与 `build-bundles` 的 `complete` job、`build-backends` 的 `merge-manifest` 同理；
 *   后者的 `if: always()` 曾让"三条腿全挂"写出 `packs: []` 然后报绿。）
 *
 * ## 用法
 *
 *   node scripts/ci/emit-e2e-attestation.mjs \
 *     --leg import --bundle-run 31252923419 \
 *     --platforms linux-x64,darwin-arm64,win32-x64 \
 *     --out dist/e2e-attest.json [--github-output "$GITHUB_OUTPUT"]
 *
 * 缺任何一个必填项就 **exit 1 且不写文件** —— 一个说了半句真话的凭证比没有更糟。
 */
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt = undefined) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};

const die = (msg) => {
  console.error(`✘ ${msg}`);
  console.error('  （凭证没有写出去 —— 半真的凭证比没有更糟。）');
  process.exit(1);
};

const leg = arg('--leg');
const bundleRun = arg('--bundle-run');
const platforms = String(arg('--platforms', ''))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const out = arg('--out', 'dist/e2e-attest.json');
/*
 * ★ 覆盖面两格（Manager 2026-08-10 裁决）：**一张不说覆盖面的凭证，
 *   会让闸门给出比实际更强的保证。**
 *
 * · `--undecided N`：这条腿本轮有多少条断言是"无从判断"（跑了，但什么都没证明）。
 *   一条腿可以**三平台全绿**却带着若干条没被验到的断言
 *   （`[CI 实测 e2e-browser run 31367583056]` darwin 就带着 4 条），
 *   而凭证只说"跑绿过"，读起来像"全验过"。
 * · `--mode sample|full`：`allcomponents` 那种抽样覆盖面。
 *   `mode=sample` 时 18/30 个模型变体被跳过（大号 Whisper 全在跳过里，
 *   因为 runner 装不下 39.4 GB）—— 那不是"验过了"。
 *
 * 两个都是**可选**：不传就写 null，老调用方一个字都不用改（schema 向后兼容）。
 * ⚠️ artifact 的**名字一个字不改** —— 现有消费方靠名字精确匹配。
 */
const undecidedRaw = arg('--undecided', null);
const mode = arg('--mode', null);
if (undecidedRaw !== null && !/^\d+$/.test(String(undecidedRaw))) {
  die(`--undecided 必须是非负整数，实得 ${JSON.stringify(undecidedRaw)}`);
}
if (mode !== null && !/^(sample|full)$/.test(String(mode))) {
  die(`--mode 只能是 sample 或 full，实得 ${JSON.stringify(mode)}`);
}

if (!leg || !/^[a-z0-9-]+$/.test(leg))
  die(`--leg 缺失或不合法（只允许小写字母/数字/连字符）：${leg}`);
/*
 * ★ `bundleRunId` 必须是纯数字。
 *   它会成为 artifact 名字的一部分，而消费方是**按名字精确匹配**去问的 ——
 *   一个带空格或换行的 id 会生成一个永远问不到的名字，
 *   于是这条腿看起来"发过凭证了"，闸门却永远说没有。
 */
if (!bundleRun || !/^\d+$/.test(bundleRun)) {
  die(
    `--bundle-run 必须是纯数字的 run id，实得 ${JSON.stringify(bundleRun)}。\n` +
      '  （它会拼进 artifact 名字；不是纯数字就会生成一个消费方永远问不到的名字。）',
  );
}
if (platforms.length === 0) die('--platforms 是空的 —— 说不出跑过哪些平台的凭证没有意义');

const attestation = {
  schemaVersion: 1,
  leg,
  /** 这张凭证绑定的**那一批包**。换一批包就是另一个名字，旧凭证自动失效。 */
  bundleRunId: bundleRun,
  platforms,
  /**
   * ★ 覆盖面：**"跑绿过"不等于"全验过"**。
   * `undecided` = 本轮"无从判断"的断言条数（null = 这条腿没上报，不是 0）。
   * `mode`      = 抽样覆盖面（sample/full；null = 不适用或没上报）。
   * ⚠️ null 与 0 **不是一回事**：0 是"报了，确实一条都没有"，
   *    null 是"这条腿还没接线" —— 闸门必须把这两种说成不同的话。
   */
  undecided: undecidedRaw === null ? null : Number(undecidedRaw),
  mode: mode === null ? null : String(mode),
  /** 以下只用于事后审计，**不参与判定**。 */
  e2eRunId: process.env.GITHUB_RUN_ID ?? null,
  e2eRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  e2eCommit: process.env.GITHUB_SHA ?? null,
  repository: process.env.GITHUB_REPOSITORY ?? null,
  emittedAt: new Date().toISOString(),
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(attestation, null, 2)}\n`);

/** 凭证的名字就是判定本身 —— 消费方问的就是这个字符串在不在。 */
const artifactName = `e2e-attest-${leg}-${bundleRun}`;

console.log('─'.repeat(88));
console.log(`── e2e 凭证：${artifactName}`);
console.log('─'.repeat(88));
console.log(`   腿      ：${leg}`);
console.log(`   针对包  ：build-bundles run ${bundleRun}`);
console.log(`   平台    ：${platforms.join(', ')}`);
console.log(
  `   覆盖面  ：未决 ${undecidedRaw === null ? '未上报' : `${undecidedRaw} 条`}` +
    ` · 抽样 ${mode === null ? '不适用/未上报' : mode}`,
);
if (undecidedRaw !== null && Number(undecidedRaw) > 0) {
  console.log(
    `   ⚠️ 这条腿有 ${undecidedRaw} 条断言**没被验到**（无从判断）——` +
      ` 这张凭证证明的是"跑绿过"，**不是"全验过"**。`,
  );
}
console.log(`   e2e run ：${attestation.e2eRunId ?? '(本机)'}`);
console.log(`   写到    ：${out}`);
console.log('');
console.log('   ⚠️ 判定落在**artifact 名字**上，不在这个文件的内容上。');
console.log('      消费方（发布前那道闸）只问「这个名字在不在」。');

const ghOut = arg('--github-output', process.env.GITHUB_OUTPUT);
if (ghOut) {
  appendFileSync(ghOut, `artifact_name=${artifactName}\nbundle_run_id=${bundleRun}\n`);
  console.log(`   已写入 GITHUB_OUTPUT：artifact_name / bundle_run_id`);
}
