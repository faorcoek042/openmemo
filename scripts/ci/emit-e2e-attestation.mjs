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
 *     [--undecided N] [--mode sample|full] [--mutations ran|skipped] \
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
/*
 * ★ `--mutations`（#102，2026-08-12）：**变异验证这一轮到底跑没跑。**
 *
 * ## 它修的那件事（真事故，不是假想）
 *
 * `[实测 e2e-runtime run 31568740737]`：三平台审计全 `success`、
 * `变异验证（linux-x64）` **failure**（一条变异存活）、run 的 conclusion 是 **failure**，
 * 而 `e2e-attest-runtime-31568189189` **照发了、未过期**。成因是 attest 作业的
 * `needs:` 里只有审计那个 job，变异 job 不在里面 —— 三平台审计全绿 ⇒ attest 照跑照发。
 *
 * 修法有两半，这个字段是**第二半**：
 *   ① `needs:` 补上变异 job，并在 `if:` 里显式白名单 `success | skipped`
 *      ⇒ **变异红 = 凭证根本不存在**（所以下面**没有** `failed` 这个取值，
 *        不是忘了写：能走到这个脚本的运行，变异必然没红）；
 *   ② 变异**被跳过**时凭证照发（否则 `mutations=false` 的跑会让发布闸门直接卡死），
 *      但必须**在凭证里说出来** —— 这就是本字段。**跳过 ≠ 通过。**
 *
 * ## 取值（三个）
 *
 *   · `ran`             —— 跑了，且**每一条变异都有结论**（抓住 / 存活）。
 *   · `ran-unverified`  —— 跑了，但**至少一条什么都没证明**（前提构造不出来 / 腿炸了 /
 *                          根本没跑到）。**具体是哪几条见 `unverifiedMutations`。**
 *   · `skipped`         —— 这一轮**没跑**（例如显式 `mutations=false`）。
 *   · 不传 ⇒ `null` —— **这条腿没接这个字段**，与 `skipped` 是两句不同的话
 *     （和 `undecided` 的 `null` vs `0` 同一条规矩）。
 *
 * ## 🔴 `ran` 的语义**收紧过一次**（v0.7.3 已知边界第 13 条，2026-08-17 关掉）
 *
 * 这里**曾经**只有两个取值，并且原文写着「只有两个，别加第三个」，理由是：
 *
 *   > `e2e-runtime-audit.mjs --mutate` 的退出码是三态的，`3 = 跑起来了但什么都没证明`
 *   > **不判红**。所以 `ran` 里仍可能有若干条什么都没证明的变异 —— 它们今天只出现在
 *   > 日志与 step summary 里，**还没有被数出来**。把那个数接进来是**下一步**
 *   > （形状与 `--undecided` 完全相同）。
 *
 * **那句"下一步"就是这一次。** 在它落地之前，`ran` 是一句**把两种结局合起来说的话**，
 * 而这种话会被读成前一种 —— `e2e-runtime` 的 darwin 格从 2026-08-10 起每一轮都是
 * `M-driver-lie` 退出码 3（`metal.probed` 恒为 true，前提在**任何一台 Mac** 上都不存在），
 * 而凭证上一直写着 `mutations: ran`，读起来是好消息。
 *
 * ⇒ 现在 `ran` **真的意味着「每一条都有结论」**：只要有一条没结论，就必须是
 *   `ran-unverified`，并且**必须同时给出是哪几条**（下面的互相校验会挡住只给其一）。
 *
 * ## ⚠️ `schemaVersion` 因此从 1 升到 2
 *
 * **不是加字段，是改语义** —— 老凭证里的 `ran` 与新凭证里的 `ran` 不是同一句话。
 * 消费方靠 `schemaVersion` 区分（见 `attestation-coverage.mjs` 的 `mutationState()`）：
 * 老凭证的 `ran` **不许**被当成新语义下的 `ran`。
 */
const mutations = arg('--mutations', null);
if (undecidedRaw !== null && !/^\d+$/.test(String(undecidedRaw))) {
  die(`--undecided 必须是非负整数，实得 ${JSON.stringify(undecidedRaw)}`);
}
if (mode !== null && !/^(sample|full)$/.test(String(mode))) {
  die(`--mode 只能是 sample 或 full，实得 ${JSON.stringify(mode)}`);
}
/**
 * ★ `--unverified-mutations`：**哪几条**什么都没证明（逗号分隔，形如
 * `darwin-arm64:M-driver-lie`）。
 *
 * 只给一个 `ran-unverified` 而不说是哪几条，下一个人看到它仍然不知道该去查什么 ——
 * 那是"报了个警但没给线索"，本仓已经吃过这一课（`removed` 在数它没删掉的东西）。
 * 所以下面有一条**互相校验**：两者必须同时出现，或者同时不出现。
 */
const unverifiedRaw = arg('--unverified-mutations', null);
if (mutations !== null && !/^(ran|ran-unverified|skipped)$/.test(String(mutations))) {
  die(
    `--mutations 只能是 ran / ran-unverified / skipped，实得 ${JSON.stringify(mutations)}。\n` +
      '  （**故意没有 failed 这个取值**：变异红的运行不该走到这里 —— 发凭证那个作业的\n' +
      '   `if:` 应该已经把它挡在门外了。收到别的值说明那道门被改松了，此刻**当场炸**\n' +
      '   比发一张写着奇怪值的凭证好。）',
  );
}

/**
 * ★ 互相校验：**`ran-unverified` 与「是哪几条」必须同进同出。**
 *
 * 两个方向都要挡，因为两个方向各自造出一种假话：
 *   · 有 `ran-unverified` 却没有清单 ⇒ 报了个警、没给线索，没人查得动；
 *   · 有清单却写着 `ran` ⇒ **凭证在说「每条都有结论」，而它自己带着反例**。
 * 在这里炸掉，比发一张自相矛盾的凭证好（与上面那条 `failed` 同一条道理）。
 */
const unverifiedList = String(unverifiedRaw ?? '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
if (mutations === 'ran-unverified' && unverifiedList.length === 0) {
  die(
    '--mutations ran-unverified 必须同时给 --unverified-mutations（是哪几条）。\n' +
      '  只说"有一条没证明"而不说是哪条，读凭证的人仍然不知道该去查什么。',
  );
}
if (unverifiedList.length > 0 && mutations !== 'ran-unverified') {
  die(
    `给了 --unverified-mutations（${unverifiedList.length} 条）却把 --mutations 写成 ` +
      `${JSON.stringify(mutations)}。\n` +
      '  那张凭证会一边说"每条变异都有结论"、一边带着反例 —— 自相矛盾的凭证比没有更坏。',
  );
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
  /*
   * ★ 1 → 2（2026-08-17）：**不是加字段，是改语义。**
   *   `mutations: 'ran'` 在 v1 里含义是「跑了且没红」（把"有一条没结论"也算了进去），
   *   在 v2 里含义是「**每一条都有结论**」。消费方必须靠这个版本号把两者分开，
   *   否则老凭证会被读成一句它从来没说过的话。见 `attestation-coverage.mjs`。
   */
  schemaVersion: 2,
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
  /**
   * ★ `mutations`（#102）：`ran` = 变异验证跑了且没红；`skipped` = **这一轮没跑**；
   * `null` = 这条腿没接这个字段。**跳过 ≠ 通过** —— 一条从来没红过的断言
   * 和一条不存在的断言，对用户来说是同一个东西，而"变异整轮没跑"就是那种状态。
   * ⚠️ 没有 `failed`：那种运行**不该有凭证**（挡在发凭证作业的 `if:` 上）。
   */
  mutations: mutations === null ? null : String(mutations),
  /**
   * ★ `unverifiedMutations`：**哪几条什么都没证明**（`ran-unverified` 时非空）。
   * 形如 `["darwin-arm64:M-driver-lie"]`。`null` = 没上报这一格。
   * 只给状态不给清单，等于报了个警却没给线索 —— 上面有互相校验挡着。
   */
  unverifiedMutations: unverifiedList.length > 0 ? unverifiedList : null,
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
    ` · 抽样 ${mode === null ? '不适用/未上报' : mode}` +
    ` · 变异 ${mutations === null ? '不适用/未上报' : mutations}`,
);
if (mutations === 'ran-unverified') {
  console.log(
    `   ⚠️ 本轮有 ${unverifiedList.length} 条变异**什么都没证明**（mutations=ran-unverified）：`,
  );
  for (const u of unverifiedList) console.log(`        · ${u}`);
  console.log('      它们既没被抓住，也不代表存活 —— 这几条断言"会不会红"本轮**没有被证明过**。');
}
if (mutations === 'skipped') {
  console.log(
    '   ⚠️ 本轮**变异验证整个没跑**（mutations=skipped）——' +
      ' 这张凭证说的是"断言跑绿了"，**没说那些断言有牙齿**。跳过 ≠ 通过。',
  );
}
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
