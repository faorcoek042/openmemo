#!/usr/bin/env node
/**
 * `e2e-import-assertions.mjs` 的**变异证明** —— 本机能跑，不需要 daemon、不需要包、
 * 不需要 GitHub。几十毫秒。
 *
 * ## 这份文件为什么存在
 *
 * 因为 import 是 CI 守卫层里**最后一条**没有判据模块、也没有自检的腿：
 *
 * | 腿 | 抽出的判据模块 | 自检 |
 * |---|---|---|
 * | runtime | `e2e-runtime-assertions.mjs` | `selftest-e2e-runtime.mjs` |
 * | browser | `e2e-browser-assertions.mjs` | `selftest-e2e-browser.mjs` |
 * | record  | `e2e-record-assertions.mjs`  | `selftest-e2e-record.mjs` |
 * | notes   | `e2e-notes-assertions.mjs`   | `selftest-e2e-notes.mjs` |
 * | **import** | **（本轮补上）** | **（本轮补上）** |
 *
 * 而"没有判据模块"不是风格问题，是**结构上不可测**：`e2e-import-audit.mjs`
 * 顶层执行、结尾 `process.exit()` ⇒ import 不进来 ⇒ **它那 37 处内联 `fail()`
 * 一条都没法被喂输入**。runtime 腿正是这样让一条判据烂了三周
 * （`/先安装 CPU/` 那条正则，产品改了一次文案它就再也没匹配过任何东西，
 * 而它看起来仍然像一条护栏）。
 *
 * ⚠️ 本腿的风险比 notes 还高一档：它**只在 schedule 与 workflow_dispatch 时跑**，
 * 也就是说判据坏掉的那一天**没有任何一个 PR 会红**，而它守的是章程里的两条主线
 * 功能（F1 链接导入 / F2 本地媒体导入）。
 *
 * ## 每条判据过五关
 *
 *   ① **好输入必须判绿** —— 挡"恒红"。一条恒红的判据和一条恒绿的判据
 *      在门禁上的价值完全相同，都是零；恒红的还更快被人学会无视。
 *   ② **每一条腿各有一个坏输入，必须判红** —— 挡"恒绿"。
 *      判据里 4 个格子只喂 1 个坏输入，只能证明其中 1 格有牙齿；
 *      **抽掉任意一格修法，这一组都要红。**（打 `☑ 独占` 的那些就是为逐格补的。）
 *   ②-bis **`SUBSUMED_LEGS_IMPORT` 的登记还对得上判据源码吗** ——
 *      `leg-coverage.mjs --leg import` 的门禁那一半，秒级。
 *      `[实测 2026-09-06，四条空转全修那一轮]` **20 格 → 17 格有专属坏输入**
 *      （打 `☑ 独占` 的那些就是为补齐它们加的）；剩 3 格删掉之后自检**照样绿** ——
 *      因为②表里那几个坏输入都会被**相邻那一格先判红**，没有用例专门盯着它们。
 *      它们不是空转（缺陷仍会被相邻那格抓住），是**数学上被吞掉**，
 *      理由逐条记在 `SUBSUMED_LEGS_IMPORT` 里。**0 格「删了就崩」** ——
 *      ⚠️ 报覆盖率时**三栏都要念**：只念 17/20 会把"判不了"混进"没覆盖"、
 *      把"没覆盖"混进"有覆盖"，两个方向都失真。
 *      ⚠️ 上一轮是 14 格 / 12 覆盖 —— 格子多出来的 6 个不是"补了用例"，
 *      是**判据真的多了几格**（④ 补的两格 + ② 的两格 + ③ 改写那两格）。
 *   ③ ★ **把判据在内存里退化，看它是不是真的还抓得住** ——
 *      把"修法抽掉之后的那一版"原样写在这里、喂同样的坏输入，
 *      要求**退化版放过、现行版抓住**。②只证明现行版会红，
 *      ③才证明它红的**是真东西**而不是运气。
 *   ④ **契约漂移守卫** —— `.mjs` 拿不到 TS 的类型检查，所以这里对着产品源码
 *      正面核那些字面量（资产角色、上传端点与字段名、adapter id、
 *      Range 的 206/416、job 终态、selfcheck 的散文）。
 *      少了它，判据会静默退回"恒不触发"或"恒红"。
 *   ⑤ **抽的过程中发现的四条空转，有名有姓的桩** ——
 *      判据**没有动**（这一轮是让它可测，不是改它判什么），
 *      但缺口在这里有一条会说话的记录：**修好的那天这几条会红**，
 *      逼出一次显式的"删掉这个桩 + 更新报告"，
 *      而不是让缺口悄悄消失或悄悄留着。
 *
 * 用法：`node scripts/ci/selftest-e2e-import.mjs`（已挂进 `pnpm test:ci-scripts`）
 */
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALL_FIXTURE_KINDS,
  ASSET_ROLES,
  ASSET_STATE_READY,
  GENERIC_MIME,
  H264_ENCODERS,
  JOB_TERMINAL_STATES,
  MIME_BY_EXT,
  LOOPBACK_ADDRESSES,
  REQUIRED_PACK_PREFIXES,
  STATUS_ACCEPTED,
  STATUS_PARTIAL_CONTENT,
  STATUS_RANGE_NOT_SATISFIABLE,
  TOOL_CHECK_PREFIX,
  UPLOAD_ENDPOINT,
  UPLOAD_FILE_FIELD,
  YTDLP_ADAPTER_ID,
  brief,
  buildMultipart,
  checkAnyFixtureBuilt,
  checkAsrModelPicked,
  checkAudio16kFetched,
  checkAudio16kPresent,
  checkDaemonDataDir,
  checkDaemonPidIdentity,
  checkFixtureBuilt,
  checkFixtureHostLoopback,
  checkFetchedByYtdlp,
  checkFullFetch,
  checkH264EncoderAvailable,
  checkHasVideoContract,
  checkImportAccepted,
  checkJobSucceeded,
  checkNoteFetched,
  checkNothingBorrowed,
  checkOriginalAssetReady,
  checkPrefixRange,
  checkRequiredPacksInstalled,
  checkShaRoundTrip,
  checkSuffixRange,
  checkToolUnderStoreRoot,
  checkUnsatisfiableRange,
  checkUploadQueued,
  classifyFetcher,
  classifyInstallAttempt,
  classifyJobPoll,
  classifyToolChecks,
  expectedContentType,
  flattenModelCatalog,
  isUnderRoot,
  isWhisperCppModel,
  missingFixtureKinds,
  modelSizeBytes,
  parseFixtureRange,
  pickH264Encoder,
  pickSmallestWhisperAsr,
  pickVadModels,
  verdictMark,
} from './e2e-import-assertions.mjs';
/*
 * ★ 只取那份**记录**，不跑那个工具 —— 逐格重扫要几十秒，而门禁要的是快速判决。
 *   `leg-coverage.mjs` 刻意不挂进 `test:ci-scripts`（它的名字不以 `selftest-` 开头，
 *   所以 T-163 的全集扫描不会要求它接链）。见那份文件头「为什么它不是门禁」。
 */
import { SUBSUMED_LEGS_IMPORT } from './leg-coverage.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

let cases = 0;
let failures = 0;
const say = (s = '') => console.log(s);
const ok = (name) => {
  cases += 1;
  say(`  ✔ ${name}`);
};
/**
 * 一条失败的**结构化**记录。`kind` 是给 `leg-coverage.mjs` 分档用的 ——
 * 它此前靠匹配报错文本里的中文来认「红的只是记录守卫」，那是在读散文。
 */
const failed = [];
const bad = (name, why, kind = 'assertion') => {
  cases += 1;
  failures += 1;
  failed.push({ name, kind });
  say(`  ✘ ${name}\n      ${why}`);
};

/** 「这份输入必须判绿」。 */
const green = (name, verdict) =>
  verdict.ok ? ok(name) : bad(name, `本该判绿，却红了：${verdict.reason}`);

/**
 * 「这份输入必须判红」。
 *
 * ⚠️ 顺带核 `reasons` 非空：调用方一律写 `for (const r of v.reasons) fail(…)`，
 * 一个 `ok:false` 而 `reasons` 是空数组的判据会让审计**判红却一个字都不打印** ——
 * 那种红没人查得动，等于没有。
 */
const red = (name, verdict) => {
  if (verdict.ok) return bad(name, '本该判红，却绿了 —— 这一格今天是空转的');
  if (!Array.isArray(verdict.reasons) || verdict.reasons.length === 0) {
    return bad(
      name,
      `判红了但 reasons 是空的（reason=${brief(verdict.reason)}）—— 审计会一个字都不打印`,
    );
  }
  return ok(name);
};

/* ══════════════════════════════════════════════════════════════════════════ */
/* 夹具 —— 形状照真实响应逐格来                                                 */
/* ══════════════════════════════════════════════════════════════════════════ */

/** 一份"媒体文件"。4096 B，内容不重复 —— 前缀与后缀切片必须能互相区分开。 */
const MEDIA = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) % 251));
const SIZE = MEDIA.length;
const N = 1024;
const SHA = 'a'.repeat(64);

const okAssets = [
  { role: ASSET_ROLES.original, state: ASSET_STATE_READY, url: '/media/asset/x', bytes: SIZE },
  { role: ASSET_ROLES.audio16k, state: ASSET_STATE_READY, url: '/media/asset/y', bytes: 999 },
];
const origAsset = okAssets[0];
const a16Asset = okAssets[1];

const fullOk = {
  status: 200,
  buf: MEDIA,
  contentLength: String(SIZE),
  acceptRanges: 'bytes',
  contentType: 'audio/mpeg',
  expectContentType: 'audio/mpeg',
};
const prefixOk = {
  status: STATUS_PARTIAL_CONTENT,
  contentRange: `bytes 0-${N - 1}/${SIZE}`,
  buf: MEDIA.subarray(0, N),
  fullBuf: MEDIA,
  n: N,
  size: SIZE,
};
const suffixOk = {
  status: STATUS_PARTIAL_CONTENT,
  buf: MEDIA.subarray(SIZE - N),
  fullBuf: MEDIA,
  n: N,
  size: SIZE,
};

/** `/api/models/catalog` 的形状（groups → variants，role/tags 从组上继承）。 */
const CATALOG_GROUPS = [
  {
    role: 'vad',
    variants: [{ id: 'vad/silero', files: [{ sizeBytes: 2 * 1024 * 1024 }] }],
  },
  {
    role: 'asr',
    variants: [
      {
        id: 'asr/whisper-tiny',
        engines: ['whisper.cpp'],
        files: [{ sizeBytes: 77 * 1024 * 1024 }],
      },
      {
        id: 'asr/whisper-base',
        engines: ['whisper.cpp'],
        files: [{ sizeBytes: 148 * 1024 * 1024 }],
      },
      {
        id: 'asr/sherpa-zipformer',
        engines: ['sherpa-onnx'],
        files: [{ sizeBytes: 40 * 1024 * 1024 }],
      },
    ],
  },
];

const INSTALLED_OK = ['media-tools-linux-x64', 'whispercpp-cpu-linux-x64', 'ytdlp-linux-x64'];

/** `/api/selfcheck` 的 `tool.*` 那一层（散文逐字照 `packages/runtime/src/selfcheck.ts`）。 */
const PATH_PROSE = '/usr/bin/ffmpeg（来自系统 PATH，非本产品安装 —— 用户机器上不一定有）';
const TOOL_CHECKS_CLEAN = [
  { id: 'tool.ffmpeg', status: 'ok', detail: '/store/media-tools/ffmpeg' },
  { id: 'tool.ytDlp', status: 'ok', detail: '/store/ytdlp/yt-dlp' },
  { id: 'ext.chineseSearch', status: 'ok', detail: 'libsimple' },
];
const TOOL_CHECKS_BORROWED = [
  { id: 'tool.ffmpeg', status: 'warn', detail: PATH_PROSE },
  { id: 'tool.ytDlp', status: 'ok', detail: '/store/ytdlp/yt-dlp' },
];

/* ══════════════════════════════════════════════════════════════════════════ */
say('══ selftest-e2e-import ══ e2e-import-assertions.mjs 的变异证明');
say('');
say('── ① 好输入必须判绿（挡"恒红"：一条恒红的判据和一条恒绿的价值同为零）');

green(
  'checkDaemonPidIdentity：pid 相同',
  checkDaemonPidIdentity({ isWindows: false, viaLauncher: true, bodyPid: 42, spawnPid: 42 }),
);
green(
  'checkDaemonDataDir：dataDir 相同',
  checkDaemonDataDir({ bodyDataDir: '/t/a', wantDataDir: '/t/a' }),
);
green('checkJobSucceeded：succeeded', checkJobSucceeded({ state: 'succeeded', text: 'succeeded' }));
green(
  'checkRequiredPacksInstalled：三个包都在',
  checkRequiredPacksInstalled({ installedIds: INSTALLED_OK }),
);
green('checkAsrModelPicked：挑得出', checkAsrModelPicked({ asr: { m: {}, bytes: 1 } }));
green(
  'checkToolUnderStoreRoot：在 storeRoot 底下',
  checkToolUnderStoreRoot({
    found: '/store/media-tools/bin/ffmpeg',
    realFound: '/store/media-tools/bin/ffmpeg',
    storeRoot: '/store',
    name: 'ffmpeg',
    whyNeeded: '造样本',
    platform: 'linux',
  }),
);
green(
  '★ checkToolUnderStoreRoot：storeRoot 用了未归一化的写法（就是那个真伤）',
  checkToolUnderStoreRoot({
    found: 'C:\\x\\models\\media-tools\\ffmpeg.exe',
    realFound: 'C:\\x\\models\\media-tools\\ffmpeg.exe',
    // env 传进来的那种写法：正斜杠、没被 join() 归一化过
    storeRoot: 'C:/x/models',
    name: 'ffmpeg',
    whyNeeded: '造样本',
    platform: 'win32',
  }),
);
green('checkH264EncoderAvailable：探到了', checkH264EncoderAvailable({ encoder: 'libx264' }));
green(
  'checkFixtureBuilt：退 0 且文件在',
  checkFixtureBuilt({ name: 'f2-audio.wav', exitCode: 0, exists: true, stderr: '' }),
);
green('checkAnyFixtureBuilt：造出了 3 个', checkAnyFixtureBuilt({ count: 3 }));
green(
  'checkUploadQueued：202 + 两个 uid',
  checkUploadQueued({ status: STATUS_ACCEPTED, body: { noteUid: 'n', jobUid: 'j' } }),
);
green(
  'checkHasVideoContract：mp4 报 true',
  checkHasVideoContract({ ready: { hasVideo: true }, wantVideo: true, what: 'mp4' }),
);
green(
  'checkHasVideoContract：纯音轨报 false',
  checkHasVideoContract({ ready: { hasVideo: false }, wantVideo: false, what: 'wav' }),
);
green('checkNoteFetched：200', checkNoteFetched({ status: 200, body: {}, noteUid: 'n' }));
green(
  'checkOriginalAssetReady：在 + ready + 有 url',
  checkOriginalAssetReady({ asset: origAsset, noteStatus: 'ready' }),
);
green('checkFullFetch：200 + 非空 + bytes + 长度对', checkFullFetch(fullOk));
green(
  'checkShaRoundTrip：相等',
  checkShaRoundTrip({ expectSha: SHA, gotSha: SHA, expectBytes: SIZE, gotBytes: SIZE }),
);
green(
  'checkShaRoundTrip：expectSha=null ⇒ 本例不比对（F1 走这一支）',
  checkShaRoundTrip({ expectSha: null, gotSha: 'whatever', expectBytes: null, gotBytes: 7 }),
);
green('checkPrefixRange：206 + Content-Range + 字节一致', checkPrefixRange(prefixOk));
green('checkSuffixRange：206 + 尾部字节一致', checkSuffixRange(suffixOk));
green(
  'checkUnsatisfiableRange：416 + Content-Range 对',
  checkUnsatisfiableRange({
    status: STATUS_RANGE_NOT_SATISFIABLE,
    contentRange: `bytes */${SIZE}`,
    expectSize: SIZE,
  }),
);
green('checkAudio16kPresent：在', checkAudio16kPresent({ asset: a16Asset }));
green(
  'checkAudio16kFetched：200 + 非空',
  checkAudio16kFetched({ status: 200, buf: Buffer.alloc(9) }),
);
green(
  'checkImportAccepted（F2b，requireIds=false）：202',
  checkImportAccepted({
    status: STATUS_ACCEPTED,
    body: {},
    requireIds: false,
    what: '传绝对路径被拒',
  }),
);
green(
  'checkImportAccepted（F1，requireIds=true）：202 + 两个 uid',
  checkImportAccepted({
    status: STATUS_ACCEPTED,
    body: { noteUid: 'n', jobUid: 'j' },
    requireIds: true,
    what: '链接导入没排上队',
  }),
);
for (const addr of LOOPBACK_ADDRESSES) {
  green(
    `checkFixtureHostLoopback：解析到 ${addr}`,
    checkFixtureHostLoopback({ host: 'x.test', address: addr }),
  );
}
green(
  'checkFetchedByYtdlp：来了、而且是 yt-dlp',
  checkFetchedByYtdlp({ probeAdapter: YTDLP_ADAPTER_ID, hits: [{ url: '/clip.mp4' }] }),
);
green('checkNothingBorrowed：一个都没借', checkNothingBorrowed({ borrowed: [] }));

/* ── 纯计算那几个的对照组 ─────────────────────────────────────────────────── */
{
  const models = flattenModelCatalog(CATALOG_GROUPS);
  if (models.length === 4) ok('flattenModelCatalog：4 个条目');
  else bad('flattenModelCatalog', `展平后 ${models.length} 个，期望 4`);
  if (models.every((m) => typeof m.role === 'string'))
    ok('flattenModelCatalog：role 从组上继承下来了');
  else bad('flattenModelCatalog', `有条目没继承到 role：${brief(models)}`);

  const asr = pickSmallestWhisperAsr(models);
  if (asr?.m?.id === 'asr/whisper-tiny') ok('pickSmallestWhisperAsr：挑中最小的 whisper-tiny');
  else bad('pickSmallestWhisperAsr', `挑中的是 ${brief(asr?.m?.id)}`);

  const vad = pickVadModels(models);
  if (vad.length === 1 && vad[0].id === 'vad/silero') ok('pickVadModels：挑中 silero');
  else bad('pickVadModels', brief(vad.map((m) => m.id)));
}
{
  const v = classifyJobPoll({
    status: 200,
    body: { job: { jobId: 'J1', state: 'succeeded' } },
    jobId: 'J1',
  });
  if (v.done && v.state === 'succeeded') ok('classifyJobPoll：succeeded 是终态');
  else bad('classifyJobPoll', brief(v));

  const running = classifyJobPoll({
    status: 200,
    body: { job: { jobId: 'J1', state: 'running' } },
    jobId: 'J1',
  });
  if (running.done === false) ok('classifyJobPoll：running ⇒ 接着轮询（不是终态）');
  else bad('classifyJobPoll', `running 被当成终态了：${brief(running)}`);
}
{
  const mp = buildMultipart('a.wav', Buffer.from('BYTES'), { language: 'en' }, 'BOUND');
  const text = mp.body.toString('latin1');
  if (text.includes(`name="${UPLOAD_FILE_FIELD}"; filename="a.wav"`))
    ok(`buildMultipart：文件字段名是 ${UPLOAD_FILE_FIELD}`);
  else bad('buildMultipart', `文件字段名不对：${brief(text.slice(0, 200))}`);
  if (text.includes('name="language"\r\n\r\nen\r\n')) ok('buildMultipart：附带字段在前、CRLF 对');
  else bad('buildMultipart', `附带字段形状不对：${brief(text.slice(0, 200))}`);
  if (text.endsWith('\r\n--BOUND--\r\n')) ok('buildMultipart：结尾 boundary 带两个短横线');
  else bad('buildMultipart', `结尾不对：${brief(text.slice(-40))}`);
  if (mp.contentType === 'multipart/form-data; boundary=BOUND')
    ok('buildMultipart：content-type 带 boundary');
  else bad('buildMultipart', mp.contentType);
  if (mp.body.includes(Buffer.from('BYTES'))) ok('buildMultipart：文件字节原样在里面');
  else bad('buildMultipart', '文件字节丢了');
}
{
  const r = parseFixtureRange('bytes=10-19', 100);
  if (r && r.start === 10 && r.end === 19) ok('parseFixtureRange：bytes=10-19');
  else bad('parseFixtureRange', brief(r));
  const open = parseFixtureRange('bytes=10-', 100);
  if (open && open.start === 10 && open.end === 99) ok('parseFixtureRange：bytes=10- ⇒ 到末尾');
  else bad('parseFixtureRange', brief(open));
  const suf = parseFixtureRange('bytes=-20', 100);
  if (suf && suf.start === 80 && suf.end === 99) ok('parseFixtureRange：bytes=-20 ⇒ 最后 20 字节');
  else bad('parseFixtureRange', brief(suf));
  if (parseFixtureRange(undefined, 100) === null)
    ok('parseFixtureRange：没有 Range 头 ⇒ null（回整个文件）');
  else bad('parseFixtureRange', '没有 Range 头时不该给区间');
}
{
  const c = classifyToolChecks(TOOL_CHECKS_CLEAN);
  if (c.tools.length === 2 && c.own.length === 2 && c.borrowed.length === 0)
    ok('classifyToolChecks（跨腿共用那一份）：干净的机器上 own=2 borrowed=0');
  else
    bad('classifyToolChecks', brief({ t: c.tools.length, o: c.own.length, b: c.borrowed.length }));
}
{
  const missing = missingFixtureKinds({ made: ALL_FIXTURE_KINDS.map((k) => k.name) });
  if (missing.length === 0) ok('missingFixtureKinds：四个都造出来了 ⇒ 不补行');
  else bad('missingFixtureKinds', brief(missing));
}
{
  for (const [ext, mime] of Object.entries(MIME_BY_EXT)) {
    const got = expectedContentType(`f2-sample${ext}`);
    if (got === mime) ok(`expectedContentType：${ext} ⇒ ${mime}`);
    else bad('expectedContentType', `${ext} 期望 ${mime}，实得 ${brief(got)}`);
  }
  if (expectedContentType('f2-sample.MP3') === MIME_BY_EXT['.mp3'])
    ok('expectedContentType：大写扩展名也认（`guessMime()` 也是 toLowerCase 的）');
  else bad('expectedContentType', '大写扩展名没认出来');
  /*
   * ★ 认不出来时回 `null`（= 本例不比对），**不是**回 `GENERIC_MIME`。
   *   回兜底值会把"我们不知道答案"写成一个具体的期望值 ——
   *   那正是把一条没验到的边变成一条恒红断言的做法。
   */
  if (expectedContentType('clip.weird') === null && expectedContentType('noext') === null)
    ok('★ ☑ 独占 expectedContentType：认不出扩展名 ⇒ null（不许凭空写一个期望值）');
  else
    bad(
      'expectedContentType',
      `认不出扩展名时该回 null，实得 ${brief(expectedContentType('clip.weird'))}`,
    );
}
if (
  verdictMark(true) === '✔ 通过' &&
  verdictMark(false) === '✘ 失败' &&
  verdictMark(null) === '⊘ 跳过'
)
  ok('verdictMark：三态各自的记号');
else bad('verdictMark', `${verdictMark(true)} / ${verdictMark(false)} / ${verdictMark(null)}`);

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('── ② 每一格各一个坏输入，必须判红（`☑ 独占` = 为逐格覆盖专门补的那些）');

red(
  'checkDaemonPidIdentity：应答方 pid 不是我 spawn 的那个（就是那次连错进程的事故）',
  checkDaemonPidIdentity({ isWindows: false, viaLauncher: true, bodyPid: 9999, spawnPid: 42 }),
);
green(
  '☑ 独占 checkDaemonPidIdentity：Windows + 经启动器 ⇒ 刻意不比 pid（cmd.exe 的 pid 不是 daemon 的）',
  checkDaemonPidIdentity({ isWindows: true, viaLauncher: true, bodyPid: 9999, spawnPid: 42 }),
);
red(
  '☑ 独占 checkDaemonPidIdentity：Windows 但**没走启动器** ⇒ 照比（豁免只对启动器那一格）',
  checkDaemonPidIdentity({ isWindows: true, viaLauncher: false, bodyPid: 9999, spawnPid: 42 }),
);
red(
  'checkDaemonDataDir：应答方报的是别人的数据目录',
  checkDaemonDataDir({ bodyDataDir: '/tmp/somebody-else', wantDataDir: '/tmp/mine' }),
);
green(
  '☑ 独占 checkDaemonDataDir：老包不发这个字段（undefined）⇒ 放过，不当成"不是我的"',
  checkDaemonDataDir({ bodyDataDir: undefined, wantDataDir: '/tmp/mine' }),
);
red('checkJobSucceeded：failed', checkJobSucceeded({ state: 'failed', text: 'failed — boom' }));
red(
  'checkJobSucceeded：blocked（缺模型/缺工具，永远不会自己好）',
  checkJobSucceeded({ state: 'blocked', text: 'blocked' }),
);
red('checkJobSucceeded：timeout', checkJobSucceeded({ state: 'timeout', text: 'TIMEOUT' }));

/* ── §3 必需包：三格各自一个坏输入 ───────────────────────────────────────── */
for (const r of REQUIRED_PACK_PREFIXES) {
  const without = INSTALLED_OK.filter((id) => !id.startsWith(r.prefix));
  red(
    `checkRequiredPacksInstalled：缺 ${r.prefix}*`,
    checkRequiredPacksInstalled({ installedIds: without }),
  );
}
{
  const v = checkRequiredPacksInstalled({ installedIds: [] });
  if (!v.ok && v.reasons.length === REQUIRED_PACK_PREFIXES.length)
    ok(
      `☑ 独占 checkRequiredPacksInstalled：一个都没装 ⇒ 报 ${v.reasons.length} 条，不是短路成 1 条`,
    );
  else
    bad(
      'checkRequiredPacksInstalled（collect 语义）',
      `期望 ${REQUIRED_PACK_PREFIXES.length} 条理由，实得 ${v.reasons.length}：${brief(v.reasons)}`,
    );
}
{
  // 前缀匹配必须是**前缀**，不是"包含"：`x-ytdlp-linux` 不算装了 `ytdlp-*`。
  red(
    '☑ 独占 checkRequiredPacksInstalled：名字里含 `ytdlp-` 但不是以它开头',
    checkRequiredPacksInstalled({
      installedIds: [
        'media-tools-linux-x64',
        'whispercpp-cpu-linux-x64',
        'vendored-ytdlp-linux-x64',
      ],
    }),
  );
}

/* ── §4 模型 ─────────────────────────────────────────────────────────────── */
red('checkAsrModelPicked：一个都挑不出来', checkAsrModelPicked({ asr: undefined }));
{
  const onlySherpa = flattenModelCatalog([
    {
      role: 'asr',
      variants: [{ id: 'asr/sherpa-x', engines: ['sherpa-onnx'], files: [{ sizeBytes: 1 }] }],
    },
  ]);
  if (pickSmallestWhisperAsr(onlySherpa) === undefined)
    ok('☑ 独占 pickSmallestWhisperAsr：只有 sherpa 的目录里挑不出（引擎那一格真的在筛）');
  else bad('pickSmallestWhisperAsr', 'sherpa 的模型被当成 whisper.cpp 能加载的了');

  const zeroBytes = flattenModelCatalog([
    { role: 'asr', variants: [{ id: 'asr/whisper-tiny', engines: ['whisper.cpp'], files: [] }] },
  ]);
  if (pickSmallestWhisperAsr(zeroBytes) === undefined)
    ok('☑ 独占 pickSmallestWhisperAsr：尺寸未知（files 为空）的不许挑中 —— 它会稳定排在最前面');
  else bad('pickSmallestWhisperAsr', '挑中了一个尺寸未知的条目，那会永远挑中一个下不下来的东西');

  if (isWhisperCppModel({ id: 'asr/whisper-tiny' })) ok('isWhisperCppModel：老目录靠 id 前缀兜底');
  else bad('isWhisperCppModel', '没有 engines 时前缀兜底失效了');
  if (!isWhisperCppModel({ id: 'asr/sherpa-x', engines: ['sherpa-onnx'] }))
    ok('isWhisperCppModel：sherpa 不算');
  else bad('isWhisperCppModel', 'sherpa 被算进来了');
  if (modelSizeBytes({ files: [{ sizeBytes: 2 }, { sizeBytes: 3 }] }) === 5)
    ok('modelSizeBytes：多文件相加');
  else bad('modelSizeBytes', '多文件没相加');
  if (pickVadModels(flattenModelCatalog(CATALOG_GROUPS), 1).length === 0)
    ok('☑ 独占 pickVadModels：超过上限的不要（上限那一格真的在筛）');
  else bad('pickVadModels', '上限没起作用');
}

/* ── §6 ffmpeg 两格 ──────────────────────────────────────────────────────── */
red(
  'checkToolUnderStoreRoot：storeRoot 里找不到（第 1 格）',
  checkToolUnderStoreRoot({
    found: null,
    storeRoot: '/store',
    name: 'ffmpeg',
    whyNeeded: '造样本',
    platform: 'linux',
  }),
);
red(
  '★ ☑ 独占 checkToolUnderStoreRoot：storeRoot 里那个 ffmpeg 是**指向宿主的软链**（⑤-b (a) 修的就是它）',
  checkToolUnderStoreRoot({
    found: '/store/media-tools/bin/ffmpeg',
    realFound: '/usr/bin/ffmpeg',
    storeRoot: '/store',
    name: 'ffmpeg',
    whyNeeded: '造样本',
    platform: 'linux',
  }),
);
red(
  '☑ 独占 checkToolUnderStoreRoot：前缀相同但不是子路径（/store-x vs /store）',
  checkToolUnderStoreRoot({
    found: '/store-x/ffmpeg',
    realFound: '/store-x/ffmpeg',
    storeRoot: '/store',
    name: 'ffmpeg',
    whyNeeded: '造样本',
    platform: 'linux',
  }),
);

/* ── isUnderRoot：③-b 那个真伤的两个平台各一组（`platform` 是入参才测得到） ── */
{
  const cases = [
    ['posix', 'linux', '/store', '/store/a/ffmpeg', true, '正常的子路径'],
    ['posix', 'linux', '/store', '/store', true, '根自己'],
    [
      'posix',
      'linux',
      '/store',
      '/store-x/ffmpeg',
      false,
      '★ 前缀相同但不是子路径（startsWith 会答错）',
    ],
    ['posix', 'linux', '/store', '/usr/bin/ffmpeg', false, '完全在别处'],
    ['posix', 'linux', '/store/', '/store/a/ffmpeg', true, '根带尾斜杠'],
    [
      'win32',
      'win32',
      'C:/x/models',
      'C:\\x\\models\\a\\ffmpeg.exe',
      true,
      '★★ 就是那个真伤：env 给正斜杠、join 给反斜杠',
    ],
    [
      'win32',
      'win32',
      'C:\\x\\models',
      'C:\\x\\models-old\\ffmpeg.exe',
      false,
      'Windows 上的前缀相同但不是子路径',
    ],
    ['win32', 'win32', 'C:\\x\\models', 'D:\\ffmpeg.exe', false, '另一个盘'],
  ];
  for (const [flavor, platform, root, cand, want, why] of cases) {
    const got = isUnderRoot(root, cand, platform);
    if (got === want) ok(`isUnderRoot[${flavor}]：${why}`);
    else
      bad(
        `isUnderRoot[${flavor}]`,
        `${why} —— 期望 ${want}，实得 ${got}（root=${root} cand=${cand}）`,
      );
  }
  /*
   * ★ **平台必须是入参**（照 `isWithinImportRoots` 的原修法）：
   *   同一份输入在两个平台上答案不同 —— 这一条正面证明 platform 真的在起作用。
   *   写死 `process.platform` 的话，这个 bug 在本机 Linux 上**测不出来**，
   *   而它恰恰只在 Windows 上显形。
   */
  const winAnswer = isUnderRoot('C:/x/models', 'C:\\x\\models\\ffmpeg.exe', 'win32');
  const posixAnswer = isUnderRoot('C:/x/models', 'C:\\x\\models\\ffmpeg.exe', 'linux');
  if (winAnswer === true && posixAnswer === false)
    ok('★ isUnderRoot：platform 是入参，同一份输入两个平台答案不同（本机就能把 Windows 那半测到）');
  else
    bad(
      'isUnderRoot 的 platform 入参',
      `win32=${winAnswer} posix=${posixAnswer} —— 期望 true/false。两边一样说明 platform 没起作用`,
    );
}

/* ── §7 造样本 ───────────────────────────────────────────────────────────── */
for (const name of H264_ENCODERS) {
  const listed = `V....D ${name}             H.264 encoder`;
  if (pickH264Encoder(listed) === name) ok(`pickH264Encoder：探到 ${name}`);
  else bad('pickH264Encoder', `${name} 没被探到`);
}
if (pickH264Encoder('V....D libvpx-vp9  VP9') === null)
  ok('pickH264Encoder：两个都不在场 ⇒ null（不硬凑一个会失败的 spec）');
else bad('pickH264Encoder', '不在场时凭空挑了一个');
if (pickH264Encoder('V....D libx264rgb   H.264 rgb') === null)
  ok('☑ 独占 pickH264Encoder：只有 libx264rgb 时不许挑中 libx264（词边界那一格）');
else bad('pickH264Encoder', '`\\b` 没起作用 —— 会挑中一个这份二进制里不存在的编码器名');
red('checkH264EncoderAvailable：两个都不在', checkH264EncoderAvailable({ encoder: null }));
red(
  'checkFixtureBuilt：ffmpeg 非零退出',
  checkFixtureBuilt({
    name: 'f2-video.mp4',
    exitCode: 1,
    exists: false,
    stderr: 'Unknown encoder',
  }),
);
red(
  '☑ 独占 checkFixtureBuilt：**退 0 但文件没写出来**（只看退出码会漏掉这一种）',
  checkFixtureBuilt({ name: 'f2-video.mp4', exitCode: 0, exists: false, stderr: '' }),
);
red('checkAnyFixtureBuilt：一个都没造出来', checkAnyFixtureBuilt({ count: 0 }));
{
  const missing = missingFixtureKinds({ made: ['f2-audio.wav'] });
  if (missing.length === 3 && missing.every((k) => k.name !== 'f2-audio.wav'))
    ok('missingFixtureKinds：只造出 1 个 ⇒ 补 3 行（没编码器那种缺法不会凭空消失）');
  else bad('missingFixtureKinds', brief(missing.map((k) => k.name)));
}

/* ── §9 上传 ─────────────────────────────────────────────────────────────── */
red(
  'checkUploadQueued：HTTP 400',
  checkUploadQueued({ status: 400, body: { error: { code: 'BAD_REQUEST' } } }),
);
red(
  '☑ 独占 checkUploadQueued：202 但没有 noteUid',
  checkUploadQueued({ status: STATUS_ACCEPTED, body: { jobUid: 'j' } }),
);
red(
  '☑ 独占 checkUploadQueued：202 但没有 jobUid（拿不到 jobUid 就没法轮询）',
  checkUploadQueued({ status: STATUS_ACCEPTED, body: { noteUid: 'n' } }),
);
red(
  'checkHasVideoContract：mp4 却报 hasVideo=false（就是那个写死 false 的缺陷）',
  checkHasVideoContract({ ready: { hasVideo: false }, wantVideo: true, what: 'mp4' }),
);
red(
  '☑ 独占 checkHasVideoContract：纯音轨却报 true（反方向也要有牙齿）',
  checkHasVideoContract({ ready: { hasVideo: true }, wantVideo: false, what: 'wav' }),
);
{
  const v = checkHasVideoContract({ ready: null, wantVideo: true, what: 'mp4' });
  if (v.ok === false && v.undecided === true)
    ok('checkHasVideoContract：收不到事件 ⇒ 第三态 undecided（**不是**通过；审计侧的缺口见 ⑤-a）');
  else bad('checkHasVideoContract', `收不到事件时应当是第三态，实得 ${brief(v)}`);
}

/* ── §8 播放判据本体 ─────────────────────────────────────────────────────── */
red(
  'checkNoteFetched：404',
  checkNoteFetched({ status: 404, body: { error: { code: 'NOTE_NOT_FOUND' } }, noteUid: 'n' }),
);
red(
  'checkOriginalAssetReady：没有 original 资产（媒体没落库）',
  checkOriginalAssetReady({ asset: undefined, noteStatus: 'ready' }),
);
red(
  '☑ 独占 checkOriginalAssetReady：资产在但 state=pending（有一行、文件还没到位）',
  checkOriginalAssetReady({ asset: { ...origAsset, state: 'pending' }, noteStatus: 'ready' }),
);
red(
  '☑ 独占 checkOriginalAssetReady：ready 但没有 url（网页拿不到播放地址）',
  checkOriginalAssetReady({ asset: { ...origAsset, url: undefined }, noteStatus: 'ready' }),
);
red('checkFullFetch：HTTP 500', checkFullFetch({ ...fullOk, status: 500 }));
red(
  '☑ 独占 checkFullFetch：200 但 0 字节（有记录、没有可播放的内容）',
  checkFullFetch({ ...fullOk, buf: Buffer.alloc(0), contentLength: '0' }),
);
red(
  '☑ 独占 checkFullFetch：没有 Accept-Ranges（播放器无法拖动进度条）',
  checkFullFetch({ ...fullOk, acceptRanges: null }),
);
red(
  '☑ 独占 checkFullFetch：Content-Length 与实收不符',
  checkFullFetch({ ...fullOk, contentLength: String(SIZE + 1) }),
);
red(
  '★ ☑ 独占 checkFullFetch：Content-Type 是 application/octet-stream（⑤-c 补的那格）',
  checkFullFetch({ ...fullOk, contentType: GENERIC_MIME }),
);
red(
  '☑ 独占 checkFullFetch：mp3 却发成了 video/mp4（发了、但发错）',
  checkFullFetch({ ...fullOk, contentType: 'video/mp4' }),
);
red(
  '☑ 独占 checkFullFetch：根本没有 Content-Type 头（这一格对 F1 那条 null 路径也生效）',
  checkFullFetch({ ...fullOk, contentType: null, expectContentType: null }),
);
green(
  '☑ 独占 checkFullFetch：expectContentType=null ⇒ 不比对具体值（F1 走这一支）',
  checkFullFetch({ ...fullOk, contentType: 'video/webm', expectContentType: null }),
);
{
  const v = checkFullFetch({
    status: 500,
    buf: Buffer.alloc(0),
    contentLength: '7',
    acceptRanges: null,
    contentType: null,
    expectContentType: 'audio/mpeg',
  });
  /*
   * ⚠️ 期望的是 **5** 不是 6：最后一格（具体值对不对）在 `contentType` 为 null 时
   *    也不成立，但它与"头缺失"那格说的是同一件事的两个层次 —— 这里数的是
   *    **真的会打印出来的行数**，写死一个"格子总数"会在加格子的那天变成一句假话。
   *    这条用例钉的是 `collect` 语义（不短路），不是格子的个数。
   */
  const wantAll = 6;
  if (!v.ok && v.reasons.length === wantAll)
    ok(`☑ 独占 checkFullFetch（collect 语义）：六格全坏 ⇒ 报 ${wantAll} 条，不是短路成 1 条`);
  else
    bad(
      'checkFullFetch（collect 语义）',
      `期望 ${wantAll} 条理由，实得 ${v.reasons.length}：${brief(v.reasons)}`,
    );
}
red(
  '★ checkShaRoundTrip：sha 不符（同时否掉"文件丢了"/"截断了"/"偏移算错了"）',
  checkShaRoundTrip({ expectSha: SHA, gotSha: 'b'.repeat(64), expectBytes: SIZE, gotBytes: SIZE }),
);
red('checkPrefixRange：拿到 200 而不是 206', checkPrefixRange({ ...prefixOk, status: 200 }));
red(
  '☑ 独占 checkPrefixRange：Content-Range 的 total 写成了切片长度',
  checkPrefixRange({ ...prefixOk, contentRange: `bytes 0-${N - 1}/${N}` }),
);
red(
  '★ ☑ 独占 checkPrefixRange：头对、字节错位一格（偏移算错了 —— 只有逐字节比对分得开）',
  checkPrefixRange({ ...prefixOk, buf: MEDIA.subarray(1, N + 1) }),
);
red(
  '☑ 独占 checkPrefixRange：只回了半截（长度不对）',
  checkPrefixRange({ ...prefixOk, buf: MEDIA.subarray(0, N - 1) }),
);
red('checkSuffixRange：拿到 200 而不是 206', checkSuffixRange({ ...suffixOk, status: 200 }));
red(
  '★ ☑ 独占 checkSuffixRange：206 但回的是**开头** N 字节（`bytes=-N` 那条分支算错了）',
  checkSuffixRange({ ...suffixOk, buf: MEDIA.subarray(0, N) }),
);
red(
  'checkUnsatisfiableRange：越界却回 206',
  checkUnsatisfiableRange({
    status: STATUS_PARTIAL_CONTENT,
    contentRange: `bytes */${SIZE}`,
    expectSize: SIZE,
  }),
);
red(
  'checkUnsatisfiableRange：越界却回 200（把整个文件又发了一遍）',
  checkUnsatisfiableRange({ status: 200, contentRange: null, expectSize: SIZE }),
);
red(
  '★ ☑ 独占 checkUnsatisfiableRange：416 对、但 Content-Range 里的总长写错了（⑤-c 补的那格）',
  checkUnsatisfiableRange({
    status: STATUS_RANGE_NOT_SATISFIABLE,
    contentRange: `bytes */${SIZE + 999}`,
    expectSize: SIZE,
  }),
);
red(
  '☑ 独占 checkUnsatisfiableRange：416 对、但根本没发 Content-Range',
  checkUnsatisfiableRange({
    status: STATUS_RANGE_NOT_SATISFIABLE,
    contentRange: null,
    expectSize: SIZE,
  }),
);
green(
  '☑ 独占 checkUnsatisfiableRange：expectSize=null ⇒ 退回只钉状态码（没有调用点这样传）',
  checkUnsatisfiableRange({
    status: STATUS_RANGE_NOT_SATISFIABLE,
    contentRange: 'bytes */whatever',
  }),
);
red('checkAudio16kPresent：没有这份资产', checkAudio16kPresent({ asset: undefined }));
red('checkAudio16kFetched：404', checkAudio16kFetched({ status: 404, buf: Buffer.alloc(0) }));
red(
  '☑ 独占 checkAudio16kFetched：200 但 0 字节',
  checkAudio16kFetched({ status: 200, buf: Buffer.alloc(0) }),
);

/* ── §10 / §11 导入入口 ──────────────────────────────────────────────────── */
red(
  'checkImportAccepted（F2b）：403 PATH_NOT_ALLOWED',
  checkImportAccepted({
    status: 403,
    body: { error: { code: 'PATH_NOT_ALLOWED' } },
    requireIds: false,
    what: '传绝对路径被拒',
  }),
);
red(
  '☑ 独占 checkImportAccepted（F1）：202 但没有 uid —— requireIds 那一格真的在管',
  checkImportAccepted({
    status: STATUS_ACCEPTED,
    body: {},
    requireIds: true,
    what: '链接导入没排上队',
  }),
);
green(
  '☑ 独占 checkImportAccepted（F2b）：同一份输入在 requireIds=false 下放过（两处不对称，逐字保留）',
  checkImportAccepted({
    status: STATUS_ACCEPTED,
    body: {},
    requireIds: false,
    what: '传绝对路径被拒',
  }),
);
red(
  'checkFixtureHostLoopback：解析不到（workflow 那条 hosts 步骤坏了）',
  checkFixtureHostLoopback({ host: 'x.test', address: null }),
);
red(
  '☑ 独占 checkFixtureHostLoopback：解析到了，但是个**公网**地址（那就真出网了）',
  checkFixtureHostLoopback({ host: 'x.test', address: '93.184.216.34' }),
);
red(
  'checkFetchedByYtdlp：一个请求都没收到（第 1 格）',
  checkFetchedByYtdlp({ probeAdapter: null, hits: [] }),
);
red(
  '★ ☑ 独占 checkFetchedByYtdlp：**有人取了，但不是 yt-dlp**（⑤-d 修的就是它）',
  checkFetchedByYtdlp({ probeAdapter: 'direct-http', hits: [{}, {}] }),
);
red(
  '☑ 独占 checkFetchedByYtdlp：取了，但 adapterId 这个字段没了（恒 null）',
  checkFetchedByYtdlp({ probeAdapter: null, hits: [{}] }),
);
{
  if (parseFixtureRange('bytes=200-', 100)?.unsatisfiable === true)
    ok('parseFixtureRange：start 越界 ⇒ 416');
  else bad('parseFixtureRange', 'start 越界没回 416');
  const clip = parseFixtureRange('bytes=0-999', 100);
  if (clip && clip.end === 99)
    ok('☑ 独占 parseFixtureRange：end 超过总长 ⇒ 夹到 total-1（不许多发字节）');
  else bad('parseFixtureRange', `end 没被夹住：${brief(clip)}`);
  if (parseFixtureRange('bytes=abc', 100) === null)
    ok(
      '☑ 独占 parseFixtureRange：形状不认识 ⇒ null，不是当成 0-（不许把垃圾 Range 读成整文件请求以外的东西）',
    );
  else bad('parseFixtureRange', '认了一个不合法的 Range');
}
{
  const f = classifyFetcher({ probeAdapter: YTDLP_ADAPTER_ID, hits: [{}, {}] });
  if (f.kind === 'ytdlp' && f.hits === 2) ok('classifyFetcher：adapterId=yt-dlp 且被取过 ⇒ ytdlp');
  else bad('classifyFetcher', brief(f));
  const other = classifyFetcher({ probeAdapter: 'direct-http', hits: [{}] });
  if (other.kind === 'other') ok('classifyFetcher：不是 yt-dlp ⇒ other（⚠️ 审计侧不判它，见 ⑤-d）');
  else bad('classifyFetcher', brief(other));
  const none = classifyFetcher({ probeAdapter: null, hits: [] });
  if (none.kind === 'none') ok('classifyFetcher：一个请求都没有 ⇒ none');
  else bad('classifyFetcher', brief(none));
}

/* ── §12 借宿主 ──────────────────────────────────────────────────────────── */
{
  const c = classifyToolChecks(TOOL_CHECKS_BORROWED);
  red(
    `checkNothingBorrowed：借了 ${c.borrowed.length} 个`,
    checkNothingBorrowed({ borrowed: c.borrowed }),
  );
}

/* ── 轮询：那三条"不是我要的 job" ────────────────────────────────────────── */
{
  const httpErr = classifyJobPoll({ status: 503, body: {}, jobId: 'J1' });
  if (httpErr.done && httpErr.state === 'error') ok('classifyJobPoll：HTTP 非 200 ⇒ error');
  else bad('classifyJobPoll', brief(httpErr));

  const wrong = classifyJobPoll({
    status: 200,
    body: { job: { jobId: 'J-OTHER', state: 'succeeded' } },
    jobId: 'J1',
  });
  if (wrong.done && wrong.state === 'error')
    ok(
      '★ ☑ 独占 classifyJobPoll：端点返回**别人的 job** 且它 succeeded ⇒ 判 error，不是"我成功了"',
    );
  else bad('classifyJobPoll', `拿到别人的成功被当成自己的：${brief(wrong)}`);

  const blocked = classifyJobPoll({
    status: 200,
    body: { job: { jobId: 'J1', state: 'blocked', blockedCode: 'NO_ASR_MODEL' } },
    jobId: 'J1',
  });
  if (blocked.done && blocked.state === 'blocked' && blocked.text.includes('NO_ASR_MODEL'))
    ok('☑ 独占 classifyJobPoll：blocked 当场说清楚（不是轮询到 TIMEOUT）');
  else bad('classifyJobPoll', brief(blocked));

  for (const st of JOB_TERMINAL_STATES) {
    const v = classifyJobPoll({
      status: 200,
      body: { job: { uid: 'J1', state: st } },
      jobId: 'J1',
    });
    if (v.done && v.state === st) ok(`classifyJobPoll：终态 ${st}（uid 这个别名也认）`);
    else bad('classifyJobPoll', `${st}: ${brief(v)}`);
  }
}
{
  const succeeded = classifyInstallAttempt({ state: 'succeeded', job: {}, attempt: 1 });
  const lastTry = classifyInstallAttempt({
    state: 'failed',
    job: { error: { retryable: true } },
    attempt: 2,
  });
  const notRetry = classifyInstallAttempt({
    state: 'failed',
    job: { error: { code: 'DISK_FULL', retryable: false } },
    attempt: 1,
  });
  const retry = classifyInstallAttempt({
    state: 'failed',
    job: { error: { code: 'PROVIDER_UNREACHABLE', retryable: true } },
    attempt: 1,
  });
  if (succeeded === 'done') ok('classifyInstallAttempt：成功 ⇒ done');
  else bad('classifyInstallAttempt', succeeded);
  if (lastTry === 'done') ok('☑ 独占 classifyInstallAttempt：第 2 次也失败 ⇒ done（不无限重试）');
  else bad('classifyInstallAttempt', lastTry);
  if (notRetry === 'not-retryable')
    ok('★ ☑ 独占 classifyInstallAttempt：DISK_FULL / retryable:false ⇒ 一次都不重试');
  else bad('classifyInstallAttempt', `retryable:false 被重试了：${notRetry}`);
  if (retry === 'retry') ok('classifyInstallAttempt：产品标了 retryable ⇒ 重试一次');
  else bad('classifyInstallAttempt', retry);
}

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('── ②-bis 「删了也绿」那几格的登记还对得上吗（`leg-coverage.mjs --leg import` 的门禁那一半）');

/*
 * ②只保证「每条判据至少有一个坏输入」。更强的那个问题是「**判据里的每一格**
 * 是不是都有一个只有它会响的输入」——把那一格删掉，②还红不红？
 *
 * 那个问题由 `scripts/ci/leg-coverage.mjs --leg import` 回答（手动跑，逐格删了再跑本文件）。
 *
 * ★ 这一段是那个工具的**门禁那一半**，秒级：`SUBSUMED_LEGS_IMPORT` 里每条 `needle`
 *   必须在判据源码里**恰好出现一次**。
 *
 * ⚠️ 它**不是豁免名单**。名单里记的不是"这几格不用管"，是"这几格为什么被吞掉"，
 * 而且每一条都是**可核对的事实**（源码里恰好一处）。
 *
 * ⚠️ 这一节的失败带 `kind: 'subsumed-record'` —— `leg-coverage.mjs` 靠**那个字段**
 * （不是靠匹配这句中文）把「记录守卫在响」与「有一个坏输入在响」分开。
 * 措辞随便改，判决不受影响；**但那个 kind 不许改**，改了那边会把记录守卫读成覆盖率。
 */
{
  const src = readFileSync(join(REPO, 'scripts', 'ci', 'e2e-import-assertions.mjs'), 'utf8');
  /*
   * 地板：这份记录被清空的样子，和"全都补上专属坏输入了"一模一样。
   * 真补齐了请连这条地板一起改（并重跑 `--leg import` 更新报告里那三栏数字）。
   */
  assert.ok(
    SUBSUMED_LEGS_IMPORT.length >= 3,
    `SUBSUMED_LEGS_IMPORT 只剩 ${SUBSUMED_LEGS_IMPORT.length} 条 —— 少于 3 条时多半是这份记录被清空了`,
  );
  for (const leg of SUBSUMED_LEGS_IMPORT) {
    const hits = src.split(leg.needle).length - 1;
    if (hits === 1) {
      ok(`②-bis 登记对得上：\`${leg.needle.slice(0, 48)}…\``);
    } else {
      bad(
        `SUBSUMED_LEGS 对不上判据源码：\`${leg.needle.slice(0, 60)}\``,
        `源码里 ${hits} 处（期望恰好 1 处）—— 这一格被改/删/复制了。\n` +
          `      它原本是「删了也绿」的那几格之一，理由是：${leg.why}\n` +
          '      请重跑 `node scripts/ci/leg-coverage.mjs --leg import`，并更新 SUBSUMED_LEGS_IMPORT。',
        /*
         * ★ `kind` 是给 `leg-coverage.mjs` 分档的**结构信号**：这条红来自
         *   **记录守卫**（它正在逐格删格子，所以这条必然响），不是来自任何一个坏输入。
         *   它此前靠匹配上面那句中文来认，`[实测]` 因此把一格误记过。
         */
        'subsumed-record',
      );
    }
  }
  // 前提检查：拿一个必不存在的 needle 过一遍，证明上面那组不是恒真
  if (src.includes(`must(definitely_not_a_real_leg_${Date.now()})`))
    bad('②-bis 的前提检查', '不可能的 needle 竟然命中了 —— 这组守卫是恒真的');
  else ok('②-bis 的前提检查：不存在的 needle 确实匹配不到（上面那组不是恒真）');
}

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('── ③ ★ 把判据在内存里退化 —— 退化版必须放过②抓住的那些（否则②红得是运气）');

/*
 * ②只证明「现行判据对这些输入会红」。它证不了「现行判据比退化版更强」——
 * 一个 `() => ({ok:false})` 也能让②全绿。所以这里把**修法抽掉之后的那一版**
 * 原样写出来，喂同样的坏输入：**退化版必须放它过去**。
 * 两条一起才说明现行判据抓到的是真东西。
 */
function degraded(name, weakFn, strongFn, input, why) {
  const weak = weakFn(input);
  const strong = strongFn(input);
  if (!strong.ok && weak.ok) {
    ok(`★ ${name}：退化版放过、现行版抓住 —— ${why}`);
  } else if (strong.ok) {
    bad(`★ ${name}`, `**现行判据自己就放过去了**：这一格今天是空转的。${why}`);
  } else {
    bad(
      `★ ${name}`,
      `退化版也把它判红了 —— 说明我抄的"退化版"不是真的退化版，这条对照什么都没证明`,
    );
  }
}

/* ③-a 播放判据退化成「数据库里有一行就算过」—— 这条腿存在的全部理由 */
const playableIsRowInDb = ({ status }) => ({ ok: status === 200, reason: '', reasons: [] });
degraded(
  'sha256 往返 vs "数据库里有一行"',
  () => playableIsRowInDb({ status: 200 }),
  checkShaRoundTrip,
  { expectSha: SHA, gotSha: 'b'.repeat(64), expectBytes: SIZE, gotBytes: 12 },
  '归档时把文件截断了：记录在、HTTP 200、字节不对。"有一行"的判据对它全绿',
);

/* ③-b 前缀 Range 退化成「只看状态码 + Content-Range」（不比字节） */
const prefixHeadersOnly = ({ status, contentRange, n, size }) => ({
  ok: status === STATUS_PARTIAL_CONTENT && contentRange === `bytes 0-${n - 1}/${size}`,
  reason: '',
  reasons: [],
});
degraded(
  '前缀 Range 逐字节比对 vs 只看头',
  prefixHeadersOnly,
  checkPrefixRange,
  { ...prefixOk, buf: MEDIA.subarray(1, N + 1) },
  '偏移算错一格：206 对、Content-Range 也自洽（服务端按自己算的值填的），只有字节不对',
);

/* ③-c 后缀 Range 退化成「只看状态码」 */
const suffixStatusOnly = ({ status }) => ({
  ok: status === STATUS_PARTIAL_CONTENT,
  reason: '',
  reasons: [],
});
degraded(
  '后缀 Range 比字节 vs 只看 206',
  suffixStatusOnly,
  checkSuffixRange,
  { ...suffixOk, buf: MEDIA.subarray(0, N) },
  '`bytes=-N` 那条分支算成了"开头 N 字节"：拖到结尾播不出，而状态码一直是 206',
);

/* ③-d 整体 GET 退化成「只看 200」 */
const fullStatusOnly = ({ status }) => ({ ok: status === 200, reason: '', reasons: [] });
degraded(
  '整体 GET 四格 vs 只看 200',
  fullStatusOnly,
  checkFullFetch,
  { ...fullOk, buf: Buffer.alloc(0), contentLength: '0' },
  '200 + 0 字节：有记录但没有可播放的内容，而"只看 200"对它全绿',
);

/* ③-e job 轮询退化成「只看 state」（不核 jobId）—— 那个名字被写错过三次 */
const pollIgnoringId = ({ status, body }) => {
  const job = body?.job ?? body;
  return { ok: status === 200 && job?.state === 'succeeded', reason: '', reasons: [] };
};
degraded(
  'job 轮询核 jobId vs 只看 state',
  pollIgnoringId,
  (i) => {
    const v = classifyJobPoll(i);
    return { ok: v.done && v.state === 'succeeded', reason: v.text ?? '', reasons: [v.text ?? ''] };
  },
  { status: 200, body: { job: { jobId: 'J-OTHER', state: 'succeeded' } }, jobId: 'J1' },
  '端点回了**别人的** job 且它成功了 —— 不核 id 的那一版会把别人的成功读成自己的',
);

/* ③-f original 资产退化成「有这一行就算」（不看 state） */
const assetExistsOnly = ({ asset }) => ({ ok: !!asset, reason: '', reasons: [] });
degraded(
  'original 资产核 state vs 只看有没有这一行',
  assetExistsOnly,
  checkOriginalAssetReady,
  {
    asset: { role: ASSET_ROLES.original, state: 'missing', url: '/media/asset/x' },
    noteStatus: 'ready',
  },
  'state=missing：媒体文件不在了，而"有这一行"的判据对它全绿 —— 正是本腿要否掉的第一种形态',
);

/* ③-g 借宿主判据退化成「反正 selfcheck 回了 200 就算干净」 */
const borrowedAlwaysClean = () => ({ ok: true, reason: '', reasons: [] });
degraded(
  '借宿主判据 vs "回了 200 就算干净"',
  borrowedAlwaysClean,
  checkNothingBorrowed,
  { borrowed: classifyToolChecks(TOOL_CHECKS_BORROWED).borrowed },
  '真的借了宿主 ffmpeg：selfcheck 照样 200，只有 warn+散文那一档说得出来',
);

/*
 * ③-h H.264 探测退化成「包含即可」（丢掉词边界）。
 *
 * ⚠️ 比的是**审计那一步的判决**（"这台机器上有没有可用的 H.264 编码器"），
 *    不是 `pickH264Encoder` 的返回值本身 —— 后者不是 `{ok}` 形状，
 *    硬套一个 `{ok}` 会让这条对照证明的是我临时编的那个谓词，不是判据。
 */
const pickByIncludes = (listed) => H264_ENCODERS.find((n) => String(listed).includes(n)) ?? null;
degraded(
  'H.264 探测的词边界 vs 只做 includes',
  (listed) => checkH264EncoderAvailable({ encoder: pickByIncludes(listed) }),
  (listed) => checkH264EncoderAvailable({ encoder: pickH264Encoder(listed) }),
  'V....D libx264rgb   H.264 rgb',
  '只有 libx264rgb 的构建：`includes` 会挑中一个这份二进制里**不存在**的编码器名，' +
    '于是这一步绿灯放行，ffmpeg 在下一步当场 `Unknown encoder` —— ' +
    '而那句报错读起来像"造样本失败"，不像"探测器瞎了"',
);

/* ③-i ★ 第三态 vs「收不到就算过」（⑤-a 修的那条） */
const hasVideoTreatMissingAsPass = ({ ready, wantVideo }) =>
  ready
    ? { ok: ready.hasVideo === wantVideo, reason: 'x', reasons: ['x'] }
    : { ok: true, reason: '', reasons: [] };
{
  const input = { ready: null, wantVideo: true, what: 'mp4' };
  const weak = hasVideoTreatMissingAsPass(input);
  const strong = checkHasVideoContract(input);
  if (weak.ok && strong.ok === false && strong.undecided === true)
    ok(
      '★ hasVideo 第三态 vs "收不到就算过"：退化版判绿、现行版判**未决** —— ' +
        'SSE 事件名改一个字，退化版会让这条契约悄悄没有读者',
    );
  else
    bad(
      '★ hasVideo 第三态',
      `退化版 ok=${weak.ok}、现行版 ok=${strong.ok}/undecided=${strong.undecided} —— ` +
        '期望「退化版绿、现行版未决」。现行版若判绿，这一格今天还是空转的',
    );
}

/* ③-j ★ 断"哪个适配器" vs 断"有没有人来取"（⑤-d 修的那条） */
const fetchedByAnyone = ({ hits }) => ({
  ok: (hits ?? []).length > 0,
  reason: 'x',
  reasons: ['x'],
});
degraded(
  '取回方判据 vs "有没有人来取"',
  fetchedByAnyone,
  checkFetchedByYtdlp,
  { probeAdapter: 'direct-http', hits: [{}, {}] },
  'DirectHttp 去取也让 fixtureHits 涨 —— 只问"有没有人"的那一版对它全绿，' +
    '而这条腿自称验的是**站点解析器那一支**',
);

/* ③-k ★ relative() vs startsWith()（⑤-b 那个真伤，Windows 那一面） */
const underRootByStartsWith = ({ storeRoot, realFound }) => ({
  ok: String(realFound).startsWith(String(storeRoot)),
  reason: 'x',
  reasons: ['x'],
});
degraded(
  'isUnderRoot vs startsWith（Windows 上那个真伤）',
  ({ storeRoot, realFound }) => {
    const v = underRootByStartsWith({ storeRoot, realFound });
    // 退化版这里"红"的方向是反的：它把一个**在** storeRoot 里的文件判成借宿主的。
    return { ok: !v.ok, reason: 'x', reasons: ['x'] };
  },
  ({ storeRoot, realFound, platform }) => ({
    ok: !isUnderRoot(storeRoot, realFound, platform),
    reason: 'x',
    reasons: ['x'],
  }),
  { storeRoot: 'C:/x/models', realFound: 'C:\\x\\models\\ffmpeg.exe', platform: 'win32' },
  '★ env 传进来的未归一化 storeRoot：`startsWith` 说"不在里面"（于是审计报「借宿主的」），' +
    '而它就在 storeRoot 里 —— 这是**守卫说假话**，不是产品坏了',
);

/* ③-l ★ 逐格比 Content-Type vs 只看"有没有这个头" */
const contentTypeExistsOnly = ({ contentType }) => ({
  ok: typeof contentType === 'string' && contentType.length > 0,
  reason: 'x',
  reasons: ['x'],
});
degraded(
  'Content-Type 逐字比 vs 只看头在不在',
  contentTypeExistsOnly,
  checkFullFetch,
  { ...fullOk, contentType: GENERIC_MIME },
  '有人"顺手把 media_assets.mime 补上真值"（上传那条路的 multipart 里写的就是 ' +
    'application/octet-stream）⇒ mp3 变得不可播，而 HTTP 全程 200、头也在',
);

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('── ④ 契约漂移守卫：那些字面量在产品源码里还在不在（`.mjs` 拿不到类型检查）');

/**
 * 一条契约守卫 + 它的**前提检查**。
 *
 * ⚠️ 每一条后面都跟一条「不可能的字面量必须匹配不到」：少了它，一个读错文件、
 * 或者 `includes` 拿到空串的守卫会**恒真** —— 而恒真的守卫失效时看起来和从没有过一样。
 */
const readSrc = (rel) => {
  try {
    return readFileSync(join(REPO, rel), 'utf8');
  } catch (e) {
    bad(`④ 读不到 ${rel}`, `契约守卫读不到产品源码，这一组全部无效：${e.message}`);
    return '';
  }
};
function contract(name, src, needle, why) {
  if (src.includes(needle)) ok(`④ ${name}：\`${needle}\` 还在`);
  else bad(`④ ${name}`, `产品源码里找不到 \`${needle}\` —— ${why}`);
  const impossible = `__openmemo_impossible_${name.replace(/\W/g, '')}__`;
  if (src.includes(impossible))
    bad(`④ ${name} 的前提检查`, '不可能的字面量竟然命中了 —— 这条守卫是恒真的');
}

{
  const notesTs = readSrc('packages/shared/src/notes.ts');
  contract(
    '资产角色 original',
    notesTs,
    `'${ASSET_ROLES.original}',`,
    '角色改名 ⇒ 找不到资产 ⇒ 判据恒红，而它红的话会指向产品',
  );
  contract('资产角色 audio16k', notesTs, `'${ASSET_ROLES.audio16k}',`, '同上');
  contract(
    '资产状态 ready',
    notesTs,
    `MEDIA_ASSET_STATES = ['pending', '${ASSET_STATE_READY}', 'missing', 'failed']`,
    "四格之一改了 ⇒ `state === 'ready'` 恒假（`notes.ts` 里记着这个形状栽过一次）",
  );
}
{
  const uploadTs = readSrc('apps/web/src/features/capture/upload.ts');
  contract(
    '上传端点',
    uploadTs,
    `UPLOAD_ENDPOINT = '${UPLOAD_ENDPOINT}'`,
    'F2 的全部价值在于"走网页真正走的那条路"，端点漂了就不是那条路了',
  );
  contract(
    'multipart 文件字段名',
    uploadTs,
    `form.append('${UPLOAD_FILE_FIELD}', file, file.name)`,
    '字段名对不上 ⇒ daemon 400 ⇒ 表现成"上传坏了"，而坏的是夹具',
  );
}
{
  const typesTs = readSrc('packages/pipeline/src/media/types.ts');
  contract(
    'yt-dlp 适配器 id',
    typesTs,
    `'${YTDLP_ADAPTER_ID}'`,
    '这个字面量改名 ⇒ `classifyFetcher` 恒回 other ⇒ F1 那句"走的是站点解析器"永远说不出口',
  );
}
{
  const mediaTs = readSrc('apps/daemon/src/http/media.ts');
  contract(
    'Range 206',
    mediaTs,
    `res.writeHead(${STATUS_PARTIAL_CONTENT}, {`,
    '产品不再发 206 的话这条腿该红',
  );
  contract(
    'Range 416',
    mediaTs,
    `res.writeHead(${STATUS_RANGE_NOT_SATISFIABLE}, { 'Content-Range': \`bytes */\${size}\``,
    '⚠️ 顺带钉住：产品**确实**在 416 上发了 Content-Range，而判据没在看它（见 ⑤-c）',
  );
  contract('Accept-Ranges', mediaTs, `'Accept-Ranges': 'bytes'`, '播放器拖进度条靠它');
  /*
   * ★ Content-Type 那条链：`/media` 发的是 `asset.mime ?? guessMime(abs)`，
   *   而 `media_assets.mime` 对 original **刻意是 NULL** ⇒ 实际发的就是扩展名判出来的那个。
   *   这里逐格核 `MIME_BY_EXT`（本腿四种样本用得到的那几格），
   *   少了它，`expectedContentType()` 会静默给出一个产品早就不发的期望值 ⇒ **恒红**。
   */
  contract(
    'Content-Type 由 mime 或 guessMime 给',
    mediaTs,
    'asset.mime ?? guessMime(abs)',
    '这条链断了 Content-Type 那两格就无从谈起',
  );
  for (const [ext, mime] of Object.entries(MIME_BY_EXT)) {
    contract(`MIME_BY_EXT ${ext}`, mediaTs, `'${ext}': '${mime}'`, `扩展名判定漂了 ⇒ 期望值恒红`);
  }
  contract(
    'guessMime 的兜底值',
    mediaTs,
    `?? '${GENERIC_MIME}'`,
    '★ 它是"认不出扩展名"的样子，也是"有人把 multipart 里那行字写进库"的样子 —— 浏览器不播它',
  );
  contract(
    '★ media_assets.mime 对 original 刻意是 NULL',
    readSrc('apps/daemon/src/jobs/runners/transcribe.ts'),
    '`mime` **刻意不填**',
    '这条判断被推翻的那天，Content-Type 那一格的期望值来源要跟着改（那正是它守的失败面）',
  );
}
{
  const jobsTs = readSrc('packages/shared/src/jobs.ts');
  contract(
    'job 终态三格',
    jobsTs,
    `TERMINAL_JOB_STATES: readonly JobState[] = ['${JOB_TERMINAL_STATES.join("', '")}']`,
    '终态集合漂了 ⇒ `classifyJobPoll` 会一直轮询到 TIMEOUT，报"超时"而不是"失败"',
  );
  contract('job 的 blocked 那一档', jobsTs, `'blocked',`, 'blocked 没了的话那一支恒不触发');
}
{
  const eventsTs = readSrc('apps/daemon/src/jobs/events.ts');
  contract(
    'media.ready 事件名',
    eventsTs,
    `makeEvent('media.ready'`,
    '★ 事件名改了 ⇒ 审计的 `mediaReady` 永远是空的 ⇒ hasVideo 那条契约再也没有读者（见 ⑤-a）',
  );
  contract(
    'hasVideo 契约字段',
    eventsTs,
    'hasVideo: boolean;',
    '它此前是写死的 false，本腿是它唯一的读者',
  );
}
{
  const selfcheckTs = readSrc('packages/runtime/src/selfcheck.ts');
  contract(
    'selfcheck 的 tool.* 前缀',
    selfcheckTs,
    `'${TOOL_CHECK_PREFIX}ffmpeg'`,
    `前缀漂了 ⇒ \`${TOOL_CHECK_PREFIX}*\` 一项都挑不出来 ⇒ "借了几个"恒为 0 而**审计不 fail**`,
  );
  contract(
    '🔴 借宿主那一档靠的**散文**',
    selfcheckTs,
    '（来自系统 PATH，非本产品安装 —— 用户机器上不一定有）',
    '★ 这句话改一个词 ⇒ `borrowed` 恒为 0 ⇒ **一个真的在借宿主 ffmpeg 的包会全绿通过 F1/F2**',
  );
}
{
  const argGuardTs = readSrc('packages/pipeline/src/subprocess/argGuard.ts');
  contract(
    'SSRF 防线还在',
    argGuardTs,
    'isPrivateOrReservedHost',
    'F1 整节的论证建立在"产品会拒掉回环"上；它没了的话那段长注释就不再成立',
  );
}
{
  /*
   * ★ 接线守卫：审计**真的**在用这些判据。
   *
   * 少了它，有人把 `e2e-import-audit.mjs` 里的调用改回内联 `if`，
   * 本文件仍然一片绿 —— 而它证明的会是一个没有任何调用方的模块。
   * 这正是 `check:orphans` 那道门治的病，只不过它不扫 `scripts/`。
   */
  const auditSrc = readSrc('scripts/ci/e2e-import-audit.mjs');
  contract(
    '审计 import 了判据模块',
    auditSrc,
    "} from './e2e-import-assertions.mjs';",
    '判据模块没有调用方 ⇒ 本文件证明的是一个死模块',
  );
  for (const fn of [
    'checkShaRoundTrip(',
    'checkPrefixRange(',
    'checkSuffixRange(',
    'classifyJobPoll(',
    // ↓ 这一轮四条修法的接线，逐条钉住（拆掉任何一条，⑤ 那边也会红，两处互为备份）
    'checkHasVideoContract(',
    'checkFetchedByYtdlp(',
    'checkToolUnderStoreRoot(',
    'checkUnsatisfiableRange(',
    'expectedContentType(',
  ]) {
    contract(`审计真的调用了 ${fn})`, auditSrc, fn, '这一条判据被换回内联了');
  }
  const inlineFails = auditSrc
    .split('\n')
    .filter((l) => /^\s+fail\(/.test(l) && !l.includes('.reason'));
  if (inlineFails.length <= 6) {
    ok(`④ 内联 fail() 的地板：还剩 ${inlineFails.length} 处不走判据模块（抽不动的那几处，见报告）`);
  } else {
    bad(
      '④ 内联 fail() 的地板',
      `还有 ${inlineFails.length} 处内联 fail() 不走判据模块（本轮收敛到 ≤6）：\n      ` +
        inlineFails.map((l) => l.trim().slice(0, 90)).join('\n      '),
    );
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('── ⑤ 那四条空转的桩 —— 已经**翻了个面**：从「缺口仍在」变成「修法仍在」');

/*
 * ## 桩为什么留着（Manager 2026-09-06 裁决逐字：「桩保留,别删」）
 *
 * #98 抽判据时抓到四条「把修法抽掉它也不红」，当时一条都没改，各留一个
 * **会说话的桩**：缺口修好的那天它们会红，逼出一次显式的「删桩 + 更新报告」。
 * 这一轮四条全修了 —— 于是四个桩**按设计红了**，现在按设计走完最后一步：
 * 不是删掉，是**掉个头**。
 *
 * 从今天起它们钉的是「**修法还在不在**」：
 *   · 谁把三态改回二态、把 `adapterId` 从判决里拿掉、把 `relative()` 换回
 *     `startsWith`、把补上的两格删掉 —— 这里当场红。
 *   · 而它们红的那句话会把人领回**那条空转当初长什么样**，
 *     不是一句干巴巴的"断言失败"。
 *
 * ⚠️ 判据钉的是**结构**（判据源码里那几个字面量在不在），不是"注释里提没提过"。
 *    这一整轮抓的就是「注释声称一件从没发生的事」，桩自己不能是那个形状。
 */
{
  const audit = readSrc('scripts/ci/e2e-import-audit.mjs');
  const assertions = readSrc('scripts/ci/e2e-import-assertions.mjs');
  const stub = (id, fixStillThere, what, ifItGoesRed) => {
    if (fixStillThere) ok(`⑤-${id} 修法仍在：${what}`);
    else
      bad(
        `⑤-${id} 修法**被拆掉了**`,
        `${what}\n      这条缺口当初的样子：${ifItGoesRed}\n` +
          '      → 要么把修法放回去，要么这是一次有意的判决变更 —— 那就连同这个桩一起改，' +
          '并更新 `e2e-import-assertions.mjs` 里对应的 `## ✅ 已修` 段。',
      );
  };

  stub(
    'a',
    assertions.includes('undecided: true') &&
      audit.includes('const undecideds = []') &&
      audit.includes('if (hv.undecided)') &&
      audit.includes('undecided(`F2:${fx.name}`') &&
      audit.includes('JSON.stringify({ unknowns: undecideds.length }'),
    '`media.ready` 收不到 ⇒ **第三态**，进 `undecideds`、进 `--undecided-out` 那份计数，' +
      '总表那一行也改成 ⊘ —— 不是绿，也不是红（收不到可能是真的未决）。',
    '那一支曾经**只 say 不 fail**，`ok` 保持 true ⇒ 总表照旧「✔ 通过」，' +
      '而注释写着「收不到就如实说收不到，不当成通过」。SSE 事件名改一个字，' +
      'hasVideo 这条契约就再也没有读者，且没有任何东西会红。',
  );

  stub(
    'b',
    assertions.includes('export function isUnderRoot(root, candidate, platform') &&
      assertions.includes('p.relative(p.resolve(String(root)), real)') &&
      !assertions.includes('String(found).startsWith(String(storeRoot))') &&
      audit.includes('realpathSync') &&
      audit.includes('realFound: REAL_FFMPEG'),
    '两件事都修了：(b) 前缀比对换成 `isUnderRoot()`（`relative()` + `platform` 入参 +' +
      ' 两边 resolve，照 `apps/daemon/src/http/rest/notes.ts` 的 `isWithinImportRoots` 原修法）；' +
      '(a) 判据改吃 **realpath 之后**的路径，于是"storeRoot 里放一个指向宿主的软链"这种' +
      '真实的"借宿主的"形态它真的抓得住。',
    '老写法 `found.startsWith(storeRoot)`：`findUnder(storeRoot, …)` 结构上只返回' +
      ' storeRoot 底下的路径 ⇒ 恒真、一次都不可能红；而它真响起来那天说的是假话' +
      '（Windows 上 env 传进来的未归一化 storeRoot ⇒ 报「借宿主的」而它就在 storeRoot 里）。',
  );

  stub(
    'c',
    assertions.includes('expectContentType === null || contentType === expectContentType') &&
      assertions.includes('contentRange === `bytes */${expectSize}`') &&
      audit.includes('expectedContentType(fx.name)') &&
      audit.includes('expectSize: size'),
    '文档里那两格补上了：② 的 Content-Type（按扩展名给期望值，镜像 `media.ts` 的' +
      ' `MIME_BY_EXT`）与 ⑥ 的 `416 + Content-Range: bytes */<size>`。',
    '`ctype` 曾经**只被 `say()` 打印**、416 只比状态码 —— 而 `assertPlayable()` 的' +
      '文档从第一天起就写着这两格。产品两处**都做对了**，是守卫没在看。',
  );

  stub(
    'd',
    assertions.includes('export function checkFetchedByYtdlp') &&
      assertions.includes("f.kind === 'ytdlp'") &&
      audit.includes('checkFetchedByYtdlp({ probeAdapter, hits: fixtureHits })') &&
      audit.includes('if (!fetchedBy.ok) {') &&
      !assertions.includes('export function checkFixtureWasFetched'),
    '`adapterId` 进判决了：断的是**哪个适配器**（`kind === \'ytdlp\'`），不是"有没有人来取"。' +
      '弱的那个入口（`checkFixtureWasFetched`）被第一格原样吸收后删掉 ——' +
      '留着它等于给调用方留一条退回空转的路。',
    '此前唯一会红的是"一个请求都没收到"，而 **`fixtureHits > 0` 只证明「有人」取过' +
      "（DirectHttp 去取也满足它）**；`adapterId` 不是 yt-dlp 时只 `say('ⓘ …')`。" +
      '于是 fallback 链一变，F1 仍然全绿，而 workflow 那句「验到了 yt-dlp 那一段」成了假话。',
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
/**
 * ★ **机器可读的判决**（`--verdict-out <file>`）—— 给 `leg-coverage.mjs` 用。
 *
 * ## 为什么这个文件必须存在（2026-09-06 裁决）
 *
 * 那个工具此前判「这一格删了会不会崩」靠的是**对整段输出做正则**
 * （`/SyntaxError|ReferenceError|…/`），判「红的是不是只有记录守卫」靠的是
 * **匹配一句中文**。`[实测]` 我在一条 `why` 说明里写了一次 `Type` + `Error` 拼起来的词，
 * 它当场把那一格从「没覆盖」错记成「判不了」——
 * **守卫自己在读散文**，与这一整轮在猎的是同一个病。
 *
 * 所以判决改成结构化的：本文件把 `{ cases, failures, failed[] }` 落盘，
 * 每条失败带一个 `kind`。`leg-coverage.mjs` 读这份 JSON：
 *
 *   · 文件**不存在** ⇒ 这次跑压根没走到这里 ⇒ `broke`（崩了，什么都没证明）
 *   · `failures === 0` 而退出码非 0（或反过来）⇒ 账对不上 ⇒ 同样算 `broke`
 *   · 全部失败的 `kind` 都是 `subsumed-record` ⇒ 红的只是记录守卫，**不算覆盖**
 *
 * 三条都不看一个字的散文。
 */
{
  const at = process.argv.indexOf('--verdict-out');
  if (at >= 0 && process.argv[at + 1]) {
    writeFileSync(
      process.argv[at + 1],
      `${JSON.stringify({ cases, failures, failed }, null, 2)}\n`,
    );
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('─'.repeat(78));
if (failures === 0) {
  say(`✔ selftest-e2e-import：${cases} 条断言全部通过`);
  say('  （⑤ 那四条桩现在钉的是「**修法仍在**」—— 谁把修法拆掉，那四条当场红。）');
} else {
  say(`✘ selftest-e2e-import：${cases} 条里 ${failures} 条失败`);
}
assert.equal(failures, 0, `${failures} 条自检失败`);
