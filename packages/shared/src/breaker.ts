/**
 * 加速后端断路器 —— **面向用户的那几句话**（T-174）。
 *
 * ## 为什么这些句子在 `shared` 而不是在自检里
 *
 * T-173 把断路器状态翻成人话，写在 `packages/runtime/src/selfcheck.ts` 里（`retryPhrase()` /
 * `humanDelay()`，模块私有）。那时只有一个出口要用它，放哪里都一样。
 *
 * 现在有**两个**出口要说同一件事：自检页（`hw.breaker`）与运行时页（`BreakerNotice`）。
 * 而 `@openmemo/runtime` 依赖 `node:fs` / 子进程，**浏览器打不进去** ——
 * 于是"前端自己再写一遍"是这里唯一顺手的做法，也正是本仓反复吃亏的那个形状：
 * 同一件事两处各写一遍，第一次一致，第三次就不一致了，而且**没有任何东西会报错**。
 *
 * 所以句子提到这里：本包按约定是**纯类型 + 纯函数、无 I/O**（见 `index.ts` 头注），
 * daemon 与浏览器都能 import。`selfcheck.ts` 现在从这里 import 回去，
 * **它原有的那批断言（`/将在约 4 分钟后自动重试/` 等）就变成了这个模块的守卫** ——
 * 谁改坏了措辞，自检的测试当场红，不需要新增一套平行的断言。
 *
 * ## 这里**不**做的事
 *
 * - 不翻译 `lastError`。它是探针自己的原文（`probe timed out after 10000ms (killed)…`），
 *   与路径/版本号同性质 —— 翻译它就等于前端自己编一个错误信息出来。
 *   中文句子里因此会嵌一段英文，这是刻意的。
 * - 不决定"要不要显示"。那是 `breakerTripped()` 的事，两个出口共用同一个判据。
 */

/** 三态裁决。`open` = 冷却中；`recover` = 冷却到期、该放一发恢复探测了。 */
export type BreakerVerdict = 'closed' | 'open' | 'recover';

/** 中英各一句。**两句必须说同一件事** —— 不是一句的翻译，是同一个事实的两种写法。 */
export interface BilingualText {
  readonly zh: string;
  readonly en: string;
}

/**
 * 造句需要的最小事实集。
 *
 * 故意写得比 `BreakerStatusInfo`（runtime）和 `BreakerDiagnostics`（daemon）都**窄**：
 * 三个生产者结构上都能直接喂进来，不需要任何适配层。
 * 注意**没有 `verdict`** —— 造句用不到它，它只决定走哪个分支（见 `breakerTripped()`）。
 */
export interface BreakerCopyInput {
  /** 此刻被停用的后端。空数组 = 没有被停用的。cpu 永不入列。 */
  readonly blacklistedBackends: readonly string[];
  readonly consecutiveFailures: number;
  /** 最近一次探测失败的原因（探针原文，不翻译）；null = 没有失败记录。 */
  readonly lastError: string | null;
  /** 冷却到期时刻（ISO）。 */
  readonly retryAt: string | null;
  /** 是否有一发后台恢复探测正在跑。 */
  readonly recovering: boolean;
}

/**
 * 断路器此刻是不是"有话要说"。
 *
 * ★ **两个出口必须用同一个判据**，否则会出现自检说"已暂时停用"而运行时页什么都不显示
 * （或者反过来）的情形 —— 那比两处措辞不一致更难查，因为两边单看都自洽。
 *
 * `verdict` 收 `string` 而不是 `BreakerVerdict`：HTTP 回来的东西不该被当成已经校验过的联合类型。
 * **认不出来的值一律当"停用中"处理**，不静默放行 —— 静默放行正是本次要消灭的东西。
 */
export function breakerTripped(verdict: string, blacklistedBackends: readonly string[]): boolean {
  return !(verdict === 'closed' && blacklistedBackends.length === 0);
}

/**
 * 把断路器状态翻成"接下来会发生什么"的一句话。
 *
 * 这句话是用户唯一能看到的东西，所以它宁可承认"时刻没记录"，也不许编一个时间出来。
 *
 * `now` 可注入：界面上这句话要每秒重算一次（倒计时），测试要钉死具体的数字。
 */
export function breakerRetryPhrase(b: BreakerCopyInput, now: number = Date.now()): BilingualText {
  if (b.recovering) {
    return {
      zh: '正在重试 —— 一发后台恢复探测已经在跑，成功即自动恢复。',
      en: 'Retrying now — a recovery probe is already running in the background; success restores them automatically.',
    };
  }
  const due = b.retryAt === null ? Number.NaN : Date.parse(b.retryAt);
  if (Number.isNaN(due)) {
    // 「跳闸 ⇒ retryAt 必然存在」这条不变式被破坏了。如实说，不要假装知道时间。
    return {
      zh: '重试时刻未记录；下一次探测会立刻重试。',
      en: 'No retry time recorded; the next check will retry immediately.',
    };
  }
  const leftMs = due - now;
  if (leftMs <= 0) {
    return {
      zh: '冷却已到期，下一次探测就会重试。',
      en: 'Cooldown has elapsed; the next check will retry.',
    };
  }
  const d = humanDelay(leftMs);
  return { zh: `将在约 ${d.zh}后自动重试。`, en: `Automatic retry in about ${d.en}.` };
}

/**
 * 「停用了什么 / 为什么 / 多久之后重试」—— 一整句。
 *
 * 三件事必须在同一句里：只说"停用了"是吓唬人，只说"会重试"是敷衍，
 * 用户要的是"我现在该等还是该动手"，而那需要三件事凑齐才回答得了。
 */
export function breakerDetail(b: BreakerCopyInput, now: number = Date.now()): BilingualText {
  const backends =
    b.blacklistedBackends.length > 0 ? b.blacklistedBackends.join('、') : '（未列出）';
  const backendsEn =
    b.blacklistedBackends.length > 0 ? b.blacklistedBackends.join(', ') : '(not listed)';
  const why = b.lastError ?? '未记录原因';
  const whyEn = b.lastError ?? 'no reason recorded';
  const when = breakerRetryPhrase(b, now);
  return {
    zh: `已暂时停用：${backends}（连续 ${String(b.consecutiveFailures)} 次探测失败：${why}）。${when.zh}`,
    en:
      `Temporarily disabled: ${backendsEn} ` +
      `(${String(b.consecutiveFailures)} consecutive probe failures: ${whyEn}). ${when.en}`,
  };
}

/**
 * 「你不用动手」——**只有建议，不含那条 HTTP 入口**。
 *
 * 界面上用这一支：那条 `GET …?reset=1` 在运行时页上的对应物是一个**真的按钮**，
 * 把 URL 念给用户听没有意义（D-05 §5.3：不许把技术细节原样甩给用户）。
 */
export function breakerAdvice(): BilingualText {
  return {
    zh: '不需要手动操作 —— 到点会自动重试，成功即自动恢复。',
    en: 'No action needed — it retries automatically and recovers on its own.',
  };
}

/** 手动重试的 HTTP 入口。CLI / 自检文本用它 —— 那两个地方点不了按钮。 */
export function breakerManualRetryHint(): BilingualText {
  return {
    zh: '想立刻重试：GET /api/runtime/hardware?reset=1',
    en: 'To retry right now: GET /api/runtime/hardware?reset=1',
  };
}

/**
 * 建议 + HTTP 入口，拼成自检的 `remediation` 那一整句。
 *
 * 拼接规则（中文不加空格、英文加）只写在这里一处 —— 两个调用方各拼一次就是下一次不一致的种子。
 */
export function breakerRemediation(): BilingualText {
  const a = breakerAdvice();
  const h = breakerManualRetryHint();
  return { zh: `${a.zh}${h.zh}`, en: `${a.en} ${h.en}` };
}

/**
 * 时长 → 人话。中英分开是因为两边的**分档阈值一样、写法不一样**（`58 秒` vs `58s`）。
 *
 * 不导出：它没有独立的用户，唯一的意义是给 `breakerRetryPhrase()` 造那个 `Y`。
 * （导出一个零调用方的东西会被 `check:orphans` 拦下，那条棘轮是对的。）
 */
function humanDelay(ms: number): BilingualText {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return { zh: `${String(s)} 秒`, en: `${String(s)}s` };
  const m = Math.round(s / 60);
  if (m < 90) return { zh: `${String(m)} 分钟`, en: `${String(m)} min` };
  const h = Math.round(m / 60);
  return { zh: `${String(h)} 小时`, en: `${String(h)} h` };
}
