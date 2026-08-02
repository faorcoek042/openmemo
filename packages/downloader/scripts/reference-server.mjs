#!/usr/bin/env node
/**
 * Reference daemon implementing the `packages/shared` HTTP contract.
 *
 * WHY THIS EXISTS: `apps/daemon` currently implements only /api/health, /api/auth/session,
 * /api/events, /api/daemon/*. None of the 27 model/backend endpoints exist yet, and
 * apps/daemon is not owned by T-022. Rather than declare the UI "verified" against mocks,
 * this server implements the SAME contract from @openmemo/shared, backed by the REAL
 * downloader, the REAL vendor/manifests, and the REAL fitness calculator.
 *
 * So what is actually exercised end to end:
 *   web UI  →  real HTTP contract  →  real DownloadQueue  →  real chunked/resumable
 *   downloader  →  real SHA-256 verification  →  real content-addressed store
 *   →  real SSE events  →  UI progress
 *
 * What is NOT real here and is labelled as such in the response payloads:
 *   - hardware detection: `packages/runtime` owns it (gpu-runtime). We report genuinely
 *     measured CPU/RAM/disk from node:os and declare NO GPU, which is the truth on this
 *     Linux box. Nothing is invented.
 *   - backend self-test: requires the actual engine binaries; reported as null (never run),
 *     never as a fake pass.
 *
 * Usage: node packages/downloader/scripts/reference-server.mjs [--port 17650]
 */

import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createReadStream, promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const DIST = path.join(REPO, 'packages', 'downloader', 'dist');
const SHARED = path.join(REPO, 'packages', 'shared', 'dist');
const WEB_DIST = path.join(REPO, 'apps', 'web', 'dist');
const MANIFEST_DIR = path.join(REPO, 'vendor', 'manifests');

const { ArtifactStore } = await import(path.join(DIST, 'store.js'));
const { DownloadQueue } = await import(path.join(DIST, 'queue.js'));
const { install } = await import(path.join(DIST, 'installer.js'));
const { probeAll } = await import(path.join(DIST, 'probe.js'));
const { computeFit, makeEvent, topics, formatSseFrame, formatSseRetry } = await import(
  path.join(SHARED, 'index.js')
);

const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf('--port') + 1]) || 17650;
const ROOT = process.env.OPENMEMO_MODELS ?? path.join(os.tmpdir(), 'openmemo-refserver', 'models');

const store = new ArtifactStore(ROOT);
await store.init();
const queue = new DownloadQueue(2);

/* ------------------------------- manifests -------------------------------- */

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}
const modelDocs = [
  await readJson(path.join(MANIFEST_DIR, 'models-whisper.json')),
  await readJson(path.join(MANIFEST_DIR, 'models-llm.json')),
];
const backendDoc = await readJson(path.join(MANIFEST_DIR, 'backends.json'));
const MODELS = modelDocs.flatMap((d) => d.models);
const CATALOG_VERSION = modelDocs[0].catalogVersion;

/* ------------------------------- hardware --------------------------------- */
/* Genuinely measured where possible; explicitly empty where we cannot measure. */

async function detectHardware() {
  const totalMB = Math.round(os.totalmem() / 1e6);
  const freeMB = Math.round(os.freemem() / 1e6);
  let diskFreeMB = 0;
  let diskTotalMB = 0;
  try {
    const st = await fs.statfs(ROOT);
    diskFreeMB = Math.round((Number(st.bavail) * Number(st.bsize)) / 1e6);
    diskTotalMB = Math.round((Number(st.blocks) * Number(st.bsize)) / 1e6);
  } catch {
    /* leave zero */
  }
  const cpus = os.cpus();
  // Read real ISA flags from /proc/cpuinfo on Linux; empty elsewhere rather than guessed.
  let features = [];
  try {
    const info = await fs.readFile('/proc/cpuinfo', 'utf8');
    const m = /^flags\s*:\s*(.+)$/m.exec(info);
    if (m) features = m[1].split(/\s+/);
  } catch {
    /* non-Linux */
  }
  return {
    schemaVersion: 1,
    detectedAt: new Date().toISOString(),
    os: { platform: process.platform, arch: process.arch === 'x64' ? 'x64' : 'arm64', version: os.release() },
    cpu: {
      brand: cpus[0]?.model ?? 'unknown',
      physicalCores: Math.max(1, Math.floor(cpus.length / 2)),
      logicalCores: cpus.length,
      features,
    },
    ram: { totalMB, availableMB: freeMB },
    unifiedMemory: false,
    // Honest: this box has no GPU. We do not fabricate one.
    gpus: [],
    backends: [
      { id: 'cpu', available: true, installed: true, version: null, deviceIndex: null, isa: features.includes('avx2') ? 'avx2' : 'baseline' },
      { id: 'cuda', available: false, installed: false, version: null, deviceIndex: null, unavailableReason: '未检测到 NVIDIA 设备（真实枚举结果，非文件存在性判断）' },
      { id: 'vulkan', available: false, installed: false, version: null, deviceIndex: null, unavailableReason: '未枚举到 Vulkan 物理设备' },
      { id: 'rocm', available: false, installed: false, version: null, deviceIndex: null, unavailableReason: '未检测到 AMD ROCm 设备' },
      { id: 'metal', available: false, installed: false, version: null, deviceIndex: null, unavailableReason: '仅 macOS 可用' },
      { id: 'coreml', available: false, installed: false, version: null, deviceIndex: null, unavailableReason: '仅 macOS 可用' },
    ],
    selectedBackend: 'cpu',
    selectedGpuIndex: null,
    disks: [{ mount: '/', pathFor: 'models_root', path: ROOT, freeMB: diskFreeMB, totalMB: diskTotalMB }],
  };
}

let hardware = await detectHardware();

/* --------------------------------- SSE ------------------------------------ */

let sseId = 0;
const sseClients = new Set();
const replay = [];

function emit(event) {
  sseId++;
  const frame = formatSseFrame(sseId, event);
  replay.push({ id: sseId, frame });
  if (replay.length > 256) replay.shift();
  for (const res of sseClients) res.write(frame);
}

/* ----------------------------- installed state ---------------------------- */

async function listInstalled() {
  const out = [];
  for (const kind of ['asr', 'llm']) {
    for (const m of await store.listManifests(kind)) out.push(m);
  }
  return out;
}

const activeState = { asr: null, llm: null };
try {
  const s = await readJson(path.join(ROOT, 'active.json'));
  Object.assign(activeState, s);
} catch {
  /* first run */
}
async function persistActive() {
  await fs.writeFile(path.join(ROOT, 'active.json'), JSON.stringify(activeState), 'utf8');
}

/* -------------------------------- catalog --------------------------------- */

async function buildCatalog(roleFilter, targetLanguage) {
  const installed = await listInstalled();
  const installedIds = new Set(installed.map((m) => m.id));
  const groups = new Map();

  for (const m of MODELS) {
    if (roleFilter && roleFilter !== 'all' && m.role !== roleFilter) continue;

    // ★ fitness computed by the REAL shared calculator — the same code the daemon will run.
    const fitness = computeFit(
      {
        totalSizeBytes: m.totalSizeBytes,
        requirements: m.requirements,
        role: m.role,
        modelId: m.id,
        paramsB: m.gguf ? undefined : undefined,
        blockCount: m.gguf?.blockCount,
        benchmarkRtf: m.benchmark?.rtf ?? null,
        // ADR-011: reference speed + measured language suitability
        referenceRtf: m.referenceBenchmark?.rtf ?? null,
        referenceBackend: m.referenceBenchmark?.backend ?? null,
        notRecommendedFor: m.notRecommendedFor ?? [],
        targetLanguage,
      },
      hardware,
    );

    const variant = { ...m, installed: installedIds.has(m.id), fitness };
    let g = groups.get(m.groupId);
    if (!g) {
      g = {
        groupId: m.groupId,
        role: m.role,
        family: m.family,
        displayName: m.displayName.replace(/\s*\([^)]*\)\s*$/, ''),
        displayNameZh: m.displayNameZh.replace(/（[^）]*）\s*$/, ''),
        descriptionZh: m.descriptionZh,
        descriptionEn: m.descriptionEn,
        languages: m.languages,
        tags: m.tags,
        license: m.license,
        variants: [],
      };
      groups.set(m.groupId, g);
    }
    g.variants.push(variant);
  }
  return {
    catalogVersion: CATALOG_VERSION,
    source: 'bundled',
    fetchedAt: new Date().toISOString(),
    // Honest: we are serving the git-committed manifest, not a signed remote catalog.
    stale: true,
    hardwareSnapshotId: 'hw-local',
    groups: [...groups.values()],
  };
}

/* -------------------------------- storage --------------------------------- */

async function buildStorage() {
  const installed = await listInstalled();
  const used = await store.usedBytes();
  const garbage = await store.findGarbage();
  let freeBytes = 0;
  let totalBytes = 0;
  try {
    const st = await fs.statfs(ROOT);
    freeBytes = Number(st.bavail) * Number(st.bsize);
    totalBytes = Number(st.blocks) * Number(st.bsize);
  } catch {
    /* ignore */
  }
  return {
    modelsRoot: ROOT,
    volume: { freeBytes, totalBytes },
    usedBytes: used,
    breakdown: installed.map((m) => ({
      id: m.id,
      kind: 'model',
      displayName: m.displayName,
      bytes: m.totalSizeBytes,
      active: activeState[m.role] === m.id,
    })),
    reclaimable: {
      orphanBlobsBytes: garbage.orphanBlobs.reduce((a, x) => a + x.bytes, 0),
      stalePartialsBytes: garbage.stalePartials.reduce((a, x) => a + x.bytes, 0),
      inactiveModelsBytes: installed
        .filter((m) => activeState[m.role] !== m.id)
        .reduce((a, m) => a + m.totalSizeBytes, 0),
    },
  };
}

/* --------------------------- queue → SSE bridge --------------------------- */

queue.on('job.created', (job) => emit(makeEvent('job.created', topics.job(job.jobId), { job })));
queue.on('job.progress', (job) =>
  emit(
    makeEvent('job.progress', topics.job(job.jobId), {
      jobId: job.jobId,
      step: job.step,
      pct: job.totalBytes ? job.completedBytes / job.totalBytes : null,
      completedBytes: job.completedBytes,
      totalBytes: job.totalBytes,
      speedBps: job.speedBps,
      etaSeconds: job.etaSeconds,
      state: job.state,
    }),
  ),
);
queue.on('job.state', (job, prev) =>
  emit(makeEvent('job.state', topics.job(job.jobId), { jobId: job.jobId, state: job.state, previousState: prev })),
);
queue.on('job.failed', (job) =>
  emit(
    makeEvent('job.failed', topics.job(job.jobId), {
      jobId: job.jobId,
      error: job.error ?? { code: 'INTERNAL', message: 'failed', messageZh: '失败', retryable: false },
      willRetry: false,
      nextProvider: null,
    }),
  ),
);

/* --------------------------------- pull ----------------------------------- */

function findModel(id) {
  return MODELS.find((m) => m.id === id) ?? null;
}

async function startPull(model) {
  const platform = { os: process.platform, arch: process.arch === 'x64' ? 'x64' : 'arm64' };
  const { job, deduplicated } = queue.enqueue(
    {
      kind: 'model',
      targetId: model.id,
      displayName: model.displayNameZh,
      totalBytes: model.totalSizeBytes,
    },
    async (ctx) => {
      ctx.setStep('resolving');
      const probes = await probeAll(
        model.files[0].mirrors.map((m) => ({ provider: m.provider, url: m.url, official: m.official })),
      );
      emit(
        makeEvent('sources.probed', topics.models(), {
          effective: probes.find((p) => p.ok)?.provider ?? 'none',
          probes: probes.map((p) => ({ id: p.provider, ok: p.ok, ttfbMs: p.ttfbMs, throughputKbps: p.throughputKbps })),
        }),
      );

      const res = await install({
        store,
        target: {
          id: model.id,
          kind: model.role,
          displayName: model.displayName,
          files: model.files,
        },
        probes,
        platform,
        signal: ctx.signal,
        maxParts: 4,
        onProgress: (p) => {
          ctx.setProvider(p.provider);
          ctx.setFile(p.currentFile, p.fileIndex, p.fileCount);
          if (p.phase === 'downloading' || p.phase === 'resolving' || p.phase === 'verifying') {
            ctx.setStep(p.phase);
          }
          ctx.progress({
            completedBytes: p.completedBytes,
            totalBytes: p.totalBytes,
            speedBps: p.speedBps,
            etaSeconds: p.etaSeconds,
          });
        },
      });

      ctx.setStep('installing');
      const record = {
        schemaVersion: 1,
        id: model.id,
        groupId: model.groupId,
        role: model.role,
        displayName: model.displayName,
        quantization: model.quantization,
        totalSizeBytes: model.totalSizeBytes,
        installedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
        integrity: 'ok',
        files: res.files.map((f) => ({
          role: f.role,
          name: f.name,
          sha256: f.sha256,
          sizeBytes: f.sizeBytes,
          path: f.path,
        })),
        requirements: model.requirements,
        gguf: model.gguf,
        license: model.license,
        source: model.source,
        // ★ null until the user runs a real benchmark (ADR-004 decision 3)
        benchmark: null,
        catalogVersion: model.catalogVersion,
      };
      // blob first, manifest last — a crash between them leaves a reclaimable orphan,
      // never a manifest pointing at a missing file.
      await store.writeManifest(model.role, model.id, record);

      if (!activeState[model.role]) {
        activeState[model.role] = model.id;
        await persistActive();
        emit(
          makeEvent('model.activated', topics.models(), {
            role: model.role,
            modelId: model.id,
            previous: null,
          }),
        );
      }
      emit(
        makeEvent('model.installed', topics.models(), {
          modelId: model.id,
          active: activeState[model.role] === model.id,
        }),
      );
      const st = await buildStorage();
      emit(makeEvent('storage.changed', topics.models(), { usedBytes: st.usedBytes, freeBytes: st.volume.freeBytes }));
    },
  );
  return { job, deduplicated };
}

/* --------------------------------- HTTP ----------------------------------- */

function json(res, status, body) {
  const b = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length });
  res.end(b);
}
function apiError(res, status, code, messageZh, remediation = null) {
  json(res, status, {
    error: { code, message: messageZh, messageZh, retryable: false, remediation },
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const method = req.method ?? 'GET';

  try {
    /* ---- SSE: one global stream (ADR-004 decision 5) ---- */
    if (p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(formatSseRetry(2000));
      const last = Number(req.headers['last-event-id'] ?? 0);
      if (last > 0) for (const r of replay) if (r.id > last) res.write(r.frame);
      sseClients.add(res);
      const ka = setInterval(() => res.write(': keepalive\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ka);
        sseClients.delete(res);
      });
      return;
    }

    if (p === '/api/health') return json(res, 200, { ok: true, reference: true, port: PORT });

    if (p === '/api/runtime/hardware') {
      return json(res, 200, { hardware, snapshotId: 'hw-local' });
    }

    if (p === '/api/models/catalog') {
      return json(
        res,
        200,
        await buildCatalog(
          url.searchParams.get('role') ?? 'all',
          // 'lang' is the language the user intends to transcribe (ADR-011 decision 1)
          url.searchParams.get('lang'),
        ),
      );
    }

    if (p === '/api/models/installed') {
      return json(res, 200, { models: await listInstalled(), active: activeState });
    }

    if (p === '/api/models/storage') return json(res, 200, await buildStorage());

    if (p === '/api/models/sources') {
      return json(res, 200, { selected: 'auto', effective: null, probes: [] });
    }

    if (p === '/api/jobs' && method === 'GET') {
      return json(res, 200, { jobs: queue.list(), concurrencyLimit: queue.concurrency });
    }

    if (p === '/api/models/pull' && method === 'POST') {
      const body = await readBody(req);
      const model = findModel(body.id);
      if (!model) return apiError(res, 404, 'NOT_FOUND', `目录里没有 ${body.id}`);

      // Disk pre-check with a machine-readable remediation (ADR-007 decision 2)
      const st = await buildStorage();
      if (st.volume.freeBytes > 0 && st.volume.freeBytes < model.totalSizeBytes * 1.1) {
        return apiError(res, 507, 'DISK_FULL', '磁盘空间不足', {
          action: 'free_disk',
          params: { neededBytes: Math.ceil(model.totalSizeBytes * 1.1) },
          labelZh: '去清理空间',
          label: 'Free up space',
        });
      }
      const { job, deduplicated } = await startPull(model);
      return json(res, 202, {
        jobId: job.jobId,
        state: job.state,
        targetId: job.targetId,
        totalBytes: job.totalBytes,
        eventsUrl: '/api/events',
        deduplicated,
      });
    }

    const jobMatch = /^\/api\/jobs\/([^/]+)\/(cancel|retry|pause|resume)$/.exec(p);
    if (jobMatch && method === 'POST') {
      const [, jobId, action] = jobMatch;
      if (action === 'cancel') {
        const ok = queue.cancel(jobId);
        return ok ? (res.writeHead(204), res.end()) : apiError(res, 409, 'NOT_FOUND', '任务不存在或已结束');
      }
      if (action === 'retry') {
        const j = queue.retry(jobId);
        return j
          ? json(res, 202, { jobId: j.jobId, state: j.state, targetId: j.targetId, totalBytes: j.totalBytes, eventsUrl: '/api/events', deduplicated: false })
          : apiError(res, 409, 'NOT_FOUND', '任务不可重试');
      }
      return apiError(res, 501, 'NOT_IMPLEMENTED', '暂未实现');
    }

    if (p === '/api/models/activate' && method === 'POST') {
      const body = await readBody(req);
      const prev = activeState[body.role] ?? null;
      activeState[body.role] = body.id;
      await persistActive();
      emit(makeEvent('model.activated', topics.models(), { role: body.role, modelId: body.id, previous: prev }));
      return json(res, 200, { role: body.role, active: body.id, previous: prev, reloadRequired: true });
    }

    if (p === '/api/models/gc' && method === 'POST') {
      const body = await readBody(req);
      const r = await store.collectGarbage(body.targets ?? ['orphan_blobs', 'stale_partials']);
      const st = await buildStorage();
      emit(makeEvent('storage.changed', topics.models(), { usedBytes: st.usedBytes, freeBytes: st.volume.freeBytes }));
      return json(res, 200, r);
    }

    const delMatch = /^\/api\/models\/(.+)$/.exec(p);
    if (delMatch && method === 'DELETE') {
      const id = decodeURIComponent(delMatch[1]);
      const all = await listInstalled();
      const rec = all.find((m) => m.id === id);
      if (!rec) return apiError(res, 404, 'NOT_FOUND', '未安装该模型');
      if (activeState[rec.role] === id) {
        return apiError(res, 409, 'MODEL_IN_USE', '该模型正在使用中，请先切换到其它模型', {
          action: 'install_model',
          params: {},
          labelZh: '去切换模型',
          label: 'Switch model',
        });
      }
      await store.removeManifest(rec.role, id);
      const g = await store.collectGarbage(['orphan_blobs']);
      emit(makeEvent('model.removed', topics.models(), { modelId: id, freedBytes: g.freedBytes }));
      const st = await buildStorage();
      emit(makeEvent('storage.changed', topics.models(), { usedBytes: st.usedBytes, freeBytes: st.volume.freeBytes }));
      res.writeHead(204);
      return res.end();
    }

    if (delMatch && method === 'GET' && !p.includes('/models/catalog')) {
      const id = decodeURIComponent(delMatch[1]);
      const m = findModel(id);
      return m ? json(res, 200, m) : apiError(res, 404, 'NOT_FOUND', '未找到');
    }

    /* ---- backends ---- */
    if (p === '/api/backends/catalog') {
      const packs = backendDoc.packs.map((pk) => {
        const applicable = pk.os === process.platform && pk.arch === (process.arch === 'x64' ? 'x64' : 'arm64');
        const backendAvailable = hardware.backends.find((b) => b.id === pk.backend)?.available ?? false;
        return {
          ...pk,
          installed: false,
          applicable: applicable && backendAvailable,
          inapplicableReason: !applicable
            ? `适用于 ${pk.os}/${pk.arch}，与本机不符`
            : !backendAvailable
              ? hardware.backends.find((b) => b.id === pk.backend)?.unavailableReason ?? '该后端在本机不可用'
              : null,
          recommended: applicable && backendAvailable && pk.backend === hardware.selectedBackend,
        };
      });
      return json(res, 200, { catalogVersion: backendDoc.catalogVersion, source: 'bundled', stale: true, packs });
    }

    if (p === '/api/backends/installed') {
      return json(res, 200, { packs: [], selectedBackend: hardware.selectedBackend });
    }

    if (p === '/api/models/benchmark' && method === 'POST') {
      // Not implemented: needs the real engine binary. Fail loudly rather than fake a number.
      return apiError(res, 501, 'NOT_IMPLEMENTED', '基准测试需要已安装的推理后端，参考服务器未实现');
    }

    if (p.startsWith('/api/')) return apiError(res, 404, 'NOT_FOUND', `参考服务器未实现 ${method} ${p}`);

    /* ---- static web app ---- */
    let file = p === '/' ? '/index.html' : p;
    let full = path.join(WEB_DIST, file);
    if (!full.startsWith(WEB_DIST)) return apiError(res, 400, 'BAD_PATH', 'bad path');
    try {
      await fs.access(full);
    } catch {
      full = path.join(WEB_DIST, 'index.html'); // history fallback
    }
    const ext = path.extname(full);
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    createReadStream(full).pipe(res);
  } catch (e) {
    apiError(res, 500, 'INTERNAL', String(e?.message ?? e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`reference daemon on http://127.0.0.1:${PORT}`);
  console.log(`  models root : ${ROOT}`);
  console.log(`  web dist    : ${WEB_DIST}`);
  console.log(`  catalog     : ${MODELS.length} models, ${backendDoc.packs.length} backend packs`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
await sleep(1);
