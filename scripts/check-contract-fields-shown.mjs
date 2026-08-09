#!/usr/bin/env node
/**
 * check-contract-fields-shown.mjs —— **契约里用来给用户做决定的字段，界面必须真的读它。**
 *
 * ## 它是「零引用导出」那招的反面
 *
 * `check-orphan-exports.mjs` 问的是「我导出的东西有没有人用」。
 * 这个脚本问的是**另一半**：
 *
 * > **我们发给前端的那个字段，前端到底有没有读？**
 *
 * 后者今天没有任何守卫，而它已经产生过一次真实的用户损失：
 *
 * `[用户真机 2026-08-09, Windows]` 用户装了 `vad/silero-vad-onnx`
 * （目录里写着 `engines: ['sherpa-onnx']`），而他的引擎是 whisper.cpp，
 * 需要的是 `vad/silero-vad-ggml`（`engines: ['whisper.cpp']`）。
 * 装完之后 daemon 每次装配都警告一次「已安装的 VAD 权重 whisper.cpp 加载不了」，
 * **却从没说过"你该装的是另一个"** —— 而答案一直写在 `engines` 字段里。
 *
 * `[实测 2026-08-09]` 当时 `engines` 在 `apps/web/src/features/models/**` 里
 * **零引用**：产品把两个模型都摆出来，**却从来没把"谁配谁"显示给用户看过**。
 * 那不是"忘了做一个功能"，是**一个已经在传输层上送到的事实，在最后一米被丢掉了**。
 *
 * ## 判据
 *
 * 一条规则 = 「字段 `F` 必须在 `目录 D` 底下至少被读到一次」。
 * 读不到 → **当场红**，并说清坏了会怎样。
 *
 * ⚠️ **刻意不做成"扫所有契约字段"**：那会立刻变成一条噪音门禁
 * （契约里绝大多数字段本来就不该出现在界面上）。规则是**人挑的、逐条附理由的**，
 * 与 `scripts/mutation-check.mjs` 的变异清单同一条判据 ——
 * 自动生成会产出一堆等价规则，然后没人看。
 *
 * ⚠️ **匹配的是标识符，不是散文**。上一位刚栽过
 * 「一条靠散文措辞撑着的守卫，是一条会静默停止工作的守卫」——
 * 所以这里只找 `\bengines\b` 这种**词边界标识符**，不去正则匹配注释里的中文说法。
 * 注释怎么改都不影响判定；只有**代码真的不再读它**才会红。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 规则清单。**每条都必须写清"坏了用户会怎样"** —— 否则下一个人只会看到一条红灯，
 * 不知道它在保护什么，于是最省事的做法就是把规则删掉。
 */
const RULES = [
  {
    field: 'engines',
    dir: 'apps/web/src/features/models',
    why:
      '模型卡片不显示「这个条目适配哪个引擎」⇒ 用户在两个名字相近的 VAD 之间只能靠猜。' +
      '真实后果：装了 sherpa 的那个、whisper.cpp 加载不了，daemon 每次装配警告一遍，' +
      '而界面从头到尾没告诉过他该装另一个（2026-08-09 用户真机）。',
  },
];

/** 递归收集某目录下的 `.ts` / `.tsx`（跳过测试与 dist）。 */
function sources(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'dist' || e.name === 'node_modules') continue;
        walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

let bad = 0;
console.log('契约字段的界面读者检查');
console.log('─'.repeat(78));

for (const rule of RULES) {
  const abs = join(REPO, rule.dir);
  try {
    if (!statSync(abs).isDirectory()) throw new Error('not a dir');
  } catch {
    console.error(`✘ 规则目录不存在：${rule.dir} —— 规则本身失效了，比它红更值得查`);
    bad++;
    continue;
  }

  const files = sources(abs);
  // 词边界匹配标识符，避免 `enginesFoo` / 注释里的中文说法造成假阳或假阴。
  const re = new RegExp(`\\b${rule.field}\\b`);
  const readers = files.filter((f) => re.test(readFileSync(f, 'utf8')));

  if (readers.length === 0) {
    console.error(`✘ 字段 \`${rule.field}\` 在 ${rule.dir}/** 里**零读者**`);
    console.error(`   坏了会怎样：${rule.why}`);
    bad++;
  } else {
    console.log(`✔ ${rule.field.padEnd(12)} ${rule.dir}/** 里有 ${readers.length} 个读者`);
    for (const r of readers.slice(0, 4)) console.log(`     ${r.replace(REPO + '/', '')}`);
  }
}

console.log('─'.repeat(78));
if (bad > 0) {
  console.error(`✘ ${bad} 条规则不满足 —— 一个已经送到前端的事实，在最后一米被丢掉了。`);
  process.exit(1);
}
console.log(`✔ ${RULES.length} 条规则全部满足。`);
