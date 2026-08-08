#!/usr/bin/env node
/**
 * 探针冷启动真实耗时 —— 把「冷」那一发放在机器的第一件事上
 *
 * ── 这个脚本存在的唯一理由 ────────────────────────────────────────────────────────
 *
 * `cold-start-audit` 的 §6b 已经定性成功：darwin-arm64 上探针超时**不是挂，是慢**，
 * 慢在 `ggml_metal_library_init`。但它拿不到**真实的冷启动耗时**，原因是一条
 * 看起来无法回避的互斥：
 *
 *   > 要量就得先跑一发长超时的，而那会捂热 Metal 缓存、毁掉要复现的现象本身。
 *
 * **这条互斥只在同一个 job 内成立。** runner 是一次性的，每个 job 都是全新的冷机器。
 * 所以答案是**换一个 job**，而不是在同一个 job 里想办法。
 *
 * 这个脚本就是那个 job 的全部内容：**它什么都不做，第一件事就是用长超时跑探针。**
 * 不起 daemon、不跑自检、不转写、不装模型。
 *
 * ── 为什么绝不能起 daemon ──────────────────────────────────────────────────────
 *
 * `apps/daemon/src/runtime/setup.ts:496` 在启动路径上就调了 `runProbe()`。
 * 也就是说**只要 daemon 起来过，Metal 就已经被捂热了**，后面量到的都是热数。
 * §6b 之所以量不到，根因正是它跑在 daemon 起来之后。
 * 所以这里直接用 `packages/downloader` 的 `install()` 把包装上 —— 产品自己的安装器，
 * 只是不经过 HTTP 那一层，因而**不触发任何 Metal 初始化**。
 *
 * ── 不改产品常量 ───────────────────────────────────────────────────────────────
 *
 * `PROBE_TIMEOUT_MS` 是 ADR-003 决策 3 定死的 10 秒，**这里一个字没动**。
 * 放宽的是 `runProbe()` 的 `timeoutMs` **入参**（它本来就接受），且只在本脚本里。
 * 调的也刻意是**产品自己那个函数** —— 自己另写一个 spawn 就等于换了环境变量、
 * 换了参数、换了解析，测的就不是同一件事了。
 *
 * ── 两条对立的预测（写在跑之前，免得事后编故事）────────────────────────────────
 *
 * `cold-start-audit` run 31167151669 的 macOS 屏蔽组打出过这么两发：
 *     第 1 发 默认 10s  → timeout，10010ms，stderr 停在 `using embedded metal library`
 *     第 2 发 放宽 120s → ok，21103ms，`ggml_metal_library_init: loaded in 20.959 sec`
 * 而同一台机器上稍后的对照组第 1 发就 ok，93ms，`loaded in 0.016 sec`。
 *
 * 于是「21103ms 到底算不算冷启动耗时」有两种读法，**它们给出可区分的预测**：
 *
 *   H1「第 1 发被 kill 掉，什么也没留下」
 *      → Metal 缓存是**全有全无**的，第 2 发是从零开始的完整一发。
 *      → 本脚本的冷发应当 ≈ **21 秒**（与 21103ms 同量级）。
 *
 *   H2「第 1 发那 10 秒是有用功，第 2 发接着它往下做」
 *      → 21103ms 是**被污染的偏低值**，真实冷启动应当是两者之和。
 *      → 本脚本的冷发应当 ≈ **31 秒**（10 + 21）。
 *
 * 本脚本的冷发是这台机器上的**第一次** Metal 初始化，不存在前一发，
 * 所以它直接判定 H1 / H2 —— 这正是同一个 job 内做不到的那件事。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────────────
 *
 *   node scripts/ci/probe-cold-timing.mjs [--long-ms 120000] [--pack <id>]
 *
 * 只观测，不做判据：**永远 exit 0**，除非脚本自身出错（装不上包、找不到探针）。
 * 一个用来取数的脚本没有资格因为"数不好看"把 CI 弄红。
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const argv = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const LONG_MS = Number(argOf('--long-ms', '120000'));
const WANT_PACK = argOf('--pack', null);

const say = (s = '') => process.stdout.write(`${s}\n`);
const hdr = (t) => {
  say();
  say('─'.repeat(94));
  say(`── ${t}`);
  say('─'.repeat(94));
};

/** `ggml_metal_library_init: loaded in 20.959 sec` → 20.959 (秒)。拿不到就 null。 */
function metalInitSeconds(stderr) {
  const m = /ggml_metal_library_init:\s*loaded in\s*([0-9.]+)\s*sec/.exec(stderr ?? '');
  return m ? Number(m[1]) : null;
}

/** 探针是否连 metal 库都还没开始加载就被砍了（stderr 停在 using embedded metal library）。 */
function stoppedAtMetalInit(stderr) {
  const s = stderr ?? '';
  return (
    s.includes('ggml_metal_library_init: using embedded metal library') &&
    metalInitSeconds(s) === null
  );
}

function fmt(r) {
  const parts = [`ok=${r.ok}`, `耗时=${r.durationMs}ms`];
  if (!r.ok) parts.push(`kind=${r.kind}`, `message=${r.message}`);
  const sec = metalInitSeconds(r.stderr);
  if (sec !== null) parts.push(`metal_library_init=${sec}s`);
  return parts.join('  ');
}

function dumpStderr(r, indent = '      ') {
  say('   ── stderr 全文 ──');
  say(
    r.stderr
      ? r.stderr
          .split('\n')
          .map((l) => `${indent}${l}`)
          .join('\n')
      : `${indent}(空)`,
  );
}

async function main() {
  hdr('0. 这台机器是什么 + 它现在有多冷');

  say(`   platform=${process.platform}  arch=${process.arch}  node=${process.version}`);
  say(`   长超时入参 = ${LONG_MS}ms（产品常量 PROBE_TIMEOUT_MS 未改）`);
  say();
  say('   ★ 冷度声明：本 job 到此为止**没有起过 daemon、没有跑过自检、没有跑过转写**。');
  say('     下面第 2 节那一发，是这台机器上的第一次 Metal 初始化。');
  say('     （daemon 的启动路径 apps/daemon/src/runtime/setup.ts:496 自己就会 runProbe()，');
  say('      所以只要它起来过，后面量到的一律是热数 —— 这正是 §6b 量不到的根因。）');

  /* ── 1. 用产品自己的安装器把包装上（不经 daemon，不碰 Metal）── */

  hdr('1. 安装后端包（产品自己的 install()，不经 daemon —— 这一步不触碰 Metal）');

  const dl = await import(pathToFileURL(join(REPO, 'packages/downloader/dist/index.js')).href);
  const pl = await import(pathToFileURL(join(REPO, 'packages/pipeline/dist/index.js')).href);
  const rt = await import(pathToFileURL(join(REPO, 'packages/runtime/dist/index.js')).href);

  const manifest = JSON.parse(await readFile(join(REPO, 'vendor/manifests/backends.json'), 'utf8'));
  const packs = manifest.packs ?? manifest.items ?? [];

  // 挑本平台的 whisper.cpp 包 —— 探针（openmemo-probe）就在里面（T-167①）。
  const pack =
    (WANT_PACK ? packs.find((p) => p.id === WANT_PACK) : null) ??
    packs.find(
      (p) =>
        p.os === process.platform &&
        p.arch === process.arch &&
        p.engine === 'whisper.cpp' &&
        (p.providesFiles ?? []).some((f) => f.startsWith('openmemo-probe')),
    );

  if (!pack) {
    say(`   ✘ 目录里没有适用于 ${process.platform}/${process.arch} 且带探针的 whisper.cpp 包。`);
    say('     → 本平台无从测量，如实报告，不编数。');
    return;
  }
  say(`   包：${pack.id}  (${pack.displayName})`);
  say(`   大小：${pack.totalSizeBytes} B`);

  // mkdtemp：绝不碰 ~/.local/share/openmemo/datadir.json，也不碰任何真实数据目录。
  const storeRoot = await mkdtemp(join(tmpdir(), 'openmemo-probe-timing-'));
  say(`   临时 store（mkdtemp，用完即删）：${storeRoot}`);

  const store = new dl.ArtifactStore(storeRoot);
  const t0 = Date.now();
  await dl.install({
    store,
    target: { id: pack.id, kind: 'backend', displayName: pack.displayName, files: pack.files },
    platform: { os: process.platform, arch: process.arch },
    maxParts: 4,
  });
  say(`   ✔ 装好了，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const probeName = process.platform === 'win32' ? 'openmemo-probe.exe' : 'openmemo-probe';
  const probePath = await pl.findInBackendPacks(storeRoot, probeName);
  if (!probePath || !existsSync(probePath)) {
    say(`   ✘ 装完了却找不到探针（findInBackendPacks 返回 ${probePath}）—— 这本身就是个结论。`);
    await rm(storeRoot, { recursive: true, force: true });
    return;
  }
  const backendDir = dirname(probePath);
  say(`   探针：${probePath}`);
  try {
    const libs = (await readdir(backendDir)).filter((f) => /ggml|metal|vulkan|cuda|blas/i.test(f));
    say(`   后端库（${libs.length}）：${libs.join(', ') || '(无)'}`);
  } catch {
    /* 列目录失败不影响测量本身 */
  }

  const results = {};

  /* ── 2. 冷的那一发：这台机器上的第一次 Metal 初始化 ── */

  hdr(`2. ★ 冷发：长超时 ${LONG_MS}ms —— 本机第一次 GPU/后端初始化`);
  say('   （这一发就是 §6b 在结构上拿不到的那个数。）');
  say();
  const coldWall0 = Date.now();
  const cold = await rt.runProbe({ probePath, backendDir, timeoutMs: LONG_MS });
  const coldWall = Date.now() - coldWall0;
  say(`   ${fmt(cold)}   （墙钟 ${coldWall}ms）`);
  dumpStderr(cold);
  results.cold = {
    durationMs: cold.durationMs,
    wallMs: coldWall,
    ok: cold.ok,
    kind: cold.kind ?? null,
    metalSec: metalInitSeconds(cold.stderr),
  };

  /* ── 3. 紧接着的热发：对照系 ── */

  hdr(`3. ★ 热发（对照）：产品默认超时 ${rt.PROBE_TIMEOUT_MS}ms，紧接着再跑一遍`);
  say('   没有这一发，"冷的花了 N 秒"就没有参照系。');
  say();
  const warm = await rt.runProbe({ probePath, backendDir });
  say(`   ${fmt(warm)}`);
  dumpStderr(warm);
  results.warm = {
    durationMs: warm.durationMs,
    ok: warm.ok,
    kind: warm.kind ?? null,
    metalSec: metalInitSeconds(warm.stderr),
  };

  hdr('4. 第二发热的（确认热态是稳的，不是刚好赶上）');
  const warm2 = await rt.runProbe({ probePath, backendDir });
  say(`   ${fmt(warm2)}`);
  results.warm2 = {
    durationMs: warm2.durationMs,
    ok: warm2.ok,
    metalSec: metalInitSeconds(warm2.stderr),
  };

  /* ── 5. 读数 ── */

  hdr('5. 读数（只依据上面三发的实测输出）');

  say(
    `   冷发   ok=${cold.ok}  ${cold.durationMs}ms  metal_library_init=${results.cold.metalSec ?? 'n/a'}s`,
  );
  say(
    `   热发   ok=${warm.ok}  ${warm.durationMs}ms  metal_library_init=${results.warm.metalSec ?? 'n/a'}s`,
  );
  say(
    `   热发2  ok=${warm2.ok}  ${warm2.durationMs}ms  metal_library_init=${results.warm2.metalSec ?? 'n/a'}s`,
  );
  say();

  if (!cold.ok) {
    if (cold.kind === 'timeout') {
      say(`   ✘ 冷发在 ${LONG_MS}ms 内**仍然没有返回** —— 「慢」这个定性被证伪，它是真的卡住。`);
      say('     → §6b 之前那个 21103ms 就需要重新解释了。');
      if (stoppedAtMetalInit(cold.stderr)) {
        say('     stderr 停在 `using embedded metal library` 且没有 `loaded in …` ——');
        say('     即卡在 Metal 着色器库初始化那一步内部，不是别处。');
      }
    } else {
      say(`   ✘ 冷发不是超时而是 ${cold.kind}：${cold.message}`);
      say('     → 既不是慢也不是挂，落到"崩溃/执行失败"那一类。');
    }
    say('   本轮拿不到冷启动耗时，如实标 UNKNOWN，不用别的数去顶替。');
  } else {
    const ratio = warm.durationMs > 0 ? (cold.durationMs / warm.durationMs).toFixed(0) : 'n/a';
    say(
      `   ✔ 冷发成功，耗时 **${cold.durationMs}ms**（≈ ${(cold.durationMs / 1000).toFixed(1)} 秒）。`,
    );
    say(`     热发 ${warm.durationMs}ms —— 冷 / 热 ≈ ${ratio}×。`);
    say();
    /*
     * ★ H1/H2 只对「冷发真的付了 Metal 初始化那笔钱」的平台有意义。
     *   Linux/Windows 上探针根本不碰 Metal（冷发也就十几毫秒），
     *   在那儿印 H1/H2 是拿一个 macOS 的问题去套一个没有这个问题的平台 ——
     *   本仓最贵的那类错误就是"判据长得像结论"。所以这里先问有没有资格判。
     */
    const metalObserved = results.cold.metalSec !== null || results.warm.metalSec !== null;
    if (!metalObserved) {
      say('   ── H1 / H2 判定：**本平台不适用** ──');
      say('     stderr 里没有 `ggml_metal_library_init` —— 这台机器上探针根本不初始化 Metal，');
      say('     "冷启动第一发很贵"这个现象在这里不存在，也就没有 H1/H2 可判。');
      say(`     （本平台冷发 ${cold.durationMs}ms，本身就远在 ${rt.PROBE_TIMEOUT_MS}ms 之内。）`);
    } else {
      const s = cold.durationMs / 1000;
      if (s >= 15 && s <= 26) {
        say(`     冷发 ${s.toFixed(1)}s 落在 ~21s 附近 → **H1 成立**：`);
        say('     被 kill 的那一发什么也没留下，Metal 缓存是全有全无的。');
        say('     → run 31167151669 的 21103ms **不是被污染的值**，它本来就是冷启动耗时。');
      } else if (s >= 27 && s <= 38) {
        say(`     冷发 ${s.toFixed(1)}s 落在 ~31s 附近 → **H2 成立**：`);
        say('     之前那 10 秒是有用功，21103ms 是偏低的污染值。');
        say(`     → 真实冷启动耗时是 ${s.toFixed(1)}s，比之前记的高一档。`);
      } else {
        say(`     冷发 ${s.toFixed(1)}s **两条预测都没落进去**（H1≈21s / H2≈31s）。`);
        say('     → 不硬套：说明 Metal 初始化耗时本身在这批 runner 上就有较大方差，');
        say('       单次测量不足以定值。结论应当写成区间而不是一个数。');
      }
    }
    say();
    say(`   ── 与 PROBE_TIMEOUT_MS = ${rt.PROBE_TIMEOUT_MS}ms 的关系 ──`);
    if (cold.durationMs > rt.PROBE_TIMEOUT_MS) {
      say(
        `     冷发 ${cold.durationMs}ms > ${rt.PROBE_TIMEOUT_MS}ms → **首次探测在这类机器上必然超时**。`,
      );
      say(
        `     要让它一次过，超时得 ≥ ${Math.ceil((cold.durationMs * 1.5) / 1000)}s 量级（含余量）。`,
      );
      say('     ⚠️ 本脚本**不改那个常量**，也不主张改 —— 只把数摆出来供决策。');
    } else {
      say(`     冷发 ${cold.durationMs}ms ≤ ${rt.PROBE_TIMEOUT_MS}ms → 当前超时值对冷启动是够的。`);
    }
  }

  say();
  say('   ── 机器可读（便于回执引用）──');
  say(
    `   RESULT_JSON ${JSON.stringify({ platform: process.platform, arch: process.arch, pack: pack.id, probeTimeoutMs: rt.PROBE_TIMEOUT_MS, longMs: LONG_MS, ...results })}`,
  );

  await rm(storeRoot, { recursive: true, force: true });
  say();
  say(`   已删除临时 store：${storeRoot}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    say(`\n✘ 脚本自身出错：${e?.stack ?? e}`);
    process.exit(1);
  },
);
