/**
 * T-173：断路器的**残留情形** —— 包已经装好了，之后缓存才变冷。
 *
 * ## 这份测试要回答的那个问题
 *
 * T-172 把「装包那条路」修好了：装包末尾捂热，正好落在指纹放行的那一次重试之前，
 * 把它从必然失败变成必然成功。**但它明确留了一条没修**：
 *
 * > 包已装好、之后 shader 缓存才变冷（系统升级清了缓存 / 换用户账户 / 缓存被回收）。
 * > 那时**没有装包动作** → 不会捂热 → **指纹也不变** → 两次超时后同样永久拉黑，零报错。
 *
 * 所以下面这条不是"冷却期算得对不对"的单元测试，是那句话的**端到端反例**：
 * 一台已经装好包的机器，在**指纹一个字节都没变**的前提下探测开始失败，
 * 用户**什么都不做**，产品自己回来了吗？
 *
 * ## 哪些是真的、哪些是替身（先说清楚，免得把结论读大）
 *
 * - **真的**：`detectRuntimeHardware()`、`runProbe()` 子进程、断路器状态机、
 *   指纹计算、恢复探测的调度与单飞 —— 全是产品自己的代码在跑。
 * - **替身 ①**：探针是一个 shell 脚本，不是真的 `openmemo-probe`。
 *   本机是 Linux 且没人构建过 probe，真二进制取不到。
 * - **替身 ②**：跳闸用的是**瞬时 crash（exit 134）**而不是两发 10 s 超时。
 *   `[理由]` 怎么跳的闸与本测试要证的事无关（`recordProbeOutcome` 只看 `result.ok`），
 *   而两发真超时要凭空烧掉 20 秒。**跳闸这件事本身是产品代码真跑的。**
 * - **不是替身**：恢复探测那一发**真的 sleep 12 秒**。这一条不许简化 ——
 *   它就是本测试的核心证据：**那一发活过了 `PROBE_TIMEOUT_MS`。**
 *   冷 Mac 上 Metal 首次初始化实测 12–21 s，而被 kill 的探针什么都不留，
 *   所以"恢复探测用哪个预算"决定了这条残留情形到底能不能自愈。
 *   把预算改回 10 s，这个文件当场变红（已做反向验证）。
 * - **替身 ③**：`now` 注入。等真的一分钟冷却，等于写一条迟早被 skip 的测试。
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BREAKER_COOLDOWN_MS, PROBE_TIMEOUT_MS } from '@openmemo/runtime';

import { breakerRecovery, breakerSnapshot, detectRuntimeHardware } from './setup.js';

/*
 * PROTOCOL §9-bis：指针文件重定向写在**模块顶层**，窗口为零 —— 不靠任何清理代码。
 * 判据是"被 kill -9 在最坏那一行会给机器留下什么"，不是"清理得干不干净"。
 */
const SANDBOX = mkdtempSync(join(tmpdir(), 'om-breaker-'));
process.env['OPENMEMO_POINTER_FILE'] = join(SANDBOX, 'datadir.json');
// 这三个会绕过路径解析，必须确保它们不存在，否则下面造的布局全部失效
delete process.env['OPENMEMO_PROBE'];
delete process.env['OPENMEMO_BACKEND_DIR'];
delete process.env['OPENMEMO_MODELS'];

/** 合法的 probe 输出（`isProbeOutput` 会逐字段校验，糊弄不过去）。 */
const PROBE_JSON = JSON.stringify({
  schemaVersion: 1,
  ggmlVersion: '0.15.1',
  ggmlCommit: 'testcommit',
  searchPath: '/fake',
  deviceCount: 0,
  devices: [],
});

interface Machine {
  dataDir: string;
  modelsDir: string;
  /**
   * 换一台"机器"的行为：
   * `warm` 秒回 · `crash` 立刻 exit 134 · `cold` sleep 12 秒（> 10s 交互预算）·
   * `slow` sleep 2 秒（只为让"同时在跑"这件事有个窗口，不用为它烧掉 12 秒）。
   */
  setMode(mode: 'warm' | 'crash' | 'cold' | 'slow'): void;
  /** 探针到今天为止被 spawn 了多少次。 */
  spawns(): number;
}

let seq = 0;

/**
 * 造一台装好了后端包的机器。
 *
 * ★ 关键：`setMode()` **只写 mode 文件，不碰 probe 二进制本身，也不增删任何库** ——
 * 指纹由「内核版本 + probe 的 size/mtime + backendDir 里的库清单」算出来，
 * 所以这台机器"变冷"之后**指纹一个字节都不变**。这正是残留情形的定义。
 */
function makeMachine(): Machine {
  seq += 1;
  const dataDir = join(SANDBOX, `m-${String(seq)}`);
  const runtimeDir = join(dataDir, 'bin', 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const modelsDir = join(dataDir, 'models');
  mkdirSync(modelsDir, { recursive: true });

  const modeFile = join(dataDir, 'mode');
  const countFile = join(dataDir, 'spawns');
  writeFileSync(modeFile, 'warm');
  writeFileSync(countFile, '');

  const probePath = join(runtimeDir, 'openmemo-probe');
  writeFileSync(
    probePath,
    [
      '#!/bin/sh',
      `echo x >> ${JSON.stringify(countFile)}`,
      `case "$(cat ${JSON.stringify(modeFile)})" in`,
      '  crash) exit 134 ;;',      // → runProbe 判成 kind:'crash'
      '  cold)  sleep 12 ;;',      // → 12s > PROBE_TIMEOUT_MS，10s 预算下必被 kill
      '  slow)  sleep 2 ;;',
      'esac',
      `printf '%s' ${JSON.stringify(PROBE_JSON)}`,
    ].join('\n'),
  );
  chmodSync(probePath, 0o755);
  // 目录里有 ggml 库才像一个装好的后端包（也进指纹）
  writeFileSync(join(runtimeDir, 'libggml-base.so.0'), 'not a real so');

  return {
    dataDir,
    modelsDir,
    setMode: (mode) => {
      writeFileSync(modeFile, mode);
    },
    spawns: () => readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length,
  };
}

const INSTALLED = new Set<'cpu'>(['cpu']);

function detect(m: Machine, now?: Date): ReturnType<typeof detectRuntimeHardware> {
  return detectRuntimeHardware({
    dataDir: m.dataDir,
    modelsDir: m.modelsDir,
    installedBackends: INSTALLED,
    ...(now === undefined ? {} : { now }),
  });
}

describe('T-173 ★ 残留情形：包已装好、之后缓存才变冷 —— 现在真的能自愈', () => {
  it('端到端：跳闸 → 冷却 → 后台恢复探测活过 10s → 断路器彻底复位（用户零操作）', async () => {
    const m = makeMachine();

    // ---- ① 起点：机器是好的。没有这一步，后面的"复位"可能只是"从来没坏过" ----------
    const healthy = await detect(m);
    assert.equal(healthy.probe.ran, true);
    assert.equal(healthy.probe.ok, true);
    assert.equal(healthy.breaker.open, false);
    assert.equal(healthy.blacklistedBackends.length, 0);
    const fingerprintBefore = healthy.breaker.driverFingerprint;
    assert.equal(typeof fingerprintBefore, 'string');

    // ---- ② 缓存变冷：探测开始失败。**没有任何安装动作** --------------------------------
    m.setMode('crash');
    await detect(m);
    const tripped = await detect(m);

    assert.equal(tripped.breaker.open, true, '两次失败必须跳闸');
    assert.equal(tripped.breaker.verdict, 'open');
    assert.equal(tripped.blacklistedBackends.includes('metal'), true);
    // 注意：跳闸的那一发**自己**是跑了探针的（跑完才知道失败），所以要看下一发
    assert.equal(tripped.probe.ran, true);
    const parked = await detect(m);
    assert.equal(parked.probe.ran, false, '跳闸后探针就不该再被调用 —— 这才是断路器省下的钱');

    // ★ 指纹没变 ⇒ T-172 那条「指纹变化给一次重试」的出口在这里根本不存在
    assert.equal(
      tripped.breaker.driverFingerprint,
      fingerprintBefore,
      '残留情形的前提就是指纹不变；它要是变了，这条测试测的就是另一件事',
    );
    // ★ 出口存在，且它是**这次**新加的那条
    assert.equal(tripped.breaker.retryAt === null, false, '跳闸了却没有重试时刻 = 死锁');

    // ---- ③ 冷却期内：一发都不许探（否则等于把断路器删掉，每次白等 10s）-----------------
    const spawnsAfterTrip = m.spawns();
    for (let i = 0; i < 3; i += 1) await detect(m);
    assert.equal(
      m.spawns(),
      spawnsAfterTrip,
      '冷却期内还在探 —— 那不是冷却期，是把断路器删了',
    );

    // ---- ④ 冷却到期：后台放一发恢复探测，**当次请求不等它** -----------------------------
    m.setMode('cold'); // 这一发要跑 12 秒：交互路径的 10s 预算下它会被 kill
    const future = new Date(Date.now() + BREAKER_COOLDOWN_MS + 1_000);

    const t0 = Date.now();
    const during = await detect(m, future);
    const requestMs = Date.now() - t0;

    assert.equal(
      requestMs < 5_000,
      true,
      `半开那一发不许跑在交互路径上（本次请求耗时 ${String(requestMs)}ms）`,
    );
    assert.equal(during.breaker.recovering, true, '应当已经起了一发后台恢复探测');
    assert.equal(during.breaker.open, true, '恢复还没跑完，此刻仍然是停用状态 —— 不许提前报好');

    // ---- ⑤ 等那一发跑完，并**量它到底跑了多久** ---------------------------------------
    const pending = breakerRecovery(during.layout.backendDir);
    assert.equal(pending === null, false, '拿不到在跑的恢复任务');
    const r0 = Date.now();
    await pending;
    const recoveryMs = Date.now() - r0;
    assert.equal(
      recoveryMs > PROBE_TIMEOUT_MS,
      true,
      `恢复探测只跑了 ${String(recoveryMs)}ms —— 没超过 ${String(PROBE_TIMEOUT_MS)}ms 就证明不了` +
        '"它活过了交互预算"，这条残留情形的核心就没被测到',
    );

    // ---- ⑥ 断路器**彻底复位**了吗？直接读 state，不经过任何会自己重探的路径 -------------
    const healed = breakerSnapshot(during.layout.backendDir);
    assert.equal(healed.blacklistedAt, null, '★ 残留情形没有自愈');
    assert.equal(healed.consecutiveFailures, 0);
    assert.equal(healed.retryAt, null);

    // ---- ⑦ 产品层面看到的也是好的 ------------------------------------------------------
    m.setMode('warm');
    const after = await detect(m);
    assert.equal(after.breaker.open, false);
    assert.equal(after.breaker.verdict, 'closed');
    assert.equal(after.blacklistedBackends.length, 0);
    assert.equal(after.probe.ran, true, '复位之后探针应当重新被调用');
  });

  it('对照组：恢复探测**也失败**时不许报好，且退避后重新计时（证明上面那些断言有区分力）', async () => {
    const m = makeMachine();
    m.setMode('crash');
    await detect(m);
    const tripped = await detect(m);
    assert.equal(tripped.breaker.open, true);
    const firstRetryAt = tripped.breaker.retryAt;

    const future = new Date(Date.now() + BREAKER_COOLDOWN_MS + 1_000);
    const during = await detect(m, future);
    await breakerRecovery(during.layout.backendDir);

    const still = breakerSnapshot(during.layout.backendDir);
    assert.equal(still.blacklistedAt === null, false, '一直在失败却报复位了');
    assert.equal(still.consecutiveFailures >= 3, true);
    // 出口仍然在，而且被推后了（退避），不是原地卡死也不是永久关上
    assert.equal(still.retryAt === null, false);
    assert.equal(
      Date.parse(still.retryAt ?? '') > Date.parse(firstRetryAt ?? ''),
      true,
      '失败之后没有重新计时 —— 那会变成永久重试或永久停用',
    );
  });

  it('单飞：冷却到期后并发打 5 发，只许起**一个**恢复探测', async () => {
    const m = makeMachine();
    m.setMode('crash');
    await detect(m);
    await detect(m);

    const before = m.spawns();
    // 这里不需要 12 秒 —— 要证的是"只起一个"，2 秒的窗口足够让 5 发并发都撞上在跑的那一个
    m.setMode('slow');
    const future = new Date(Date.now() + BREAKER_COOLDOWN_MS + 1_000);
    const results = await Promise.all([
      detect(m, future),
      detect(m, future),
      detect(m, future),
      detect(m, future),
      detect(m, future),
    ]);
    const dir = results[0]?.layout.backendDir ?? '';
    await breakerRecovery(dir);

    assert.equal(
      m.spawns() - before,
      1,
      '并发请求各起了一发探针 —— 那正是断路器本该防住的"猛敲一个坏掉的东西"',
    );
  });
});
