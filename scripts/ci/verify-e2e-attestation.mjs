#!/usr/bin/env node
/**
 * 发布前那道闸：**这一批包，四条 e2e 腿是不是都对着它跑绿过？**
 *
 * ## 为什么需要它（这是一次真事故的修法，不是加个保险）
 *
 * `v0.3.0` 发出去之后才发现，四条 e2e 腿此前跑的**都是更早的包**。
 * 是用户追问「确定各平台都验过了吗」才查出来的。
 *
 * 与 `v0.2.0` 那次是**同一个形状**：
 *   · v0.2.0：CI 从没执行过启动器 → 用户双击打不开
 *   · v0.3.0：e2e 从没跑过要发的那批包 → 谁也不知道那批包行不行
 * **都是判据没有对准交付物，而且都靠人记得。**
 *
 * 根因是一条容易被读漏的性质：
 *
 * > **e2e 腿测的是「包」，不是「树」。** 它绿只说明**那一批包**好；
 * > 不说明 HEAD 好。反过来 HEAD 修好了它也**不会自己变绿** —— 得先重新出包。
 *
 * 所以「跑过 e2e」和「要发的这批包」之间必须有一条**机器可查**的联系。
 * 那条联系就是 artifact 名字里的 `bundleRunId`。
 *
 * ## 判据（刻意做得很笨，笨才可靠）
 *
 * 对每一条腿 `<leg>`：在该腿 workflow 的**成功** run 里，是否存在一个
 * **未过期**、名为 `e2e-attest-<leg>-<bundleRunId>` 的 artifact？
 *
 *   · 不下载、不解析、不读内容 —— **名字在不在**就是答案。
 *     一个需要读内容才能判定的凭证，迟早会有人读错。
 *   · 名字里带 `bundleRunId` ⇒ **换一批包就是另一个名字**，旧凭证自动失效。
 *     这正是那次事故缺的东西：以前"跑过 e2e"是个没有宾语的句子。
 *   · 只认**成功**的 run（`conclusion === 'success'`）。
 *   · 只认**未过期**的 artifact：存在过 ≠ 现在还能查到（保留期）。
 *
 * ## 缺省是**拒绝**
 *
 * 查不到、查不动、腿的名字对不上 —— **一律拒绝**，不给"看起来没问题"留位置。
 * 这条闸存在的全部理由就是挡住"没人记得去跑"，
 * 而"没人记得"在数据上的样子恰恰就是"查不到"。
 *
 * ## 用法
 *
 *   node scripts/ci/verify-e2e-attestation.mjs --bundle-run 31252923419
 *     [--legs import,notes,record,runtime] [--repo owner/name]
 *
 * 需要 `GH_TOKEN`（`actions: read` 足够）。
 */
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (name, dflt = undefined) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};

const REPO = arg('--repo', process.env.GITHUB_REPOSITORY);
const BUNDLE_RUN = arg('--bundle-run');
/**
 * 登记在案的腿。**写死在这里是有意的**：一条新腿加进来必须显式登记，
 * 否则这道闸会在"腿变多了"的时候悄悄放宽 —— 那正是它要挡的那类漂移。
 */
/*
 * ⚠️ `browser` 这一条曾经叫 `browser-linux` —— 那时它只跑 ubuntu，
 *    而把覆盖面写进腿名，是为了让**限制出现在做判定的这一行上**，不藏在文档里。
 *    `[CI 实测 run 31295977228]` 三平台都跑通之后才改回 `browser`：
 *    **先验证、再改名**，反过来就是"先承诺再看能不能做到"。
 *    哪天某个平台掉了，这个名字要**跟着缩回去**。
 */
const LEGS = String(arg('--legs', 'import,notes,record,runtime,browser,allcomponents'))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
/** 往回翻多少次 run 去找凭证。 */
const SCAN = Number(arg('--scan', '30'));

const say = (s = '') => console.log(s);
const die = (msg) => {
  say('');
  say(`✘ ${msg}`);
  process.exit(1);
};

if (!REPO) die('缺 --repo 或 GITHUB_REPOSITORY');
if (!BUNDLE_RUN || !/^\d+$/.test(BUNDLE_RUN)) {
  die(`--bundle-run 必须是纯数字的 build-bundles run id，实得 ${JSON.stringify(BUNDLE_RUN)}`);
}

/**
 * 调 gh api。**带超时**（PROTOCOL §11：一切外部命令带超时）+ **有限重试**。
 *
 * ## 为什么加重试，而"查不动 = 拒绝"这条又不能松
 *
 * `[实测]` 第一次拿这道闸去问 v0.3.0 那批包时，`record` 那一格撞上
 * `net/http: TLS handshake timeout` —— 闸门于是**拒绝了一批其实已经验全的包**。
 * 拒绝本身没错（"我没问到"决不能渲染成"它没问题"），但**闸门不能是抖的**：
 *
 * > 一道会因为网络抖动随机变红的闸门，会训练所有人「先重跑一次再说」——
 * > 而那正是「学会忽略它」的第一步。
 *
 * 本仓已经为同一族吃过亏（"一条永远红的守卫等于一条被删掉的守卫"），
 * 这是它的**抖动版**：不是永远红，是随机红，后果一样。
 *
 * 所以两件事必须同时成立：
 *   · **重试**把传输层抖动吸收掉 —— 网络问题不该变成判断；
 *   · **重试用尽仍失败 = 拒绝** —— 真的问不到时，缺省依旧是拒绝。
 *
 * 只对**传输层**失败重试。HTTP 4xx 是语义答案（例如"这条腿的 workflow 不存在"），
 * 立刻返回，不用重试去掩盖一个确定的答案。
 */
function gh(path, attempts = 3) {
  let last = '';
  for (let i = 1; i <= attempts; i++) {
    const r = spawnSync('gh', ['api', path], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (r.status === 0) {
      try {
        return { ok: true, value: JSON.parse(r.stdout) };
      } catch (e) {
        return { ok: false, error: `gh api ${path} 的输出不是 JSON：${e.message}` };
      }
    }
    last = `gh api ${path} 失败（exit ${r.status}）：${(r.stderr || '').slice(0, 400)}`;
    // 4xx 是语义答案（比如"这条腿的 workflow 不存在"），不是抖动 —— 立刻返回，
    // 别拿重试去掩盖一个确定的答案。
    if (/HTTP 4\d\d/.test(r.stderr ?? '')) break;
    if (i < attempts) {
      say(`   （第 ${i} 次查询失败，重试中：${last.slice(0, 120)}）`);
      spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${i * 1500})`], { timeout: 10_000 });
    }
  }
  return { ok: false, error: last };
}

say('─'.repeat(94));
say(`── 发布前闸门：build-bundles run ${BUNDLE_RUN} 是不是 ${LEGS.length} 条腿都跑绿过？`);
say('─'.repeat(94));
say(`   仓库：${REPO}`);
say(`   要找的凭证：${LEGS.map((l) => `e2e-attest-${l}-${BUNDLE_RUN}`).join('\n               ')}`);
say('');

const missing = [];
const found = [];

/**
 * 腿名 → workflow 文件名。默认按 `e2e-<腿名>.yml` 推导。
 *
 * 这张表现在是空的：`browser-linux` 改回 `browser` 之后，五条腿的名字都与文件名对得上。
 * **留着这张表而不是删掉**，是因为那次 404 证明了这里存在一条隐式耦合 ——
 * 下一个想在腿名里写点什么（覆盖面、变体）的人，需要有个地方安放它，
 * 而不是被迫把腿名迁就文件名。
 */
const WORKFLOW_OF = {};

for (const leg of LEGS) {
  const want = `e2e-attest-${leg}-${BUNDLE_RUN}`;
  const wf = WORKFLOW_OF[leg] ?? `e2e-${leg}.yml`;
  const runs = gh(`repos/${REPO}/actions/workflows/${wf}/runs?status=success&per_page=${SCAN}`);
  if (!runs.ok) {
    // 查不动 = 拒绝。不把"我没问到"渲染成"它没问题"。
    missing.push({ leg, want, why: `查不动 ${wf} 的 run 列表：${runs.error}` });
    say(`   ${leg.padEnd(9)} ✘ 查不动：${runs.error}`);
    continue;
  }
  const ids = (runs.value?.workflow_runs ?? []).map((r) => r.id);
  if (ids.length === 0) {
    missing.push({ leg, want, why: `${wf} 没有任何成功的 run` });
    say(`   ${leg.padEnd(9)} ✘ ${wf} 一次成功的 run 都没有`);
    continue;
  }
  let hit = null;
  for (const id of ids) {
    const arts = gh(`repos/${REPO}/actions/runs/${id}/artifacts`);
    if (!arts.ok) continue; // 单次查不动就试下一个 run；全都查不动会落到下面的 missing
    const names = (arts.value?.artifacts ?? [])
      .filter((a) => a.expired === false)
      .map((a) => a.name);
    if (names.includes(want)) {
      hit = id;
      break;
    }
  }
  if (hit === null) {
    missing.push({
      leg,
      want,
      why: `翻了最近 ${ids.length} 次成功的 ${wf}，没有未过期的 ${want}`,
    });
    say(`   ${leg.padEnd(9)} ✘ 没找到 ${want}（翻了 ${ids.length} 次成功的 run）`);
  } else {
    found.push({ leg, want, runId: hit });
    say(`   ${leg.padEnd(9)} ✔ ${want}（来自 ${wf} run ${hit}）`);
  }
}

say('');
say('─'.repeat(94));
if (missing.length === 0) {
  say(`✔ ${LEGS.length} 条腿都对 build-bundles run ${BUNDLE_RUN} 跑绿过 —— 这批包可以发。`);
  for (const f of found) say(`   · ${f.leg}: ${f.want}（e2e run ${f.runId}）`);
  process.exit(0);
}

say(`✘ **拒绝发布**：${missing.length}/${LEGS.length} 条腿没有对这批包的凭证。`);
say('');
for (const m of missing) say(`   · ${m.leg}：${m.why}`);
say('');
say('── 这不是"闸门坏了"，这就是它要拦的那件事 ────────────────────────────────────');
say('   e2e 腿测的是**包**，不是**树**：它绿只说明那一批包好，不说明 HEAD 好；');
say('   反过来 HEAD 修好了它也不会自己变绿 —— 得先重新出包、再跑腿。');
say('');
/*
 * ★ 每条腿的输入**不一样**，这里必须逐条给对的那一条。
 *   `[实测]` 有人照着一句通用的 `-f bundleRunId=…` 去触发 e2e-runtime，
 *   吃了一个 **HTTP 422** —— 那条腿的输入叫 `bundlesRunId`（**多一个 s**）。
 *   一句会 422 的提示比不给提示更糟：它让人以为是闸门坏了。
 */
const DISPATCH_HINT = {
  import: (b) => `gh workflow run e2e-import.yml --ref master -f bundleRunId=${b}`,
  // 现场组装模式给不了已发布包的背书，所以必须显式关掉。
  notes: (b) =>
    `gh workflow run e2e-notes.yml --ref master -f assembleFromSource=false -f bundleRunId=${b}`,
  // legs 必须是 all：只跑一个平台的 run 不该发三平台凭证。
  record: (b) => `gh workflow run e2e-record.yml --ref master -f bundleRunId=${b} -f legs=all`,
  /*
   * ★ `allcomponents` **必须显式给 bundleRunId**：它的这个入参是可选的，
   *   留空会按 artifact 名各自解析，三个平台可能落到**不同批**的包上 ——
   *   那种 run 不发凭证（见 e2e-allcomponents.yml 的 attest job）。
   */
  allcomponents: (b) =>
    `gh workflow run e2e-allcomponents.yml --ref master -f bundleRunId=${b} -f legs=all`,
  // ⚠️ bundlesRunId，多一个 s；且必须 artifact 模式。
  runtime: (b) =>
    `gh workflow run e2e-runtime.yml --ref master -f bundleSource=artifact -f bundlesRunId=${b}`,
};
say('   要放行，先把缺的腿对**这一批包**跑一遍（注意各腿的输入名不同）：');
for (const m of missing) {
  const hint = DISPATCH_HINT[m.leg];
  say(
    hint
      ? `     ${hint(BUNDLE_RUN)}`
      : `     （腿 ${m.leg} 没有登记触发方式 —— 去它的 workflow 里看 workflow_dispatch 的输入名）`,
  );
}
say('');
say('   ⚠️ 如果某条腿**从来没发过凭证**，那是它还没接上这套契约。接法是在它的 workflow');
say('      末尾加一个 needs 全部平台、且**不带任何 `if:`** 的 job：');
say('        - run: node scripts/ci/emit-e2e-attestation.mjs \\');
say('                 --leg <腿名> --bundle-run <那批包的 run id> \\');
say('                 --platforms <跑过的平台，逗号分隔> --out dist/e2e-attest.json');
say('        - uses: actions/upload-artifact@v6');
say('          with: { name: e2e-attest-<腿名>-<run id>, path: dist/e2e-attest.json,');
say('                  if-no-files-found: error }');
say('      不带 `if:` 是关键：任何平台失败/跳过 → 这个 job 被跳过 → 凭证根本不存在。');
process.exit(1);
