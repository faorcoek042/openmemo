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

import {
  BREAKER_COOLDOWN_MS,
  CIRCUIT_BREAKER_THRESHOLD,
  PROBE_TIMEOUT_MS,
} from '@openmemo/runtime';

import {
  breakerRecovery,
  breakerSnapshot,
  breakerStatus,
  detectRuntimeHardware,
  requestBreakerRecovery,
} from './setup.js';

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
      '  crash) exit 134 ;;', // → runProbe 判成 kind:'crash'
      '  cold)  sleep 12 ;;', // → 12s > PROBE_TIMEOUT_MS，10s 预算下必被 kill
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
    assert.equal(m.spawns(), spawnsAfterTrip, '冷却期内还在探 —— 那不是冷却期，是把断路器删了');

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

/**
 * T-175：**用户手点「立刻重试」走的是恢复那条路**，不再就地探一发。
 *
 * ## 为什么这几条值得存在
 *
 * 改之前 `?reset=1` 是 `resetBreaker()` + `detect(true)`：清掉裁决 ⇒ 裁决变 `closed`
 * ⇒ **就地跑一发探测，交互预算 `PROBE_TIMEOUT_MS`（10 s）**。
 * 而冷 Mac 上 Metal 首次初始化实测 12–21 s ⇒ **手点那一发几乎必然超时，
 * 反而是后台自动那发（90 s）能成** —— 按钮点了跟没点一样，只是多记一次失败。
 *
 * Manager 判据：那 10 秒是保护"顺带发生"的请求的，不是保护一次显式用户动作的。
 *
 * ── 把名字遮住，这些断言什么时候会失败 ──────────────────────────────────────
 *  · 有人把手点改回就地探（当次请求会开始变慢，且在冷机器上必然超时）；
 *  · 有人让手点绕过单飞（两个探针抢同一块 GPU 初始化）；
 *  · 有人让手点先 `resetBreaker()` 再探（界面会闪一下假的"已恢复"）。
 */
describe('T-175 手点「立刻重试」= 后台恢复那条路（不是就地探一发）', () => {
  it('★ 冷却期内手点：不等那一发、当次请求立刻回，且报"正在重试"', async () => {
    const m = makeMachine();
    m.setMode('crash');
    await detect(m);
    await detect(m); // 跳闸

    const before = m.spawns();
    // 这一发要活过交互预算：证明手点拿到的是恢复预算，不是 10 秒
    m.setMode('cold');

    const t0 = Date.now();
    const { started, status } = await requestBreakerRecovery({
      dataDir: m.dataDir,
      modelsDir: m.modelsDir,
    });
    const elapsed = Date.now() - t0;

    assert.equal(started, true, '冷却期内手点必须真的起一发（这正是"显式重试"的含义）');
    assert.equal(status.recovering, true, '起了之后必须报"正在重试"，否则界面无话可说');
    assert.equal(
      status.recoveryStartedAt === null,
      false,
      '没有起跑时刻 —— 界面就算不出"已经等了多久"，只能自己编一个',
    );
    assert.equal(
      status.recoveryTimeoutMs > PROBE_TIMEOUT_MS,
      true,
      `手点用的还是交互预算（${String(status.recoveryTimeoutMs)}ms）—— 冷机器上必然超时`,
    );
    /*
     * ★ 当次请求不许等那一发。探针 sleep 12 秒，所以"立刻返回"必须远小于它。
     * 用 5 秒而不是 1 秒：CI 机器慢，留足余量，但仍然与 12 秒拉得开。
     */
    assert.equal(elapsed < 5_000, true, `手点请求挂了 ${String(elapsed)}ms —— 它不该等那一发`);

    // 计数**不许**被先抹掉：那会让界面闪一下假的"已恢复"
    assert.equal(
      breakerSnapshot(status.backendDir).consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD,
      true,
      '手点把失败计数清了 —— 探测还没跑完就先宣布好了',
    );

    /*
     * ★ 上面那条断言的是**报出来的**预算（`recoveryTimeoutMs`），这一条断言**实际跑到的**。
     *
     * 反向验证抓到的一个真实缺口：把 `recoveryProbe()` 的 `timeoutMs` 改回
     * `PROBE_TIMEOUT_MS` 之后，报出来的预算仍然是 90 s（那是另一个常量），
     * 于是本组用例**全绿** —— 只有 T-173 那条端到端会红。
     * 报的和跑的可以分叉，所以两个都要钉：探针 sleep 12 s，
     * 若预算真是 10 s 它会在 10 s 处被 kill，这里就量不到 12 s。
     */
    const t1 = Date.now();
    await breakerRecovery(status.backendDir);
    const probeRan = Date.now() - t1 + elapsed;
    /*
     * 阈值要**留出余量**，不能写成 `> PROBE_TIMEOUT_MS`：
     * 预算真是 10 s 时那一发在 10 s 处被 kill，量出来是 10 000ms 出头，
     * 恰好能擦着通过 —— 反向验证实测这条变异因此存活过一次。
     * 探针 sleep 12 s，所以用 11 s 把「跑满 12 秒」和「10 秒被砍」清楚地分开。
     */
    assert.equal(
      probeRan > PROBE_TIMEOUT_MS + 1_000,
      true,
      `恢复那一发只跑了 ${String(probeRan)}ms —— 它拿到的还是交互预算，冷 Mac 上必被 kill`,
    );
    assert.equal(m.spawns() - before, 1, '手点应当恰好起一发');
  });

  it('★ 单飞与手点共存：已经有一发在跑时，手点是"加入等待"，不是再起一发、也不是报错', async () => {
    const m = makeMachine();
    m.setMode('crash');
    await detect(m);
    await detect(m);

    const before = m.spawns();
    m.setMode('slow');

    const paths = { dataDir: m.dataDir, modelsDir: m.modelsDir };
    const first = await requestBreakerRecovery(paths);
    assert.equal(first.started, true, '第一发应当真的起来');

    // 用户连点 / 多个标签页同时点
    const rest = await Promise.all([
      requestBreakerRecovery(paths),
      requestBreakerRecovery(paths),
      requestBreakerRecovery(paths),
    ]);

    for (const r of rest) {
      assert.equal(r.started, false, '★ 又起了一发 —— 两个探针会抢同一块 GPU 初始化');
      // 加入等待 ≠ 被拒绝：状态里仍然是"正在重试"，界面照常显示进度
      assert.equal(r.status.recovering, true, '被拒绝了 —— 用户会以为自己点坏了什么');
      assert.equal(
        r.status.recoveryStartedAt,
        first.status.recoveryStartedAt,
        '★ 起跑时刻被刷新了 —— 进度会一直归零，用户永远看不到它前进',
      );
    }

    await breakerRecovery(first.status.backendDir);
    assert.equal(m.spawns() - before, 1, `连点起了 ${String(m.spawns() - before)} 发探针`);
  });

  it('★ 那一发跑完后 recovering 归位，起跑时刻也跟着清掉（不许留一个永远在跑的假象）', async () => {
    const m = makeMachine();
    m.setMode('crash');
    await detect(m);
    await detect(m);

    m.setMode('warm'); // 这一发会成功 → 断路器彻底复位
    const { status } = await requestBreakerRecovery({
      dataDir: m.dataDir,
      modelsDir: m.modelsDir,
    });
    await breakerRecovery(status.backendDir);

    const after = await breakerStatus({ dataDir: m.dataDir, modelsDir: m.modelsDir });
    assert.equal(after.recovering, false, '跑完了还报"正在重试" —— 按钮会永远禁用着');
    assert.equal(after.recoveryStartedAt, null, '起跑时刻没清掉 —— 界面会一直数下去');
    assert.equal(after.verdict, 'closed', '成功那一发之后断路器应当复位');
    assert.deepEqual(after.blacklistedBackends, [], '复位了却还挂着停用列表');
  });
});
