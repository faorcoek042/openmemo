#!/usr/bin/env node
/**
 * Fill out the Whisper catalog from ggerganov/whisper.cpp.
 *
 * Every SHA-256 comes from the HF tree API's `lfs.oid` — that field IS the sha256, so a
 * 3 GB model costs one JSON request instead of a 3 GB download. Nothing here is typed by
 * hand: sizes, digests and the pinned revision all come from the API response.
 *
 * RAM/disk are computed with `whisperOverheadMB` from @openmemo/shared rather than
 * re-derived here. That table was back-solved from whisper.cpp's published memory table
 * and is ADDITIVE — whisper's compute buffers are sized by model dimensions and do not
 * shrink with quantization, so a multiplicative estimate under-promises on exactly the
 * quantized models we recommend.
 *
 *   node packages/downloader/scripts/gen-whisper-catalog.mjs        # print
 *   node packages/downloader/scripts/gen-whisper-catalog.mjs --write
 */
import { readFile, writeFile } from 'node:fs/promises';

import { whisperOverheadMB } from '../../shared/dist/fitness.js';
import { speedClassForSize } from '../../shared/dist/models.js';

const REPO = 'ggerganov/whisper.cpp';
const HF = 'https://huggingface.co';
const CATALOG_VERSION = '2026.08.03';

/**
 * The variants to publish.
 *
 * Multilingual coverage is complete (every size x every quantisation the repo ships).
 * The English-only `.en` builds are deliberately NOT exhaustive: they are useless for
 * this app's primary Chinese audience, so one representative quantisation per size is
 * enough to serve English users without doubling the length of every list.
 */
const SIZES = {
  tiny: { zh: '超小模型', en: 'tiny', tier: 'small' },
  base: { zh: '基础模型', en: 'base', tier: 'small' },
  small: { zh: '小模型', en: 'small', tier: 'balanced' },
  medium: { zh: '中模型', en: 'medium', tier: 'large' },
  'large-v1': { zh: '大模型 v1', en: 'large-v1', tier: 'full' },
  'large-v2': { zh: '大模型 v2', en: 'large-v2', tier: 'full' },
};

const QUANT = {
  '': { q: 'f16', label: 'F16', zh: 'F16 全精度' },
  '-q5_0': { q: 'q5_0', label: 'Q5_0', zh: 'Q5_0 量化' },
  '-q5_1': { q: 'q5_1', label: 'Q5_1', zh: 'Q5_1 量化' },
  '-q8_0': { q: 'q8_0', label: 'Q8_0', zh: 'Q8_0 量化' },
};

/** Files we want, as they appear in the repo. */
const WANTED = [
  'ggml-tiny-q5_1.bin',
  'ggml-tiny-q8_0.bin',
  'ggml-base.bin',
  'ggml-base-q8_0.bin',
  'ggml-small.bin',
  'ggml-small-q8_0.bin',
  'ggml-medium.bin',
  'ggml-medium-q8_0.bin',
  'ggml-large-v1.bin',
  'ggml-large-v2.bin',
  'ggml-large-v2-q5_0.bin',
  'ggml-large-v2-q8_0.bin',
  'ggml-tiny.en-q5_1.bin',
  'ggml-base.en-q5_1.bin',
  'ggml-small.en-q5_1.bin',
  'ggml-medium.en-q5_0.bin',
];

/** `ggml-large-v2-q5_0.bin` -> { size:'large-v2', en:false, quant:'-q5_0' } */
function parseName(file) {
  const stem = file.replace(/^ggml-/, '').replace(/\.bin$/, '');
  const mq = /(-q\d_\d)$/.exec(stem);
  const quant = mq ? mq[1] : '';
  let base = mq ? stem.slice(0, -quant.length) : stem;
  const en = base.endsWith('.en');
  if (en) base = base.slice(0, -3);
  return { size: base, en, quant };
}

const j = async (u) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  return r.json();
};

const meta = await j(`${HF}/api/models/${REPO}`);
const rev = meta.sha;
const tree = await j(`${HF}/api/models/${REPO}/tree/${rev}?recursive=true`);
const byPath = new Map(tree.filter((f) => f.type === 'file').map((f) => [f.path, f]));

const out = [];
const missing = [];
for (const file of WANTED) {
  const f = byPath.get(file);
  if (!f?.lfs?.oid) {
    missing.push(file);
    continue;
  }
  const { size, en, quant } = parseName(file);
  const s = SIZES[size];
  const q = QUANT[quant];
  if (!s || !q) {
    missing.push(`${file} (unmapped)`);
    continue;
  }

  const bytes = f.lfs.size ?? f.size;
  const mb = bytes / 1e6;
  const ram = Math.round(mb) + whisperOverheadMB(size);
  const idSuffix = en ? '-en' : '';
  const id = `asr/whisper-${size}${idSuffix}-${q.q}`;

  out.push({
    schemaVersion: 1,
    id,
    groupId: `asr/whisper-${size}${idSuffix}`,
    role: 'asr',
    family: 'whisper',
    arch: 'whisper',
    format: 'ggml',
    quantization: q.q,
    quantTier: s.tier,
    // 档位来自体积（唯一不用测量就知道的属性），与用户机器无关。
    // 注意它**不是速度承诺** —— 速度看 `speedEvidence`（D-03 §14 / D-10 R-M1）。
    speedClass: speedClassForSize(size),
    displayName: `Whisper ${s.en}${en ? ' (English-only)' : ''} (${q.label})`,
    displayNameZh: `Whisper ${s.zh}${en ? '·仅英文' : ''}（${q.zh}）`,
    descriptionZh: en
      ? `仅支持英文的专用版本，同尺寸下英文准确率略高于多语种版。中文请勿使用。`
      : `Whisper ${s.en} 多语种模型，${q.zh}。体积 ${(mb / 1000).toFixed(2)} GB，运行约需 ${ram} MB 内存。`,
    descriptionEn: en
      ? `English-only build; slightly better English accuracy than the multilingual model of the same size. Not for Chinese.`
      : `Whisper ${s.en} multilingual model, ${q.label}. About ${ram} MB of RAM at runtime.`,
    languages: en ? ['en'] : ['multi'],
    tags: en ? ['english-only'] : ['multilingual'],
    engines: ['whisper.cpp'],
    // ADR-011 决策 1：只在**测量过**不可接受时才写。英文专用版对中文是结构性不支持，
    // 不是"质量差一点"，所以这条是确定的；多语种小模型的中文劣化沿用既有条目的判断。
    ...(en || size === 'tiny' || size === 'base' || size === 'small'
      ? { notRecommendedFor: ['zh'] }
      : {}),
    files: [
      {
        role: 'weights',
        name: file,
        sizeBytes: bytes,
        sha256: f.lfs.oid,
        mirrors: [
          { provider: 'hf', url: `${HF}/${REPO}/resolve/${rev}/${file}`, official: true },
          {
            provider: 'hf-mirror',
            url: `https://hf-mirror.com/${REPO}/resolve/${rev}/${file}`,
            official: false,
          },
        ],
      },
    ],
    totalSizeBytes: bytes,
    requirements: {
      ramRequiredMB: ram,
      vramRequiredMB: ram,
      diskRequiredMB: Math.ceil(mb * 1.1),
      cpuFeatures: [],
      computedAtContext: null,
    },
    license: { id: 'MIT', gated: false, url: `${HF}/${REPO}` },
    source: { provider: 'hf', repo: REPO, revision: rev },
    benchmark: null,
    // 生成器**不可能**知道速度：它只读上游文件列表，没有跑过任何一次推理。
    // 因此新条目一律落在 `unmeasured`，要升级成 `measured` 必须有人真的拿秒表跑一遍
    // （见 D-03 §14）。默认值选"诚实的空"而不是"看起来合理的估计"，
    // 是因为后者会让一个从没跑过的数字长得和实测一模一样。
    speedEvidence: { kind: 'unmeasured', reason: 'not_run' },
    catalogVersion: CATALOG_VERSION,
  });
}

if (missing.length) process.stderr.write(`missing/unmapped: ${missing.join(', ')}\n`);
process.stderr.write(`generated ${out.length} entries at revision ${rev}\n`);

if (process.argv.includes('--write')) {
  const p = new URL('../../../vendor/manifests/models-whisper.json', import.meta.url);
  const doc = JSON.parse(await readFile(p, 'utf8'));
  const have = new Set(doc.models.map((m) => m.id));
  const added = out.filter((m) => !have.has(m.id));
  doc.models.push(...added);
  // 同一 groupId 的变体排在一起，组内按体积升序 —— UI 直接按顺序渲染
  doc.models.sort((a, b) =>
    a.groupId === b.groupId
      ? a.totalSizeBytes - b.totalSizeBytes
      : a.groupId.localeCompare(b.groupId),
  );
  doc.catalogVersion = CATALOG_VERSION;
  await writeFile(p, JSON.stringify(doc, null, 2) + '\n');
  process.stderr.write(`wrote ${added.length} new entries; total ${doc.models.length}\n`);
} else {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
