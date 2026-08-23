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
 * 所以这里不去正则匹配注释里的中文说法。
 *
 * ## ★ 2026-08-10：判据从「出现过」收紧成「真的从对象上读了」
 *
 * 上一版的判据是 `\bfield\b` 命中**整个文件原文**。它挡掉了散文，**但没挡掉两件事**：
 * **注释里的标识符**，和**恰好同名的局部变量/参数**。
 *
 * `[实测]` 拿今天这个真实缺陷当靶子 —— 用户报「任务中心点不进历史记录」，
 * 根因是 `noteUid` 在 `features/tasks/api.ts` 的 `MergedJob` 里被丢掉
 * （而 `shared/jobs.ts` 的契约注释原话是
 * 「Owning note, so the UI can offer "open the note" without a lookup table.」
 * —— **字段就是为这个动作准备的**）。
 * 给它加一条规则，在**修复之前**的代码上跑上一版判据：
 *
 * ```
 * ✔ noteUid   apps/web/src/features/tasks/** 里有 2 个读者
 *      api.ts   ← 其实只是 useActiveNoteJob 的一个**参数名**，与任务中心列表毫无关系
 *      sse.ts   ← 其实只是一句**注释**
 * ```
 *
 * **绿的。** 两个"读者"一个是注释、一个是同名参数，而用户点不进去。
 * 这正是这条守卫要防的那类损失 —— **它却可以被一句注释伪装成已修复。**
 *
 * ### 为什么"剥掉注释"不够（这一条是判断的关键）
 *
 * 剥注释只干掉 `sse.ts` 那一处；`api.ts` 那两处是**真代码**
 * （`useActiveNoteJob(noteUid: string | undefined, …)` 的形参 + 把它当实参传下去）。
 * 也就是说**只剥注释，这个靶子仍然是绿的**。
 *
 * → 所以判据换成「**真的从一个对象上读了这个字段**」：属性访问 `x.field` / `x?.field`，
 *   或解构 `const { field } = x`。这两种形态才对应"消费了契约里的那个字段"；
 *   而形参名、实参、类型声明里的同名键，都不是。
 *
 * ### 自检：这条守卫自己会不会瞎
 *
 * 匹配器上线前先跑一组**阳性/阴性对照**（`assertMatcherWorks`）：
 * 认得出 4 种真读取、且不把 4 种假读取算进去，任一条不符**当场退出**。
 * 判据与 `check-orphan-exports.mjs` 同一条：
 * **先证明探针能看见你已知存在的东西，再相信它说"没有"。**
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
  /*
   * ★ 2026-08-10：清单从 1 条扩到 5 条。
   *
   * 我自己在上一轮说过：**这条守卫的价值取决于清单有多长，而清单只有一条。**
   * 下面四条都来自「契约里带『我算这个是给你（UI）用的』意图注释」的那份普查
   * （41 个候选 / 11 个零消费）—— 每一条都是**服务端已经算好发出、界面却从没读过**。
   */
  {
    field: 'cpuFeaturesUnverified',
    dir: 'apps/web/src/components/common',
    why:
      '契约原话：`the UI must never render it as such`——「你的 CPU 不支持 AVX2」和' +
      '「我们没能查你的 CPU 有没有 AVX2」是两句不同的话，而 Windows 上只有后者为真' +
      '（`detectCpuWin32()` 无条件返回空特性集，从没查过任何标志位）。' +
      '零消费 ⇒ 产品对用户说了一句它并不知道的话（真机已发生）。',
  },
  {
    field: 'capabilityCaveats',
    dir: 'apps/web/src/features/models',
    why:
      '契约原话：`shown verbatim in the UI (ADR-013 decision 1)`，且必须在**下载之前**。' +
      '零消费 ⇒ 用户为速度选了 Paraformer，"无词级时间戳/数字输出为中文/英文一律小写"' +
      '这些代价要等用起来才发现。',
  },
  {
    field: 'detail',
    dir: 'apps/web/src/features/models',
    why:
      '契约原话：`Diagnostic numbers, surfaced in the detail panel so users can sanity-check us.`' +
      '零消费 ⇒ 一个只说"跑不动"、不肯说"我按什么算的"的判断，用户既无法反驳也无法信任。',
  },
  {
    field: 'noteUid',
    dir: 'apps/web/src/features/tasks',
    why:
      '契约原话：`Owning note, so the UI can offer "open the note" without a lookup table.`' +
      '零消费 ⇒ 任务中心点不进那条笔记（真实用户报告 2026-08-10，已由 af01cc1c 修复）。',
  },
  {
    field: 'engines',
    dir: 'apps/web/src/features/models',
    why:
      '模型卡片不显示「这个条目适配哪个引擎」⇒ 用户在两个名字相近的 VAD 之间只能靠猜。' +
      '真实后果：装了 sherpa 的那个、whisper.cpp 加载不了，daemon 每次装配警告一遍，' +
      '而界面从头到尾没告诉过他该装另一个（2026-08-09 用户真机）。',
  },
  {
    field: 'installedOnDiskButUnrecorded',
    dir: 'apps/web/src/features/runtime',
    why:
      'daemon 算出「这个包该提供的东西，本机现在正从一份没有安装记录的副本用着」（T-197）。' +
      '零消费 ⇒ 回到那句被举报的假话：`/api/selfcheck` 的 `tool.ffmpeg` 是绿的、' +
      '流水线正拿盘上那份 7.1.5 在转码，而 `/runtime` 同一时刻写着「安装 119 MB」，' +
      '用户点下去把同一个东西再下一遍（2026-08-10 用户真机 `:10000`）。' +
      '这一格是那句话唯一的解药——服务端算了没人读，等于没修。',
  },
  {
    field: 'activeUnusable',
    dir: 'apps/web/src/features/models',
    why:
      'daemon 算出「这个模型记为使用中，但本机拿它的那个引擎加载不了」（A-4）。' +
      '零消费 ⇒ 回到那个被举报的现场：激活态说这个 VAD 正在用，' +
      '流水线装配同一时刻说「加载不了 → 切分降级为固定窗口」，' +
      '而那条警告只出现在 daemon 控制台（`[用户真机 2026-08-09, Windows]` 一次启动 3 遍），' +
      '网页上一个字都没有。用户看到的是「使用中」，做不了任何事。',
  },
  /*
   * ★ #109：**两条，两个目录，缺一不可。**
   *
   * 卸载有两个入口（`/models` 与 `/runtime`），它们回的是同一个契约
   * （`UninstallWithRefusalsResponse`）。只挂一条规则的话，另一个入口退回沉默时
   * 这道门是绿的 —— 而"同一件事在两个页面上有两种答案"正是本仓反复在清的那一族。
   */
  {
    field: 'filesNotRemoved',
    dir: 'apps/web/src/features/models',
    why:
      '用户点了卸载：模型从列表里消失了，盘上却还留着几个文件（安装记录指向数据目录之外）。' +
      '零消费 ⇒ 回到 `795f091` 之后那个现场：服务端把「哪几个没删掉、它们在哪」' +
      '算好了发过来，界面**一个字都不说**，用户既不知道该去哪把那几百 MB 删掉，' +
      '也不知道自己的卸载其实已经生效了（于是再点一次，拿到 404）。',
  },
  {
    field: 'filesNotRemoved',
    dir: 'apps/web/src/features/runtime',
    why:
      '后端包那一侧同一句话：卡片回到「可安装」，而包内的文件还躺在盘上。' +
      '零消费 ⇒ 用户看到的是"卸载了但空间没回来"，且没有任何地方告诉他这些字节在哪儿、' +
      '为什么产品不肯动它们（它们不在数据目录里）。',
  },
  /*
   * ★ #113：第三档（我们**试了、没删动**），同样两条、两个目录。
   *
   * 与上面那两条**不是同一件事**：`filesNotRemoved` 是"我们不肯删"，
   * 这一格是"我们删不动"。只挂前者的话，daemon 把第三档算出来、
   * 界面一个字不说，门禁照样绿 —— 而那正是这一轮要修的形状本身。
   */
  {
    field: 'filesFailedToRemove',
    dir: 'apps/web/src/features/models',
    why:
      '用户点了卸载：模型消失了，而某个文件 `fs.rm` 真的抛了（Windows 上一个没释放的句柄就够）。' +
      '零消费 ⇒ 回到 #113 之前那个现场：daemon 把失败**吞掉**、`removed` 照加，' +
      '用户拿到一个干净的成功，而文件还在盘上。现在服务端说得出「哪几个没删掉、在哪儿、' +
      '能做什么（重启一次多半就好）」——界面不读，这句话就还是没说出口。',
  },
  {
    field: 'filesFailedToRemove',
    dir: 'apps/web/src/features/runtime',
    why:
      '后端包那一侧同一句话，而且这里更常撞上：包里的动态库可能正被推理进程加载着。' +
      '零消费 ⇒ 用户看到"卸载了但空间没回来"，且拿不到那句唯一可执行的建议。',
  },
  {
    field: 'lastFailure',
    dir: 'apps/web/src/features/notes',
    why:
      'daemon 算出「这条笔记最近一次流水线任务失败了」并把 jobUid / 错误码 / 中英两份原因' +
      '一起发出来（#98）。零消费 ⇒ 回到修之前那个现场：笔记详情页对一次转写失败' +
      '**一个字都不显示**，用户看到空的转写稿面板 + 不动的播放器 + 零条解释，' +
      '而唯一说过话的是右下角那条**刷新即无**的 toast。' +
      '它是「为什么失败」和「能对哪条任务点重试」在界面上唯一的来源 ——' +
      '服务端算了没人读，等于没修。',
  },
  {
    field: 'sha256Verification',
    dir: 'apps/web/src/features/components',
    why:
      '「这个哈希是我们自己把每个字节下下来算的，还是抄上游给的」——两种强度的证据，' +
      '而界面靠它决定要不要提醒用户少信一点。这一格是**替换掉一条会说谎的判据**才加的：' +
      '上一版拿 `/API|digest|upstream/i` 去嗅 `sha256Provenance` 那段自由散文，' +
      '`[实测 2026-08-24]` 13 条散文里 5 条被判成"上游提供"，**全部误判**，' +
      '而且恰好是证据最强的那几条（`whispercpp-cpu-win-x64` 明写着"不带任何凭证全量重下后' +
      '本机 sha256sum 复算"，命中的 `api` 来自另一句里的 DLL 名 `api-ms-win-crt-*`）。' +
      '零消费 ⇒ 判据必然被退回散文，而散文改一个词结论就翻转，且不会有任何东西报错。',
  },
];

/**
 * 剥掉注释**与字符串字面量**，只留下真代码。
 *
 * ⚠️ 必要但**不充分** —— 见文件头：靶子里那两处是真代码（形参 + 实参），剥注释救不了。
 *
 * ## ★ 为什么还要剥字符串（上线一小时后自己撞上的假绿）
 *
 * 只剥注释的版本会把 **i18n 的键**当成属性访问。
 * `[实测]` 给 `FitResult.detail`（契约注释：`Diagnostic numbers, surfaced in the detail
 * panel so users can sanity-check us.`）判读者：
 *
 * ```
 * 属性访问正则 /[.?]\s*detail\b/ 在 ModelDetailPage.tsx 里命中 27 次
 *   …{t('models.detail.loading')}…   ← 全部是 i18n 键，不是属性访问
 *   …{t('models.detail.back')}…
 * 而它真正的子字段 needMB / vramBudgetMB / ramBudgetMB / diskFreeMB / diskNeededMB
 *   在 apps/web 全域各 0 次
 * ```
 *
 * ⇒ **判成"已消费"，而它一次都没被读过。** 与这个守卫本来要抓的那类损失完全同形，
 * 只是这次假绿的是守卫自己。
 *
 * ## 模板字符串里的 `${…}` 要留下
 *
 * 反引号里 `${…}` 内是**真代码**，可能正是 `x.field`。所以不能整段抹掉 ——
 * 下面按字符走一遍，只把**字面文本**替换成空格，`${…}` 原样保留。
 * （用扫描而不是正则：正则处理不了嵌套与转义，而这个函数是整条守卫的地基。）
 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // 块注释
    if (c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2);
      out += ' ';
      i = end === -1 ? n : end + 2;
      continue;
    }
    // 行注释
    if (c === '/' && c2 === '/') {
      const end = src.indexOf('\n', i);
      out += ' ';
      i = end === -1 ? n : end;
      continue;
    }
    // 普通字符串：整段抹成空格（里面不可能有代码）
    if (c === "'" || c === '"') {
      i++;
      while (i < n && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      out += ' ';
      i++;
      continue;
    }
    // 模板字符串：字面文本抹掉，`${…}` 里的代码保留
    if (c === '`') {
      i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          let depth = 1;
          i += 2;
          const start = i;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            if (depth > 0) i++;
          }
          out += ' ' + src.slice(start, i) + ' ';
          i++; // 跳过收尾的 }
          continue;
        }
        i++;
      }
      out += ' ';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 这段代码里，有没有**真的从某个对象上读出 `field`**？
 *
 * 认两种形态，其余一律不算：
 *   1. 属性访问：`x.field` / `x?.field` / `x.field?.y`
 *   2. 解构赋值：`const { field } = x` / `const { a, field } = x`
 *      —— 末尾那个 `=` 是关键：它把**类型声明** `type T = { field: string }` 排除掉
 *      （那里的 `=` 在花括号**之前**）。
 *
 * **不算**：形参名、实参、`interface`/`type` 里的同名键、字符串字面量。
 * 它们都只说明"这个词出现过"，不说明"这个事实被消费了"。
 */
function readsField(code, field) {
  const f = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const propertyAccess = new RegExp(`[.?]\\s*${f}\\b`);
  const destructuring = new RegExp(`\\{[^{}]*\\b${f}\\b[^{}]*\\}\\s*=`);
  return propertyAccess.test(code) || destructuring.test(code);
}

/**
 * ★ 匹配器自检：**先证明探针能看见你已知存在的东西，再相信它说"没有"。**
 *
 * 阴性样本里那两条（形参、实参）**逐字来自这次的真实靶子**
 * （`useActiveNoteJob(noteUid: string | undefined, …)`），
 * 它们正是上一版判据放行的东西。
 */
function assertMatcherWorks() {
  const yes = [
    'const x = job.noteUid;',
    'const y = job?.noteUid;',
    'const { noteUid } = job;',
    'const { jobId, noteUid, state } = job;',
  ];
  const no = [
    'function useActiveNoteJob(noteUid: string | undefined) {}',
    'const job = pickActiveNoteJob(jobs, noteUid, kind);',
    'interface MergedJob { noteUid: string | null }',
    'type T = { noteUid: string };',
  ];
  /*
   * ★ 字符串字面量单独一组：它们要先过 `stripCommentsAndStrings` 才轮到匹配器。
   * 第一行**逐字来自实测**：`t('models.detail.loading')` 让 `FitResult.detail`
   * 被判成"已消费"，而它一次都没被读过。
   */
  const noAfterStrip = [
    "const s = t('models.noteUid.loading');",
    'const s = "job.noteUid";',
    'const s = `见 job.noteUid 那一段`;',
  ];
  const keepsTemplateCode = ['const s = `id=${job.noteUid}`;'];
  const wrong = [
    ...yes.filter((c) => !readsField(c, 'noteUid')).map((c) => `漏判（应算读取）：${c}`),
    ...no.filter((c) => readsField(c, 'noteUid')).map((c) => `误判（不该算读取）：${c}`),
    ...noAfterStrip
      .filter((c) => readsField(stripCommentsAndStrings(c), 'noteUid'))
      .map((c) => `误判（字符串字面量不该算读取）：${c}`),
    ...keepsTemplateCode
      .filter((c) => !readsField(stripCommentsAndStrings(c), 'noteUid'))
      .map((c) => `漏判（模板串里 \${…} 是真代码，必须保留）：${c}`),
  ];
  if (wrong.length) {
    console.error('✘ 匹配器自检未通过 —— **在报告任何结论之前**先停下：\n');
    for (const w of wrong) console.error(`   · ${w}`);
    console.error(
      '\n一个判不准的匹配器，绿和红都不作数。' +
        '（`interface`/`type` 那两条阴性是刻意的：契约类型里当然有这个键，' +
        '但"类型上有"不等于"界面读了"。）\n',
    );
    process.exit(1);
  }
}

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

assertMatcherWorks();

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
  const readers = files.filter((f) =>
    readsField(stripCommentsAndStrings(readFileSync(f, 'utf8')), rule.field),
  );

  if (readers.length === 0) {
    /*
     * 把"提都没提过"和"提了但没真读"分开报 —— 两者的下一步动作完全不同：
     * 前者是功能没做，后者往往是**做了一半**（类型上接了、渲染那一米丢了），
     * 而后者正是这条守卫存在的理由。
     */
    const mentioned = files.filter((f) =>
      new RegExp(`\\b${rule.field}\\b`).test(stripCommentsAndStrings(readFileSync(f, 'utf8'))),
    );
    console.error(`✘ 字段 \`${rule.field}\` 在 ${rule.dir}/** 里**没有任何真实读取**`);
    if (mentioned.length > 0) {
      console.error(
        `   ⚠️ 它在 ${mentioned.length} 个文件里出现过，但**都不是从对象上读它**` +
          `（形参名 / 实参 / 类型声明里的同名键都不算）：`,
      );
      for (const m of mentioned.slice(0, 4)) console.error(`     ${m.replace(REPO + '/', '')}`);
      console.error(
        `   判据：属性访问 \`x.${rule.field}\` 或解构 \`const { ${rule.field} } = x\`。`,
      );
    }
    console.error(`   坏了会怎样：${rule.why}`);
    bad++;
  } else {
    console.log(`✔ ${rule.field.padEnd(12)} ${rule.dir}/** 里有 ${readers.length} 个读者`);
    for (const r of readers.slice(0, 4)) console.log(`     ${r.replace(REPO + '/', '')}`);
  }
}

console.log('─'.repeat(78));
if (bad > 0) {
  // ⚠️ 措辞刻意不说"用户看不见" —— 本守卫判的是**零消费**，不是可见性。见下。
  console.error(`✘ ${bad} 条规则不满足 —— 一个已经送到前端的事实，**零消费**：没有任何人读它。`);
  process.exit(1);
}
/*
 * ★ 绿灯必须**说清自己判的是什么**，否则读者会自行补上最强的那个解释。
 *
 * 另一路实测过这条边界：**把 `ModelCard` 的渲染整个换成 `{null}`，本守卫仍然绿** ——
 * 因为同目录下 `ModelsPage` 那处读取还在。**它判的是「目录里至少有一个真实读取」，
 * 不是「用户真的看见了」。**
 *
 * 一句"N 条规则全部满足"什么都没说，而文件名里的 `shown`、红灯里原本那句
 * "在最后一米被丢掉了"，都在把人往"用户可见"那个更强的解释上推。
 * 判据没改（改判据会让它变成一条噪音门禁），**改的是它对自己的描述**。
 */
console.log(`✔ ${RULES.length} 条规则满足：每个字段在其目录下**至少有 1 个真实读取**。`);
console.log(
  '  ⚠️ 这不等于用户看得见 —— 同目录另一处读取就能让它绿（实测：把某个卡片的渲染换成 `{null}` 它照样绿）。',
);
