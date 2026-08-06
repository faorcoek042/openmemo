#!/usr/bin/env node
/**
 * 把「只有一个真实来源」的模型文件下载下来、**逐字节校验**，产出一份可以挂到我们自己
 * release 上的镜像集。
 *
 * ## 为什么这件事必须在 CI 上做，而不是在开发机上
 *
 * `[实测 2026-08-06，本开发机]`：
 *
 * ```
 * getent hosts huggingface.co   →  2001::c085:4d85   （只有 IPv6，且是个到不了的地址）
 * TCP 443 huggingface.co        →  连不上/超时
 * hf-mirror.com                 →  连得上，但对该路径回 308 → huggingface.co
 * ```
 *
 * 也就是说**这台机器根本取不到这些文件**，自然也就无从复算 sha256。
 * 而「没复算过的摘要不许进 release」是硬条件。→ 下载与校验一律在干净 runner 上做，
 * 产物走 artifact 交出去。这与本仓一贯的判据是同一条：
 * **开发机上的"能用"不算证据，那台机器恰恰是最不该信的一台。**
 *
 * ## 为什么镜像一份钉死的 blob 没有同步负担
 *
 * 这些 URL 全部钉在**不可变引用**上（HuggingFace 的 40 位 commit sha），清单里还有 sha256。
 * 所以镜像出来的东西**不会"变旧"**：它要么与上游逐字节相同，要么校验当场失败 ——
 * **钉死的东西没有"过期"这个状态。**
 * （需要人管的是"上游出了新版跟不跟"，而那件事今天本来就是手工改清单，与镜不镜像无关。）
 *
 * ## 判据
 *
 * - 选中的文件数为 0 → **当场失败**。`node --test` 对空集返回绿这条坑本仓已经踩过三次，
 *   一个"什么都没镜像"却报成功的脚本是同一个形状。
 * - 任何一个文件的 sha256 或字节数与清单不符 → **当场失败，且不写出任何产物**。
 *   部分正确的镜像比没有镜像更糟：它看起来是成功的。
 * - 顺带**探测每一个 mirror URL 真的返回什么**（不改红绿，只记录）——
 *   本机观测到 `hf-mirror` 是 308 跳回 huggingface.co，
 *   如果在 runner 上也是，那么清单里那条 `hf-mirror` **不是冗余，只是同一个来源的别名**。
 *   这件事只有真发一次请求才知道。
 *
 * 用法：
 *   node scripts/ci/mirror-model-blobs.mjs --out dist/model-mirror
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const OUT = resolve(arg('--out', join(REPO, 'dist', 'model-mirror')));

/**
 * 要镜像哪些 —— **按 id 显式列出，不按"体积"或"来源数"自动推导。**
 *
 * 理由：自动推导的集合会随清单变动而**静默地**变大或变小，
 * 而"我们决定托管哪些第三方文件"是一个需要人拍板的决定（体积、许可证、责任）。
 * 这里写死，改动就必然出现在 diff 里。
 *
 * 选择依据（`catalog-truth` T-149 ④ 的分层，我复核过）：这三组是**一个替代都没有**的，
 * 且整组都在中文路径上（F3 实时字幕 / 中文离线引擎 / 中文标点）。
 * whisper 的 q8_0 档虽然也是单一来源，但每个都有同模型的 q5/f16 兄弟且已有 ModelScope 镜像
 * —— 主源挂了用户仍装得上，**所以不搬**（4.87 GB 的影子仓库买不到对应的保险）。
 */
const MIRROR_MODEL_IDS = [
  'asr/sherpa-streaming-zh-14m',
  'asr/paraformer-zh-small',
  'punctuation/ct-transformer-zh-en',
];

const say = (s = '') => console.log(s);
const hdr = (s) => {
  say('');
  say('─'.repeat(94));
  say(`── ${s}`);
  say('─'.repeat(94));
};

/**
 * release 资产名必须全局唯一，而这些文件里 `tokens.txt` **出现两次**
 * （sherpa-streaming 与 paraformer 各一份，内容不同）。
 * 直接用原名上传会让后一个覆盖前一个 —— 而且不会有任何报错。
 * 所以加模型 id 前缀。
 *
 * ⚠️ 这不影响装到磁盘上的名字：`ArtifactFile.name` 才决定落盘名，
 * 而 URL 的 basename 与 `name` 本来就允许不同（yt-dlp 那几条就是：
 * 上游资产叫 `yt-dlp_linux`，落盘叫 `yt-dlp`）。
 */
const assetName = (modelId, fileName) => `${modelId.replace(/\//g, '__')}__${fileName}`;

/** 打包用的子目录名（`asr/paraformer-zh-small` → `paraformer-zh-small`）。 */
const slugOf = (modelId) => modelId.split('/').pop();

async function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 只发一个 1 字节的 Range 请求，看这个 URL 到底给什么 —— 不下整份。 */
async function probe(url) {
  try {
    const r = await fetch(url, { headers: { range: 'bytes=0-0' }, redirect: 'manual' });
    const loc = r.headers.get('location');
    return `HTTP ${r.status}${loc ? ` → ${new URL(loc, url).host}` : ''}`;
  } catch (e) {
    return `请求失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

async function main() {
  const manifest = JSON.parse(
    await readFile(join(REPO, 'vendor', 'manifests', 'models-asr-support.json'), 'utf8'),
  );

  const picked = manifest.models.filter((m) => MIRROR_MODEL_IDS.includes(m.id));
  /*
   * ★ 空集守卫。id 写错、清单改名、或者有人"顺手"把模型挪进别的清单文件 ——
   *   任何一种都会让这里变成 0，而一个什么都没镜像却报成功的脚本，
   *   正是本仓最贵的那类失败。
   */
  if (picked.length !== MIRROR_MODEL_IDS.length) {
    const found = picked.map((m) => m.id);
    console.error(
      `mirror-model-blobs: 要镜像 ${MIRROR_MODEL_IDS.length} 个模型，只在清单里找到 ${picked.length} 个。\n` +
        `  找到：${found.join(', ') || '(无)'}\n` +
        `  缺失：${MIRROR_MODEL_IDS.filter((i) => !found.includes(i)).join(', ')}`,
    );
    process.exit(1);
  }

  const jobs = [];
  for (const m of picked) {
    for (const f of m.files) {
      const official = f.mirrors.find((x) => x.official) ?? f.mirrors[0];
      if (!official) {
        console.error(`mirror-model-blobs: ${m.id} / ${f.name} 没有任何 mirror URL`);
        process.exit(1);
      }
      jobs.push({ modelId: m.id, file: f, url: official.url, others: f.mirrors.filter((x) => x !== official) });
    }
  }
  if (jobs.length === 0) {
    console.error('mirror-model-blobs: 一个文件都没选中');
    process.exit(1);
  }

  hdr(`0. 打算镜像 ${jobs.length} 个文件（来自 ${picked.length} 个模型）`);
  let planned = 0;
  for (const j of jobs) {
    planned += j.file.sizeBytes;
    say(`   ${assetName(j.modelId, j.file.name).padEnd(56)} ${String(j.file.sizeBytes).padStart(10)} B`);
  }
  say(`   合计 ${(planned / 1024 / 1024).toFixed(1)} MiB`);

  /* ── 1. 先探一遍每个 mirror URL 真的给什么（不改红绿，只记录事实）── */

  hdr('1. 各 mirror URL 实际返回什么 —— 「有两条 mirror」不等于「有两个来源」');
  say('   开发机上观测到 hf-mirror 对这些路径回 308 → huggingface.co，');
  say('   那样的话它不是冗余、只是同一个来源的别名。runner 上是不是这样，只有真发请求才知道。');
  say('');
  const seen = new Map();
  for (const j of jobs) {
    for (const mi of [{ provider: 'official', url: j.url }, ...j.others]) {
      const host = new URL(mi.url).host;
      if (seen.has(host)) continue;
      seen.set(host, await probe(mi.url));
    }
  }
  for (const [host, result] of seen) say(`   ${host.padEnd(24)} ${result}`);

  /* ── 2. 真下载 + 逐字节校验 ── */

  hdr('2. 下载并**逐字节校验** —— 对不上就当场失败，且不写出任何产物');
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const verified = [];
  const failures = [];
  for (const j of jobs) {
    const label = assetName(j.modelId, j.file.name);
    const t0 = Date.now();
    let buf;
    try {
      const r = await fetch(j.url, { redirect: 'follow' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      buf = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      failures.push(`${label}: 下载失败 ${e instanceof Error ? e.message : String(e)}`);
      say(`   ✘ ${label.padEnd(56)} 下载失败`);
      continue;
    }
    const gotSha = await sha256(buf);
    const okSize = buf.length === j.file.sizeBytes;
    const okSha = gotSha === j.file.sha256;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!okSize || !okSha) {
      failures.push(
        `${label}: 清单说 ${j.file.sizeBytes}B/${j.file.sha256}，实得 ${buf.length}B/${gotSha}`,
      );
      say(`   ✘ ${label.padEnd(56)} 校验不符（${secs}s）`);
      continue;
    }
    /*
     * 按模型分子目录存放 —— **只为打包，不影响最终资产名**。
     * 每个 artifact 因此可以自带一份"只列它自己那几个文件"的 SHA256SUMS，
     * 于是**最显然的那条命令**（`sha256sum -c SHA256SUMS`）在单独拿一个 artifact 时
     * 就是对的。理由见下面写 SHA256SUMS 那段。
     */
    const dir = join(OUT, slugOf(j.modelId));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, label), buf);
    verified.push({ ...j, assetName: label, sha256: gotSha, sizeBytes: buf.length });
    say(`   ✔ ${label.padEnd(56)} ${String(buf.length).padStart(10)} B  ${secs}s`);
  }

  if (failures.length > 0) {
    /*
     * ★ 一个都不留。**部分正确的镜像比没有镜像更糟** —— 它看起来是成功的，
     *   而缺的那一半要等用户装到一半才发现。
     */
    await rm(OUT, { recursive: true, force: true });
    console.error('');
    console.error(`mirror-model-blobs: ${failures.length} 个文件没通过，已删除全部产物：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  /* ── 3. 交给人去建 release 的那份清单 ── */

  hdr('3. 最终清单（建 release 时逐条核对这个表）');
  say('');
  say('   | 资产名 | 字节 | sha256 | 上游（不可变引用） |');
  say('   |---|---:|---|---|');
  for (const v of verified) {
    say(`   | \`${v.assetName}\` | ${v.sizeBytes} | \`${v.sha256}\` | ${v.url} |`);
  }
  const total = verified.reduce((n, v) => n + v.sizeBytes, 0);
  say('');
  say(`   ${verified.length} 个文件，合计 ${total} B（${(total / 1024 / 1024).toFixed(1)} MiB）`);
  say('   **每一条的 sha256 都是下载后重算的，且与仓库清单里那个逐字符相同。**');
  say('');
  say('   收到产物之后先验一遍再上传（不依赖本仓任何工具）：');
  say('       单独一个 artifact：  cd <解压目录> && sha256sum -c SHA256SUMS');
  say('       三个都收齐之后：    sha256sum -c SHA256SUMS.all   （把 9 个文件放同一个目录）');

  /*
   * ★ `SHA256SUMS`：**让"传过来的东西没坏"一条命令就能验，且不依赖我们的任何工具。**
   *
   * 起因是一次真实的失败：366 MiB 的单个 artifact 第一次传到 66 MiB 就断了。
   * 断了本身不可怕 —— 可怕的是**断得像成功**：解压出来文件数可能是对的，
   * 最后一个短了几十 MB，而解压器不一定抱怨。
   * 格式用 coreutils 的标准格式（两个空格），刻意不自造。
   *
   * ★★ **每个 artifact 里那份只列它自己的文件**，另有一份 `SHA256SUMS.all` 列全部 9 个。
   *
   * 为什么要分两份 —— 这条是实测出来的，不是设计洁癖：
   * 第一版每个 artifact 都放同一份 9 行的 SHA256SUMS，于是单独拿一个 artifact 去验时，
   * **最显然的那条命令会失败**：
   *
   *     $ sha256sum -c SHA256SUMS
   *     punctuation__ct-transformer-zh-en__model.onnx: FAILED open or read
   *     sha256sum: WARNING: 5 listed files could not be read
   *     exit 1
   *
   * 5 个"缺失"其实只是不在这个 artifact 里，**文件一个都没坏** ——
   * 但输出长得和真损坏一模一样，而且退出码是 1。
   * 让人去记 `--ignore-missing` 是把成本转嫁给读者；
   * **正确的做法是让最显然的那条命令本来就是对的。**
   */
  const total9 = `${verified.map((v) => `${v.sha256}  ${v.assetName}`).join('\n')}\n`;
  await writeFile(join(OUT, 'SHA256SUMS.all'), total9);
  for (const slug of new Set(verified.map((v) => slugOf(v.modelId)))) {
    const mine = verified.filter((v) => slugOf(v.modelId) === slug);
    await writeFile(
      join(OUT, slug, 'SHA256SUMS'),
      `${mine.map((v) => `${v.sha256}  ${v.assetName}`).join('\n')}\n`,
    );
    /*
     * `SHA256SUMS.all` 也放进每个子目录：三个 artifact 收齐、9 个文件并到同一个目录之后，
     * 用它一次验全部。放进子目录（而不是只放 OUT 根）是为了让每个 artifact 的
     * 内容保持**扁平** —— upload-artifact 取被匹配文件的最近公共祖先做根，
     * 一旦把根目录的文件也纳进来，压缩包里就会多出一层目录。
     */
    await writeFile(join(OUT, slug, 'SHA256SUMS.all'), total9);
  }

  const manifestJson = `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note: '逐字节镜像自上游不可变引用；sha256 由本文件的生成过程重新计算并与仓库清单比对通过。',
        files: verified.map((v) => ({
          assetName: v.assetName,
          modelId: v.modelId,
          installName: v.file.name,
          sizeBytes: v.sizeBytes,
          sha256: v.sha256,
          upstreamUrl: v.url,
        })),
      },
      null,
      2,
    )}\n`;
  await writeFile(join(OUT, 'MIRROR-MANIFEST.json'), manifestJson);
  // 每个子目录也放一份：单独拿走一个 artifact 时它仍然能自证来源。
  for (const slug of new Set(verified.map((v) => slugOf(v.modelId)))) {
    await writeFile(join(OUT, slug, 'MIRROR-MANIFEST.json'), manifestJson);
  }
  say(`   清单写到 ${join(OUT, 'MIRROR-MANIFEST.json')}（每个子目录各一份副本）`);
}

await main();
