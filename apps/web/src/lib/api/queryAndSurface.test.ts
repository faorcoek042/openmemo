/**
 * 三条守卫，都关于「声明了一件事，却没有任何东西让它成真」：
 *
 *   ① **一个 `queryKey` 只许有一个 `queryFn`。**
 *   ② **界面上承诺要报告状态的每个 API 面，仓里必须真的有东西能写它。**
 *   ③ **某个域一旦在 `SURFACES` 里声明了，该域的 `api()` 调用就必须带上 surface 实参。**
 *
 * ─────────────────────────────── ① ───────────────────────────────
 *
 * react-query **按 key 去重**：同一个 key 上挂着两份不同的 `queryFn` 时，
 * **只有先挂载的那个观察者的 `queryFn` 会真的执行**。于是"这次请求长什么样"
 * 变成了一个**取决于组件挂载顺序**的事实。
 *
 * 本轮实际发作的两例（形状逐字相同）：
 *
 * | key | 一份 | 另一份 |
 * | --- | --- | --- |
 * | `qk.models.installed` | `api('/models/installed')` ⇒ surface `'generic'` | `api('models', …)` ×2 ⇒ surface `'models'` |
 * | `qk.models.storage`   | `api('/models/storage')` ⇒ `'generic'`          | `api('models', …)` + `staleTime: 30_000` |
 *
 * 后果是顶栏「已接通 N / 模拟 M」和 `<MockNotice surface="models">`
 * 会随"用户先开哪一页"而变 —— 一个没有报错、复现要靠特定点击顺序的缺陷。
 *
 * ⚠️ 判据只比 `queryFn` 里**运行时真正决定发什么请求**的那部分（surface 实参 + 路径），
 * **不比泛型参数**：`qk.folders` 上那两份的差别只是 `api<unknown>` vs
 * `api<FolderNode[] | {folders}>`，发出去的是同一个请求，`select` 各不相同是
 * react-query 支持的正常用法。把类型差也判红会误伤它 —— 而误伤过一次的门禁没人再信。
 *
 * ─────────────────────────────── ② ───────────────────────────────
 *
 * `<MockNotice surface="runtime" />` 在引导页第二步挂了很久，而它**结构上永远渲染不出来**：
 * `/api/runtime/*` 的四个调用全是裸 `api('/runtime/…')`，落进 `'generic'`；
 * 全仓没有任何 `markSurface('runtime', …)`。也就是说 `runtime` 这个面
 * **永远停在 `'unknown'`**，`isSurfaceMocked` 恒为 false。
 *
 * 产品在那一步承诺"如果这块是假的我会告诉你"，而那句话没有任何机制能被说出口。
 * 这与"按钮点了没反应"是同一族：**UI 承诺了一件没有实现支撑的事**。
 *
 * ⚠️ 判据是**单向**的：只要求"界面用到的面必须可写"，
 * **不**要求"每个声明的面都被用到"。`media` / `recorderWs` 今天仍然零写入点
 * （前者走 `mediaUrl()` 直连 `<audio>`，后者是 WebSocket，都不经过 `api()`），
 * 它们没有任何 `<MockNotice>` 引用，所以这条守卫**不管它们** —— 那是另一笔账，
 * 绿灯不能读成"所有面的状态都是真的"。
 *
 * ─────────────────────────────── ③ ───────────────────────────────
 *
 * ⚠️ **② 的覆盖面取决于「有没有人挂过 `<MockNotice>` 条幅」，那是个偶然的判据。**
 * `backends` 就是这么漏过去的：`/backends/*` 的六个调用**全是裸的**（⇒ `'generic'`），
 * 全仓没有任何 `api('backends', …)` / `markSurface('backends', …)`，
 * 于是这个面在四种打开顺序下都停在 `'unknown'` —— 与 ② 刚修掉的 `runtime`
 * **结构上完全同型**。它逃掉只是因为**没人给它挂过条幅**。
 *
 * ③ 换一个不靠运气的判据：**`SURFACES` 里声明过的域**。
 * 那份清单不是装饰 —— `ConnectivitySummary`（顶栏那句「已接通 N / 模拟 M」）
 * 数的就是它里面除 `generic` 之外的每一项。一个面停在 `'unknown'`，
 * 既不进"已接通"也不进"模拟"，于是**它在那个仪表盘上根本不存在**；
 * 而它回落 mock 时打的 `'generic'` 又被那两个数**刻意排除**（#84 修的就是这条）。
 * 也就是说：一次落到假数据上的 `/backends/installed`，全屏幕**没有任何一处**说得出口。
 *
 * ⚠️ 判据要求的是「带 surface 实参」，**不是**「surface 名等于路径首段」。
 * 后者会误伤两处**刻意**的映射：`api('import', '/notes/probe')`、
 * `api('transcript', '/notes/:uid/transcript')` —— 端点挂在 `/notes` 下，
 * 但用户看到的是"导入"和"转写"两块，标注按用户看到的分。
 *
 * ⚠️ 这条**只管 `SURFACES` 里有名字的域**。`/components/*`、`/folders`、`/tags`、
 * `/secrets`、`/llm/*` 今天没有对应的面，落 `'generic'` 是正确的、不是漏 ——
 * 要不要给它们开面是另一笔账（开了这条守卫自然就管上了，这正是判据的意义）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';

import { SURFACES } from './surfaces';

function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    '\n'.repeat((m.match(/\n/g) ?? []).length),
  );
  return noBlock
    .split('\n')
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (quote) {
          if (ch === '\\') i++;
          else if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        else if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

function productFiles(): string[] {
  return [...globSync('src/**/*.ts'), ...globSync('src/**/*.tsx')]
    .filter((f) => !/\.test\.tsx?$/.test(f))
    .filter((f) => !f.startsWith('src/test/'))
    .map((f) => f.replace(/\\/g, '/'));
}

const sourceOf = new Map<string, string>();
function source(file: string): string {
  let s = sourceOf.get(file);
  if (s === undefined) {
    s = stripComments(readFileSync(file, 'utf8'));
    sourceOf.set(file, s);
  }
  return s;
}

/* ══════════════════════════ ① 一个 key 一个 queryFn ══════════════════════════ */

interface QueryDef {
  at: string;
  key: string;
  /** `queryFn` 里那次 `api(...)` 调用的**运行时形状**：`surface|path`（泛型已剥掉）。 */
  call: string;
}

/**
 * `lib/api/mock.ts` 不参与：它是 mock 源，里面没有 `useQuery`。
 * 找不到 `api(...)` 的 `queryFn`（自己 `rawFetch`、纯本地计算的那几处）记成
 * `raw:<位置>` —— **每处各不相同，因此永远不会与别人撞车**，等于"不判"。
 * 这是刻意的：它们不是"同一个端点的第二份定义"，把它们卷进来只会制造噪音。
 */
function collectQueryDefs(): QueryDef[] {
  const out: QueryDef[] = [];
  for (const file of productFiles()) {
    const lines = source(file).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const km = /^\s*queryKey\s*:\s*(.+?),?\s*$/.exec(lines[i]!);
      if (!km) continue;
      const key = km[1]!
        .replace(/\s+/g, '')
        .replace(/asconst$/, '')
        .replace(/,$/, '');
      const ctx = lines.slice(i, i + 8).join(' ');
      // 剥掉泛型参数：只留 surface 实参与路径 —— 那才是"发什么请求"
      const m = /\bapi\s*(?:<[^>]*>)?\s*\(\s*(?:'([a-zA-Z]+)'\s*,\s*)?[`']([^`']+)[`']/.exec(ctx);
      const call = m
        ? `${m[1] ?? 'generic'}|${m[2]!.split('?')[0]!.replace(/\$\{[^}]*\}/g, ':x')}`
        : `raw:${file}:${i + 1}`;
      out.push({ at: `${file}:${i + 1}`, key, call });
    }
  }
  return out;
}

describe('① 同一个 queryKey 上不许有两份不同的 queryFn', () => {
  test('前提：扫得出东西（空集 / 正则失效会让下面那条假绿）', () => {
    const defs = collectQueryDefs();
    assert.ok(defs.length >= 20, `只扫到 ${defs.length} 个 useQuery —— 扫描逻辑坏了`);
    // 定点校准：这三个 key 必须被看见，且各自解析出了真实的 api() 调用
    for (const anchor of ['qk.models.installed', 'qk.jobs.all', 'qk.backends.catalog']) {
      const hit = defs.filter((d) => d.key === anchor);
      assert.ok(hit.length > 0, `扫描漏掉了 ${anchor}`);
      assert.ok(
        hit.every((d) => !d.call.startsWith('raw:')),
        `${anchor} 的 queryFn 没被解析出来（${hit.map((d) => d.call).join(', ')}）—— 正则收窄了`,
      );
    }
  });

  test('★ 一个 key 一份定义：surface 实参与路径都必须一致', () => {
    const byKey = new Map<string, QueryDef[]>();
    for (const d of collectQueryDefs()) byKey.set(d.key, [...(byKey.get(d.key) ?? []), d]);

    const divergent = [...byKey.entries()]
      .filter(([, defs]) => new Set(defs.map((d) => d.call)).size > 1)
      .map(
        ([key, defs]) =>
          `  ${key}\n` + defs.map((d) => `      ${d.at}   →  api(${d.call})`).join('\n'),
      );

    assert.deepEqual(
      divergent,
      [],
      '这些 queryKey 上挂着不止一份 queryFn：\n' +
        divergent.join('\n') +
        '\n⚠️ react-query 只执行**先挂载的那一个** ⇒ 实际发出去的是哪一个请求、' +
        '哪个 API 面被标成 live/mock，取决于用户先打开哪个页面。' +
        '\n修法照 `lib/api/jobs.ts` / `lib/api/hardware.ts` / `lib/api/models.ts`：' +
        '把实现提升到 `lib/api/`（`features/` 之间不许互相 import），feature 侧再导出。',
    );
  });
});

/* ═════════════════ ② 界面用到的 surface 必须真的有人写它 ═════════════════ */

/** `<MockNotice surface="X" …>` 里出现过的所有 X。 */
function surfacesPromisedInUi(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of productFiles().filter((f) => f.endsWith('.tsx'))) {
    const lines = source(file).split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i]!.matchAll(/<MockNotice[^/>]*\bsurface=["']([a-zA-Z]+)["']/g)) {
        const s = m[1]!;
        found.set(s, [...(found.get(s) ?? []), `${file}:${i + 1}`]);
      }
    }
  }
  return found;
}

/** 能把某个面写成 live/mock/offline 的调用点：`api('X', …)` 或 `markSurface('X', …)`。 */
function surfacesWritten(): Set<string> {
  const found = new Set<string>();
  for (const file of productFiles()) {
    for (const m of source(file).matchAll(
      /(?:\bapi\s*(?:<[^>]*>)?\s*\(\s*|markSurface\s*\(\s*)'([a-zA-Z]+)'\s*,/g,
    )) {
      found.add(m[1]!);
    }
  }
  return found;
}

describe('② 界面上承诺要报告的每个 API 面，都必须真的有写入点', () => {
  test('前提：两个扫描都不是空的', () => {
    const promised = surfacesPromisedInUi();
    const written = surfacesWritten();
    assert.ok(promised.size >= 5, `只扫到 ${promised.size} 个 <MockNotice surface=…> —— 扫描坏了`);
    assert.ok(written.size >= 5, `只扫到 ${written.size} 个 surface 写入点 —— 扫描坏了`);
    // 定点校准：这两个是已知一定成立的
    assert.ok(promised.has('notes'), 'notes 面的 MockNotice 扫不到了');
    assert.ok(written.has('import'), "markSurface('import', …) 扫不到了");
  });

  test('★ 每个被 `<MockNotice surface=…>` 用到的面，都得有 `api(面, …)` 或 `markSurface(面, …)`', () => {
    const written = surfacesWritten();
    const dead = [...surfacesPromisedInUi().entries()]
      .filter(([s]) => !written.has(s))
      .map(([s, at]) => `  surface="${s}"  ←  ${at.join(', ')}`);

    assert.deepEqual(
      dead,
      [],
      '这些面在界面上挂着"这块可能是假数据"的提示，但**全仓没有任何东西能把它们标成非 unknown**，\n' +
        '于是 `isSurfaceMocked()` 恒为 false，那个提示**结构上永远渲染不出来**：\n' +
        dead.join('\n') +
        '\n两种修法二选一，别猜：要么给该域的 `api()` 调用补上 surface 实参' +
        '（`/api/runtime/*` 那四处走的就是这条），要么这个提示本来就不该在那里，删掉它。',
    );
  });

  test('反面：被用到的面必须都是 `SURFACES` 里声明过的（拼错了不许静默变成一个新面）', () => {
    const declared = new Set<string>(SURFACES as readonly string[]);
    const unknown = [...surfacesPromisedInUi().keys()].filter((s) => !declared.has(s));
    assert.deepEqual(unknown, [], `<MockNotice> 用了没有声明的面：${unknown.join(', ')}`);
  });
});

/* ═══════ ③ 声明过的域，它的 api() 调用不许再落进 'generic' ═══════ */

interface ApiCall {
  at: string;
  /** 路径首段（`/backends/installed` → `backends`）。 */
  head: string;
  /** 显式传了 surface 实参吗？ */
  declared: string | undefined;
}

/**
 * 全部 `api(...)` 调用点。
 *
 * 用整文件匹配而不是按行：真实调用有相当一部分是折行写的
 * （`api<GetCatalogResponse>(\n  'models',\n  `/models/catalog?…`,\n)`），
 * 按行扫会把它们**全部漏掉**，而漏检的门禁会稳稳地报绿。
 * 位置用"第几个换行"换算回行号，红的时候要能指到地方。
 */
function collectApiCalls(): ApiCall[] {
  const out: ApiCall[] = [];
  const RE = /\bapi\s*(?:<[^>]*>)?\s*\(\s*(?:'([a-zA-Z]+)'\s*,\s*)?[`']\/([a-zA-Z][\w-]*)/g;
  for (const file of productFiles()) {
    const src = source(file);
    for (const m of src.matchAll(RE)) {
      const line = src.slice(0, m.index).split('\n').length;
      out.push({ at: `${file}:${line}`, head: m[2]!, declared: m[1] });
    }
  }
  return out;
}

describe('③ `SURFACES` 里声明过的域，调用点必须带 surface 实参', () => {
  test('前提：扫描器看得见东西，且认得出折行写法', () => {
    const calls = collectApiCalls();
    assert.ok(calls.length >= 30, `只扫到 ${calls.length} 个 api() 调用 —— 正则或 glob 坏了`);
    // 定点校准：这三个必须被看见，否则下面那条是空转
    for (const probe of ['backends', 'models', 'notes']) {
      assert.ok(
        calls.some((c) => c.head === probe),
        `扫不到任何 /${probe}/… 的调用`,
      );
    }
    // 折行写法：`/models/catalog` 那处的 surface 与路径分居两行
    assert.ok(
      calls.some((c) => c.head === 'models' && c.at.startsWith('src/lib/api/models.ts')),
      '折行的 api(\n  surface,\n  path) 没被扫到 —— 换成按行匹配就会漏掉一大片',
    );
    /*
     * 剥注释必须在工作：`lib/api/models.ts` / `lib/api/backends.ts` / `client.ts`
     * 的文件头里**逐字**写着 `api('/models/installed')` 这种被禁的写法（它们在讲
     * 这段历史）。不剥的话这条守卫会指着解释文字判红 —— 假红灯比没有门更坏。
     */
    const bare = /\bapi\s*\(\s*'\/models/;
    assert.equal(bare.test(stripComments("// api('/models/installed')")), false, '行注释没剥掉');
    assert.equal(bare.test(stripComments("/* api('/models/x') */")), false, '块注释没剥掉');
    assert.equal(bare.test(stripComments("api('/models/x')")), true, '剥过头了，真调用也没了');
  });

  test('★ 裸调用不许出现在已声明的域上', () => {
    const declared = new Set<string>(SURFACES as readonly string[]);
    const offenders = collectApiCalls()
      .filter((c) => c.declared === undefined && declared.has(c.head))
      .map((c) => `  ${c.at}   →  api('/${c.head}/…')  ⇒  surface 'generic'`);

    assert.deepEqual(
      offenders,
      [],
      '这些调用属于一个**已经在 `SURFACES` 里声明过**的域，却没带 surface 实参：\n' +
        offenders.join('\n') +
        '\n⇒ 它们全部记在 `generic` 上，而那个面被顶栏的「已接通 N / 模拟 M」' +
        '**刻意排除**；该域自己则永远停在 `unknown`，两个数里都不出现。' +
        '\n于是"这块正在用假数据"这件事，在整个界面上没有任何一处说得出口。' +
        "\n修法：把面名当第一个实参传进去 —— `api('backends', '/backends/installed')`。" +
        "\n（面名**不必**等于路径首段：`api('import', '/notes/probe')` 是对的，" +
        '标注按用户看到的那块分，不按 REST 路径分。）',
    );
  });

  test('反面：扫出来的 surface 实参必须都是声明过的（拼错了不许静默变成新面）', () => {
    const declared = new Set<string>(SURFACES as readonly string[]);
    const bogus = collectApiCalls()
      .filter((c) => c.declared !== undefined && !declared.has(c.declared))
      .map((c) => `${c.at} → api('${c.declared}', …)`);
    assert.deepEqual(bogus, [], `api() 用了没有声明的面：${bogus.join(', ')}`);
  });
});
