#!/usr/bin/env node
/**
 * 把「三平台每格各自的 undecided 计数」汇总成一个数，喂给
 * `emit-e2e-attestation.mjs --undecided`。
 *
 * ## 这个脚本要挡住的事故形状（Manager 2026-08-10 二次裁决）
 *
 * 第一版设计是「凑不齐 N 个文件就 die()、退出码非 0」——抄的是
 * `merge-backend-manifest.mjs` / `emit-e2e-attestation.mjs` 那条「一个说了
 * 半句真话的凭证比没有更糟」的老规矩。但这里**不是同一个失败面**：
 *
 *   · `emit-e2e-attestation.mjs` die() 了，后果是**这条腿的凭证 artifact
 *     压根不产出** —— 闸门（`verify-e2e-attestation.mjs`，只认 artifact
 *     名字存在与否）会把整条腿读成「没跑」。
 *   · 而本脚本的输出只是**喂进**那条命令的一个可选参数
 *     （`--undecided`，不传就是 `null`，schema 早就支持）。
 *     如果本脚本因为「三格里有一格的产物没传上来」就 die()，「写凭证」这一步
 *     根本不会执行 —— **一个纯展示用的覆盖面统计出了故障，
 *     却连累了闸门真正认的那个信号（artifact 存不存在）**。
 *     换句话说：某一平台上传超时/崩溃/被跳过 → 汇总脚本挂了 → 凭证没发出去 →
 *     闸门把这条腿判成「缺失」，比「凭证在、但 undecided=null」更糟。
 *     这正是「没拿到 ≠ 不存在」这条教训，只是挪到了验证链自己身上。
 *
 * 所以判据翻过来：**任何一格对不上（少了、多了、重复、读不出、字段不是数）都
 * 只是响亮地警告 + 把结果收敛成 `null`，绝不拼凑一个只包含"凑巧到齐的那几格"
 * 的和，也绝不让退出码非 0。** 0 和"缺失"必须能被下游分清——
 * 全部到齐但都汇报 0，和缺了一格，长得完全不一样，绝不能被同一个 `null` 盖住，
 * 也绝不能被同一个"看起来像 0"的数盖住。
 *
 * ## 输出协议
 *
 * 通过 `--github-output` 写一个键：`undecided_flag`。
 *   · 全部标签到齐且都是合法数字 → `--undecided <sum>`（含参数名，可以直接
 *     原样拼进下一条命令行）。
 *   · 任何一处对不上 → 空字符串（拼进命令行等价于什么都没传，
 *     `emit-e2e-attestation.mjs` 收到的就是它自己的默认值 `null`）。
 * 调用方不需要写任何额外的 YAML 条件分支：
 *   `emit-e2e-attestation.mjs ... ${{ steps.sum.outputs.undecided_flag }} --out ...`
 *
 * ## 通用性
 *
 * 目录 + `--field`（默认 `unknowns`）+ `--file-template`（`{label}` 占位符）
 * 都是参数，脚本本身不写死 `runtime` 或任何平台名——`browser` 腿以后要接同一个
 * 聚合问题时，直接换一份 `--expect-labels` / `--file-template` 调这同一个脚本，
 * 不需要改这个文件。
 *
 * ## 用法
 *
 *   node scripts/ci/sum-undecided.mjs \
 *     --dir undecided \
 *     --expect-labels linux-x64,darwin-arm64,win32-x64 \
 *     --file-template 'e2e-runtime-undecided-{label}.json' \
 *     [--field unknowns] \
 *     [--reduce sum|agree] \
 *     [--github-output "$GITHUB_OUTPUT"]
 *
 * `--reduce` 决定"三格怎么并成一个数"，**默认 `sum`**（见下面那段注释）：
 * 每平台各自独立的未决用 `sum`；三格是同一件事的三次观察时用 `agree`
 * （要求一致、取公共值，不一致就收敛成 null）。
 *
 * `--dir` / `--expect-labels` 缺失是**调用方本身的配置错误**（写死在 YAML 里，
 * 不随平台跑没跑而变），这两项照旧 die()——它们与"某一平台跑没跑"不是同一类问题。
 */
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};

const die = (msg) => {
  console.error(`✘ ${msg}`);
  process.exit(1);
};

const warn = (msg) => {
  console.warn(`⚠ ${msg}`);
};

const dir = arg('--dir', null);
if (!dir) die('--dir 是必填项（扫描哪个目录）');

const expectLabelsRaw = arg('--expect-labels', null);
if (!expectLabelsRaw)
  die('--expect-labels 是必填项（逗号分隔，例如 linux-x64,darwin-arm64,win32-x64）');

const field = arg('--field', 'unknowns');
/*
 * ★ 怎么把三格并成一个数（`--reduce`，默认 `sum`，老调用方一个字都不用改）
 *
 * 加这一档，是因为 **allcomponents 腿把"求和"暴露成了一个错误的默认**：
 *
 *   · runtime / browser / record 三条腿的未决是**每个平台各自独立**的
 *     （"这台 runner 上构造不出这个前提"）—— 三格是三件不同的事，**该加起来**。
 *   · allcomponents 腿的未决是 `role=llm` 那 5 个变体够不着
 *     （`/api/models/catalog` 不列它们）。而那 5 个来自
 *     `vendor/manifests/models-llm.json` —— **一个与平台无关的文件**，
 *     三个包里装的是同一份。求和会得到 15，也就是**把同一个文件数了三遍**。
 *
 * 所以两种归并都要有名字，而且**必须在调用点写出来**：
 *   · `--reduce sum`   三格是三件独立的事 → 相加
 *   · `--reduce agree` 三格是同一件事的三次观察 → 要求它们**一致**，取那个公共值
 *
 * ⚠️ `agree` 模式下"三格不一致"**不是噪声，是信号**：它意味着三个平台读到的
 *    清单真的不一样。那种情况按本脚本一贯的口径处理 —— 响亮警告 + 收敛成 null，
 *    **绝不挑一个当代表**（挑一个正是"靠巧合才安全"的那种写法）。
 */
const reduce = arg('--reduce', 'sum');
if (!['sum', 'agree'].includes(reduce)) {
  die(`--reduce 只能是 sum 或 agree，实得 ${JSON.stringify(reduce)}`);
}
const fileTemplate = arg('--file-template', '{label}.json');
if (!fileTemplate.includes('{label}')) {
  die(`--file-template 必须包含 {label} 占位符，实得 ${JSON.stringify(fileTemplate)}`);
}
const ghOut = arg('--github-output', process.env.GITHUB_OUTPUT);

const expectLabels = String(expectLabelsRaw)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (expectLabels.length === 0) die('--expect-labels 解析出来是空的');

const problems = [];

// 重复的 label：不是"某一平台没跑到"，但也不是"配置永远错"——
// 按裁决第 3 条，与其他不一致一样走"警告 + null"，不 die()。
const dupSeen = new Set();
const dupLabels = new Set();
for (const l of expectLabels) {
  if (dupSeen.has(l)) dupLabels.add(l);
  dupSeen.add(l);
}
if (dupLabels.size > 0) {
  problems.push(`--expect-labels 里有重复：${[...dupLabels].join(', ')}`);
}
const uniqueLabels = [...new Set(expectLabels)];

let filesInDir = [];
try {
  filesInDir = readdirSync(dir);
} catch (err) {
  problems.push(`读不到目录 ${dir}：${String(err.message ?? err)}`);
}
const jsonFilesInDir = filesInDir.filter((f) => f.endsWith('.json'));

const expectedFilenames = new Map(uniqueLabels.map((l) => [l, fileTemplate.replace('{label}', l)]));

console.log('─'.repeat(72));
console.log(`── sum-undecided：${dir}`);
console.log('─'.repeat(72));

let sum = 0;
const breakdown = [];
for (const label of uniqueLabels) {
  const filename = expectedFilenames.get(label);
  if (!jsonFilesInDir.includes(filename)) {
    problems.push(`缺失：标签 ${label} 期望的 ${filename} 没找到`);
    breakdown.push({ label, filename, status: 'missing' });
    continue;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(`${dir}/${filename}`, 'utf8'));
  } catch (err) {
    problems.push(`${filename} 不是合法 JSON：${String(err.message ?? err)}`);
    breakdown.push({ label, filename, status: 'malformed' });
    continue;
  }
  const value = parsed?.[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    problems.push(`${filename} 的 ${field} 字段不是非负整数：${JSON.stringify(value)}`);
    breakdown.push({ label, filename, status: 'bad-field' });
    continue;
  }
  sum += value;
  breakdown.push({ label, filename, status: 'ok', value });
}

// 目录里出现了没被任何期望标签认领的 .json —— 同样按"对不上"处理，不静默忽略。
const claimed = new Set(expectedFilenames.values());
const extras = jsonFilesInDir.filter((f) => !claimed.has(f));
if (extras.length > 0) {
  problems.push(`目录里有 ${extras.length} 个未预期的文件：${extras.join(', ')}`);
}

for (const b of breakdown) {
  const line =
    b.status === 'ok'
      ? `   ✔ ${b.label.padEnd(16)} ${b.filename.padEnd(40)} ${field}=${b.value}`
      : `   ✘ ${b.label.padEnd(16)} ${b.filename.padEnd(40)} ${b.status}`;
  console.log(line);
}
if (extras.length > 0) {
  for (const f of extras) console.log(`   ✘ ${''.padEnd(16)} ${f.padEnd(40)} 未预期`);
}

console.log('');

/*
 * 归并。`agree` 模式多一道判据：三格必须报出**同一个值**。
 * 不一致时**不挑代表、不取众数、不取最大** —— 按本脚本一贯的口径收敛成 null。
 */
let reduced = sum;
if (problems.length === 0 && reduce === 'agree') {
  const distinct = [...new Set(breakdown.filter((b) => b.status === 'ok').map((b) => b.value))];
  if (distinct.length === 1) {
    reduced = distinct[0];
  } else {
    problems.push(
      `--reduce agree 要求各格报同一个值，实得 ${distinct.sort((a, b) => a - b).join(' / ')}` +
        `（${breakdown
          .filter((b) => b.status === 'ok')
          .map((b) => `${b.label}=${b.value}`)
          .join('，')}）—— 三个平台读到的不是同一份东西，这本身就是要查的信息`,
    );
  }
}

let flag;
if (problems.length === 0) {
  flag = `--undecided ${reduced}`;
  console.log(
    reduce === 'agree'
      ? `✔ ${uniqueLabels.length}/${uniqueLabels.length} 个标签都到齐且**一致**，${field}=${reduced}（agree：同一件事的三次观察，不相加）`
      : `✔ ${uniqueLabels.length}/${uniqueLabels.length} 个标签都到齐，合计 ${field}=${sum}`,
  );
} else {
  flag = '';
  const foundLabels = breakdown.filter((b) => b.status === 'ok').map((b) => b.label);
  warn(
    `未上报：期望 ${uniqueLabels.join(',')}，只拿到 ${foundLabels.length ? foundLabels.join(',') : '(none)'} —— 产出 null，不拼凑`,
  );
  for (const p of problems) warn(`  ${p}`);
  console.log('   （这不影响这条腿的判定——判定只看凭证 artifact 的名字在不在——');
  console.log('    只是这次算不出一个可信的 undecided 数字，所以如实报 null。）');
}

if (ghOut) {
  appendFileSync(ghOut, `undecided_flag=${flag}\n`);
  console.log(
    `   已写入 GITHUB_OUTPUT：undecided_flag=${flag === '' ? '(空 ⇒ 等价于 null)' : flag}`,
  );
}

process.exit(0);
