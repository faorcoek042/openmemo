#!/usr/bin/env node
/**
 * Windows 真机上补齐 D-20 §2.3 三项实测里"解码覆盖面"那一格。
 *
 * ## 这条腿为什么存在
 *
 * `docs/design/D-20-bundled-deps.md` §13 在 Linux 上已经把这件事从"读 configure
 * 参数猜"变成了"真下载、真跑、`volumedetect` 量真实电平"，19/19 全过。但 Windows
 * 那格当时只有"同一个 release tag、同一个 FFmpeg 源码 commit，理论上应该一致"——
 * **那是推断，不是实测**。这个仓库不止一次栽在"小的测过了，就当大的也测过"
 * （`measure-install-phases.mjs` 那次 CUDA 包 677.9 MB vs 4 MB 就是同一个坑）。
 * Windows 与 Linux 是不同的编译目标（不同的文件系统语义、不同的路径分隔符、
 * Defender 实时扫描、GNU vs MSVC 运行库），**测别的平台不能替 Windows 背书**。
 *
 * 判据完全照抄 Linux 那一轮，一条都不放宽：
 *
 *   - 解码覆盖面：`UPLOAD_MEDIA_EXTENSIONS`（从源码 grep，不抄文档）逐个造样本，
 *     判据是 `ffmpeg -af volumedetect` 量出的**真实平均电平**，不是退出码、
 *     不是"文件非空"。
 *   - `-ss`/`-t` 切片、`-protocol_whitelist` 远端取流 + 明文 `http://` 仍被拒、
 *     `ffprobe` 本地与远端 —— 一样都不能少。
 *
 * ## 两份 ffmpeg，用途不同，别搞混
 *
 * - **GPL 构建**：只用来"造样本"——LGPL 构建没有 libx264/libmp3lame/libxvid 这些
 *   编码器，没法造出 mp4/avi 这类样本。**这份二进制的解码结果不计入任何判据。**
 * - **LGPL 构建**：真正被测的对象。上面列的每一条判据全部用它跑。
 *
 * 两份都从 BtbN 与 `vendor/manifests/backends.json` 里 Windows 那条**完全同一个
 * release tag、同一个 FFmpeg 源码 commit** 下载 —— 只是变体不同（gpl / lgpl），
 * 不是随便挑的版本。
 *
 * ## 纪律
 *
 * - 本脚本不改 `vendor/manifests/backends.json`，不改 `packages/pipeline` 任何一行——
 *   它只是从命令行读两个已经下载好的 ffmpeg/ffprobe 路径，跑一遍产品的真实 argv。
 * - 任何一格解不出来就如实报，退出码非零；**不允许因为大多数格式过了就把失败的
 *   那几个悄悄归为"不重要"**——那正是"凑一个好看的结论"。
 */
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const args = process.argv.slice(2);
const argOf = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const GPL_FFMPEG = argOf('--gpl-ffmpeg');
const LGPL_FFMPEG = argOf('--lgpl-ffmpeg');
const LGPL_FFPROBE = argOf('--lgpl-ffprobe');
const WORKDIR = argOf('--workdir', join(REPO_ROOT, '.ffmpeg-lgpl-verify'));
const REMOTE_URL = argOf(
  '--remote-url',
  'https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3',
);

if (GPL_FFMPEG === null || LGPL_FFMPEG === null || LGPL_FFPROBE === null) {
  console.error(
    'usage: ffmpeg-lgpl-verify.mjs --gpl-ffmpeg <path> --lgpl-ffmpeg <path> --lgpl-ffprobe <path> [--workdir <dir>]',
  );
  process.exit(2);
}

const LOCAL_PROTOCOLS = 'file';
const REMOTE_PROTOCOLS = 'https,tls,tcp,crypto,httpproxy';

function run(bin, argv, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, { shell: false, ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
  });
}

/**
 * §1：从源码读白名单，不抄文档 —— 与 Linux 那一轮同一条纪律。
 */
async function readUploadExtensions() {
  const src = await readFile(
    join(REPO_ROOT, 'packages/shared/src/media-extensions.ts'),
    'utf8',
  );
  const m = /export const UPLOAD_MEDIA_EXTENSIONS[^[]*\[([\s\S]*?)\]\);/.exec(src);
  if (m?.[1] === undefined) {
    throw new Error('没能在 media-extensions.ts 里找到 UPLOAD_MEDIA_EXTENSIONS —— 拒绝伪造清单');
  }
  const exts = [...m[1].matchAll(/'(\.[a-z0-9]+)'/g)].map((x) => x[1]);
  if (exts.length === 0) throw new Error('UPLOAD_MEDIA_EXTENSIONS 解析出 0 项 —— 正则大概率过期了');
  return exts;
}

/** 每种扩展名怎么用 GPL 构建造出一个约 2 秒的真实样本（不是同一种编码器套壳）。 */
const RECIPES = {
  '.mp3': (i, o) => ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libmp3lame', o],
  '.m4a': (i, o) => ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', o],
  '.wav': (i, o) => ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'pcm_s16le', o],
  '.flac': (i, o) => ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'flac', o],
  '.ogg': (i, o) => ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libvorbis', o],
  '.opus': (i, o) => ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libopus', o],
  '.aac': (i, o) => ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', o],
  '.wma': (i, o) => ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'wmav2', o],
  '.mp4': (i, o) => [
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=2:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-c:a', 'aac', o,
  ],
  '.m4v': (i, o) => [
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=2:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-c:a', 'aac', o,
  ],
  '.mkv': (i, o) => [
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=2:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-c:a', 'aac', o,
  ],
  '.mov': (i, o) => [
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=2:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-c:a', 'aac', o,
  ],
  '.avi': (i, o) => [
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=2:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libxvid', '-c:a', 'libmp3lame', o,
  ],
  '.webm': (i, o) => [
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=2:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libvpx-vp9', '-c:a', 'libopus', o,
  ],
  '.mpeg': (i, o) => [
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=2:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'mpeg1video', '-c:a', 'mp2', o,
  ],
  '.mpg': (i, o) => [
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=2:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'mpeg2video', '-c:a', 'mp2', o,
  ],
  '.flv': (i, o) => [
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=2:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'flv', '-c:a', 'libmp3lame', o,
  ],
  '.wmv': (i, o) => [
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=2:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'wmv2', '-c:a', 'wmav2', o,
  ],
  '.ts': (i, o) => [
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=2:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-c:a', 'aac', o,
  ],
};

async function generateSample(ext, outPath) {
  const recipe = RECIPES[ext];
  if (recipe === undefined) {
    throw new Error(`没有 ${ext} 的造样本配方 —— 白名单可能新增了扩展名，脚本要跟着补`);
  }
  const argv = ['-y', '-loglevel', 'error', ...recipe(null, outPath)];
  const r = await run(GPL_FFMPEG, argv);
  if (r.code !== 0) throw new Error(`造样本失败 ${ext}: ${r.stderr.slice(0, 500)}`);
}

async function normalize(input, output, opts = {}) {
  const protocols = opts.remote === true ? REMOTE_PROTOCOLS : LOCAL_PROTOCOLS;
  const argv = [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-protocol_whitelist', protocols,
    '-progress', 'pipe:1',
    '-i', input,
    '-vn', '-map', '0:a:0',
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav',
    output,
  ];
  return run(LGPL_FFMPEG, argv);
}

async function slice(input, output) {
  const argv = [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-protocol_whitelist', LOCAL_PROTOCOLS,
    '-ss', '0.000', '-t', '1.000',
    '-i', input,
    '-c:a', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-f', 'wav',
    output,
  ];
  return run(LGPL_FFMPEG, argv);
}

async function probe(input, opts = {}) {
  const protocols = opts.remote === true ? REMOTE_PROTOCOLS : LOCAL_PROTOCOLS;
  const argv = [
    '-v', 'error', '-hide_banner',
    '-protocol_whitelist', protocols,
    '-print_format', 'json', '-show_format', '-show_streams',
    '-i', input,
  ];
  return run(LGPL_FFPROBE, argv);
}

async function volumeDetect(wavPath) {
  const argv = [
    '-nostdin', '-hide_banner', '-i', wavPath,
    '-af', 'volumedetect', '-f', 'null', '-',
  ];
  const r = await run(LGPL_FFMPEG, argv);
  const m = /mean_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(r.stderr);
  if (m?.[1] === undefined) return { ok: false, meanDb: null, raw: r.stderr.slice(0, 300) };
  if (m[1] === '-inf') return { ok: false, meanDb: -Infinity, raw: r.stderr.slice(0, 300) };
  return { ok: true, meanDb: Number(m[1]), raw: '' };
}

async function main() {
  await mkdir(join(WORKDIR, 'samples'), { recursive: true });
  await mkdir(join(WORKDIR, 'out'), { recursive: true });

  const exts = await readUploadExtensions();
  console.log(`UPLOAD_MEDIA_EXTENSIONS（源码实测）：${exts.length} 项 → ${exts.join(' ')}`);

  const results = [];

  for (const ext of exts) {
    const row = { ext, sample: 'pending', normalize: 'pending', meanDb: null, error: null };
    try {
      const samplePath = join(WORKDIR, 'samples', `s${ext}`);
      await generateSample(ext, samplePath);
      row.sample = 'ok';

      const outPath = join(WORKDIR, 'out', `${ext.slice(1)}.wav`);
      const r = await normalize(samplePath, outPath);
      if (r.code !== 0) {
        row.normalize = 'fail';
        row.error = r.stderr.slice(0, 300);
      } else {
        const st = await stat(outPath).catch(() => null);
        if (st === null || st.size === 0) {
          row.normalize = 'fail';
          row.error = 'output file missing/empty';
        } else {
          const vol = await volumeDetect(outPath);
          row.meanDb = vol.meanDb;
          row.normalize = vol.ok ? 'pass' : 'fail(silent)';
        }
      }
    } catch (err) {
      row.normalize = 'fail';
      row.error = String(err?.message ?? err).slice(0, 300);
    }
    console.log(
      `${ext.padEnd(8)} sample=${row.sample.padEnd(4)} normalize=${row.normalize.padEnd(12)} meanDb=${row.meanDb ?? 'n/a'}`,
    );
    results.push(row);
  }

  // sliceWav（-ss/-t）—— 用清单里第一个音频格式的输出样本
  const sliceInput = join(WORKDIR, 'samples', 's.mp3');
  const sliceOutput = join(WORKDIR, 'out', 'sliced.wav');
  let sliceResult = { ok: false, meanDb: null, error: null };
  try {
    const r = await slice(sliceInput, sliceOutput);
    if (r.code !== 0) throw new Error(r.stderr.slice(0, 300));
    const vol = await volumeDetect(sliceOutput);
    sliceResult = { ok: vol.ok, meanDb: vol.meanDb, error: vol.ok ? null : vol.raw };
  } catch (err) {
    sliceResult.error = String(err?.message ?? err).slice(0, 300);
  }
  console.log(`sliceWav (-ss/-t): ${sliceResult.ok ? 'pass' : 'FAIL'} meanDb=${sliceResult.meanDb}`);

  // ffprobe 本地 —— 对已生成的每个样本跑一遍
  const probeResults = [];
  for (const ext of exts) {
    const samplePath = join(WORKDIR, 'samples', `s${ext}`);
    const r = await probe(samplePath);
    let ok = false;
    let info = null;
    try {
      const j = JSON.parse(r.stdout);
      ok = Array.isArray(j.streams) && j.streams.length > 0;
      info = j.streams?.map((s) => `${s.codec_type}:${s.codec_name}`).join(',') ?? null;
    } catch {
      ok = false;
    }
    probeResults.push({ ext, ok, info });
  }
  console.log(
    `ffprobe local: ${probeResults.filter((p) => p.ok).length}/${probeResults.length} passed`,
  );

  // 远端 HTTPS：probe + normalize，都走 REMOTE_PROTOCOLS
  let remoteProbe = { ok: false, error: null };
  let remoteNormalize = { ok: false, meanDb: null, error: null };
  try {
    const r = await probe(REMOTE_URL, { remote: true });
    const j = JSON.parse(r.stdout);
    remoteProbe.ok = Array.isArray(j.streams) && j.streams.length > 0;
  } catch (err) {
    remoteProbe.error = String(err?.message ?? err).slice(0, 300);
  }
  try {
    const remoteOut = join(WORKDIR, 'out', 'remote.wav');
    const r = await normalize(REMOTE_URL, remoteOut, { remote: true });
    if (r.code !== 0) throw new Error(r.stderr.slice(0, 300));
    const vol = await volumeDetect(remoteOut);
    remoteNormalize = { ok: vol.ok, meanDb: vol.meanDb, error: vol.ok ? null : vol.raw };
  } catch (err) {
    remoteNormalize.error = String(err?.message ?? err).slice(0, 300);
  }
  console.log(
    `remote https: probe=${remoteProbe.ok ? 'pass' : 'FAIL'} normalize=${remoteNormalize.ok ? 'pass' : 'FAIL'} meanDb=${remoteNormalize.meanDb}`,
  );

  // 安全回归：明文 http:// 必须被拒
  let httpRejected = false;
  let httpRejectError = null;
  try {
    const httpUrl = REMOTE_URL.replace(/^https:/, 'http:');
    const rejectOut = join(WORKDIR, 'out', 'should-not-exist.wav');
    const r = await normalize(httpUrl, rejectOut, { remote: true });
    const fileExists = await stat(rejectOut).then(() => true, () => false);
    httpRejected = r.code !== 0 && !fileExists;
    httpRejectError = r.stderr.slice(0, 300);
  } catch (err) {
    httpRejectError = String(err?.message ?? err).slice(0, 300);
  }
  console.log(`http:// rejection: ${httpRejected ? 'pass (correctly rejected)' : 'FAIL'}`);

  const allDecodePass = results.every((r) => r.normalize === 'pass');
  const allProbePass = probeResults.every((p) => p.ok);
  const overallOk =
    allDecodePass && allProbePass && sliceResult.ok && remoteProbe.ok && remoteNormalize.ok && httpRejected;

  const summary = {
    platform: 'win32-x64',
    generatedAt: new Date().toISOString(),
    extensions: exts,
    decode: results,
    probeLocal: probeResults,
    sliceWav: sliceResult,
    remoteProbe,
    remoteNormalize,
    httpRejected,
    httpRejectError,
    passCount: results.filter((r) => r.normalize === 'pass').length,
    totalCount: results.length,
    overallOk,
  };
  await writeFile(join(WORKDIR, 'ffmpeg-lgpl-verify-result.json'), JSON.stringify(summary, null, 2));

  // GitHub Step Summary（若在 CI 里跑）
  const md = [
    `# ffmpeg LGPL 解码覆盖面 —— win32-x64`,
    ``,
    `**${summary.passCount}/${summary.totalCount} 扩展名通过**（判据：volumedetect 真实电平非静音，不是退出码/文件非空）`,
    ``,
    `| 扩展名 | 造样本 | 解码 | mean_volume dB |`,
    `| --- | --- | --- | --- |`,
    ...results.map(
      (r) => `| ${r.ext} | ${r.sample} | ${r.normalize} | ${r.meanDb ?? 'n/a'} |`,
    ),
    ``,
    `- sliceWav (-ss/-t): **${sliceResult.ok ? 'pass' : 'FAIL'}**`,
    `- ffprobe local: **${probeResults.filter((p) => p.ok).length}/${probeResults.length}**`,
    `- remote https probe: **${remoteProbe.ok ? 'pass' : 'FAIL'}**`,
    `- remote https normalize: **${remoteNormalize.ok ? 'pass' : 'FAIL'}** (mean_volume=${remoteNormalize.meanDb})`,
    `- http:// rejection: **${httpRejected ? 'pass' : 'FAIL'}**`,
    ``,
    `**总体：${overallOk ? '全部通过' : '⚠️ 至少一项失败，见上表 — 如实报，不淡化'}**`,
  ].join('\n');
  console.log('\n' + md);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' });
  }

  if (!overallOk) {
    console.error('\n至少一项判据没过 —— 退出码非零，如实反映，不允许静默通过。');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
