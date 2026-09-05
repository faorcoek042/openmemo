#!/usr/bin/env node
/**
 * 防线：**同一个概念在两个包里各声明了一份**。
 *
 * ## 它补的是哪个洞
 *
 * `scripts/check-orphan-exports.mjs` 管的是「导出没人用」。它**不管**「同一个东西被
 * 声明了两遍」—— 而且更糟：重名的两份**互相证明对方活着**（T-183 修的正是这个遮蔽，
 * 那次修的是"引用算给谁"，不是"两份该不该存在"）。于是这一类缺陷对现有五道门**全盲**：
 *
 *   · `RECORD_SAMPLE_RATE = 16_000` 在 daemon 与 web **各一份**，而它是**跨进程协议常量**。
 *     一边改了另一边不会红 —— 音频**静默错采样**，没有任何一条断言会响。
 *   · `SEGMENT_FLAG` 三份（shared / pipeline / web），位值今天对得上**靠的是纪律不是机制**，
 *     而且四个位里三个名字不同。位错了是静默的，还会**污染已存数据**（`transcript_segments.flags`）。
 *   · `JobState` 八个字面量，shared 由 `JOB_STATES` 派生，daemon `queue.ts` **手抄一遍**；
 *     同一个 daemon 里 `jobs/events.ts` 用的是 shared 那份，`jobs/queue.ts` 用的是自己那份。
 *
 * 这些**行数极小、风险极高**：它们全都编译得过、跑得过、测得绿。今天靠人对齐，明天靠运气。
 *
 * ## 判据必须能**自己发现新的重复**
 *
 * ⚠️ 这一轮已经抓到三道守卫栽在**手抄名单**上（孤儿门禁按裸名匹配、T-163 只钉 7/29、
 * 启动器名单 4/11，而且那个检测器自己也只认一个函数名）。所以这里**没有一份"要盯哪些常量"
 * 的清单** —— 两条判据都是从源码里**现算**出来的：
 *
 *   **D1 同名**：同一个导出标识符在 **≥2 个工作区包**里各被 `declare` 一次。
 *               名字就是概念 —— 两个包各写一个 `SearchHit`，说的就是同一件事。
 *   **D2 同值**：同一个**字面量集合**（字符串联合 / 位域）在 ≥2 个包里各声明一份，
 *               **不看名字**。这条抓的是 D1 漏掉的那半边：`JobState` vs `JOB_STATES`、
 *               `EngineId` vs `ASR_ENGINE_IDS` —— 抄的时候顺手改了名，D1 就瞎了。
 *
 * 下面那份 `duplicate-declarations-baseline.json` **不是判据**，是**判据的产物**：
 * 检测器现算出全部重复，基线只回答"这一条已经有人看过了、结论是什么"。
 * 加一个新的重复 → 它不在基线里 → 红。这与孤儿门禁同一个形状，理由也同一条。
 *
 * ## 已经收敛好的形态**不算重复**（否则这道门会惩罚正解）
 *
 * `apps/web/src/lib/api/types.ts` 用的是 T-150 的**别名法**：
 *
 *     import type { NoteStatus as NoteStatusContract } from '@openmemo/shared';
 *     export type NoteStatus = NoteStatusContract;
 *
 * 那是**一份**声明加一个本地名字，正是这道门想要的结果。所以凡是右手边只有一个
 * **来自 import 的标识符**的声明，一律不算一次声明。⚠️ 不认这一条的话，这道门会把
 * 修好的 4 个（`NoteDetail`/`NoteStatus`/`NoteKind`/`RetranscribeBlocked`）一起报红 ——
 * **一道会惩罚正解的门，两周内就会被所有人学会绕过去。**
 *
 * ## 量过之后**故意不判红**的两档（只打印）
 *
 * 判据方向定死在**只会漏检、不会误伤**那一侧。这两档实测误报太高：
 *
 * | 档 | 实测跨包组数 | 其中真的是同一个概念 | 结论 |
 * |---|---|---|---|
 * | **裸数值相同**（`export const X = 16_000`） | 5 | **1** | 只打印 |
 * | **interface 字段名集合相同** | 11 | ~7 | 只打印 |
 *
 * 裸数值那 5 组里，4 组是纯巧合：`OMPK_VERSION`/`ASR_CHANNELS`/`PLAN_VERSION` 都等于 1，
 * `DEFAULT_SAMPLES_PER_PIXEL` 与 `SSE_REPLAY_BUFFER_SIZE` 都等于 256。
 * 试过用"名字里有公共词元"收紧，`DEGRADED_POLL_INTERVAL_MS` 与 `KEEPALIVE_INTERVAL_MS`
 * 共享 `INTERVAL`+`MS` 照样进来 —— **收紧不掉，就说收紧不掉。**
 *
 * ⚠️ 所以本轮最高风险的那条（`16_000` 三处名字各不相同）**只有 D1 那一半被判红**
 * （`RECORD_SAMPLE_RATE` 在 daemon/web 同名），`ASR_SAMPLE_RATE` / `SHERPA_SAMPLE_RATE`
 * 与它同值异名这件事，这道门**判不了**，只会打印。**绿灯不能读成"没有重复的常量"。**
 * 这两档**每一轮都打印**（绿的时候也打）—— #103 那道门正是栽在「有欠账才打印」上。
 *
 * 跑：`node scripts/ci/check-duplicate-declarations.mjs`
 *     `--update` 把当前全部重复写回基线（**只在人核过之后用**）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { prepare, REPO, sourceFiles, stripCommentsOnly } from '../lib/ts-lexer.mjs';

const BASELINE_PATH = join(REPO, 'scripts', 'duplicate-declarations-baseline.json');

/* ─────────────────────────── 探针自检的三个常量 ───────────────────────────
 *
 * 与孤儿门禁同一条讲究：**先证明探针能看见你已知存在的东西**。
 * 工具返回空集 / 残缺集和"本来就没有"长得一模一样，而后者看起来像好消息。
 */
/** 一定要能看见的文件（`src/` 第一层 —— 当年那个残缺 glob 恰好漏掉的就是它）。 */
const PROBE_FILE = 'apps/daemon/src/main.ts';
/** 一定扫得出来的声明：它就在 `PROBE_FILE` 里。 */
const PROBE_DECL = 'StartOptions';
/** 声明总数下限。远低于现状（约 2000），只用来抓"突然什么都扫不到"。 */
const MIN_DECLS = 500;

export const pkgOf = (f) => f.split('/').slice(0, 2).join('/');
export const isTestFile = (p) =>
  p.includes('.test.') || p.includes('/__tests__/') || p.includes('/test/');

/**
 * 顶层导出声明。
 *
 * `declare` 一并认（`.d.ts` 风格的写法在 `src/` 里也出现过）；
 * `function`/`class` 也认 —— 两个包各写一个同名函数同样是"同一个概念两份实现"
 * （实测命中 `defaultCapacities`：daemon 与 pipeline 各一份 lane 容量表）。
 */
const DECL_RE =
  /\bexport\s+(?:declare\s+)?(?:async\s+)?(function|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;

/** `import`/`export … from '…'` 的具名绑定 —— 用来认出"右手边其实是别人的那份"。 */
const IMPORT_RE =
  /\bimport\s+(?:type\s+)?(?:\{([^}]*)\}|[A-Za-z_$][\w$]*\s*,\s*\{([^}]*)\})\s*from\s*['"][^'"]*['"]/g;

/** 本文件从别处 import 进来的**本地名**集合。 */
export function importedNames(src) {
  const out = new Set();
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(src))) {
    for (const part of (m[1] ?? m[2] ?? '').split(',')) {
      const t = part.trim().replace(/^type\s+/, '');
      if (!t) continue;
      const as = /^[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(t);
      out.add(as ? as[1] : t);
    }
  }
  return out;
}

/**
 * 这条声明是不是**别名**（`export type X = Y;` / `export const X = Y;`，`Y` 来自 import）。
 *
 * ★ 这一条是这道门**不惩罚正解**的关键，见文件头 T-150 那一段。
 * 判据钉的是「右手边是不是一个来自 import 的裸标识符」，**不是**文件叫什么名字。
 *
 * @param src 剥了注释、**保留字符串**的源码
 * @param at  声明关键字 `export` 的下标
 */
export function isAliasOfImport(src, at, imported) {
  // `export type X = Y;` / `export type X = Y.Z;` / `export const X = Y;`
  const m =
    /^export\s+(?:declare\s+)?(?:type|const|let)\s+[A-Za-z_$][\w$]*\s*(?::[^=;]*)?=\s*([A-Za-z_$][\w$]*)\s*(?:\[[^\]]*\])?\s*;/.exec(
      src.slice(at, at + 400),
    );
  if (!m) return false;
  return imported.has(m[1]);
}

/** 平衡地取出 open/close 包住的那一段（含两端）。`src[from]` 必须是 `open`。 */
export function balanced(src, from, open, close) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return null;
}

const STR_RE = /(['"])((?:[^'"\\]|\\.)*)\1/g;
const stringsIn = (s) => {
  STR_RE.lastIndex = 0;
  const out = [];
  let m;
  while ((m = STR_RE.exec(s))) out.push(m[2]);
  return out;
};

/** `1 << 3` / `0x04` / `8` / `16_000` → number；别的 → null。 */
export function intExpr(t) {
  const s = t.trim();
  let m = /^(\d+)\s*<<\s*(\d+)$/.exec(s);
  if (m) return Number(m[1]) * 2 ** Number(m[2]);
  m = /^0x([0-9a-f]+)$/i.exec(s);
  if (m) return parseInt(m[1], 16);
  if (/^-?\d[\d_]*$/.test(s)) return Number(s.replace(/_/g, ''));
  return null;
}

/**
 * 扫一个文件，吐出它的**声明**与**字面量指纹**。
 *
 * @param file 仓库相对路径（只当标签用，不读盘）
 * @param raw  文件原文
 */
export function scanFile(file, raw) {
  /*
   * ★ **两份预处理，两个用途** —— 这一条是自检 §3 撞出来的，不是设计出来的。
   *
   * · `src`（只剥注释、**保留字符串内容**）：字面量的值就住在字符串里，
   *   `['chat','summarize']` 这种东西只能从这一份里读。
   * · `code`（注释**与字符串内容**一起剥掉）：判"这里有没有一条真声明"只能看这一份。
   *
   * 只用前一份的话，一句
   *     export const TEMPLATE = "export const LLM_PURPOSES = ['chat'] as const;";
   * 就会被当成一次真声明 —— 而"在字符串里写代码"（模板、错误信息、生成器）
   * 本仓库到处都是。⚠️ 两份**下标逐字符对齐**（`scanSource` 抹东西时一进一出、
   * 只换内容不换长度），所以可以拿同一个 `m.index` 在两份之间互相验证。
   */
  const src = stripCommentsOnly(raw);
  const code = prepare(raw);
  /** 这个下标上在**真代码**里也确实起了一条 `export` —— 不是字符串里的字。 */
  const isRealDecl = (i) => code.startsWith('export', i);
  const imported = importedNames(src);
  /** @type {{name:string,kind:string}[]} */
  const decls = [];
  /** @type {{tier:string,key:string,name:string,detail:string}[]} */
  const prints = [];

  DECL_RE.lastIndex = 0;
  let m;
  while ((m = DECL_RE.exec(code))) {
    if (isAliasOfImport(src, m.index, imported)) continue;
    decls.push({ name: m[2], kind: m[1] });
  }

  /* ── D2 ①：`export const N = ['a','b',…] as const;` ── */
  for (const mm of src.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*\[/g)) {
    if (!isRealDecl(mm.index)) continue;
    const open = mm.index + mm[0].length - 1;
    const arr = balanced(src, open, '[', ']');
    if (!arr || !/^\s*as\s+const/.test(src.slice(open + arr.length))) continue;
    const items = stringsIn(arr);
    if (items.length < 2) continue;
    const uniq = [...new Set(items)].sort();
    if (uniq.length !== items.length) continue; // 有非字符串项混进来就别猜
    prints.push({
      tier: 'strset',
      key: `strset:${uniq.join('|')}`,
      name: mm[1],
      detail: uniq.join(', '),
    });
  }

  /* ── D2 ②：`export type N = 'a' | 'b' | …;` ── */
  for (const mm of src.matchAll(/\bexport\s+type\s+([A-Za-z_$][\w$]*)\s*=\s*([^;{]*);/g)) {
    if (!isRealDecl(mm.index)) continue;
    const parts = mm[2]
      .split('|')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length < 2) continue;
    if (!parts.every((p) => /^(['"])(?:[^'"\\]|\\.)*\1$/.test(p))) continue;
    const uniq = [...new Set(parts.map((p) => p.slice(1, -1)))].sort();
    prints.push({
      tier: 'strset',
      key: `strset:${uniq.join('|')}`,
      name: mm[1],
      detail: uniq.join(', '),
    });
  }

  /* ── D2 ③：`export const N = { A: 1<<0, … } as const;` —— **不看键名** ──
   *
   * ★ 不看键名是这一条的要点，不是偷懒：`SEGMENT_FLAG` 三份的**四个位里三个名字不同**
   *   （`HALLUCINATION`↔`SUSPECT_REPETITION`、`CONFIRMED`↔`HUMAN_CONFIRMED`、
   *   `SILENCE`↔`SILENCE_OR_MUSIC`）。按键名比对的话，这道门对它**全盲**。
   *   位值才是写进 `transcript_segments.flags` 的那个东西。
   */
  for (const mm of src.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*\{/g)) {
    if (!isRealDecl(mm.index)) continue;
    const open = mm.index + mm[0].length - 1;
    const obj = balanced(src, open, '{', '}');
    if (!obj || !/^\s*as\s+const/.test(src.slice(open + obj.length))) continue;
    const inner = obj.slice(1, -1);
    if (/[{[]/.test(inner)) continue; // 嵌套的先不猜
    const entries = inner
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (entries.length < 2) continue;
    const vals = [];
    let ok = true;
    for (const e of entries) {
      const c = e.indexOf(':');
      const v = c < 0 ? null : intExpr(e.slice(c + 1));
      if (v === null) {
        ok = false;
        break;
      }
      vals.push(v);
    }
    if (!ok) continue;
    const sorted = [...vals].sort((a, b) => a - b);
    prints.push({
      tier: 'bitset',
      key: `bitset:${sorted.join('|')}`,
      name: mm[1],
      detail: sorted.join(', '),
    });
  }

  /* ── 只打印：裸数值（实测 5 组 1 真，见文件头） ── */
  for (const mm of src.matchAll(
    /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(-?\d[\d_]*(?:\.\d+)?)\s*;/g,
  )) {
    if (!isRealDecl(mm.index)) continue;
    const v = Number(mm[2].replace(/_/g, ''));
    prints.push({ tier: 'num', key: `num:${v}`, name: mm[1], detail: String(v) });
  }

  /* ── 只打印：interface 字段名集合（实测 11 组 ~7 真，见文件头） ── */
  for (const mm of src.matchAll(/\bexport\s+interface\s+([A-Za-z_$][\w$]*)[^{]*\{/g)) {
    if (!isRealDecl(mm.index)) continue;
    const open = mm.index + mm[0].length - 1;
    const obj = balanced(src, open, '{', '}');
    if (!obj) continue;
    const fields = [
      ...new Set(
        [...obj.matchAll(/(?:^|[;\n{])\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/g)].map(
          (x) => x[1],
        ),
      ),
    ].sort();
    if (fields.length < 3) continue;
    prints.push({
      tier: 'fields',
      key: `fields:${fields.join('|')}`,
      name: mm[1],
      detail: fields.join(', '),
    });
  }

  return { file, decls, prints };
}

/**
 * 把 `scanFile()` 的结果汇成分档。
 *
 * ★ **参数是文件内容表，不是从磁盘读** —— 这样自检可以拿一段写死的样本跑**同一段代码**，
 *   而不是复述一遍它的逻辑（复述出来的对照组只能证明复述本身）。
 *
 * @param {Map<string,string>} bodies 仓库相对路径 → 文件原文
 */
export function collect(bodies) {
  /** @type {Map<string, {file:string,name:string,kind:string}[]>} */
  const byName = new Map();
  /** @type {Map<string, {file:string,name:string,detail:string,tier:string}[]>} */
  const byValue = new Map();
  let declCount = 0;

  for (const [file, raw] of bodies) {
    if (isTestFile(file)) continue; // 测试里复述一遍契约是正当的
    const { decls, prints } = scanFile(file, raw);
    declCount += decls.length;
    for (const d of decls) {
      if (!byName.has(d.name)) byName.set(d.name, []);
      byName.get(d.name).push({ file, ...d });
    }
    for (const p of prints) {
      if (!byValue.has(p.key)) byValue.set(p.key, []);
      byValue.get(p.key).push({ file, ...p });
    }
  }

  /** 一组「跨 ≥2 个包」的重复。`sites` 已按路径排序，可直接当基线键。 */
  const group = (key, list) => ({
    key,
    sites: list.map((x) => `${x.file} :: ${x.name}`).sort(),
    detail: list[0].detail ?? '',
  });

  const crossPkg = (list) => new Set(list.map((x) => pkgOf(x.file))).size >= 2;

  const dupNames = [];
  for (const [name, list] of byName) {
    if (list.length < 2 || !crossPkg(list)) continue;
    dupNames.push(group(`name:${name}`, list));
  }

  /** @type {Record<string, {key:string,sites:string[],detail:string}[]>} */
  const dupValues = { strset: [], bitset: [], num: [], fields: [] };
  for (const [key, list] of byValue) {
    if (list.length < 2 || !crossPkg(list)) continue;
    dupValues[key.split(':')[0]].push(group(key, list));
  }

  const bySite = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  dupNames.sort(bySite);
  for (const k of Object.keys(dupValues)) dupValues[k].sort(bySite);

  return { dupNames, dupValues, declCount };
}

/* ══════════════════════════════ CLI ══════════════════════════════ */

if (import.meta.url === `file://${process.argv[1]}`) {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const files = sourceFiles();
  const bodies = new Map(files.map((f) => [f, readFileSync(join(REPO, f), 'utf8')]));

  /* ── 三关探针自检：任何一关不过就当场退出（不是"报个警告继续跑"）── */
  const selfCheckFailures = [];
  if (!files.includes(PROBE_FILE))
    selfCheckFailures.push(`文件清单里没有 ${PROBE_FILE} —— 探针漏掉了 src/ 第一层`);
  const { dupNames, dupValues, declCount } = collect(bodies);
  if (declCount < MIN_DECLS)
    selfCheckFailures.push(`只扫到 ${declCount} 个导出声明（下限 ${MIN_DECLS}）—— 扫描器多半瞎了`);
  const probeSeen = scanFile(PROBE_FILE, bodies.get(PROBE_FILE) ?? '').decls.some(
    (d) => d.name === PROBE_DECL,
  );
  if (!probeSeen) selfCheckFailures.push(`${PROBE_FILE} 里扫不到 ${PROBE_DECL} —— 声明正则失效`);
  if (selfCheckFailures.length) {
    console.error('✘ 探针自检没过 —— **结果不可信，不是"没有重复"**：\n');
    for (const s of selfCheckFailures) console.error(`   ${s}`);
    process.exit(1);
  }

  /* ── 判红的两档 ── */
  const red = [...dupNames, ...dupValues.strset, ...dupValues.bitset];

  if (process.argv.includes('--update')) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(
        {
          _comment:
            '★ scripts/ci/check-duplicate-declarations.mjs 的基线。**它不是判据** —— ' +
            '判据是那个脚本现算出来的两条（同名 / 同字面量集合）。这里只回答"这一条已经有人看过了、结论是什么"。' +
            'accepted 只准变短：一份不会缩水的豁免名单，几轮之后就没人相信它了。' +
            '每条都必须写 note 说清**为什么两份是对的**，或者**它在等谁**。',
          accepted: red.map((g) => ({
            key: g.key,
            sites: g.sites,
            note:
              baseline.accepted?.find((e) => e.key === g.key)?.note ?? 'TODO: 写清为什么两份是对的',
          })),
        },
        null,
        2,
      )}\n`,
    );
    console.log(`✔ 已写回 ${BASELINE_PATH}（${red.length} 条）`);
    process.exit(0);
  }

  console.log(`ℹ 扫描 ${files.length} 个源文件 / ${declCount} 个导出声明（测试文件不计）`);
  console.log(
    `ℹ 跨包重复：同名 ${dupNames.length} 组 · 同字符串集 ${dupValues.strset.length} 组 · ` +
      `同位域 ${dupValues.bitset.length} 组 【以上判红】` +
      ` | 同裸数值 ${dupValues.num.length} 组 · 同字段集 ${dupValues.fields.length} 组 【只打印】`,
  );

  /* ── ★ 每一轮都打印的"抓不到什么"。绿的时候也打。 ──
   *
   * #103 那道门正是栽在「有欠账才打印」上：条件恰好永远不成立 ⇒ 一次都没打印过。
   * 所以这两段**无条件**打，哪怕这两档一条都没有。
   */
  console.log(
    `\nⓘ 这道门**判不了**的两档（实测误报太高，只打印 —— 绿灯不能读成"没有重复的常量"）：`,
  );
  console.log(
    `   · 裸数值相同：实测 5 组跨包，其中真的是同一个概念的只有 1 组。` +
      `本轮最高风险的 16_000（三处名字各不相同）就落在这里 —— 只有同名的那一半判得了。`,
  );
  for (const g of dupValues.num) console.log(`     [${g.detail}] ${g.sites.join('  |  ')}`);
  console.log(`   · interface 字段名集合相同：实测 11 组跨包，约 7 组是真的。`);
  for (const g of dupValues.fields) console.log(`     ${g.sites.join('  |  ')}`);

  /* ── 与基线对账 ── */
  const current = new Map(red.map((g) => [g.key, g]));
  const accepted = new Map((baseline.accepted ?? []).map((e) => [e.key, e]));

  const added = red.filter((g) => !accepted.has(g.key));
  const grown = red.filter((g) => {
    const e = accepted.get(g.key);
    return e && g.sites.some((s) => !e.sites.includes(s));
  });
  const stale = [...accepted.keys()].filter((k) => !current.has(k));
  const shrunk = [...accepted.values()].filter(
    (e) => current.has(e.key) && e.sites.some((s) => !current.get(e.key).sites.includes(s)),
  );

  let failed = false;

  if (added.length) {
    failed = true;
    console.error(`\n✘ ${added.length} 组**新的**跨包重复声明（基线里没有）：\n`);
    for (const g of added) {
      console.error(`   ${g.key}${g.detail ? `  [${g.detail}]` : ''}`);
      for (const s of g.sites) console.error(`      ${s}`);
    }
    console.error(
      '\n同一个概念被声明了两遍。**这类缺陷编译得过、跑得过、测得绿** ——\n' +
        '两份今天一致靠的是纪律，明天靠的是运气，而分叉之后没有任何一条断言会响。\n' +
        '三条出路，选一条：\n' +
        '  1. **收敛**（多数时候是本意）：权威那份留在两边都够得着的包里（通常是\n' +
        '     `@openmemo/shared`），另一份改成 `export { X } from …` 或 T-150 的别名法\n' +
        '     （`export type X = XContract;`）—— 别名法这道门认得，不会报你；\n' +
        '  2. **删掉**没人用的那份；\n' +
        `  3. 确实该两份 → 登记进 ${BASELINE_PATH}，note 里写清**为什么**。\n` +
        '     ⚠️ 别只为了变绿而登记：这份名单是给下一个人看的地图。\n',
    );
  }

  if (grown.length) {
    failed = true;
    console.error(`\n✘ ${grown.length} 组已知重复**又多了一份**：\n`);
    for (const g of grown) {
      const known = accepted.get(g.key).sites;
      for (const s of g.sites.filter((x) => !known.includes(x)))
        console.error(`   ${g.key}  +${s}`);
    }
    console.error('\n第 3 份比第 2 份更坏 —— 收敛的成本随份数涨，而它们全都静默。\n');
  }

  if (stale.length || shrunk.length) {
    failed = true;
    console.error(`\n✘ 基线里有 ${stale.length + shrunk.length} 条已经过期：\n`);
    for (const k of stale) console.error(`   ${k}  ← 已经不是跨包重复了`);
    for (const e of shrunk) {
      const now = current.get(e.key).sites;
      for (const s of e.sites.filter((x) => !now.includes(x))) console.error(`   ${e.key}  -${s}`);
    }
    console.error(
      '\n有人把它收敛了（或删了）—— 这是好事，但基线必须跟着变短。\n' +
        `请从 ${BASELINE_PATH} 里删掉这几行。\n` +
        '判据：**豁免名单只准变短。** 一份不会缩水的名单，几轮之后就没人相信它了。\n' +
        '⚠️ 这条同时是**扫描器失明的报警器**：探针瞎了的表现正是"基线大面积过期"，\n' +
        '   而那看起来像好消息。\n',
    );
  }

  if (failed) process.exit(1);
  console.log('\n✔ 没有新的跨包重复声明，基线也没有过期条目');
}
