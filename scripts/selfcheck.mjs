#!/usr/bin/env node
/**
 * selfcheck.mjs — one command that reports the REAL state of every layer.
 *
 * OWNER: gpu-runtime (T-042, 同源化于 T-119).
 *
 * WHY THIS EXISTS: the product degrades silently. Every layer here has a graceful
 * fallback, which is correct behaviour and also exactly the problem — libsimple missing
 * falls back to trigram (and Chinese search quietly stops working), a missing backend
 * pack falls back to "not installed" (and transcription is simply unavailable), a
 * missing VAD model falls back to fixed-size chunking. Each fallback is individually
 * sensible; together they let the product run in a degraded state with nobody aware.
 *
 * So this script does not ask "did it load?" — it asks "does the FEATURE work?".
 *
 * ─── T-119：这个文件现在**不含任何判据** ─────────────────────────────────────────────
 * 检查项全部在 `@openmemo/runtime` 的 `runSelfCheck()` 里，与 `GET /api/selfcheck`
 * **同一份实现**。这里只做两件事：
 *   1. 把探针接上（pipeline 的工具解析、better-sqlite3 的分词器实测、llm 的本机探测…）
 *   2. 渲染
 *
 * 之前这里是 552 行独立实现，比端点多出硬件探测 / 数据目录自洽性 / 本地 LLM / 代理四类，
 * 于是**网页绿 ≠ CLI 绿**。一个自检工具自己两个出口给不同答案，比没有自检更糟：
 * 它会让人对绿灯失去判断力。
 *
 * 给了 `--daemon` 时还会多做一件事：把本地报告与端点报告**逐 id 比对**，
 * 任何漂移报成 required 失败。"我保证同源"是句话，这个比对是证据。
 *
 * Exit code is 1 if any REQUIRED check fails.
 *
 * Usage:
 *   node scripts/selfcheck.mjs
 *   node scripts/selfcheck.mjs --data-dir /tmp/omdata --daemon http://127.0.0.1:10000
 *   node scripts/selfcheck.mjs --json
 *   node scripts/selfcheck.mjs --daemon ... --proxy-test   # 额外真发一次外网请求验代理
 *
 * `--token` 仍然接受，但 T-118 起鉴权默认关闭（OPENMEMO_AUTH=none），通常不需要。
 */

import { access, constants, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * ★★ T-145：动态 import 必须走 `pathToFileURL()`，**不能把绝对路径拼进模板字符串**。
 *
 * 这条是第一次在 Windows runner 上跑冷启动审计时抓到的（run 31029690089）——
 * 整个 selfcheck 在 Windows 上**根本跑不起来**：
 *
 *   selfcheck crashed: Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]:
 *     Only URLs with a scheme in: file, data, and node are supported by the
 *     default ESM loader. On Windows, absolute paths must be valid file:// URLs.
 *     Received protocol 'd:'
 *
 * 因为 `${REPO_ROOT}/packages/...` 在 Windows 上是 `D:\a\openmemo\...`，
 * ESM loader 把开头的 `D:` 当成了 URL scheme。
 *
 * ★ 这与 `platform` T-141 §3 第 1 条是**同一族**：`main.ts:1075` 手拼
 *   `` `file://${process.argv[1]}` `` 而不用 `pathToFileURL()`。
 *   同一个教训，同一个仓库，第二个文件 —— 修了被点名的那处，没有回头查同族。
 *
 * 后果的严重性值得单独说：**自检工具自己在 Windows 上是坏的。**
 * 也就是说在 Windows 上，"产品有没有装好"这个问题**连问都问不出来**。
 */
const distUrl = (rel) => pathToFileURL(join(REPO_ROOT, rel)).href;

// ---------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const argOf = (name, fallback = undefined) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const JSON_OUT = argv.includes('--json');
/** 真发一次外网请求验证代理。默认关闭 —— 自检必须能离线跑完。 */
const PROXY_TEST = argv.includes('--proxy-test');

function defaultDataDir() {
  const home = homedir();
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'OpenMemo');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'OpenMemo');
  }
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'openmemo');
}

const DATA_DIR = argOf('--data-dir', process.env.OPENMEMO_DATA_DIR ?? defaultDataDir());
const STORE_ROOT = process.env.OPENMEMO_MODELS ?? join(DATA_DIR, 'models');
const EXT_DIR = process.env.OPENMEMO_EXT_DIR ?? join(DATA_DIR, 'bin', 'ext');
const DAEMON = argOf('--daemon', null);
const TOKEN = argOf('--token', process.env.OPENMEMO_TOKEN ?? null);

const canRead = async (p) => {
  try {
    await access(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

const SUFFIX =
  process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';

// ---------------------------------------------------------------------------------------
// 探针接线 —— 这里只负责"怎么问"，"问什么/怎么判"全在 runSelfCheck 里
// ---------------------------------------------------------------------------------------

/** 本地 better-sqlite3（pnpm 的 .pnpm 目录里那份）。拿不到就返回 null，不让自检崩。 */
async function loadSqlite() {
  try {
    const require = createRequire(import.meta.url);
    const dirs = await readdir(join(REPO_ROOT, 'node_modules', '.pnpm'));
    const hit = dirs.find((d) => d.startsWith('better-sqlite3@'));
    return require(join(REPO_ROOT, 'node_modules', '.pnpm', hit, 'node_modules', 'better-sqlite3'));
  } catch {
    return null;
  }
}

/**
 * 中文分词实测。
 *
 * 在**内存库 + 自带语料**上跑，不碰用户的 `segments_fts`：
 * "这四个词能不能被切出来并命中"是**分词器自身的性质**，与用户有没有笔记无关。
 * 查在用户库上，全新安装会四个词全 0 → 报红，而"红灯不代表坏了"和
 * "绿灯不代表能用"是同一个病的两面，且更糟：第一次打开就见红叉，久了就学会无视红灯。
 */
function makeSqliteProbes(Database) {
  let db = null;
  let loadedSimple = false;
  let loadedVec = false;

  const open = () => {
    if (db !== null) return db;
    db = new Database(':memory:');
    try {
      db.loadExtension(join(EXT_DIR, `libsimple${SUFFIX}`));
      loadedSimple = true;
    } catch {
      loadedSimple = false;
    }
    try {
      db.loadExtension(join(EXT_DIR, `vec0${SUFFIX}`));
      loadedVec = true;
    } catch {
      loadedVec = false;
    }
    return db;
  };

  return {
    chineseSearch: async () => {
      const h = open();
      if (!loadedSimple) return null;
      try {
        if (await canRead(join(EXT_DIR, 'dict', 'jieba.dict.utf8'))) {
          h.exec(`select jieba_dict('${join(EXT_DIR, 'dict').replace(/'/g, "''")}')`);
        }
        h.exec("CREATE VIRTUAL TABLE IF NOT EXISTS t USING fts5(x, tokenize='simple')");
        h.exec('DELETE FROM t');
        const ins = h.prepare('INSERT INTO t(x) VALUES (?)');
        for (const s of [
          'Twitter,非官方中文名称推特,是一个社交网络及微博客服务',
          '用户可以经由SMS、即时通讯、电邮、Twitter网站或Twitter用户端软件',
          '2009年6月2日下午,中国大陆封锁了推特',
          '目前手机SMS更新服务暂时只有在美国、加拿大及英国可获得免费服务',
        ]) {
          ins.run(s);
        }
        const out = {};
        for (const q of ['用户', '推特', '中国', '服务']) {
          out[q] = h.prepare('SELECT count(*) c FROM t WHERE t MATCH ?').get(q).c;
        }
        return out;
      } catch {
        // 装上了但用不了，与"没装"要分开
        return null;
      }
    },
    vecVersion: () => {
      const h = open();
      if (!loadedVec) return Promise.resolve(null);
      try {
        return Promise.resolve(h.prepare('select vec_version() v').get().v ?? null);
      } catch {
        return Promise.resolve(null);
      }
    },
    close: () => {
      if (db !== null) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/** 读 `<dataDir>/openmemo.db` 里的 media_assets / settings。只读打开，读不到就 null。 */
function openAppDb(Database) {
  if (Database === null) return null;
  try {
    return new Database(join(DATA_DIR, 'openmemo.db'), { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function readSetting(appDb, key) {
  if (appDb === null) return undefined;
  try {
    const row = appDb.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value_json) : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  const rt = await import(distUrl('packages/runtime/dist/index.js'));
  const pl = await import(distUrl('packages/pipeline/dist/index.js'));
  const shared = await import(distUrl('packages/shared/dist/index.js'));
  /*
   * sherpa-onnx / Paraformer 选型：**同一个 `resolveStreamingModel()` /
   * `resolveOfflineChineseModel()` / `resolvePunctuation()`**，不是重新猜一遍文件名。
   *
   * 以前这里手写了一份 `by-name/asr/model.int8.onnx` 硬编码检查，且从不构造
   * `SherpaOnnxEngine` —— `meta.sameSource` 因此永远给 `engine.sherpa-onnx
   * 本地=缺 端点=ok`：daemon 的 `buildPipeline()` 用安装记录 + 文件形状判定
   * （encoder/decoder/joiner+tokens.txt 是 sherpa、onnx+tokens.txt 是 Paraformer）
   * 正确选出模型，这里从来没看过安装记录。
   *
   * 现在直接 import daemon 里那三个函数本身（同 `resolveBackendTool()` 的
   * 同源做法，见上面 T-162 的注释），两边保证是**同一次调用**，不是"分别实现、
   * 靠人记得同步"。
   */
  const daemonSetup = await import(distUrl('apps/daemon/dist/pipeline/setup.js'));

  const tools = await pl.discoverTools({ storeRoot: STORE_ROOT, dataDir: DATA_DIR });
  /*
   * T-162：跑的是哪个后端包。与 daemon 出口给的是同一件事 ——
   * 那边读 `bundle.whisperCliOrigin`（buildPipeline 装配时算的），这边现算一次，
   * **调的是同一个 `resolveBackendTool()`**，输入也都是 STORE_ROOT，所以结论必然一致。
   * 只在它与 `tools.whisperCli` 逐字相同时才认：不同就说明这条路径来自
   * 环境变量或系统 PATH，报一个包 id 就是在为另一个二进制作证。
   */
  const whisperCliName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const resolvedWhisper = await pl.resolveBackendTool(STORE_ROOT, whisperCliName);
  const whisperCliOrigin =
    resolvedWhisper !== null && resolvedWhisper.path === tools.whisperCli ? resolvedWhisper : null;
  const Database = await loadSqlite();
  const sqlite = Database === null ? null : makeSqliteProbes(Database);
  const appDb = openAppDb(Database);

  // -- ASR 引擎候选：与 daemon 的 buildPipeline 保持同样的构造方式 -----------------------
  const engineList = [new pl.WhisperCppEngine({ tools, cwd: join(DATA_DIR, 'tmp') })];

  const stream = await daemonSetup.resolveStreamingModel(STORE_ROOT, process.env);
  if (stream.model) {
    engineList.push(new pl.SherpaOnnxEngine({ model: stream.model, provider: 'cpu' }));
  }

  const para = await daemonSetup.resolveOfflineChineseModel(STORE_ROOT, process.env);
  if (para.model) {
    const punctuation = await daemonSetup.resolvePunctuation(STORE_ROOT, process.env);
    engineList.push(
      new pl.ParaformerEngine({
        tools,
        cwd: join(DATA_DIR, 'tmp'),
        model: para.model,
        ...(punctuation ? { punctuation } : {}),
        provider: 'cpu',
      }),
    );
  }
  const candidates = await pl.buildCandidates(engineList);

  const proxyCfg = readSetting(appDb, 'proxy');

  const report = await rt.runSelfCheck({
    dataDir: DATA_DIR,
    storeRoot: STORE_ROOT,
    extensionsDir: EXT_DIR,
    proxyTest: PROXY_TEST,
    probes: {
      tools: () => Promise.resolve(tools),
      installed: (kind) => pl.listInstalledModels(STORE_ROOT, kind),

      // T-162：跑的是哪个后端包。**必须与 daemon 那个出口给出同一个答案**（见上）。
      backendSelection: () =>
        Promise.resolve(
          whisperCliOrigin === null
            ? null
            : {
                selectedBackend: whisperCliOrigin.preferred,
                packId: whisperCliOrigin.packId,
                packBackend: whisperCliOrigin.backend,
                degraded: whisperCliOrigin.degraded,
              },
        ),

      /*
       * T-149：按安装记录里的 `role` 问，不按目录名猜。
       * **必须与 daemon 那个出口调同一个函数**（`rest/selfcheck.ts` 里也是它）——
       * 两个出口各自解析、而 `meta.sameSource` 只比 id 与 status，
       * 那正是 T-148 里两边都报绿的机制（vad-fix §2）。
       */
      installedByRole: (role) => rt.listInstalledNamesByRole(STORE_ROOT, role),

      /*
       * T-153：内置目录读到了没有。
       * **import daemon 里那两个加载器本身**（同 T-162 的同源做法）——
       * 两边保证是同一次调用，`meta.sameSource` 才有意义。
       * 自己在这里重写一份"看看目录在不在"，正是它历来出漂移的方式。
       */
      catalogLoad: async () => {
        const mf = await import(distUrl('apps/daemon/dist/http/rest/manifests.js'));
        const dir = mf.resolveManifestDir();
        const [m, b] = await Promise.all([mf.loadModelCatalog(dir), mf.loadBackendCatalog(dir)]);
        const err = m.loadError ?? b.loadError;
        return {
          loaded: err === null,
          dir,
          models: m.models.length,
          packs: b.packs.length,
          reasonZh: err ? err.messageZh : null,
          reasonEn: err ? `${err.code}: ${err.message} (${err.dir})` : null,
        };
      },

      // probe 藏在后端包里（挨着 libggml-base），只有 pipeline 的两层扫描找得到。
      probePath: () =>
        pl.findInBackendPacks(
          STORE_ROOT,
          process.platform === 'win32' ? 'openmemo-probe.exe' : 'openmemo-probe',
        ),

      /*
       * T-173：断路器是 **daemon 进程内**的状态，CLI 这个进程里根本没有它。
       * 所以只能问 daemon；没有 `--daemon` 就如实回 null（检查项照常出现，说"取不到"），
       * 而不是在本进程另算一份 —— 那就是第二个实现，且必然与 daemon 那份不一致。
       * 与 `proxyConnectivity` 同一形状。
       *
       * `/api/runtime/breaker` 是纯观测的（T-173 起不再触发探测），所以问它不会
       * 反过来改变 `/api/selfcheck` 那一侧看到的状态 —— `meta.sameSource` 才稳得住。
       */
      breaker: async () => {
        if (!DAEMON) return null;
        try {
          const r = await fetch(`${DAEMON}/api/runtime/breaker`, {
            headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
            signal: AbortSignal.timeout(10_000),
          });
          if (!r.ok) return null;
          const j = await r.json();
          if (typeof j?.verdict !== 'string') return null;
          return {
            verdict: j.verdict,
            blacklistedBackends: Array.isArray(j.blacklistedBackends) ? j.blacklistedBackends : [],
            consecutiveFailures: j.breaker?.consecutiveFailures ?? 0,
            threshold: j.threshold ?? 0,
            lastError: j.breaker?.lastError ?? null,
            retryAt: j.retryAt ?? null,
            recovering: j.recovering === true,
          };
        } catch {
          return null;
        }
      },

      chineseSearch: () => (sqlite === null ? Promise.resolve(null) : sqlite.chineseSearch()),
      vecVersion: () => (sqlite === null ? Promise.resolve(null) : sqlite.vecVersion()),

      engines: () =>
        Promise.resolve(
          candidates.map((c) => ({
            id: c.engine.id,
            available: c.available,
            ...(c.unavailableReason ? { reason: c.unavailableReason } : {}),
          })),
        ),
      selectFor: (language) => {
        const s = pl.selectEngine({ candidates, language, mode: 'batch' });
        return Promise.resolve(s ? { engineId: s.engineId, reason: s.reason } : null);
      },

      mediaAssets: () => {
        if (appDb === null) return Promise.resolve(null);
        try {
          return Promise.resolve(
            appDb
              .prepare('SELECT role, rel_path FROM media_assets')
              .all()
              .map((r) => ({ role: r.role, relPath: r.rel_path })),
          );
        } catch {
          return Promise.resolve(null);
        }
      },

      localLlmServices: async () => {
        try {
          const llm = await import(distUrl('packages/llm/dist/index.js'));
          const found = await llm.detectLocalBackends({ timeoutMs: 1200 });
          return found.map((d) => ({ label: d.label, models: d.models?.length ?? 0 }));
        } catch {
          return null;
        }
      },

      /*
       * 档 1 直接读 DB + secrets 文件，**不经 HTTP** —— 这样不给 `--daemon` 也能答，
       * 两个出口才可能得到同一份结论。secrets 只看**键名**，绝不读明文。
       */
      llmKeyConfig: async () => {
        const providerId = readSetting(appDb, 'llm.defaultProviderId') ?? null;
        let hasKey;
        try {
          const { readFile } = await import('node:fs/promises');
          const raw = JSON.parse(await readFile(join(DATA_DIR, 'secrets.json'), 'utf8'));
          // 只列**键名**。这里刻意不解构 value —— 明文 Key 连进变量都不该进。
          hasKey = Object.keys(raw?.secrets ?? raw ?? {}).some((k) => /^llm\..+\.apiKey$/.test(k));
        } catch {
          // 文件不存在 = 一个 Key 都没存过，这是全新安装的正常状态
          hasKey = false;
        }
        return { providerId: typeof providerId === 'string' ? providerId : null, hasKey };
      },

      /*
       * ⚠️ 缺省值必须与 daemon 的 `readProxyConfig()` **同一份** ——
       * 它没配过时返回 `DEFAULT_PROXY_CONFIG`（mode='system'），不是 null。
       * 这里若自己写一句"未配置"，status 虽然一样、detail 却会不一致，
       * 而"差异只允许在渲染层"这条一旦破一次，同源校验就只剩形式意义了。
       */
      proxy: async () => {
        const cfg = proxyCfg ?? shared.DEFAULT_PROXY_CONFIG;
        const mode = typeof cfg.mode === 'string' ? cfg.mode : 'system';
        const url =
          mode === 'manual' ? (cfg.socks5 ?? cfg.httpsProxy ?? cfg.httpProxy ?? null) : null;
        const support = pl.ffmpegProxySupport(url ? { url } : null);
        return {
          mode,
          activeUrl: url ? pl.redactProxyUrl(url) : null,
          ffmpegSupported: support.supported,
          ffmpegReason: support.reason ?? null,
        };
      },

      proxyConnectivity: async () => {
        if (!DAEMON) return null;
        try {
          const r = await fetch(`${DAEMON}/api/settings/proxy/test`, {
            method: 'POST',
            headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
            signal: AbortSignal.timeout(30_000),
          });
          const j = await r.json();
          return {
            ok: j.ok === true,
            probes: (j.probes ?? []).map((p) => ({
              target: p.target,
              result: p.result,
              viaProxy: p.viaProxy === true,
            })),
          };
        } catch {
          return null;
        }
      },
    },
  });

  // -- 同源校验：把本地报告与端点报告逐 id 比对 -------------------------------------------
  const extra = [];
  if (DAEMON) {
    try {
      const res = await fetch(`${DAEMON}/api/selfcheck${PROXY_TEST ? '?proxyTest=1' : ''}`, {
        headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
        signal: AbortSignal.timeout(60_000),
      });
      const remote = await res.json();
      const diff = rt.diffSelfCheckReports(report, remote);
      /*
       * 只比 id 与 status，不比 detail —— detail 里有路径、设备数、耗时这类
       * 本来就该不同的东西（CLI 在仓库根跑，daemon 在自己的进程里跑）。
       * 拿它们当判据只会制造假报警，久了这条就没人看了。
       */
      extra.push({
        id: 'meta.sameSource',
        labelZh: 'CLI 与 /api/selfcheck 同源',
        status: diff.length === 0 ? 'ok' : 'fail',
        required: true,
        detail:
          diff.length === 0
            ? `${report.results.length} 项逐 id 一致（本地 ${report.counts.fail} 失败 / 端点 ${remote.counts.fail} 失败）`
            : diff
                .map((d) => `${d.id}: 本地=${d.here ?? '缺'} 端点=${d.there ?? '缺'}`)
                .join(' · '),
      });
    } catch (err) {
      extra.push({
        id: 'meta.sameSource',
        labelZh: 'CLI 与 /api/selfcheck 同源',
        status: 'warn',
        required: false,
        detail: `无法比对：${err.message}`,
      });
    }
  }

  sqlite?.close();
  if (appDb !== null) {
    try {
      appDb.close();
    } catch {
      /* ignore */
    }
  }

  // -- 渲染（**这是本文件与端点唯一允许不同的地方**）--------------------------------------
  const rows = [...report.results, ...extra.map((e) => ({ layer: 'meta', ...e }))];
  const failures = rows.filter((r) => r.status === 'fail' && r.required);

  if (JSON_OUT) {
    console.log(JSON.stringify({ ...report, results: rows, ok: failures.length === 0 }, null, 2));
  } else {
    console.log('\x1b[1mOpenMemo 自检\x1b[0m');
    console.log(`  dataDir   ${report.dataDir}`);
    console.log(`  storeRoot ${report.storeRoot}`);
    console.log(`  extDir    ${report.extensionsDir}`);
    const TITLES = {
      hardware: '硬件探测',
      tools: '原生工具 / 后端包',
      models: '模型',
      llm: 'LLM（ADR-016：仅在线）',
      ext: 'SQLite 扩展（按功能验，不按加载验）',
      datadir: '数据目录自洽性',
      engines: 'ASR 引擎候选',
      proxy: '代理',
      meta: '同源校验',
    };
    let last = null;
    for (const r of rows) {
      if (r.layer !== last) {
        console.log(`\n\x1b[36m── ${TITLES[r.layer] ?? r.layer}\x1b[0m`);
        last = r.layer;
      }
      const mark =
        r.status === 'ok'
          ? '\x1b[32m✔\x1b[0m'
          : r.status === 'warn'
            ? '\x1b[33m!\x1b[0m'
            : '\x1b[31m✘\x1b[0m';
      console.log(`  ${mark} ${r.labelZh.padEnd(30)} ${r.detail}`);
    }
    const okN = rows.filter((r) => r.status === 'ok').length;
    const warnN = rows.filter((r) => r.status === 'warn').length;
    console.log(
      `\n\x1b[1m结果\x1b[0m  通过 ${okN} · 警告 ${warnN} · \x1b[31m失败 ${failures.length}\x1b[0m`,
    );
    for (const f of failures) {
      console.log(`  \x1b[31m✘ ${f.labelZh}\x1b[0m — ${f.detail}`);
      if (f.remediation) console.log(`      → ${f.remediation}`);
    }
    if (failures.length === 0) console.log('  所有必需项通过。');
  }

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('selfcheck crashed:', err);
  process.exit(1);
});
