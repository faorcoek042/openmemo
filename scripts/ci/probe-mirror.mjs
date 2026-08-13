/**
 * A 层镜像探针 + **退避重试**（#108）。
 *
 * ## 为什么这份从 `e2e-allcomponents.mjs` 里搬出来
 *
 * `[CI 实测 2026-08-12]` 六条定时腿铺开的第一夜 4/6 红，查清全是**一个上游故障窗口**，
 * 两端被同一份代码的绿灯夹住：
 *
 *     18:53  三条手动跑        github.com 全绿，6/6 后端包下载成功
 *     19:07  allcomponents     1 个文件 `socket hang up`
 *     19:51  notes             2/6 `fetch failed`
 *     19:59  import            6/6 `Origin error 503`
 *     20:06  record            6/6 又全部成功
 *
 * A 层这一侧的成因很具体：**每个镜像只发一次请求、零重试**，
 * 而 29 个组件是**单源**的（`single-source-baseline.json`，例如
 * `libsimple-darwin-arm64` 只有 github.com）—— 任何一次瞬时抖动直接转成红。
 *
 * > **一条会随机变红的门，教给人的还是那句「别信这盏灯」。**
 *
 * 搬出来是为了**能被喂坏数据**：留在那个 1000 行、要 bundle 要 daemon 的脚本里，
 * 重试逻辑就只能靠读代码相信它 —— 而这一周本仓抓到的空转守卫全是那么来的。
 * 变异证明在 `scripts/ci/selftest-probe-mirror.mjs`（起真的 HTTP 服务器，
 * 真的 503、真的掐 socket），已挂进 `pnpm test:ci-scripts`。
 *
 * ## 重试的形状：**按轮**，不是每个文件各退避各的
 *
 * A 层要探 71 个文件、约 90 个镜像。如果每个镜像独立退避重试，
 * 总时长会随失败个数线性放大（90 × 65s ≈ 1.6 小时），而这条腿整个 job 只有 90 分钟。
 * 所以这里的选择是：
 *
 *   · **同一轮里所有失败镜像共用一次等待** —— 等待不随失败个数放大；
 *   · 每个镜像仍有独立的**次数**上限（`maxAttempts`）；
 *   · 整个重试阶段另有一个**墙钟总预算**（`budgetMs`），连请求耗时一起算。
 *     预算先到就停，并**明说是预算先到**（否则读者会以为次数试满了）。
 *
 * 这两个上限都会在日志里打出来。理由不是好看：一条跑了 20 分钟的探测，
 * 如果不说"我在按策略等"，下一个人分不清是网络慢还是我们在死等。
 *
 * ## 🔴 加重试**不是**为了把红灯变绿
 *
 * 抖一下（一次 hang up / 一次 503，退避后就好了）→ 重试后成功，正常继续；
 * 真的不可达（次数或预算用尽仍全败）→ **仍然红**，且报告里带得出
 * 试了几次、每次隔多久、每次的失败原因。
 *
 * 而 404 / 403 这类**确定性**失败一次都不重试：重试三次仍是 404，
 * 只是把一条已经确定的结论推迟几十秒。
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * 对一个 URL 发**真实**的 Range 请求，只取前 `want` 字节。
 *
 * 只取头部而不整下：这一层要回答的是「这个来源还在不在、还是不是那个文件」，
 * 而那三件事（可达、总长度、魔数）在头 64 KB 里就能答完。
 * 整下一遍留给 B 层 —— 两层加起来才是完整判据，单独任何一层都不是。
 */
export function probeUrl(url, want = 65536, timeoutMs = 45_000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      // ⚠️ 写不出 URL 是**我们自己**的清单错了，重试一万次也一样 —— 标成确定性失败。
      resolve({ ok: false, deterministic: true, reason: `URL 不合法：${url}` });
      return;
    }
    const fn = u.protocol === 'https:' ? httpsRequest : httpRequest;
    /*
     * ⚠️ `hostname` + `port` 分开传，**不能**用 `host`（`URL.host` 里带端口）。
     *
     * `[CI 实测 run 31695269578]` 这一条是被自检当场抓出来的：搬过来的原版写的是
     * `host: u.host`，对 `https://github.com/...` 没事（`u.host` 不含默认端口），
     * 但对 `http://127.0.0.1:41273/...` 就变成"去解析一个叫 `127.0.0.1:41273` 的主机名"
     * ⇒ 一个请求都发不出去。**真实清单里没有带端口的 URL，所以它一直是潜伏的**，
     * 而自检里的桩上游必然带端口 —— 于是 12 条里 7 条当场红，正是它该有的样子。
     */
    const req = fn(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: { range: `bytes=0-${want - 1}`, 'user-agent': 'openmemo-e2e-allcomponents' },
        timeout: timeoutMs,
      },
      (res) => {
        // 跟随重定向（GitHub releases → objects CDN；HF → CDN）
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          resolve({ redirect: new URL(res.headers.location, url).href });
          return;
        }
        const chunks = [];
        let got = 0;
        res.on('data', (d) => {
          chunks.push(d);
          got += d.length;
          if (got >= want) req.destroy();
        });
        const done = () => {
          const buf = Buffer.concat(chunks);
          let total = null;
          const cr = res.headers['content-range'];
          if (cr) {
            const m = /\/(\d+)$/.exec(String(cr));
            if (m) total = Number(m[1]);
          } else if (res.headers['content-length'] && res.statusCode === 200) {
            total = Number(res.headers['content-length']);
          }
          resolve({
            ok: res.statusCode === 200 || res.statusCode === 206,
            status: res.statusCode,
            total,
            head: buf,
          });
        };
        res.on('end', done);
        res.on('close', done);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, reason: e.message }));
    req.end();
  });
}

/** 跟重定向，最多 `hops` 跳。跳数超了是**确定性**失败（再试一次还是同一条链）。 */
export async function probeFollow(url, hops = 5) {
  let cur = url;
  for (let i = 0; i < hops; i += 1) {
    const r = await probeUrl(cur);
    if (r.redirect) {
      cur = r.redirect;
      continue;
    }
    return r;
  }
  return { ok: false, deterministic: true, reason: `重定向超过 ${hops} 跳` };
}

/**
 * ★ 出厂策略。**两个上限都是显式的、有限的，而且都会被打进日志。**
 *
 * · `maxAttempts: 4` —— 首探 + 3 次重试，退避 5s / 15s / 45s，累计等待 65s。
 *   那一夜的故障窗口是**分钟量级**（19:59 全败 → 20:06 全好），65 秒盖不住整段，
 *   但足以滤掉 19:07 那种单发抖动；再长就该让人去看上游，而不是让 CI 陪着等。
 * · `budgetMs: 180_000` —— **整个重试阶段**的墙钟上限（连请求耗时一起算）。
 *   一次 job 有 90 分钟，3 分钟是 3.3%；而且它只在**已经有东西失败**时才花掉。
 *
 * 刻意不做抖动：这里是单进程、按轮批量重试，随机化只会让日志更难核对
 * （"它到底等了多久"是人要读的第一件事）。
 */
export const A_LAYER_RETRY_POLICY = {
  maxAttempts: 4,
  baseMs: 5_000,
  factor: 3,
  capMs: 60_000,
  budgetMs: 180_000,
};

/** 第 `round` 轮重试之前等多久（round 从 1 起）。指数增长，被 `capMs` 夹住。 */
export function retryDelayMs(round, policy = A_LAYER_RETRY_POLICY) {
  const exp = policy.baseMs * policy.factor ** Math.max(0, round - 1);
  return Math.round(Math.min(policy.capMs, exp));
}

/**
 * 这次失败**值不值得再试一次**。
 *
 * ⚠️ 反面才是这条改动的重点：
 *   · `deterministic`（清单里的 URL 写错了、重定向成环）→ 不重试；
 *   · 4xx（404 / 403 / 410 …）→ 不重试。上游明确回答了"没有这个东西"，
 *     那是**结论**，不是抖动。把它重试成绿正是这条任务最容易做坏的地方；
 *   · 429 / 408 / 5xx → 重试（限流、超时、源站故障，都是"过会儿可能就好了"）；
 *   · 连状态行都没有（socket hang up / fetch failed / timeout）→ 重试。
 */
export function isRetriableProbe(r) {
  if (!r || r.ok) return false;
  if (r.deterministic) return false;
  const s = Number(r.status);
  if (Number.isFinite(s) && s > 0) return s >= 500 || s === 429 || s === 408;
  return true;
}

/** 一次尝试的人类可读原因。**没有原因时说"没给原因"，不许留空**。 */
export function reasonOf(r) {
  if (!r) return '(没有结果)';
  if (r.ok) return `HTTP ${r.status}`;
  if (r.status) return `HTTP ${r.status}`;
  return String(r.reason ?? '(没给原因)');
}

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(0)}s` : `${ms}ms`);

function attemptOf(attempt, waitedMsBefore, r) {
  return { attempt, waitedMsBefore, ok: !!r?.ok, status: r?.status ?? null, reason: reasonOf(r) };
}

/** 「试了几次、每次隔多久、每次为什么失败」——一行说完。 */
export function attemptTrail(attempts) {
  return (attempts ?? [])
    .map((a) =>
      a.attempt === 1
        ? `第1次 ${a.reason}`
        : `等 ${fmtMs(a.waitedMsBefore)} 后第${a.attempt}次 ${a.reason}`,
    )
    .join('；');
}

/**
 * 对**第一轮失败的镜像**做按轮退避重试。
 *
 * `targets`：`[{ key, label, url, first }]`，`first` 是第一轮那次失败的结果。
 * 依赖全部可注入（`probe` / `sleep` / `now` / `log`），所以自检里能用真 HTTP 服务器
 * 配上压缩过的等待跑完整条路径 —— 判据一个字都不用改。
 *
 * ⚠️ **空集不许读成"全都恢复了"**：`considered === 0` 时 `ran` 为 false，
 *    `summarizeRetryZh()` 会明说"没有触发重试"。这是本仓反复发作的那一类
 *    （`[].every(...)` 恒真），所以它在自检里有一条专门的断言。
 */
export async function retryFailedProbes(targets, opts = {}) {
  const policy = { ...A_LAYER_RETRY_POLICY, ...(opts.policy ?? {}) };
  const probe = opts.probe;
  if (typeof probe !== 'function') throw new Error('retryFailedProbes: 必须传 probe(url)');
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});

  const state = new Map();
  for (const t of targets ?? []) {
    state.set(t.key, { target: t, result: t.first, attempts: [attemptOf(1, 0, t.first)] });
  }

  const startedAt = now();
  let budgetExhausted = false;
  let rounds = 0;
  let pending = [...state.values()].filter((s) => isRetriableProbe(s.result));
  const retriableAtStart = pending.length;

  for (let round = 1; round <= policy.maxAttempts - 1 && pending.length > 0; round += 1) {
    const delay = retryDelayMs(round, policy);
    const used = now() - startedAt;
    if (used + delay > policy.budgetMs) {
      budgetExhausted = true;
      log(
        `   ⚠️ 总预算 ${fmtMs(policy.budgetMs)} 不够再等一轮（已用 ${fmtMs(used)}，下一轮要等 ${fmtMs(delay)}）` +
          ` —— 停止重试，剩下 ${pending.length} 个按失败算。`,
      );
      break;
    }
    log(
      `   ↻ 第 ${round}/${policy.maxAttempts - 1} 轮重试：等 ${fmtMs(delay)} 后重探 ${pending.length} 个镜像` +
        `（总预算 ${fmtMs(policy.budgetMs)}，已用 ${fmtMs(used)}）`,
    );
    await sleep(delay);
    rounds = round;

    const next = [];
    for (let i = 0; i < pending.length; i += 1) {
      if (now() - startedAt > policy.budgetMs) {
        budgetExhausted = true;
        next.push(...pending.slice(i));
        log(
          `   ⚠️ 重探到一半总预算用尽，本轮还剩 ${pending.length - i} 个没轮到 —— 它们按失败算。`,
        );
        break;
      }
      const s = pending[i];
      const r = await probe(s.target.url);
      s.result = r;
      s.attempts.push(attemptOf(round + 1, delay, r));
      if (!r?.ok && isRetriableProbe(r)) next.push(s);
    }
    pending = next;
    if (budgetExhausted) break;
  }

  const all = [...state.values()];
  return {
    policy,
    considered: all.length,
    retriableAtStart,
    ran: rounds > 0,
    rounds,
    budgetExhausted,
    recovered: all.filter((s) => s.result?.ok),
    stillFailing: all.filter((s) => !s.result?.ok),
    /** 一次都没重试过的（确定性失败，或预算连第一轮都不够）。 */
    neverRetried: all.filter((s) => s.attempts.length === 1),
  };
}

/**
 * 重试阶段的一句话结论。
 *
 * ★ 三种情形**必须说得不一样**，否则报告会把它们混成一句"没问题"：
 *   ① 压根没有失败镜像 → 「没有触发重试」，**不是**「全部恢复」；
 *   ② 有失败、重试后全好了 → 说清是重试救回来的（否则下次没人知道上游在抖）；
 *   ③ 仍有失败 → 说清还剩几个、是次数用尽还是预算用尽。
 */
export function summarizeRetryZh(o) {
  if (!o || o.considered === 0) {
    return '没有触发重试 —— 第一轮所有镜像都答应了（0 个失败，不是"重试全都成功了"）';
  }
  const head =
    `第一轮有 ${o.considered} 个镜像失败，其中 ${o.retriableAtStart} 个值得重试` +
    `（其余是 404 这类确定性失败，一次都不重试）；`;
  const body = o.ran
    ? `实际重试 ${o.rounds} 轮，救回 ${o.recovered.length} 个，仍然失败 ${o.stillFailing.length} 个。`
    : `**一轮都没跑到**（${o.budgetExhausted ? '总预算不够等第一轮' : '没有可重试的'}），仍然失败 ${o.stillFailing.length} 个。`;
  const tail = o.budgetExhausted ? ` ⚠️ 是**总预算先用尽**，不是次数试满。` : '';
  return head + body + tail;
}
