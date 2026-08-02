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

  for (const [label, path, required] of [
    ['ffmpeg', tools.ffmpeg, true],
    ['ffprobe', tools.ffprobe, true],
    ['whisper-cli', tools.whisperCli, true],
    ['whisper-vad-speech-segments', tools.whisperVad, false],
    ['yt-dlp（可选，GPL）', tools.ytDlp, false],
  ]) {
    const ok = Boolean(path) && (await canExec(path));
    record('tools', label, ok ? 'ok' : required ? 'fail' : 'warn', ok ? path : '未找到', required);
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
  const llm = await pl.listInstalledModels(STORE_ROOT, 'llm');

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
  record('models', 'LLM 模型', llm.length > 0 ? 'ok' : 'warn',
    llm.length > 0 ? llm.join(', ') : '无（F4 思维导图需要 LLM 或云 API Key）', false);
  return { asr, llm };
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
    record('ext', 'libsimple 存在', 'fail', `缺失：${simplePath}（运行 scripts/build-sqlite-ext.sh）`);
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
  await checkExtensions();
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
