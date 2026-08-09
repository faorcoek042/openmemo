#!/usr/bin/env node
/**
 * `e2e-allcomponents-assertions.mjs` 的**变异证明**。
 *
 * ## 为什么这轮非补不可
 *
 * 上一轮（run 31295507733）台账上并排躺着两条红：
 *   · 「目录枚举与清单对得上」  ← **我的判据写错了**（拿总数硬比，差的是 5 个 role=llm）
 *   · 「后端包全部装上了」      ← **真的**（whispercpp 全平台 NOT_FOUND）
 * **两条在输出里长得一模一样**，我差点把第一条当产品缺陷报上去。
 *
 * 分不清"腿看见了"和"腿坏了"的唯一办法，就是给每条判据喂一份**本该让它变红**的输入。
 * 每条判据在这里都要过三关：
 *   ① 真形状的输入必须通过（挡"恒假"）
 *   ② 每个变异体必须被拒（挡"恒真"）
 *   ③ **空集必须报"前提不成立"**，不许报"全都好"——这是本仓反复发作的那一类
 *
 * 用法：`node scripts/ci/selftest-e2e-allcomponents.mjs`（已挂进 `pnpm test:ci-scripts`）
 */
import { strict as assert } from 'node:assert';

import {
  classifyProbeRows,
  collectReleaseRefs,
  driftedPacks,
  kindByExt,
  magicOf,
  tagOf,
} from './e2e-allcomponents-assertions.mjs';

let cases = 0;
let failures = 0;
const say = (s = '') => console.log(s);
function check(name, fn) {
  cases += 1;
  try {
    fn();
    say(`  ✔ ${name}`);
  } catch (e) {
    failures += 1;
    say(`  ✘ ${name}\n      ${e.message.split('\n')[0]}`);
  }
}

const gz = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4]);
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const ggml = (() => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(0x67676d6c, 0);
  return b;
})();

say('── 魔数与后缀');
check('gzip / zip / ggml / GGUF 都认得出来', () => {
  assert.equal(magicOf(gz), 'gzip');
  assert.equal(magicOf(zip), 'zip');
  assert.equal(magicOf(ggml), 'ggml');
  assert.equal(magicOf(Buffer.from('GGUF....')), 'gguf');
});
check('★ 取不到足够字节时是 unknown，不是瞎猜一个', () => {
  assert.equal(magicOf(Buffer.from([0x1f])), 'unknown');
  assert.equal(magicOf(null), 'unknown');
});
check('后缀 → 期望魔数；没有扩展名的裸二进制是 any（不强求）', () => {
  assert.equal(kindByExt('a.tar.gz'), 'gzip');
  assert.equal(kindByExt('a.zip'), 'zip');
  assert.equal(kindByExt('ggml-tiny.bin'), 'ggml');
  assert.equal(kindByExt('m.onnx'), 'onnx-ish');
  assert.equal(kindByExt('yt-dlp'), 'any');
});

/* ── 分类：真形状 + 变异体 ── */

const goodRows = [
  {
    id: 'media-tools-linux-x64',
    file: 'ffmpeg.tar.xz',
    sizeBytes: 100,
    mirrors: [{ host: 'github.com', ok: true, total: 100, gotKind: 'gzip' }],
  },
  {
    id: 'asr/whisper-tiny-q5_1',
    file: 'ggml-tiny-q5_1.bin',
    sizeBytes: 200,
    mirrors: [
      { host: 'huggingface.co', ok: true, total: 200, gotKind: 'ggml' },
      { host: 'hf-mirror.com', ok: true, total: 200, gotKind: 'ggml' },
    ],
  },
];

say('');
say('── 分类：真形状必须通过');
check('真形状：没有不可达 / 没有长度不符 / 只有第一行是 github-only', () => {
  const r = classifyProbeRows(goodRows);
  assert.equal(r.ok, true);
  assert.equal(r.noMirror.length, 0);
  assert.equal(r.sizeMismatch.length, 0);
  assert.equal(r.kindMismatch.length, 0);
  assert.equal(r.githubOnly.length, 1);
  assert.equal(r.githubOnly[0].id, 'media-tools-linux-x64');
});

say('');
say('── 分类：每个变异体都必须被抓出来');
check('★ 变异：某文件所有镜像都不可达（= 用户装不上）→ 进 noMirror', () => {
  const rows = structuredClone(goodRows);
  rows[1].mirrors.forEach((m) => {
    m.ok = false;
  });
  const r = classifyProbeRows(rows);
  assert.equal(r.noMirror.length, 1);
  assert.equal(r.noMirror[0].id, 'asr/whisper-tiny-q5_1');
});
check('★★ 变异：URL 还活着但**换了文件**（长度与清单不符）→ 进 sizeMismatch', () => {
  /*
   * 这一条钉的正是"上游把 asset 换掉而清单没跟上"。
   * 本轮那个 v0.3.0 → 404 是更极端的版本（直接不可达），
   * 而"还在但不是那个文件"更隐蔽 —— 存在性检查会放行。
   */
  const rows = structuredClone(goodRows);
  rows[0].mirrors[0].total = 999;
  const r = classifyProbeRows(rows);
  assert.equal(r.sizeMismatch.length, 1);
  assert.equal(r.sizeMismatch[0].row.id, 'media-tools-linux-x64');
});
check('变异：取回的魔数与后缀对不上 → 进 kindMismatch', () => {
  const rows = structuredClone(goodRows);
  rows[1].mirrors[0].gotKind = 'text/json'; // 多半是拿到了一页 HTML 错误页
  const r = classifyProbeRows(rows);
  assert.equal(r.kindMismatch.length >= 1, true);
});
check('★ 变异：一个镜像都没配 → 也算 noMirror（用户根本无从下载）', () => {
  const rows = structuredClone(goodRows);
  rows[1].mirrors = [];
  const r = classifyProbeRows(rows);
  assert.equal(r.noMirror.length, 1);
});
check('★ 变异：全部只有 github 来源 → githubOnly 覆盖全部（中国用户装不上那一类）', () => {
  const rows = structuredClone(goodRows);
  rows[1].mirrors = [{ host: 'github.com', ok: true, total: 200, gotKind: 'ggml' }];
  const r = classifyProbeRows(rows);
  assert.equal(r.githubOnly.length, 2);
});
check('反向：有非 github 镜像的行**不该**被算进 githubOnly（别把判断修成恒真）', () => {
  const r = classifyProbeRows(goodRows);
  assert.equal(
    r.githubOnly.some((x) => x.id === 'asr/whisper-tiny-q5_1'),
    false,
  );
});

say('');
say('── 前提自检：空集不许报"全都好"');
check('★★ 空数组 → ok=false 且写明"前提不成立"，不是"全部可达"', () => {
  const r = classifyProbeRows([]);
  assert.equal(r.ok, false);
  assert.equal(r.empty, true);
  assert.match(r.reason, /前提不成立/);
});
check('不是数组 → 也要拒（别把类型错误当成空集）', () => {
  assert.equal(classifyProbeRows(null).ok, false);
  assert.equal(classifyProbeRows(undefined).ok, false);
});

say('');
say('── 清单漂移：本轮那个 bug 的一句话诊断');
check('★★ 包内 v0.3.0 / 目录 v0.4.0 → 点名 whispercpp（真实复现）', () => {
  const bundle = {
    'whispercpp-cpu-linux-x64': 'https://github.com/x/y/releases/download/v0.3.0/w.tar.gz',
    'media-tools-linux-x64':
      'https://github.com/BtbN/FFmpeg-Builds/releases/download/auto/f.tar.xz',
  };
  const checkout = {
    'whispercpp-cpu-linux-x64': 'https://github.com/x/y/releases/download/v0.4.0/w.tar.gz',
    'media-tools-linux-x64':
      'https://github.com/BtbN/FFmpeg-Builds/releases/download/auto/f.tar.xz',
  };
  const d = driftedPacks(bundle, checkout);
  assert.equal(d.length, 1);
  assert.equal(d[0].id, 'whispercpp-cpu-linux-x64');
  assert.equal(tagOf(d[0].bundle), 'v0.3.0');
  assert.equal(tagOf(d[0].checkout), 'v0.4.0');
});
check('反向：两边一致时不许报漂移（否则每次都在喊狼来了）', () => {
  const same = { a: 'https://h/releases/download/v1/x' };
  assert.equal(driftedPacks(same, same).length, 0);
});
check('tagOf 取不到时回 "?"，不瞎猜', () => {
  assert.equal(tagOf('https://example.com/plain.tar.gz'), '?');
  assert.equal(tagOf(null), '?');
});

say('');
say('── 只认我们自己的 release（删 release 那条守卫的判据）');
const mixed = [
  {
    id: 'whispercpp-cpu-linux-x64',
    url: 'https://github.com/faorcoek042/openmemo/releases/download/v0.4.0/w.tar.gz',
  },
  {
    id: 'media-tools-linux-x64',
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-x/f.tar.xz',
  },
  { id: 'asr/whisper-tiny', url: 'https://huggingface.co/x/resolve/main/ggml-tiny.bin' },
];
check('★★ 只挑我们自己 release 的地址，并带上 tag', () => {
  const r = collectReleaseRefs(mixed);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'whispercpp-cpu-linux-x64');
  assert.equal(r[0].tag, 'v0.4.0');
});
check('★★ 反向：**上游**的 release 不许被算进来（删不删由不得我们）', () => {
  /*
   * 这一条是本条守卫最容易被写坏的地方：BtbN 的 ffmpeg 也长着
   * `…/releases/download/<tag>/` 的样子。把它算进来，"我能不能删这个 tag"
   * 就会得到一个错误的答案 —— 而且是**偏保守**的错误，看起来还很像对的。
   */
  const r = collectReleaseRefs(mixed);
  assert.equal(
    r.some((x) => x.id === 'media-tools-linux-x64'),
    false,
  );
});
check('★ 空集：没有任何我们自己的 release 地址时回空数组（调用方负责出声）', () => {
  assert.equal(collectReleaseRefs([]).length, 0);
  assert.equal(collectReleaseRefs(null).length, 0);
});
check('换一个 ownerRepo 就该挑出另一批（判据本身没写死本仓）', () => {
  const r = collectReleaseRefs(mixed, 'BtbN/FFmpeg-Builds');
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'media-tools-linux-x64');
});

say('');
say('─'.repeat(74));
if (failures > 0) {
  say(`✘ selftest-e2e-allcomponents：${cases} 条里 ${failures} 条不成立`);
  process.exit(1);
}
say(`✔ selftest-e2e-allcomponents：${cases} 条全部成立`);
