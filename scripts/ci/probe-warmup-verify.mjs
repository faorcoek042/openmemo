#!/usr/bin/env node
/**
 * T-172 —— **装包时的捂热，到底有没有把冷启动消掉？** 在一台真·冷 macOS runner 上验。
 *
 * ── 它和 probe-cold-timing.mjs 的分工 ────────────────────────────────────────
 *
 * `probe-cold-timing.mjs` 回答的是「冷启动有多贵」（实测 16092ms）。
 * 这个脚本回答的是**产品的修复到底成不成立**，而且用的是**产品自己那个函数**
 * （`apps/daemon/dist/runtime/warmup.js` 的 `warmProbeCache()`），不是脚本里另写一发长超时。
 * 差别不是形式：`warmProbeCache()` 自带 macOS 闸门、Metal 库结构判据、以及它自己的预算 ——
 * 这三件事都可能在真机上判错，而在 Linux 上永远暴露不出来。
 *
 * ── 为什么必须是一个**独立的 job** ──────────────────────────────────────────
 *
 * 与 probe-cold-timing 同一个理由，且更强：要验「捂热之后默认 10s 够不够」，
 * 就必须让捂热是这台机器上**第一次**碰 Metal。同 job 里但凡先跑过一发探针，
 * 缓存就热了，后面量到的一律是热数 —— 结论看起来漂亮，却什么都没验。
 * runner 是一次性的，每个 job 都是一台全新的冷机器，所以换个 job 就没有这个问题。
 *
 * ── 一个 job 里同时拿到两条臂 ────────────────────────────────────────────────
 *
 *   臂 A（不捂热会怎样）：捂热自己那一发的耗时。它 > PROBE_TIMEOUT_MS 就等于
 *                        「同一时刻用产品默认超时去探，必然超时」——
 *                        这正是今天冷 Mac 上发生的事。
 *   臂 B（捂热之后）    ：紧接着用**产品默认超时**（不传 timeoutMs）再探一发。
 *                        它 ok 且远小于 10s，才叫"冷启动被消掉了"。
 *
 * ── 判据（这个脚本**可以**把 CI 弄红，与 probe-cold-timing 不同）────────────
 *
 * 它验的是一条**产品声明**，不是取一个数。所以：
 *   · 捂热成功、而随后默认超时那一发仍然失败 → **exit 1**（声明被证伪）
 *   · 捂热没能跑（没探针 / 目录里没有 Metal 库 / 非 darwin）→ 如实报告，**exit 0**
 *     （拿不到结论 ≠ 结论是坏的，不许拿环境问题冒充失败）
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const say = (s = '') => process.stdout.write(`${s}\n`);
const hdr = (t) => {
  say();
  say('─'.repeat(94));
  say(`── ${t}`);
  say('─'.repeat(94));
};

/** `ggml_metal_library_init: loaded in 20.959 sec` → 20.959（秒）。拿不到就 null。 */
function metalInitSeconds(stderr) {
  const m = /ggml_metal_library_init:\s*loaded in\s*([0-9.]+)\s*sec/.exec(stderr ?? '');
  return m ? Number(m[1]) : null;
}

async function main() {
  hdr('0. 这台机器是什么 + 冷度声明');
  say(`   platform=${process.platform}  arch=${process.arch}  node=${process.version}`);
  say();
  say('   ★ 本 job 到此为止**没有起过 daemon、没有跑过自检、没有跑过转写、没有跑过探针**。');
  say('     下面第 2 节那一发（产品的 warmProbeCache）是这台机器上的第一次 Metal 初始化。');

  if (process.platform !== 'darwin') {
    say();
    say(`   本脚本只在 macOS 上有意义（当前 ${process.platform}）—— 不编结论，exit 0。`);
    return 0;
  }

  /* ── 1. 用产品自己的安装器把包装上（不经 daemon，不碰 Metal）── */
  hdr('1. 安装后端包（产品自己的 install()，这一步不触碰 Metal）');

  const dl = await import(pathToFileURL(join(REPO, 'packages/downloader/dist/index.js')).href);
  const pl = await import(pathToFileURL(join(REPO, 'packages/pipeline/dist/index.js')).href);
  const rt = await import(pathToFileURL(join(REPO, 'packages/runtime/dist/index.js')).href);
  const warmup = await import(pathToFileURL(join(REPO, 'apps/daemon/dist/runtime/warmup.js')).href);

  const manifest = JSON.parse(await readFile(join(REPO, 'vendor/manifests/backends.json'), 'utf8'));
  const packs = manifest.packs ?? manifest.items ?? [];
  /*
   * ★ `availability: 'pending-ci'` 的包**必须排除**：那种条目「构建过、摘要也核过，
   * 但没有发布到任何地方」，清单自己写着不许当成下载项（发一个 404 的 URL
   * 比承认缺口更糟）。`whispercpp-metal-macos-arm64` 今天就是这一档 ——
   * 不滤掉的话这个脚本会挑中它然后死在下载上，而那与捂热一点关系都没有。
   */
  const usable = packs.filter(
    (p) =>
      p.os === process.platform &&
      p.arch === process.arch &&
      p.engine === 'whisper.cpp' &&
      p.availability !== 'pending-ci' &&
      (p.providesFiles ?? []).some((f) => f.startsWith('openmemo-probe')),
  );
  // 优先挑真的带 Metal 后端库的那个 —— 捂的就是它。
  const pack =
    usable.find((p) => (p.providesFiles ?? []).some((f) => /ggml-metal/.test(f))) ?? usable[0];
  if (!pack) {
    say(
      `   ✘ 目录里没有适用于 ${process.platform}/${process.arch} 且带探针的包 —— 无从验证，exit 0。`,
    );
    return 0;
  }
  say(`   包：${pack.id}  大小：${pack.totalSizeBytes} B`);

  // mkdtemp：绝不碰 ~/.local/share/openmemo/datadir.json，也不碰任何真实数据目录。
  const dataDir = await mkdtemp(join(tmpdir(), 'openmemo-warmup-verify-'));
  const storeRoot = join(dataDir, 'models');
  say(`   临时数据目录（mkdtemp，用完即删）：${dataDir}`);

  const store = new dl.ArtifactStore(storeRoot);
  await dl.install({
    store,
    target: { id: pack.id, kind: 'backend', displayName: pack.displayName, files: pack.files },
    platform: { os: process.platform, arch: process.arch },
    maxParts: 4,
  });
  say('   ✔ 装好了');

  const probeName = 'openmemo-probe';
  const probePath = await pl.findInBackendPacks(storeRoot, probeName);
  if (!probePath || !existsSync(probePath)) {
    say(`   ✘ 装完却找不到探针（${probePath}）—— 无从验证，exit 0。`);
    await rm(dataDir, { recursive: true, force: true });
    return 0;
  }
  const backendDir = dirname(probePath);
  say(`   探针：${probePath}`);
  const libs = (await readdir(backendDir)).filter((f) => /ggml/i.test(f));
  say(`   ggml 库（${libs.length}）：${libs.join(', ') || '(无)'}`);

  /* ── 2. 臂 A：产品自己的捂热函数，这台机器上第一次碰 Metal ── */
  hdr('2. ★ 臂 A —— 产品的 warmProbeCache()（本机第一次 Metal 初始化）');
  say('   注意：调的是 apps/daemon 里那个真函数，macOS 闸门与 Metal 库判据都由它自己决定。');
  say();

  const wallA0 = Date.now();
  const warm = await warmup.warmProbeCache({
    dataDir,
    modelsDir: storeRoot,
    log: (m) => say(`     [warmProbeCache] ${m}`),
  });
  const wallA = Date.now() - wallA0;
  say(
    `   attempted=${warm.attempted}  ok=${warm.ok}  skipped=${warm.skipped ?? '-'}  ` +
      `耗时=${warm.durationMs}ms（墙钟 ${wallA}ms）`,
  );

  if (!warm.attempted) {
    say();
    say(`   ⚠️ 捂热没有真的跑（skipped=${warm.skipped}）。`);
    say('     这不是"修复失败"，是**这台机器上没有可捂的东西**（没探针 / 目录里没有 Metal 库）。');
    say('     如实报告，不编结论 → exit 0。但请注意：这也意味着本次没有验到任何东西。');
    await rm(dataDir, { recursive: true, force: true });
    return 0;
  }

  if (!warm.ok) {
    say();
    say('   ⚠️ 捂热跑了但没成功。下面仍会照跑臂 B —— 因为"捂热失败之后默认超时还是不行"');
    say('     并不能证伪产品声明（声明的前提是捂热成功）。这一格如实记录，不判红。');
  }

  /* ── 3. 臂 B：紧接着用产品默认超时再探一发 ── */
  hdr(`3. ★ 臂 B —— 紧接着用**产品默认超时** ${rt.PROBE_TIMEOUT_MS}ms 再探一发`);
  say('   不传 timeoutMs，走的就是 ADR-003 决策 3 那个 10 秒常量（本轮一个字都没改它）。');
  say();

  const wallB0 = Date.now();
  const after = await rt.runProbe({ probePath, backendDir });
  const wallB = Date.now() - wallB0;
  const sec = metalInitSeconds(after.stderr);
  say(
    `   ok=${after.ok}  耗时=${after.durationMs}ms（墙钟 ${wallB}ms）` +
      (after.ok ? '' : `  kind=${after.kind}  message=${after.message}`) +
      (sec !== null ? `  metal_library_init=${sec}s` : ''),
  );

  /* ── 4. 判据 ── */
  hdr('4. 判据');

  const wouldHaveTimedOut = warm.durationMs > rt.PROBE_TIMEOUT_MS;
  say(
    `   臂 A（不捂热会怎样）：捂热那一发 ${warm.durationMs}ms ` +
      `${wouldHaveTimedOut ? '>' : '≤'} ${rt.PROBE_TIMEOUT_MS}ms → ` +
      (wouldHaveTimedOut
        ? '**同一时刻用产品默认超时去探必然超时** —— 这正是今天冷 Mac 上发生的事。'
        : '这台机器本身就没有冷启动问题（默认超时够用），本次无从证明修复的价值。'),
  );
  say(
    `   臂 B（捂热之后）    ：默认 ${rt.PROBE_TIMEOUT_MS}ms 那一发 ok=${after.ok}，` +
      `耗时 ${after.durationMs}ms`,
  );
  say();

  say(
    `   RESULT_JSON ${JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      pack: pack.id,
      probeTimeoutMs: rt.PROBE_TIMEOUT_MS,
      warm: {
        attempted: warm.attempted,
        ok: warm.ok,
        skipped: warm.skipped,
        durationMs: warm.durationMs,
      },
      afterWarm: { ok: after.ok, durationMs: after.durationMs, kind: after.kind ?? null },
      wouldHaveTimedOutWithoutWarmup: wouldHaveTimedOut,
    })}`,
  );

  await rm(dataDir, { recursive: true, force: true });

  if (warm.ok && !after.ok) {
    say();
    say('   ✘ **产品声明被证伪**：捂热明明成功了，紧接着用默认超时那一发却仍然失败。');
    say('     "装包时捂热就能让此后的探测走 10s 阈值" 这句话在这台机器上不成立。');
    return 1;
  }

  if (warm.ok && after.ok && wouldHaveTimedOut) {
    say();
    say(`   ✔ **冷启动被消掉了**：捂热付了 ${warm.durationMs}ms（一次性），`);
    say(`     此后默认 ${rt.PROBE_TIMEOUT_MS}ms 那一发 ${after.durationMs}ms 就返回了。`);
    say('     用户从不在交互路径上付那一笔，10s 这个诊断阈值也保住了。');
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    say(`✘ 脚本自身出错：${err?.stack ?? String(err)}`);
    process.exit(1);
  },
);
