#!/usr/bin/env node
/**
 * Manifest generator — builds vendor/manifests/*.json from curated sources.
 *
 * ADR-004 decision 4 mandates that `vramRequiredMB` is NOT hand-typed. GPT4All's
 * `ramrequired` is a hand-entered integer (values seen: 1/4/8/16) compared against total
 * system RAM only; memo.ac has no such field at all. Both approaches are guesses.
 *
 * We compute it instead:
 *   1. `GET /api/models/{repo}/tree/{rev}`  → exact sizeBytes + lfs.oid (== SHA-256)
 *   2. `GET .../resolve/...` Range 0-8MB    → parse the GGUF header
 *   3. kvBytesPerToken = blockCount * headCountKv * (keyLength+valueLength) * 2
 *   4. requirements    = weights + KV cache + graph overhead   (fitness.ts)
 *
 * Step 2 is the important one: KV cache at 8K context is ~1.1 GB for Qwen3-4B/8B, which
 * is the term LM Studio's estimator under-counts and why it mis-badges models as
 * loadable. Reading it costs one 8 MB range request instead of a 2.5 GB download.
 *
 * Usage:
 *   node packages/downloader/scripts/gen-manifest.mjs --check     # verify committed manifests
 *   node packages/downloader/scripts/gen-manifest.mjs --write     # regenerate
 *   node packages/downloader/scripts/gen-manifest.mjs --gguf <repo> <file>   # inspect one file
 */

import { Buffer } from 'node:buffer';
import console from 'node:console';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Web-standard globals, named explicitly so this file does not depend on eslint env config.
const { fetch } = globalThis;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const MANIFEST_DIR = path.join(REPO_ROOT, 'vendor', 'manifests');

const HF = process.env.HF_ENDPOINT || 'https://huggingface.co';
/** GGUF metadata lives at the head of the file; 8 MB covers tokenizer arrays comfortably. */
const GGUF_HEAD_BYTES = 8 * 1024 * 1024;

/* --------------------------- GGUF header parsing -------------------------- */

const GGUF_TYPES = {
  0: ['u8', 1],
  1: ['i8', 1],
  2: ['u16', 2],
  3: ['i16', 2],
  4: ['u32', 4],
  5: ['i32', 4],
  6: ['f32', 4],
  7: ['bool', 1],
  10: ['u64', 8],
  11: ['i64', 8],
  12: ['f64', 8],
};

class Cursor {
  constructor(buf) {
    this.buf = buf;
    this.off = 0;
  }
  need(n) {
    if (this.off + n > this.buf.length)
      throw new Error('GGUF header truncated: increase GGUF_HEAD_BYTES');
  }
  u32() {
    this.need(4);
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }
  u64() {
    this.need(8);
    const v = Number(this.buf.readBigUInt64LE(this.off));
    this.off += 8;
    return v;
  }
  str() {
    const n = this.u64();
    this.need(n);
    const s = this.buf.toString('utf8', this.off, this.off + n);
    this.off += n;
    return s;
  }
  skip(n) {
    this.need(n);
    this.off += n;
  }
  value(type) {
    if (type === 8) return this.str();
    if (type === 9) {
      const et = this.u32();
      const n = this.u64();
      if (et === 8) {
        for (let i = 0; i < n; i++) this.str();
        return `<${n} strings>`;
      }
      const [, size] = GGUF_TYPES[et] ?? [null, 0];
      if (!size) throw new Error(`Unknown GGUF array element type ${et}`);
      this.skip(size * n);
      return `<${n} values>`;
    }
    const spec = GGUF_TYPES[type];
    if (!spec) throw new Error(`Unknown GGUF value type ${type}`);
    const [name, size] = spec;
    this.need(size);
    let v;
    switch (name) {
      case 'u8':
        v = this.buf.readUInt8(this.off);
        break;
      case 'i8':
        v = this.buf.readInt8(this.off);
        break;
      case 'u16':
        v = this.buf.readUInt16LE(this.off);
        break;
      case 'i16':
        v = this.buf.readInt16LE(this.off);
        break;
      case 'u32':
        v = this.buf.readUInt32LE(this.off);
        break;
      case 'i32':
        v = this.buf.readInt32LE(this.off);
        break;
      case 'f32':
        v = this.buf.readFloatLE(this.off);
        break;
      case 'bool':
        v = this.buf.readUInt8(this.off) !== 0;
        break;
      case 'u64':
        v = Number(this.buf.readBigUInt64LE(this.off));
        break;
      case 'i64':
        v = Number(this.buf.readBigInt64LE(this.off));
        break;
      case 'f64':
        v = this.buf.readDoubleLE(this.off);
        break;
      default:
        throw new Error(`unhandled ${name}`);
    }
    this.off += size;
    return v;
  }
}

export function parseGgufHeader(buf) {
  const c = new Cursor(buf);
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== 'GGUF') throw new Error(`Not a GGUF file (magic=${JSON.stringify(magic)})`);
  c.skip(4);
  const version = c.u32();
  const tensorCount = c.u64();
  const kvCount = c.u64();
  const kv = {};
  for (let i = 0; i < kvCount; i++) {
    const key = c.str();
    const type = c.u32();
    kv[key] = c.value(type);
  }
  const arch = kv['general.architecture'];
  const g = (s) => kv[`${arch}.${s}`];

  const blockCount = g('block_count');
  const headCount = g('attention.head_count');
  const headCountKv = g('attention.head_count_kv') ?? headCount;
  const embeddingLength = g('embedding_length');
  // Some architectures omit key/value length; derive from embedding/head count.
  const keyLength = g('attention.key_length') ?? Math.floor(embeddingLength / headCount);
  const valueLength = g('attention.value_length') ?? keyLength;
  const contextLength = g('context_length');

  if (!blockCount || !headCountKv || !keyLength) {
    throw new Error(`GGUF header missing required fields for arch="${arch}"`);
  }

  return {
    architecture: arch,
    version,
    tensorCount,
    blockCount,
    embeddingLength,
    headCount,
    headCountKv,
    keyLength,
    valueLength,
    contextLength,
    // f16 KV: 2 bytes per element, K and V both stored.
    kvBytesPerToken: blockCount * headCountKv * (keyLength + valueLength) * 2,
  };
}

/* ------------------------------ HF helpers -------------------------------- */

export async function hfTree(repo, rev = 'main') {
  const res = await fetch(`${HF}/api/models/${repo}/tree/${rev}?recursive=true`);
  if (!res.ok) throw new Error(`tree ${repo}: HTTP ${res.status}`);
  return res.json();
}

/**
 * Fetch size + content SHA-256 for one file.
 *
 * `redirect: 'manual'` is required: HF puts `x-linked-size` / `x-linked-etag` on the 302,
 * and following the redirect returns only the CDN's 206, where both read back as null.
 */
async function hfHead(repo, file, rev = 'main') {
  const res = await fetch(`${HF}/${repo}/resolve/${rev}/${file}`, {
    method: 'GET',
    headers: { range: 'bytes=0-0' },
    redirect: 'manual',
  });
  await res.arrayBuffer().catch(() => undefined);
  const etag = (res.headers.get('x-linked-etag') || '').replace(/^W\//, '').replace(/"/g, '');
  const size = Number(res.headers.get('x-linked-size') || 0);
  return { sha256: /^[a-f0-9]{64}$/.test(etag) ? etag : null, sizeBytes: size || null };
}

export async function fetchGgufHeader(repo, file, rev = 'main') {
  const res = await fetch(`${HF}/${repo}/resolve/${rev}/${file}`, {
    headers: { range: `bytes=0-${GGUF_HEAD_BYTES - 1}` },
    redirect: 'follow',
  });
  if (!res.ok && res.status !== 206) throw new Error(`gguf head ${file}: HTTP ${res.status}`);
  return parseGgufHeader(Buffer.from(await res.arrayBuffer()));
}

/* --------------------------- requirement math ----------------------------- */
/* Kept in sync with packages/shared/src/fitness.ts — that file is the spec. */

const WHISPER_OVERHEAD_MB = { tiny: 200, base: 250, small: 380, medium: 520, large: 820 };
const LLM_GRAPH_OVERHEAD_MB = 300;
/** Default context for requirement figures. Also stored so the number is interpretable. */
export const DEFAULT_CONTEXT = 8192;

export function whisperOverheadMB(id) {
  const s = id.toLowerCase();
  if (s.includes('large') || s.includes('turbo')) return WHISPER_OVERHEAD_MB.large;
  if (s.includes('medium')) return WHISPER_OVERHEAD_MB.medium;
  if (s.includes('small')) return WHISPER_OVERHEAD_MB.small;
  if (s.includes('base')) return WHISPER_OVERHEAD_MB.base;
  if (s.includes('tiny')) return WHISPER_OVERHEAD_MB.tiny;
  return WHISPER_OVERHEAD_MB.large;
}

export function whisperRequirements(id, weightsBytes) {
  // Additive, not multiplicative: whisper compute buffers are sized by model dimensions
  // and do not shrink with quantization.
  const mb = Math.round(weightsBytes / 1e6 + whisperOverheadMB(id));
  return {
    ramRequiredMB: mb,
    vramRequiredMB: mb,
    diskRequiredMB: Math.round((weightsBytes / 1e6) * 1.1),
    cpuFeatures: [],
    computedAtContext: null, // whisper requirements are context-independent
  };
}

export function llmRequirements(weightsBytes, gguf, context = DEFAULT_CONTEXT) {
  const weights = (weightsBytes / 1e6) * 1.05;
  const kv = (gguf.kvBytesPerToken * context) / 1e6;
  const mb = Math.round(weights + kv + LLM_GRAPH_OVERHEAD_MB);
  return {
    ramRequiredMB: mb,
    vramRequiredMB: mb,
    diskRequiredMB: Math.round((weightsBytes / 1e6) * 1.1),
    cpuFeatures: ['avx2'],
    computedAtContext: context,
  };
}

/* --------------------------------- CLI ------------------------------------ */

async function cmdGguf(repo, file) {
  console.log(`Reading GGUF header via ${(GGUF_HEAD_BYTES / 1e6).toFixed(0)} MB Range request…`);
  console.log(`  ${HF}/${repo}/resolve/main/${file}\n`);
  const h = await fetchGgufHeader(repo, file);
  const meta = await hfHead(repo, file);
  console.log(JSON.stringify(h, null, 2));
  if (meta.sizeBytes) {
    console.log(`\nsizeBytes: ${meta.sizeBytes}  sha256: ${meta.sha256}`);
    for (const ctx of [4096, 8192, 16384, 32768]) {
      const r = llmRequirements(meta.sizeBytes, h, ctx);
      const kvMB = ((h.kvBytesPerToken * ctx) / 1e6).toFixed(0);
      console.log(
        `  ctx ${String(ctx).padStart(6)}: need ${String(r.ramRequiredMB).padStart(6)} MB  (KV ${kvMB} MB)`,
      );
    }
  }
}

/** Re-verify every committed manifest against upstream. */
async function cmdCheck() {
  const files = (await fs.readdir(MANIFEST_DIR)).filter((f) => f.endsWith('.json'));
  let problems = 0;
  let checked = 0;
  for (const f of files) {
    const doc = JSON.parse(await fs.readFile(path.join(MANIFEST_DIR, f), 'utf8'));
    const entries = doc.models ?? doc.packs ?? [];
    for (const m of entries) {
      for (const file of m.files ?? []) {
        const hfMirror = (file.mirrors ?? []).find((x) => x.provider === 'hf');
        if (!hfMirror) continue;
        const match = /huggingface\.co\/(.+?)\/resolve\/(.+?)\/(.+)$/.exec(hfMirror.url);
        if (!match) continue;
        const [, repo, rev, name] = match;
        checked++;
        try {
          const meta = await hfHead(repo, name, rev);
          if (meta.sizeBytes && meta.sizeBytes !== file.sizeBytes) {
            console.log(
              `  MISMATCH size ${m.id}/${file.name}: manifest ${file.sizeBytes}, upstream ${meta.sizeBytes}`,
            );
            problems++;
          } else if (meta.sha256 && meta.sha256 !== file.sha256) {
            console.log(
              `  MISMATCH sha256 ${m.id}/${file.name}: manifest ${file.sha256.slice(0, 12)}…, upstream ${meta.sha256.slice(0, 12)}…`,
            );
            problems++;
          } else {
            console.log(`  ok  ${m.id}/${file.name}`);
          }
        } catch (e) {
          console.log(`  ERROR ${m.id}/${file.name}: ${e.message}`);
          problems++;
        }
      }
    }
  }
  console.log(`\n${checked} file(s) checked, ${problems} problem(s).`);
  // Upstream mutating a pinned file is a real supply-chain signal, not a nuisance.
  process.exit(problems === 0 ? 0 : 1);
}

const [, , cmd, ...rest] = process.argv;
if (cmd === '--gguf') {
  if (rest.length < 2) {
    console.error('usage: --gguf <repo> <file>');
    process.exit(2);
  }
  await cmdGguf(rest[0], rest[1]);
} else if (cmd === '--check') {
  await cmdCheck();
} else {
  console.log(`gen-manifest.mjs

  --gguf <repo> <file>   Read a GGUF header over Range and print derived requirements
  --check                Re-verify committed manifests against upstream size + sha256

Manifests live in vendor/manifests/ and are committed to git (ADR-001: what we download
must stay auditable). --check is intended for CI: it fails when upstream mutates a file
we pinned, which is exactly when a human should look.`);
}
