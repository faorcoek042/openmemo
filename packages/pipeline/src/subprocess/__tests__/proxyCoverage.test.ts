/**
 * 守卫：**再新增一条出网的子进程路径，不许悄悄绕过代理。**
 *
 * ## 这条守卫要防的具体事故
 *
 * `yt-dlp` 的适配器里一直有 `proxy` 选项、也一直在用它拼 `--proxy`，
 * 而**唯一的生产构造点从来没传过**。于是：
 *   · 模型下载走代理（进程内 `fetch`，被全局 undici dispatcher 接管）
 *   · 链接导入直连（子进程，dispatcher 够不着）
 *   · 设置页照样回 `appliedImmediately: true`
 * 三件事各自都"对"，合起来是一句谎话。**没有任何测试会红**，因为每一层单看都自洽。
 *
 * ## 判据：进程内 vs 子进程，是两套机制
 *
 *   · 进程内 `fetch` → `setGlobalDispatcher()` 一处接全局，**call site 无从绕过**，
 *     所以不需要守卫。
 *   · 子进程        → 只认自己 argv 里的 `--proxy` / 自己 env 里的 `http_proxy`，
 *     **必须被显式告知**。漏一个就是一个洞，而且是静默的。
 *
 * 所以这里扫的是**子进程**那一侧：`run(` / `runOrThrow(` 的每一个调用点，
 * 要么把 proxy 递下去，要么在下面的白名单里写明"它不出网"及理由。
 *
 * ## 为什么是"白名单 + 理由"而不是"全都必须传"
 *
 * 绝大多数 `run()` 是本地活（whisper 推理、ffmpeg 转本地文件、探针）。
 * 强制它们传 proxy 只会逼出一堆 `proxy: null` 样板，而样板不携带信息 ——
 * 下一个人照抄的时候不会想"我这条到底出不出网"。
 * 写理由才逼人回答那个问题，而**新增的调用点默认不在白名单里，所以默认是红的**。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ★★ 必须解析到**源码** `src/`，不能用 `new URL('../..', import.meta.url)`。
 *
 * `[实测]` 第一版就是那么写的，而本包的测试是**从 `dist/` 跑编译产物**的
 * （见 package.json 那段长注释）。于是 `../..` 落在 `dist/`，而 `dist/` 里
 * **有一堆 `.d.ts`** —— 它们同样以 `.ts` 结尾，被我的过滤条件收了进去。
 * 结果：扫到一堆声明文件、里面一个 `run({` 都没有，**守卫全绿**，
 * 而它其实一行真源码都没看过。
 *
 * 这正是本仓那条「空集/错集必须出声」的老毛病，而这次犯在**守卫自己**身上 ——
 * 一个假装在看的守卫，比没有守卫更贵。所以：向上找到 package.json 再进 `src/`，
 * 并且下面的前提自检会验明"确实读到了真源码"。
 */
function packageRoot(from: string): string {
  let d = from;
  for (;;) {
    if (existsSync(join(d, 'package.json'))) return d;
    const up = dirname(d);
    if (up === d) throw new Error(`往上找不到 package.json：${from}`);
    d = up;
  }
}
const SRC = join(packageRoot(fileURLToPath(new URL('.', import.meta.url))), 'src');

/**
 * 明确**不出网**的子进程调用点。key 是 `<相对路径>:<函数名>`，value 是理由。
 *
 * ⚠️ 往这里加一条之前先回答：**这个子进程会不会碰网络？** 会 → 不该加白名单，
 * 该把 proxy 递下去。
 */
const LOCAL_ONLY: Record<string, string> = {
  'audio/ffmpeg.ts': '本地文件转码/探测；远端那两条已经带 proxy（见同文件 opts.proxy）',
  'asr/whisperCpp.ts': 'whisper.cpp 本地推理，只读本地 wav',
  'asr/sherpaOnnx.ts': 'sherpa 本地推理',
  'asr/paraformer.ts': 'Paraformer 本地推理',
  'audio/vad.ts': 'VAD 切分，只读本地 wav',
  'tools.ts': '只跑 --version / 探针枚举，不出网',
  'benchmark/runBenchmark.ts': '本地基准，读内置样本',
};

/** 已经确认会出网、且必须把 proxy 递下去的文件。 */
const MUST_PASS_PROXY = ['media/sources/ytdlp.ts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (e === '__tests__' || e === 'dist' || e === 'node_modules') continue;
    if (statSync(full).isDirectory()) walk(full, out);
    // `.d.ts` 必须排掉：它也以 `.ts` 结尾，收进来就是上面说的那种"假装在看"。
    else if (e.endsWith('.ts') && !e.endsWith('.test.ts') && !e.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('出网代理覆盖面（子进程侧）', () => {
  const files = walk(SRC);

  it('前提自检：真的扫到了**源码**（不是 dist 里的 .d.ts —— 那会让下面每条断言恒真）', () => {
    assert.equal(files.length > 10, true, `只扫到 ${files.length} 个文件，扫描器坏了。SRC=${SRC}`);
    // 只数文件个数不够：`.d.ts` 也能凑够数。要验明确实读到了**实现**。
    const ytdlp = join(SRC, 'media/sources/ytdlp.ts');
    assert.equal(existsSync(ytdlp), true, `读不到 ${ytdlp} —— SRC 解析错了（SRC=${SRC}）`);
    const src = readFileSync(ytdlp, 'utf8');
    assert.equal(
      /await run\(\{/.test(src),
      true,
      '在 ytdlp.ts 里找不到 `await run({` —— 说明读到的不是实现文件（多半是 .d.ts）',
    );
  });

  it('★ 每一个 run()/runOrThrow() 调用点，要么传 proxy，要么在白名单里写明不出网', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file).replace(/\\/g, '/');
      if (rel.startsWith('subprocess/')) continue; // runner 自己就是那层机制
      const src = readFileSync(file, 'utf8');
      // 调用点：`run({` / `runOrThrow({`，取到配对的 `});` 为止（够用且不需要 AST）。
      const re = /\b(run|runOrThrow)\(\{/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const tail = src.slice(m.index, m.index + 2000);
        const end = tail.indexOf('});');
        const call = end >= 0 ? tail.slice(0, end) : tail;
        if (/\bproxy\s*:/.test(call)) continue; // 递下去了
        /*
         * 逐调用点的豁免标记。**比文件级白名单更重要**：像 ytdlp.ts 这种文件里
         * 既有出网的 probe/fetch，也有纯本地的 `--version` —— 文件级粒度只能二选一，
         * 要么放过真洞，要么逼人给本地调用加一个无意义的 `proxy: null`。
         * 标记写在调用点旁边，理由就长在做决定的地方。
         */
        const before = src.slice(Math.max(0, m.index - 400), m.index);
        if (/proxy-not-needed:/.test(call) || /proxy-not-needed:/.test(before)) continue;
        if (LOCAL_ONLY[rel] !== undefined) continue; // 明说不出网
        offenders.push(`${rel} 第 ${src.slice(0, m.index).split('\n').length} 行的 ${m[1]}()`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      '这些子进程调用点既没传 proxy，也没在 LOCAL_ONLY 里说明为什么不用传：\n' +
        offenders.map((o) => `  · ${o}`).join('\n') +
        '\n\n出网的 → 把 proxy 递下去；不出网的 → 加进 LOCAL_ONLY 并写清理由。',
    );
  });

  it('★ 已知出网的适配器必须真的把 proxy 递给子进程（防"改回去"）', () => {
    for (const rel of MUST_PASS_PROXY) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      assert.equal(
        /\bproxy\s*:/.test(src),
        true,
        `${rel} 不再把 proxy 传给子进程了 —— 代理对这条路径又失效了`,
      );
      assert.equal(/ytDlpProxyArgs\(/.test(src), true, `${rel} 不再拼 --proxy 了 —— yt-dlp 会直连`);
    }
  });

  it('★ buildDefaultRegistry 的 proxy 必须是**必填**（可选就等于会被漏掉）', () => {
    const idx = readFileSync(join(SRC, 'index.ts'), 'utf8');
    const block = idx.slice(idx.indexOf('interface BuildRegistryOptions'));
    const decl = block.slice(0, block.indexOf('}'));
    assert.equal(
      /proxy\s*:/.test(decl),
      true,
      'BuildRegistryOptions 里没有 proxy —— 适配器又拿不到代理了',
    );
    assert.equal(
      /proxy\s*\?\s*:/.test(decl),
      false,
      'proxy 被改成可选了。它必填不是洁癖：可选字段会被原样漏掉，' +
        '而漏掉之后一切照常工作 —— 在不需要代理的机器上（也就是我们所有的开发机上）。',
    );
  });

  it('★★ buildDefaultRegistry 必须把 proxy **真的递给**两个出网适配器', () => {
    /*
     * 这条补的是一个上面几条都盖不住的洞：`BuildRegistryOptions.proxy` 必填，
     * 只保证**daemon 得回答这个问题**；适配器那侧的 `proxy` 是可选的，
     * 所以把 `proxy: opts.proxy` 从构造里删掉，**TypeScript 一声不吭**，
     * 而代理对链接导入再次失效 —— 正是原缺陷的形状，原样复发。
     */
    const idx = readFileSync(join(SRC, 'index.ts'), 'utf8');
    const body = idx.slice(idx.indexOf('export function buildDefaultRegistry'));
    for (const adapter of ['DirectHttpSource', 'YtDlpSource']) {
      const at = body.indexOf(`new ${adapter}(`);
      assert.notEqual(at, -1, `buildDefaultRegistry 里找不到 new ${adapter}(`);
      const ctor = body.slice(at, at + 300);
      assert.equal(
        /proxy:\s*opts\.proxy/.test(ctor),
        true,
        `new ${adapter}({...}) 没有把 proxy 递下去 —— 该适配器的子进程会直连，` +
          `而设置页仍然会说 appliedImmediately: true`,
      );
    }
  });

  it('★ 两个出网适配器都必须接受 proxy 选项', () => {
    for (const rel of ['media/sources/ytdlp.ts', 'media/sources/directHttp.ts']) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      assert.equal(
        /proxy\?:\s*ProxyResolver/.test(src),
        true,
        `${rel} 的选项里没有 proxy?: ProxyResolver`,
      );
    }
  });
});
