#!/usr/bin/env node
/**
 * selfcheck.mjs — one command that reports the REAL state of every layer.
 *
 * OWNER: gpu-runtime (T-042).
 *
 * WHY THIS EXISTS: the product degrades silently. Every layer here has a graceful
 * fallback, which is correct behaviour and also exactly the problem — libsimple missing
 * falls back to trigram (and Chinese search quietly stops working), a missing backend
 * pack falls back to "not installed" (and transcription is simply unavailable), a
 * missing VAD model falls back to fixed-size chunking. Each fallback is individually
 * sensible; together they let the product run in a degraded state with nobody aware.
 *
 * So this script does not ask "did it load?" — it asks "does the FEATURE work?":
 *   - not "is libsimple present" but "does 用户 match in FTS5"
 *   - not "is whisper-cli on disk" but "is it executable and does the daemon see it"
 *
 * Exit code is 1 if any REQUIRED check fails. Optional checks report but do not fail.
 *
 * Usage:
 *   node scripts/selfcheck.mjs
 *   node scripts/selfcheck.mjs --data-dir /tmp/omdata --daemon http://127.0.0.1:17691 --token XXX
 *   node scripts/selfcheck.mjs --json
 *   node scripts/selfcheck.mjs --daemon ... --proxy-test   # 额外真发一次外网请求验代理
 *
 * ADR-016 之后的两处判据调整（T-093）：
 *   - 本地 LLM 已下线 → 不再查 `by-name/llm` 下的 GGUF（查一个产品不再提供的东西 = 噪音），
 *     改为「档 2 本机 Ollama/LM Studio 真探测」+「档 1 只报配没配，不代发请求」。
 *   - 工具来源要区分：装在 dataDir 里 = ok，只在系统 PATH 上 = warn。
 *     开发机恰好有 /usr/bin/ffmpeg 不等于用户装得上。
 */

import { access, constants, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

// ---------------------------------------------------------------------------------------
// result plumbing
// ---------------------------------------------------------------------------------------
const results = [];
function record(layer, name, status, detail, required = true) {
  results.push({ layer, name, status, detail, required });
  if (JSON_OUT) return;
  const mark = status === 'ok' ? '\x1b[32m✔\x1b[0m' : status === 'warn' ? '\x1b[33m!\x1b[0m' : '\x1b[31m✘\x1b[0m';
  console.log(`  ${mark} ${name.padEnd(38)} ${detail}`);
}
function section(title) {
  if (!JSON_OUT) console.log(`\n\x1b[36m── ${title}\x1b[0m`);
}

const canRead = async (p) => {
  try {
    await access(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};
const canExec = async (p) => {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------------------
// 1. hardware detection
// ---------------------------------------------------------------------------------------
async function checkHardware() {
  section('1. 硬件探测 (@openmemo/runtime)');
  let rt;
  try {
    rt = await import(`${REPO_ROOT}/packages/runtime/dist/index.js`);
  } catch (err) {
    record('hardware', '@openmemo/runtime 可加载', 'fail', `构建产物缺失：${err.message}`);
    return null;
  }

  const [os, cpu, ram] = [rt.detectOs(), await rt.detectCpu(), rt.detectMemory()];
  record('hardware', 'OS / 架构', 'ok', `${os.platform}/${os.arch} ${os.version}`);
  record(
    'hardware',
    'CPU 指令集',
    cpu.features.length > 0 ? 'ok' : 'warn',
    `${cpu.brand} · ${cpu.physicalCores}核 · ${cpu.features.slice(0, 6).join(',') || '未检出'}`,
    false,
  );
  record('hardware', '内存', 'ok', `${ram.totalMB} MB total`);

  // The probe is the authoritative device answer; a loader on disk proves nothing.
  // It ships INSIDE the backend pack (beside libggml-base), so it must be located the
  // same way the binaries are — a fixed path at the by-name root never matches.
  const pipelineMod = await import(`${REPO_ROOT}/packages/pipeline/dist/index.js`);
  const probePath = await pipelineMod.findInBackendPacks(
    STORE_ROOT,
    process.platform === 'win32' ? 'openmemo-probe.exe' : 'openmemo-probe',
  );
  if (probePath && (await canExec(probePath))) {
    const r = await rt.runProbe({ probePath, backendDir: dirname(probePath) });
    record(
      'hardware',
      'probe 子进程枚举设备',
      r.ok ? 'ok' : 'warn',
      r.ok ? `${r.output.deviceCount} 个设备, ggml ${r.output.ggmlVersion}` : r.message,
      false,
    );
  } else {
    record('hardware', 'probe 子进程枚举设备', 'warn', 'openmemo-probe 未安装（后端能力未知）', false);
  }
  return rt;
}

// ---------------------------------------------------------------------------------------
// 2. native tools (backend packs)
// ---------------------------------------------------------------------------------------
async function checkTools() {
  section('2. 原生工具 / 后端包');
  const pl = await import(`${REPO_ROOT}/packages/pipeline/dist/index.js`);
  const tools = await pl.discoverTools({ storeRoot: STORE_ROOT });

  const installed = await pl.listInstalledModels(STORE_ROOT, 'backend');
  record('tools', '已安装后端包', installed.length > 0 ? 'ok' : 'warn',
    installed.length > 0 ? installed.join(', ') : `无（${join(STORE_ROOT, 'by-name/backend')} 为空）`, false);

  /*
   * 「找到了」和「装上了」是两件事。
   *
   * `discoverTools()` 的第 3 顺位是 PATH，那是**开发便利**（tools.ts 注释写死了）。
   * 本机 /usr/bin/ffmpeg 存在，于是这一条一直是绿的 —— 但用户机器上没有，
   * 而 ffmpeg 目前**没有任何 HTTP 安装通道**（media-tools-linux-x64 只在 components.json
   * 里有版本记录，backends.json / 模型目录里都没有对应的包，T-093 实测三个安装端点全 404）。
   * 报绿等于把"这台开发机恰好有"当成"产品能装上"，正是自检要防的假绿灯。
   *
   * 判据：装在 dataDir 里 = ok；只在系统 PATH 上 = warn（能跑，但不可分发）；没有 = fail。
   */
  const inStore = (p) => typeof p === 'string' && p.startsWith(STORE_ROOT);
  for (const [label, path, required] of [
    ['ffmpeg', tools.ffmpeg, true],
    ['ffprobe', tools.ffprobe, true],
    ['whisper-cli', tools.whisperCli, true],
    ['whisper-vad-speech-segments', tools.whisperVad, false],
    ['yt-dlp（可选，GPL）', tools.ytDlp, false],
  ]) {
    const ok = Boolean(path) && (await canExec(path));
    if (!ok) {
      record('tools', label, required ? 'fail' : 'warn', '未找到', required);
    } else if (inStore(path)) {
      record('tools', label, 'ok', path, required);
    } else {
      record('tools', label, 'warn', `${path}（来自系统 PATH，非本产品安装 —— 用户机器上不一定有）`, false);
    }
  }

  const vadOk = Boolean(tools.vadModel) && (await canRead(tools.vadModel));
  record('tools', 'VAD 模型 (ggml silero)', vadOk ? 'ok' : 'warn',
    vadOk ? tools.vadModel : '未安装 → VAD 降级为固定窗口切分', false);

  return { pl, tools };
}

// ---------------------------------------------------------------------------------------
// 3. ASR models
// ---------------------------------------------------------------------------------------
async function checkModels(pl) {
  section('3. 模型');
  const asr = await pl.listInstalledModels(STORE_ROOT, 'asr');

  /*
   * "by-name/asr 下有文件" 不等于 "装了一个语音识别模型"。
   *
   * 实测（T-067）：VAD 模型 `ggml-silero-v6.2.0.bin` 也被存成 StoreKind='asr'
   * （StoreKind 只有 asr|llm|backend，而 ModelRole 有 asr|llm|vad|punctuation|…，
   * 两个轴被压成了一个），于是它被当成 ASR 模型，daemon 的 `pipeline.missing` 报 []，
   * 而 whisper 拿到的其实是一个 VAD 模型 —— 假绿灯。
   *
   * 所以这里按文件名把已知的非 ASR 角色剔掉再判定。这不是完美的判据（真正的修法是让
   * 安装记录带上 catalog 的 role），但至少不会把"只装了 VAD"报成"ASR 就绪"。
   */
  const NON_ASR = /silero|vad|punct|ct-transformer|speaker|diariz/i;
  const realAsr = asr.filter((n) => !NON_ASR.test(n));
  const misfiled = asr.filter((n) => NON_ASR.test(n));

  record('models', 'ASR 模型', realAsr.length > 0 ? 'ok' : 'fail',
    realAsr.length > 0
      ? realAsr.join(', ')
      : misfiled.length > 0
        ? `无可用 ASR 模型（by-name/asr 下只有非 ASR 角色的文件：${misfiled.join(', ')}）`
        : `无（${join(STORE_ROOT, 'by-name/asr')} 为空）`);
  return { asr };
}

// ---------------------------------------------------------------------------------------
// 3b. LLM — ADR-016 之后只剩在线：档 1 自带 Key，档 2 复用本机已装服务
// ---------------------------------------------------------------------------------------
/*
 * 原来这里查的是 `by-name/llm` 下有没有 GGUF —— ADR-016 砍掉内置 llama.cpp 之后，
 * 那条判据查的是一个**产品已经不提供的东西**，永远 warn，纯噪音。
 *
 * 换成什么？两档的可自检性完全不同，所以拆成两条、不合并：
 *   档 1（BYO Key）：**没法自检**。验证唯一的办法是拿用户的 Key 去发一次真请求，
 *                    那要花用户的钱、还可能在他不知情时把 Key 发出去。
 *                    所以只报"配没配"这个事实，并明说这不等于"能用"。
 *   档 2（本机 Ollama / LM Studio）：**可以真验**。detectLocalBackends() 会真发
 *                    `/v1/models` 并要求至少有一个模型 —— 端口开着但没下模型不算可用。
 *                    这条是纯本机请求，不联外网。
 */
async function checkLlm() {
  section('3b. LLM（ADR-016：仅在线，档 1 自带 Key / 档 2 复用本机服务）');

  let detected;
  try {
    const llm = await import(`${REPO_ROOT}/packages/llm/dist/index.js`);
    detected = await llm.detectLocalBackends({ timeoutMs: 1200 });
  } catch (err) {
    record('llm', '档 2 本机服务探测', 'warn', `跳过：${err.message}`, false);
    return;
  }
  record('llm', '档 2 本机已装服务', detected.length > 0 ? 'ok' : 'warn',
    detected.length > 0
      ? detected.map((d) => `${d.label}(${d.models?.length ?? 0} 模型)`).join(', ')
      : '未探测到 Ollama / LM Studio（正常：用户没装就没有）',
    false);
  // 档 1 的判定要读 daemon 的 settings/secrets，放在第 6 节（只有给了 --daemon 才有）。
}

// ---------------------------------------------------------------------------------------
// 4. SQLite extensions — tested by FEATURE, not by "loaded"
// ---------------------------------------------------------------------------------------
async function checkExtensions() {
  section('4. SQLite 扩展（按功能验，不按加载验）');
  const suffix = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
  const simplePath = join(EXT_DIR, `libsimple${suffix}`);
  const vecPath = join(EXT_DIR, `vec0${suffix}`);
  const dictDir = join(EXT_DIR, 'dict');

  if (!(await canRead(simplePath))) {
    // ADR-015 起 libsimple 走上游预编译，由「运行时」页安装；build-sqlite-ext.sh 已停用，
    // 指向它会把用户引到一条我们自己都不再走的路上。
    record('ext', 'libsimple 存在', 'fail', `缺失：${simplePath}（在「运行时」页安装中文分词扩展 libsimple）`);
    record('ext', '中文双字词可搜索', 'fail', '未测试：分词器缺失');
    return;
  }

  const require = createRequire(import.meta.url);
  let Database;
  try {
    const dirs = await readdir(join(REPO_ROOT, 'node_modules', '.pnpm'));
    const hit = dirs.find((d) => d.startsWith('better-sqlite3@'));
    Database = require(join(REPO_ROOT, 'node_modules', '.pnpm', hit, 'node_modules', 'better-sqlite3'));
  } catch (err) {
    record('ext', 'better-sqlite3 可加载', 'warn', `跳过扩展功能测试：${err.message}`, false);
    return;
  }

  const db = new Database(':memory:');
  try {
    db.loadExtension(simplePath);
    const hasDict = await canRead(join(dictDir, 'jieba.dict.utf8'));
    if (hasDict) db.exec(`select jieba_dict('${dictDir.replace(/'/g, "''")}')`);
    record('ext', 'jieba 词典', hasDict ? 'ok' : 'warn',
      hasDict ? dictDir : '缺失 → 分词退化为字符切分（仍优于 trigram）', false);

    db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='simple')");
    const ins = db.prepare('INSERT INTO t(x) VALUES (?)');
    for (const s of [
      'Twitter,非官方中文名称推特,是一个社交网络及微博客服务',
      '用户可以经由SMS、即时通讯、电邮、Twitter网站或Twitter用户端软件',
      '2009年6月2日下午,中国大陆封锁了推特',
      '目前手机SMS更新服务暂时只有在美国、加拿大及英国可获得免费服务',
    ]) ins.run(s);

    // THE acceptance criterion. trigram also "loads" — and trigram is what was broken.
    const misses = [];
    const hits = {};
    for (const q of ['用户', '推特', '中国', '服务']) {
      const n = db.prepare('SELECT count(*) c FROM t WHERE t MATCH ?').get(q).c;
      hits[q] = n;
      if (n === 0) misses.push(q);
    }
    record('ext', '中文双字词可搜索', misses.length === 0 ? 'ok' : 'fail',
      Object.entries(hits).map(([k, v]) => `${k}:${v}`).join(' '));
  } catch (err) {
    record('ext', '中文双字词可搜索', 'fail', err.message);
  }

  try {
    db.loadExtension(vecPath);
    record('ext', 'sqlite-vec', 'ok', db.prepare('select vec_version() v').get().v, false);
  } catch (err) {
    record('ext', 'sqlite-vec', 'warn', `向量检索不可用：${err.message}`, false);
  }
  db.close();
}

// ---------------------------------------------------------------------------------------
// 4b. 数据目录自洽性 —— "搬得动、删得掉" 是用户明确提的要求，那就得能验
// ---------------------------------------------------------------------------------------
/*
 * 用户的要求原话是"数据存放是独立文件夹且描述清楚，删除不要影响程序本体运行"。
 * 反过来说：**程序自己的引用也不许跑到那个文件夹外面**，否则搬走数据目录就等于弄坏数据。
 *
 * 这条查的是真东西：把 media_assets 里每一条路径解析出来，看它是不是落在 dataDir 内、
 * 文件在不在。T-093 就是靠它坐实了 `audio16k` 存的是**绝对路径**且指向 `<dataDir>/tmp/job-*`
 * —— 移动数据目录后该资产直接 403，而 UI 还把 tmp 标成"可随时删"。
 * 只看目录结构、不看数据库引用，这种问题永远查不出来。
 */
async function checkDataDirIntegrity() {
  section('4b. 数据目录自洽性（引用是否都在 dataDir 内）');
  const require = createRequire(import.meta.url);
  let db;
  try {
    const dirs = await readdir(join(REPO_ROOT, 'node_modules', '.pnpm'));
    const hit = dirs.find((d) => d.startsWith('better-sqlite3@'));
    const Database = require(join(REPO_ROOT, 'node_modules', '.pnpm', hit, 'node_modules', 'better-sqlite3'));
    db = new Database(join(DATA_DIR, 'openmemo.db'), { readonly: true, fileMustExist: true });
  } catch (err) {
    record('datadir', 'media_assets 路径全在 dataDir 内', 'warn', `跳过：${err.message}`, false);
    return;
  }

  try {
    const rows = db.prepare('SELECT role, rel_path FROM media_assets').all();
    const mediaRoot = join(DATA_DIR, 'media');
    const escaped = [];
    const dangling = [];
    for (const r of rows) {
      const abs = resolve(mediaRoot, r.rel_path);
      if (!abs.startsWith(DATA_DIR + '/') && abs !== DATA_DIR) escaped.push(`${r.role}→${r.rel_path}`);
      else if (!(await canRead(abs))) dangling.push(`${r.role}→${r.rel_path}`);
    }
    record('datadir', 'media_assets 路径全在 dataDir 内', escaped.length === 0 ? 'ok' : 'fail',
      escaped.length === 0
        ? `${rows.length} 条资产全部落在 ${DATA_DIR} 内`
        : `${escaped.length}/${rows.length} 条指向 dataDir 外（移动数据目录后会失效）：${escaped.slice(0, 3).join(' ')}`);
    record('datadir', 'media_assets 文件都在', dangling.length === 0 ? 'ok' : 'warn',
      dangling.length === 0 ? '无悬空引用' : `${dangling.length} 条文件已不存在：${dangling.slice(0, 3).join(' ')}`, false);
  } catch (err) {
    record('datadir', 'media_assets 路径全在 dataDir 内', 'warn', `查询失败：${err.message}`, false);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------
// 5. ASR engine candidates
// ---------------------------------------------------------------------------------------
async function checkEngines(pl, tools) {
  section('5. ASR 引擎候选');
  const engines = [new pl.WhisperCppEngine({ tools, cwd: join(DATA_DIR, 'tmp') })];

  const paraDir = join(STORE_ROOT, 'by-name', 'asr');
  if (await canRead(join(paraDir, 'model.int8.onnx'))) {
    engines.push(new pl.ParaformerEngine({
      tools,
      cwd: join(DATA_DIR, 'tmp'),
      model: {
        model: join(paraDir, 'model.int8.onnx'),
        tokens: join(paraDir, 'tokens.txt'),
        modelId: 'paraformer-zh-small',
        languages: ['zh'],
      },
    }));
  }

  const candidates = await pl.buildCandidates(engines);
  for (const c of candidates) {
    record('engines', c.engine.id, c.available ? 'ok' : 'warn',
      c.available ? `modes=${c.capabilities.modes} wordTs=${c.capabilities.wordTimestamps}`
                  : (c.unavailableReason ?? '不可用'), false);
  }

  const zh = pl.selectEngine({ candidates, language: 'zh', mode: 'batch' });
  const en = pl.selectEngine({ candidates, language: 'en', mode: 'batch' });
  record('engines', '中文自动选择', zh ? 'ok' : 'fail', zh ? `${zh.engineId}（${zh.reason}）` : '无可用引擎');
  record('engines', '英文自动选择', en ? 'ok' : 'fail', en ? `${en.engineId}（${en.reason}）` : '无可用引擎');
  return candidates;
}

// ---------------------------------------------------------------------------------------
// 6. daemon (optional — only when a URL is supplied)
// ---------------------------------------------------------------------------------------
async function checkDaemon() {
  if (!DAEMON) return;
  section('6. daemon 实地探针');
  let health;
  try {
    const res = await fetch(`${DAEMON}/api/health`, {
      headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    health = await res.json();
  } catch (err) {
    record('daemon', 'daemon 可达', 'fail', `${DAEMON} — ${err.message}`);
    return;
  }
  record('daemon', 'daemon 可达', 'ok', `${health.app} ${health.version} pid=${health.pid}`);

  const ext = health.db?.extensions ?? {};
  record('daemon', 'db.tokenizer', ext.tokenizer === 'simple' ? 'ok' : 'fail',
    `${ext.tokenizer}（simple = 中文分词可用；trigram = 双字词搜不到）`);
  record('daemon', 'db.sqliteVec', ext.sqliteVec ? 'ok' : 'warn', String(ext.sqliteVec), false);

  const missing = health.pipeline?.missing ?? null;
  if (missing === null) {
    record('daemon', 'pipeline.missing', 'warn', '/api/health 未报告该字段', false);
  } else {
    record('daemon', 'pipeline.missing', missing.length === 0 ? 'ok' : 'fail',
      missing.length === 0 ? '[]（全部就位）' : JSON.stringify(missing));
  }

  const get = async (p) => {
    const r = await fetch(`${DAEMON}${p}`, {
      headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    return r.json();
  };

  // ---- 档 1：只报"配没配"，不代拿用户的 Key 去试 ----
  try {
    const [{ settings }, { secrets }] = await Promise.all([get('/api/settings'), get('/api/secrets')]);
    const providerId = settings?.['llm.defaultProviderId'] ?? null;
    const hasKey = (secrets ?? []).some((s) => /^llm\..+\.apiKey$/.test(s.key));
    record('daemon', '档 1 在线 LLM 已配置', providerId && hasKey ? 'ok' : 'warn',
      providerId && hasKey
        ? `${providerId} + 已存 Key（★ 只表示配了，未代发请求验证可用性）`
        : `未配置（provider=${providerId ?? '无'} key=${hasKey ? '有' : '无'}）→ F4 思维导图会转 blocked`,
      false);
  } catch (err) {
    record('daemon', '档 1 在线 LLM 已配置', 'warn', `读取失败：${err.message}`, false);
  }

  /*
   * ---- 代理 ----
   *
   * 刻意**不**默认跑 /api/settings/proxy/test：那会真发一次外网请求。
   * 自检必须能在离线环境跑完，否则"没网"会被渲染成"产品坏了"。
   * 默认只读配置；要真连一次，显式加 --proxy-test。
   *
   * 唯一默认就报的，是一条**别处没人会说**的功能性事实：
   * SOCKS 代理下 ffmpeg 不走代理（libavformat 的 http 协议只读 http_proxy，不认 ALL_PROXY）。
   * 配了 SOCKS 的用户会以为"全都走代理了"，直到拉 HLS 直连失败也想不到是这个原因。
   */
  try {
    const px = await get('/api/settings/proxy');
    const mode = px?.config?.mode ?? 'unknown';
    const active = px?.active?.proxy ?? null;
    record('daemon', '代理配置', 'ok',
      `mode=${mode}${active ? ` → ${active}` : ''}（off=直连 / system=继承环境变量 / manual=手填）`, false);

    if (px?.media?.supported === false) {
      record('daemon', '代理覆盖 ffmpeg', 'warn',
        `${px.media.noteZh ?? px.media.reason}（模型下载与站点解析仍走代理，只有 ffmpeg 直连）`, false);
    } else {
      record('daemon', '代理覆盖 ffmpeg', 'ok', '当前代理形态 ffmpeg 可用', false);
    }

    if (PROXY_TEST) {
      const rep = await fetch(`${DAEMON}/api/settings/proxy/test`, {
        method: 'POST',
        headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
        signal: AbortSignal.timeout(30000),
      }).then((r) => r.json());
      const probes = (rep.probes ?? []).map((p) => `${p.target}:${p.result}${p.viaProxy ? '(经代理)' : '(直连)'}`);
      /*
       * 只有 mode=manual 时才算"必需项"。
       * 用户明确填了代理却连不上 = 配置坏了，下载一定会失败，该红。
       * 而 mode=off/system 下探针失败可能只是**这台机器没网** —— 把"离线"渲染成
       * "产品坏了"是另一种谎，所以那种情况只 warn。
       */
      const manual = mode === 'manual';
      record('daemon', '代理实连测试', rep.ok ? 'ok' : manual ? 'fail' : 'warn',
        (probes.join(' ') || '无探针结果') + (manual ? '' : '（未配代理：失败可能只是本机离线）'),
        manual);
    }
  } catch (err) {
    record('daemon', '代理配置', 'warn', `读取失败：${err.message}`, false);
  }
}

// ---------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------
async function main() {
  if (!JSON_OUT) {
    console.log('\x1b[1mOpenMemo 自检\x1b[0m');
    console.log(`  dataDir   ${DATA_DIR}`);
    console.log(`  storeRoot ${STORE_ROOT}`);
    console.log(`  extDir    ${EXT_DIR}`);
  }

  await checkHardware();
  const { pl, tools } = await checkTools();
  await checkModels(pl);
  await checkLlm();
  await checkExtensions();
  await checkDataDirIntegrity();
  await checkEngines(pl, tools);
  await checkDaemon();

  const failures = results.filter((r) => r.status === 'fail' && r.required);
  const warns = results.filter((r) => r.status === 'warn');

  if (JSON_OUT) {
    console.log(JSON.stringify({ dataDir: DATA_DIR, storeRoot: STORE_ROOT, results, ok: failures.length === 0 }, null, 2));
  } else {
    console.log(`\n\x1b[1m结果\x1b[0m  通过 ${results.filter((r) => r.status === 'ok').length} · 警告 ${warns.length} · \x1b[31m失败 ${failures.length}\x1b[0m`);
    for (const f of failures) console.log(`  \x1b[31m✘ ${f.name}\x1b[0m — ${f.detail}`);
    if (failures.length === 0) console.log('  所有必需项通过。');
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('selfcheck crashed:', err);
  process.exit(1);
});
