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
 *      `[实测 2026-09-06，本 PR]` **14 格 → 12 格有专属坏输入**（打 `☑ 独占` 的那些
 *      就是为补齐它们加的）；剩 2 格删掉之后自检**照样绿** —— 因为②表里那两个坏输入
 *      都会被**相邻那一格先判红**，没有用例专门盯着它们。它们不是空转
 *      （缺陷仍会被相邻那格抓住），是**数学上被吞掉**，理由逐条记在
 *      `SUBSUMED_LEGS_IMPORT` 里。**0 格「删了就崩」** ——
 *      ⚠️ 报覆盖率时**三栏都要念**：只念 12/14 会把"判不了"混进"没覆盖"、
 *      把"没覆盖"混进"有覆盖"，两个方向都失真。
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
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALL_FIXTURE_KINDS,
  ASSET_ROLES,
  ASSET_STATE_READY,
  H264_ENCODERS,
  JOB_TERMINAL_STATES,
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
  checkFixtureWasFetched,
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
  flattenModelCatalog,
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
const bad = (name, why) => {
  cases += 1;
  failures += 1;
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
    storeRoot: '/store',
    name: 'ffmpeg',
    whyNeeded: '造样本',
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
  'checkUnsatisfiableRange：416',
  checkUnsatisfiableRange({ status: STATUS_RANGE_NOT_SATISFIABLE }),
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
  'checkFixtureWasFetched：收到过请求',
  checkFixtureWasFetched({ hits: [{ url: '/clip.mp4' }] }),
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
  }),
);
red(
  '☑ 独占 checkToolUnderStoreRoot：找到了但不在 storeRoot 底下（第 2 格 —— 见 ⑤-b，今天不可达）',
  checkToolUnderStoreRoot({
    found: '/usr/bin/ffmpeg',
    storeRoot: '/store',
    name: 'ffmpeg',
    whyNeeded: '造样本',
  }),
);

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
{
  const v = checkFullFetch({
    status: 500,
    buf: Buffer.alloc(0),
    contentLength: '7',
    acceptRanges: null,
  });
  if (!v.ok && v.reasons.length === 4)
    ok('☑ 独占 checkFullFetch（collect 语义）：四格全坏 ⇒ 报 4 条，不是短路成 1 条');
  else
    bad(
      'checkFullFetch（collect 语义）',
      `期望 4 条理由，实得 ${v.reasons.length}：${brief(v.reasons)}`,
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
  checkUnsatisfiableRange({ status: STATUS_PARTIAL_CONTENT }),
);
red(
  'checkUnsatisfiableRange：越界却回 200（把整个文件又发了一遍）',
  checkUnsatisfiableRange({ status: 200 }),
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
red('checkFixtureWasFetched：一个请求都没收到', checkFixtureWasFetched({ hits: [] }));
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
 * ⚠️ 报错措辞与 notes 腿逐字相同（`SUBSUMED_LEGS 对不上判据源码`）：
 * `leg-coverage.mjs` 靠这句话把「记录守卫在响」与「有一个坏输入在响」分开，
 * 换个措辞会让它把记录守卫读成覆盖率（那正是它自己踩过的坑）。
 */
{
  const src = readFileSync(join(REPO, 'scripts', 'ci', 'e2e-import-assertions.mjs'), 'utf8');
  /*
   * 地板：这份记录被清空的样子，和"全都补上专属坏输入了"一模一样。
   * 真补齐了请连这条地板一起改（并重跑 `--leg import` 更新报告里那三栏数字）。
   */
  assert.ok(
    SUBSUMED_LEGS_IMPORT.length >= 2,
    `SUBSUMED_LEGS_IMPORT 只剩 ${SUBSUMED_LEGS_IMPORT.length} 条 —— 少于 2 条时多半是这份记录被清空了`,
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
say('── ⑤ 抽的过程中发现的**四条空转**，有名有姓的桩（判据没动 —— 本轮是让它可测）');

/*
 * ⚠️ 这几个桩钉的是**缺口存在**，不是"缺口是对的"。
 *    修好的那天它们会红，逼出一次显式的「删桩 + 更新报告」，
 *    而不是让缺口悄悄消失（下一个人再也看不出这里曾经有过一个洞）
 *    或者悄悄留着（没有任何东西会提起它）。
 */
{
  const audit = readSrc('scripts/ci/e2e-import-audit.mjs');
  const assertions = readSrc('scripts/ci/e2e-import-assertions.mjs');
  const stub = (id, stillBroken, what, howToFix) => {
    if (stillBroken) ok(`⑤-${id} 缺口仍在（登记有效）：${what}`);
    else
      bad(
        `⑤-${id} 缺口**已经被修了**`,
        `${what}\n      修法应当是：${howToFix}\n` +
          '      → 请删掉这个桩、更新 `e2e-import-assertions.mjs` 里对应的注释与报告。',
      );
  };

  stub(
    'a',
    audit.includes(
      '   ⚠️ 没收到 media.ready（noteUid=${up.body.noteUid}）—— hasVideo 本例未验证',
    ) &&
      !audit.includes(
        'fail(`F2:${fx.name}`, hv.reason);\n      ok = false;\n    } else if (hv.undecided)',
      ),
    '`media.ready` 收不到时**只 say 不 fail**（`hv.undecided` 那一支），总表照旧「✔ 通过」——' +
      ' 而那一段的注释写着「收不到就如实说收不到，不当成通过」。SSE 事件名改一个字，' +
      'hasVideo 这条契约就再也没有读者，且没有任何东西会红。',
    '把 `hv.undecided` 那一支接进 `fail()`（或接进 `--undecided` 那条管道）',
  );

  stub(
    'b',
    assertions.includes('String(found).startsWith(String(storeRoot))'),
    '`checkToolUnderStoreRoot` 的第二格今天**不可能红**：`findUnder(storeRoot, …)` 在结构上' +
      '只会返回 storeRoot 底下的路径。而它真的响起来的那天说的是假话 ——' +
      '`OPENMEMO_MODELS` 走 env 那一支时没被 `join` 归一化过，Windows 上前缀比对会当场为假' +
      '（`apps/daemon/src/http/rest/notes.ts` 记着的同一个坑，出现在守卫这一侧）。',
    '删掉第二格，或改成 `resolve()` 之后再比（`relative()` 不以 `..` 开头）',
  );

  stub(
    'c',
    !assertions.includes('contentType,\n      expect.ct') && !audit.includes('ctype !== '),
    '`assertPlayable()` 的文档列了七格，其中**两格只在注释里存在**：' +
      '② 的「Content-Type 对」（`ctype` 只被 `say()` 打印）与 ⑥ 的「416 + Content-Range」' +
      '（只比了状态码）。产品两处**都做对了**，是守卫没在看。',
    '给 `checkFullFetch` 补一格 content-type、给 `checkUnsatisfiableRange` 补一格 Content-Range',
  );

  stub(
    'd',
    audit.includes("} else if (fetcher.kind === 'ytdlp') {") &&
      !audit.includes("fetcher.kind !== 'ytdlp'"),
    '`adapterId` 被测量、被打印，但**从来不进判决**：§11 里唯一会红的是"一个请求都没收到"。' +
      'registry 的 fallback 链变了（或这个字段改名 ⇒ 恒为 null），F1 仍然全绿，' +
      '而 workflow 与审计文件头里那句「验到了 yt-dlp 那一段」从那天起是假话。' +
      '`fixtureHits > 0` 只证明了**有人**去取过 —— DirectHttp 去取也满足它。',
    "把 `fetcher.kind !== 'ytdlp'` 接进 `fail()`",
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
say('');
say('─'.repeat(78));
if (failures === 0) {
  say(`✔ selftest-e2e-import：${cases} 条断言全部通过`);
  say('  （⑤ 那四条桩是**缺口仍在**的记录，不是通过的功劳 —— 修好的那天它们会红。）');
} else {
  say(`✘ selftest-e2e-import：${cases} 条里 ${failures} 条失败`);
}
assert.equal(failures, 0, `${failures} 条自检失败`);
