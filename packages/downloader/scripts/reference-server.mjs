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
 * Usage: node packages/downloader/scripts/reference-server.mjs --models-root <dir> [--port 19450]
 *
 * ## ⚠️ T-142e：这个工具被关进盒子里了，三条一起改
 *
 * 原则（Manager 裁定，沿用变异检查器立的那条）：
 * **一个"故意不同于生产"的工具，安全边界与正常代码不是一回事。**
 * 参考服务器存在的意义就是**假装成上游**，所以它比任何产品代码都更该被关起来。
 *
 * ① **`--models-root` 从"可选"变成必填。** 原来的兜底是
 *    `process.env.OPENMEMO_MODELS ?? path.join(os.tmpdir(), 'openmemo-refserver', 'models')`：
 *    一个**固定名**目录，跨并发运行共享、跨重启存活，而且全文件**没有一处 `rm`**。
 *    现在必须自己敲路径进来 —— 同 `seed-fixture.mjs` 的处置，理由也一样：
 *    **真想用的人必须自己把它敲进去。**
 *
 * ② **不再把上一次运行写下的 `active.json` 读回来当作真相。**
 *    一个工具把**自己上一次的输出**当作事实来源，正是本项目反复撞见的形状
 *    （mock 里有个 daemon 从来不发的字段、`extraRoots` 自加入之日就是死代码）。
 *    现在每次启动都从 `{asr:null, llm:null}` 开始；文件仍然写（供人事后查看），
 *    但**永远不读回来**，这一点在 `persistActive()` 上单独标了。
 *
 * ③ **删除类操作只在"本工具自己建的 store"上执行。**
 *    这一条最重：`DELETE /api/models/:id` 会 `removeManifest` + `collectGarbage`，
 *    `POST /api/models/gc` 会收垃圾。原来 `OPENMEMO_MODELS` 优先级最高，
 *    而那个变量**产品代码自己也在读**（`packages/pipeline/src/tools.ts:91`）——
 *    谁把它导出指向真实模型库，这两个端点就是在**真删用户已装好的模型包**。
 *    判据不是"记得别导出那个变量"，是 **`store` 根目录里必须有本工具亲手放下的标记文件**；
 *    标记不在就拒绝启动、并且每次删除前**重新检查一遍**（防止运行期间被换掉）。
 *    这样就算有人导出了 `OPENMEMO_MODELS`、或者把 `--models-root` 指向真实 store，
 *    **也删不动**。
 *
 * ④ **默认端口挪出 `DEFAULT_PORT`（17650）。** 原来的默认值正是它，
 *    而这是个长驻服务：关掉父终端会把它孤儿化、端口仍被占，
 *    用户的 daemon 于是漂到 17651 —— 浏览器麦克风授权按 origin 隔离，**要重新授权**。
 *    现在默认 19450，落在 `apps/daemon/src/testPorts.test.ts` 统一管辖的 19xxx 区段里，
 *    那条测试会连同全部 daemon 测试端口一起扫，撞上 17650 或互相重叠都当场红。
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
const {
  computeFit,
  makeEvent,
  referenceSpeedOf,
  topics,
  formatSseFrame,
  formatSseRetry,
  COMPONENTS_CHECK_PARAM,
  parseComponentsCheckParam,
} = await import(path.join(SHARED, 'index.js'));
const { listComponents } = await import(path.join(DIST, 'components.js'));
const COMPONENT_REGISTRY = path.join(REPO, 'vendor', 'manifests', 'components.json');
/** Cache the last upstream sweep so the page does not re-hit GitHub on every render. */
let componentCache = null;

const argv = process.argv.slice(2);
/** 默认端口见文件头 ④：绝不能是 `DEFAULT_PORT`（17650）。`testPorts.test.ts` 钉住这一条。 */
const PORT = Number(argv[argv.indexOf('--port') + 1]) || 19450;
/**
 * Optional upstream daemon. Unmatched /api/* requests are forwarded there.
 *
 * This lets ONE origin serve: the built web app + the model/backend endpoints this file
 * implements + whatever apps/daemon has actually shipped (notes, auth, media). Without it
 * a browser test can only ever exercise one half of the API surface, because the SPA
 * talks to a single origin.
 */
const PROXY = argv.includes('--proxy') ? argv[argv.indexOf('--proxy') + 1] : null;
/**
 * Pure-shim mode: serve ONLY the built web app and forward every /api call upstream.
 *
 * Once apps/daemon implements the contract for real, testing against this file's own
 * handlers would be testing the wrong implementation. --proxy-all turns this process into
 * a static-file server plus a transparent proxy, so the browser exercises the daemon.
 */
const PROXY_ALL = argv.includes('--proxy-all');

/* ------------------------- 沙箱闸门（见文件头 ①③）------------------------- */

const rootFlag = argv.indexOf('--models-root');
const ROOT = rootFlag >= 0 ? argv[rootFlag + 1] : undefined;
if (!ROOT) {
  console.error(
    '`--models-root` 是必填的。\n' +
      '\n' +
      '这个服务会往 store 里真下载模型（可能几个 GB），并且带着两个**删除**端点\n' +
      '（DELETE /api/models/:id 与 POST /api/models/gc）。它以前的兜底是\n' +
      '  OPENMEMO_MODELS ?? /tmp/openmemo-refserver/models\n' +
      '—— 一个固定名目录（跨运行共享、从不清理），而 OPENMEMO_MODELS 是产品代码\n' +
      '自己也在读的变量：导出了它再跑这个服务，删除端点删的就是你真实装好的模型包。\n' +
      '\n' +
      '  node packages/downloader/scripts/reference-server.mjs --models-root /tmp/<你的目录>/models\n',
  );
  process.exit(2);
}

/**
 * 沙箱标记 —— **删除类操作的唯一许可证**。
 *
 * 只在"目录不存在 / 存在但是空的"时由本工具亲手放下。
 * 指向一个已有内容却没有标记的目录（例如用户真实的模型库）→ **拒绝启动**。
 * 判据不是"记得别把 --models-root 指错"，是**指错了也删不动**。
 */
const SANDBOX_MARK = path.join(ROOT, '.openmemo-refserver-sandbox');

async function isSandbox() {
  try {
    await fs.access(SANDBOX_MARK);
    return true;
  } catch {
    return false;
  }
}

{
  let entries = null;
  try {
    entries = await fs.readdir(ROOT);
  } catch {
    /* 不存在 —— 下面创建 */
  }
  if (entries === null) {
    await fs.mkdir(ROOT, { recursive: true });
    entries = [];
  }
  if (entries.length > 0 && !(await isSandbox())) {
    console.error(
      `拒绝启动：${ROOT} 里已经有东西，但没有本工具的沙箱标记。\n` +
        '\n' +
        '这个目录不是我建的，我不知道里面是什么 —— 而本服务带着两个删除端点。\n' +
        '如果这是你真实的模型库，删除端点会真的把已装的包删掉（这正是这道闸门存在的原因）。\n' +
        '\n' +
        '要么换一个空目录 / 不存在的路径，要么确认它是沙箱后手工放下标记：\n' +
        `  touch ${SANDBOX_MARK}\n`,
    );
    process.exit(2);
  }
  await fs.writeFile(
    SANDBOX_MARK,
    `openmemo reference-server sandbox\n` +
      `本文件是删除类操作的许可证（见 reference-server.mjs 文件头 ③）。\n` +
      `删掉它，DELETE /api/models/:id 与 POST /api/models/gc 就会被拒绝执行。\n` +
      `created-by-pid: ${process.pid}\ncreated-at: ${new Date().toISOString()}\n`,
    'utf8',
  );
}

/**
 * 每次删除前**重新读一遍磁盘**，不信任启动时那次检查 ——
 * 进程可能已经跑了几个小时，`--models-root` 底下的东西可能已经不是启动时那份了
 * （例如有人把它换成了指向真实 store 的符号链接）。
 * 这一步很便宜（一次 `access`），而它挡住的是"删错了就没了"。
 */
async function assertDeletable(res) {
  if (await isSandbox()) return true;
  // apiError(res, status, code, messageZh, remediation?) —— 第 4 个就是给人看的那句
  apiError(
    res,
    403,
    'NOT_A_SANDBOX',
    `拒绝删除：${ROOT} 里没有参考服务器的沙箱标记，它可能是真实的模型库`,
  );
  return false;
}

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
    os: {
      platform: process.platform,
      arch: process.arch === 'x64' ? 'x64' : 'arm64',
      version: os.release(),
    },
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
    /*
     * `probed` (T-168): did this run actually LOAD the backend's library? This box has one
     * CPU pack and nothing else, so cpu was loaded and the accelerators never were —
     * hence probed:false, and reasons that say "not installed" rather than blaming a
     * driver nobody measured. See BackendStatus.probed in @openmemo/shared.
     *
     * ★★ T-194: `BackendStatus` is now a DISCRIMINATED UNION and this file is one of its
     * four shape copies (TS interface / zod schema / openapi / this mock). Two rules the
     * TypeScript side now enforces at compile time — and which this file, being plain JS,
     * must honour by hand:
     *   · available: true  => probed MUST be true, and NO unavailableReason;
     *   · available: false => unavailableReason is REQUIRED (saying "unavailable" without
     *     saying why is the shape this repo keeps cleaning up).
     * ⚠️ HONEST GAP: nothing validates this file automatically. It calls `server.listen()`
     * at module scope, so a test cannot import it without starting a server, and no test
     * spawns it either. The six entries below were checked by hand against the union on
     * 2026-08-10 (all six legal). **If you add or edit one, check it by hand too** —
     * there is no net under this one.
     */
    backends: [
      {
        id: 'cpu',
        available: true,
        installed: true,
        probed: true,
        version: null,
        deviceIndex: null,
        isa: features.includes('avx2') ? 'avx2' : 'baseline',
      },
      {
        id: 'cuda',
        available: false,
        installed: false,
        probed: false,
        version: null,
        deviceIndex: null,
        unavailableReason: '未安装 CUDA 后端包（本次探测没有加载过它，故对驱动不作结论）',
      },
      {
        id: 'vulkan',
        available: false,
        installed: false,
        probed: false,
        version: null,
        deviceIndex: null,
        unavailableReason: '未安装 Vulkan 后端包（本次探测没有加载过它，故对驱动不作结论）',
      },
      {
        id: 'rocm',
        available: false,
        installed: false,
        probed: false,
        version: null,
        deviceIndex: null,
        unavailableReason: '未安装 ROCm 后端包（本次探测没有加载过它，故对驱动不作结论）',
      },
      {
        id: 'metal',
        available: false,
        installed: false,
        probed: false,
        version: null,
        deviceIndex: null,
        unavailableReason: '仅 macOS 可用',
      },
      {
        id: 'coreml',
        available: false,
        installed: false,
        probed: false,
        version: null,
        deviceIndex: null,
        unavailableReason: '仅 macOS 可用',
      },
    ],
    selectedBackend: 'cpu',
    selectedGpuIndex: null,
    disks: [
      { mount: '/', pathFor: 'models_root', path: ROOT, freeMB: diskFreeMB, totalMB: diskTotalMB },
    ],
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

/**
 * 当前选中的模型。**每次启动都从空开始 —— 刻意不读上一次留下的 `active.json`。**
 *
 * 原来这里是 `readJson(ROOT/active.json)` 然后 `Object.assign(activeState, s)`：
 * 把**自己上一次运行写下的东西**当作这一次的事实来源。
 * 那是本项目反复撞见的形状 —— 工具读回自己的输出，于是"上一次跑出的状态"
 * 会悄悄影响"这一次的结论"，而两次之间发生过什么没有任何人知道。
 * 参考服务器的用途是**每次给出可复现的起点**，读回历史正好毁掉这一点。
 */
const activeState = { asr: null, llm: null };
/**
 * 仍然写，但**永远不读回来**（上面那段说明了原因）——
 * 它是给人事后查看的产物，不是状态来源。改动这里之前先读文件头 ②。
 */
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
        // ADR-011: reference speed + measured language suitability.
        // Only `kind: 'measured'` yields a number — an estimate must not be shown as a
        // reference measurement, so it deliberately degrades to 「速度未测量」.
        referenceRtf: referenceSpeedOf(m.speedEvidence)?.rtf ?? null,
        referenceBackend: referenceSpeedOf(m.speedEvidence)?.backend ?? null,
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
      // #90：契约里刻度已升格成 ProgressReading（判别式联合），裸数字不再合法
      progress: job.totalBytes
        ? { kind: 'fraction', value: job.completedBytes / job.totalBytes }
        : { kind: 'unreportable', reason: 'no_denominator' },
      completedBytes: job.completedBytes,
      totalBytes: job.totalBytes,
      speedBps: job.speedBps,
      etaSeconds: job.etaSeconds,
      state: job.state,
    }),
  ),
);
queue.on('job.state', (job, prev) =>
  emit(
    makeEvent('job.state', topics.job(job.jobId), {
      jobId: job.jobId,
      state: job.state,
      previousState: prev,
    }),
  ),
);
queue.on('job.failed', (job) =>
  emit(
    makeEvent('job.failed', topics.job(job.jobId), {
      jobId: job.jobId,
      error: job.error ?? {
        code: 'INTERNAL',
        message: 'failed',
        messageZh: '失败',
        retryable: false,
      },
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
        model.files[0].mirrors.map((m) => ({
          provider: m.provider,
          url: m.url,
          official: m.official,
        })),
      );
      emit(
        makeEvent('sources.probed', topics.models(), {
          effective: probes.find((p) => p.ok)?.provider ?? 'none',
          probes: probes.map((p) => ({
            id: p.provider,
            ok: p.ok,
            ttfbMs: p.ttfbMs,
            throughputKbps: p.throughputKbps,
          })),
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
      emit(
        makeEvent('storage.changed', topics.models(), {
          usedBytes: st.usedBytes,
          freeBytes: st.volume.freeBytes,
        }),
      );
    },
  );
  return { job, deduplicated };
}

/* --------------------------------- HTTP ----------------------------------- */

function json(res, status, body) {
  // A streaming response (SSE) may already have flushed headers before an error surfaces;
  // writing them again throws ERR_HTTP_HEADERS_SENT and kills the whole server process.
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* already closed */
    }
    return;
  }
  const b = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': b.length,
  });
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

/**
 * Transparent reverse proxy to the upstream daemon.
 *
 * Forwards method/headers/body verbatim so cookies and auth behave as same-origin.
 * The Origin/Referer rewrite is required: the daemon enforces a same-origin check and
 * from its perspective THIS process is the browser — without the rewrite every POST is
 * rejected with "请求来源不被信任" and no mutation can be exercised at all.
 */
async function proxyUpstream(req, res, url, method) {
  if (!PROXY) return apiError(res, 404, 'NOT_FOUND', `未配置上游: ${method} ${url.pathname}`);
  const target = new URL(url.pathname + url.search, PROXY);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  if (headers.origin) headers.origin = PROXY;
  if (headers.referer) headers.referer = PROXY + '/';
  try {
    const up = await fetch(target, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'manual',
    });
    const out = {};
    up.headers.forEach((v, k) => {
      if (k !== 'content-encoding' && k !== 'content-length' && k !== 'transfer-encoding')
        out[k] = v;
    });
    // Set-Cookie must go INTO the header object before writeHead. Calling
    // res.setHeader() afterwards throws ERR_HTTP_HEADERS_SENT, which silently aborted the
    // response and meant the browser never received its session cookie — every subsequent
    // request then 401'd and the whole app looked broken.
    const sc = up.headers.getSetCookie?.();
    if (sc?.length) out['set-cookie'] = sc;
    // SSE and other streaming responses must be piped, not buffered — buffering an
    // event stream would make the browser wait forever for a body that never ends.
    const ct = up.headers.get('content-type') ?? '';
    res.writeHead(up.status, out);
    if (ct.includes('text/event-stream') && up.body) {
      const reader = up.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      return res.end();
    }
    return res.end(Buffer.from(await up.arrayBuffer()));
  } catch (e) {
    return apiError(res, 502, 'UPSTREAM_UNREACHABLE', `上游 daemon 无法访问: ${e?.message ?? e}`);
  }
}

// A crashed request handler must never take the server down mid-test-run.
process.on('uncaughtException', (e) => {
  console.error('[refserver] uncaught:', e?.message ?? e);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const method = req.method ?? 'GET';

  try {
    // In pure-shim mode nothing below is ours; jump straight to the proxy branch.
    if (PROXY_ALL && (p.startsWith('/api/') || p.startsWith('/ws/') || p.startsWith('/media/'))) {
      return await proxyUpstream(req, res, url, method);
    }

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

    /* ---- components: provenance + upstream version tracking (T-068) ---- */
    if (p === '/api/components' && method === 'GET') {
      /*
       * ★ 与真 daemon 用**同一个**解析函数。这里原来是 `=== 'true'`，而真 daemon 是
       * `=== '1'` —— 前端对上的是这台参考服务器，对不上真 daemon，于是
       * `?check=true` 在真 daemon 上静默地什么都不做。漂移的修法不是对齐字面量，
       * 是让它只有一份定义（`packages/shared/src/components.ts`）。
       */
      const check = parseComponentsCheckParam(url.searchParams.get(COMPONENTS_CHECK_PARAM));
      if (!check && componentCache) return json(res, 200, componentCache);
      const r = await listComponents({
        registryPath: COMPONENT_REGISTRY,
        store,
        checkUpstream: check,
        timeoutMs: 15000,
      });
      if (check) componentCache = r;
      return json(res, 200, r);
    }
    if (p === '/api/components/check' && method === 'POST') {
      await readBody(req);
      const r = await listComponents({
        registryPath: COMPONENT_REGISTRY,
        store,
        checkUpstream: true,
        timeoutMs: 15000,
      });
      componentCache = r;
      return json(res, 200, r);
    }
    if (p === '/api/components/update' && method === 'POST') {
      const body = await readBody(req);
      // Reference server does not perform the swap; it proves the contract shape.
      return json(res, 202, {
        jobId: `job_${Date.now().toString(36)}`,
        id: body.id,
        toVersion: body.toVersion ?? null,
      });
    }
    // 回滚端点已整体删除（docs/adr/ADR-017-component-rollback-removed.md）。
    // 它此前 mock 的路径 `/api/components/rollback` 跟真路由本来也对不上。

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
        return ok
          ? (res.writeHead(204), res.end())
          : apiError(res, 409, 'NOT_FOUND', '任务不存在或已结束');
      }
      if (action === 'retry') {
        const j = queue.retry(jobId);
        return j
          ? json(res, 202, {
              jobId: j.jobId,
              state: j.state,
              targetId: j.targetId,
              totalBytes: j.totalBytes,
              eventsUrl: '/api/events',
              deduplicated: false,
            })
          : apiError(res, 409, 'NOT_FOUND', '任务不可重试');
      }
      return apiError(res, 501, 'NOT_IMPLEMENTED', '暂未实现');
    }

    if (p === '/api/models/activate' && method === 'POST') {
      const body = await readBody(req);
      const prev = activeState[body.role] ?? null;
      activeState[body.role] = body.id;
      await persistActive();
      emit(
        makeEvent('model.activated', topics.models(), {
          role: body.role,
          modelId: body.id,
          previous: prev,
        }),
      );
      return json(res, 200, {
        role: body.role,
        active: body.id,
        previous: prev,
        reloadRequired: true,
      });
    }

    if (p === '/api/models/gc' && method === 'POST') {
      if (!(await assertDeletable(res))) return; // 见文件头 ③
      const body = await readBody(req);
      const r = await store.collectGarbage(body.targets ?? ['orphan_blobs', 'stale_partials']);
      const st = await buildStorage();
      emit(
        makeEvent('storage.changed', topics.models(), {
          usedBytes: st.usedBytes,
          freeBytes: st.volume.freeBytes,
        }),
      );
      return json(res, 200, r);
    }

    const delMatch = /^\/api\/models\/(.+)$/.exec(p);
    if (delMatch && method === 'DELETE') {
      if (!(await assertDeletable(res))) return; // 见文件头 ③
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
      emit(
        makeEvent('storage.changed', topics.models(), {
          usedBytes: st.usedBytes,
          freeBytes: st.volume.freeBytes,
        }),
      );
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
        const applicable =
          pk.os === process.platform && pk.arch === (process.arch === 'x64' ? 'x64' : 'arm64');
        const backendAvailable =
          hardware.backends.find((b) => b.id === pk.backend)?.available ?? false;
        return {
          ...pk,
          installed: false,
          applicable: applicable && backendAvailable,
          inapplicableReason: !applicable
            ? `适用于 ${pk.os}/${pk.arch}，与本机不符`
            : !backendAvailable
              ? (hardware.backends.find((b) => b.id === pk.backend)?.unavailableReason ??
                '该后端在本机不可用')
              : null,
          recommended: applicable && backendAvailable && pk.backend === hardware.selectedBackend,
        };
      });
      return json(res, 200, {
        catalogVersion: backendDoc.catalogVersion,
        source: 'bundled',
        stale: true,
        packs,
      });
    }

    if (p === '/api/backends/installed') {
      return json(res, 200, { packs: [], selectedBackend: hardware.selectedBackend });
    }

    if (p === '/api/models/benchmark' && method === 'POST') {
      // Not implemented: needs the real engine binary. Fail loudly rather than fake a number.
      return apiError(
        res,
        501,
        'NOT_IMPLEMENTED',
        '基准测试需要已安装的推理后端，参考服务器未实现',
      );
    }

    if (p.startsWith('/api/') || p.startsWith('/ws/') || p.startsWith('/media/')) {
      if (PROXY) {
        return await proxyUpstream(req, res, url, method);
      }
      return apiError(res, 404, 'NOT_FOUND', `参考服务器未实现 ${method} ${p}`);
    }

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
  console.log(
    `  proxy       : ${PROXY ?? '(none — unmatched /api returns 404)'}${PROXY_ALL ? '  [PROXY-ALL: serving static only]' : ''}`,
  );
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
await sleep(1);
