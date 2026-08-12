/**
 * `CONTRACT_VERSION` 的**语义**，以及 SSE 线格式 —— 两条跨进程约定。
 *
 * ## 为什么这两条值得钉住
 *
 * 它们的共同点是：**坏掉的时候两边都不报错**。
 *
 * · `CONTRACT_VERSION` 是 daemon 与 web 之间唯一的握手位。daemon 把它塞进
 *   `/api/health`（`apps/daemon/src/http/server.ts:131`），web 拿它和自己编进来的值
 *   比对（`apps/web/src/lib/api/connect.ts:115`），不等就阻断并显示"版本不匹配"。
 *   —— 它**没有**被任何 schema 描述：两边各自手写这个字段名。
 *   所以这个数字的意义完全靠约定：**改它 = 宣布旧前端必须一起换掉**。
 *
 * · SSE 帧格式坏掉是本项目最典型的"静默失败"：少一个换行，
 *   浏览器的 `EventSource` 就永远不 dispatch，而服务端 write 照样成功、
 *   连接照样开着。没有异常、没有日志、进度条只是**不动了**。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTRACT_VERSION, PACKAGE_NAME } from './index.js';
import {
  PROGRESS_READING_KINDS,
  PROGRESS_UNREPORTABLE,
  fractionOf,
  progressFraction,
  progressOf,
} from './progress.js';
import {
  AUTHORITATIVE_EVENT_TYPES,
  SEQUENCED_EVENT_TYPES,
  SSE_EVENT_TYPES,
  formatSseFrame,
  formatSseKeepalive,
  formatSseRetry,
  type SseEvent,
} from './events.js';

describe('CONTRACT_VERSION —— daemon ↔ web 的握手位', () => {
  it('是正整数（它要能被 !== 严格比较，也要能显示给用户看）', () => {
    assert.equal(Number.isInteger(CONTRACT_VERSION), true);
    assert.equal(CONTRACT_VERSION > 0, true);
  });

  it('★ 钉在当前值上 —— 这条**故意**是个绊线，不是在测功能', () => {
    // 改这个数字是一次**破坏性发布**：daemon 与 web 必须同时换掉，
    // 否则用户看到的是"版本不匹配"阻断页（web/connect.ts:115 的那条分支）。
    // 所以它不该在"顺手改一下"里被动到。
    //
    // 如果你是有意 bump 的：把下面的期望值一起改掉，并确认
    //   ① apps/daemon 与 apps/web 会一起发布；
    //   ② 老前端撞上新 daemon 时那条阻断路径仍然走得通。
    //
    // ── 1 → 2（#90，有意 bump，两条确认都做过）─────────────────────────────
    // `job.progress` 的刻度字段从 `pct: number | null` 换成
    // `progress: ProgressReading`（判别式联合，见 `progress.ts` 的文件头）。
    // ① 成立：daemon 自己 serve 那份 SPA，同一个 bundle 一起发。
    // ② 成立且**正是我们要的**：老前端读 `e.pct` 会得到 `undefined`，
    //    `?? 0` 之后每条任务恒显示 0% —— 与其让他盯着一排静止的 0%，
    //    不如让 `connect.ts` 的版本比对把他挡在"刷新一下"那句话上。
    assert.equal(
      CONTRACT_VERSION,
      2,
      'CONTRACT_VERSION 变了。这是破坏性改动，不是版本号自增 —— 见本条注释',
    );
  });

  it('包名保持稳定（它是 workspace 依赖名，改了会静默解析到别处）', () => {
    assert.equal(PACKAGE_NAME, '@openmemo/shared');
  });
});

describe('SSE 事件类型表 —— 拼错一个字符就永远静默', () => {
  it('事件类型不许重复', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const t of SSE_EVENT_TYPES) {
      if (seen.has(t)) dupes.push(t);
      seen.add(t);
    }
    assert.deepEqual(dupes, [], `SSE_EVENT_TYPES 里有重复项：${dupes.join(', ')}`);
  });

  it('★ AUTHORITATIVE / SEQUENCED 里的每一项都必须是真实存在的事件类型', () => {
    // 这两张表是**按字符串**挑事件的。写错一个字母不会有任何编译错误
    // （它们的类型是 readonly SseEventType[]，但字面量拼错时 TS 只在赋值处报错，
    //  而一旦有人把类型放宽成 string[]，拼错就彻底无声了），
    // 后果是：该被当作"仅供参考"的事件被当成权威、该按序应用的事件乱序应用。
    const all = new Set<string>(SSE_EVENT_TYPES);
    for (const t of AUTHORITATIVE_EVENT_TYPES) {
      assert.equal(all.has(t), true, `AUTHORITATIVE_EVENT_TYPES 里的 ${t} 不在 SSE_EVENT_TYPES 里`);
    }
    for (const t of SEQUENCED_EVENT_TYPES) {
      assert.equal(all.has(t), true, `SEQUENCED_EVENT_TYPES 里的 ${t} 不在 SSE_EVENT_TYPES 里`);
    }
  });

  it('按序应用的事件必然也是权威事件（否则"保序"没有意义）', () => {
    for (const t of SEQUENCED_EVENT_TYPES) {
      assert.equal(
        AUTHORITATIVE_EVENT_TYPES.includes(t),
        true,
        `${t} 要求保序，却不在权威事件表里 —— 两张表的语义对不上`,
      );
    }
  });
});

describe('SSE 线格式 —— 少一个换行就永远不 dispatch', () => {
  const sample = {
    type: 'job.progress',
    jobId: 'j1',
    progress: { kind: 'fraction', value: 0.42 },
  } as unknown as SseEvent;

  it('★ 帧必须以空行（\\n\\n）结束', () => {
    // SSE 的分帧符就是这个空行。少了它，服务端 write 成功、连接正常，
    // 而浏览器**永远不会**把这一帧交给监听器。没有任何一侧会报错。
    const frame = formatSseFrame(7, sample);
    assert.equal(frame.endsWith('\n\n'), true, `帧没有以空行结束：${JSON.stringify(frame)}`);
    assert.equal(formatSseRetry(3000).endsWith('\n\n'), true);
    assert.equal(formatSseKeepalive().endsWith('\n\n'), true);
  });

  it('id / event / data 三个字段齐全且各占一行', () => {
    const lines = formatSseFrame(7, sample).split('\n');
    assert.equal(lines[0], 'id: 7');
    assert.equal(lines[1], 'event: job.progress');
    assert.equal(lines[2]?.startsWith('data: '), true);
  });

  it('★ data 必须是**单行** JSON（换成缩进美化就会静默截断）', () => {
    // `data:` 每遇到一个换行就开一个新的 data 行，SSE 会把它们用 \n 拼起来 ——
    // 于是"美化过的 JSON"在客户端拼回来仍然能 parse，**但中间任何一个空行
    // 都会提前结束整帧**。这条断言挡的是"把 JSON.stringify 加上缩进参数"。
    const payload = formatSseFrame(1, sample).split('\n')[2]!.slice('data: '.length);
    assert.equal(payload.includes('\n'), false, 'data 里出现了换行');
    assert.deepEqual(JSON.parse(payload), sample, 'data 不是原事件的无损 JSON');
  });

  it('事件里的换行/引号被转义，不会撑破分帧', () => {
    const nasty = {
      type: 'job.failed',
      message: 'line1\nline2\n\n"quoted"',
    } as unknown as SseEvent;
    const frame = formatSseFrame(2, nasty);
    // 整帧里应当只有 3 个换行：id 行尾、event 行尾、data 行尾 + 结尾空行
    assert.equal(frame.split('\n').length, 5, `分帧被内容撑破了：${JSON.stringify(frame)}`);
    const payload = frame.split('\n')[2]!.slice('data: '.length);
    assert.deepEqual(JSON.parse(payload), nasty);
  });

  it('id 单调递增地原样出现（重连补发靠它）', () => {
    assert.equal(formatSseFrame(0, sample).startsWith('id: 0\n'), true);
    assert.equal(formatSseFrame(12345, sample).startsWith('id: 12345\n'), true);
  });
});

/* ══════════════ #90 进度刻度 —— 一个数字，两种量纲，靠约定维持 ══════════════ */

/**
 * ## 被守的那件事
 *
 * `job.progress` 的刻度字段曾经是 `pct: number | null`，而**两个生产者对它的
 * 理解不一样**：流水线那侧发 `fraction * 100`（0–100），下载那侧发
 * `completed / total`（0–1）。契约、openapi、store、`ProgressMeter`、
 * `formatPercent` 全按 0–1 用。
 *
 * 于是任何 ≥1 的帧一到，`formatPercent` 就把它夹成 `1`：
 * **每一条正在跑的转写任务都显示「100%」，进度条满格、`aria-valuenow="100"`**，
 * 而同一时刻 `GET /api/jobs` 说 `0.728`。一条 40 分钟的音频，用户会盯着
 * 「100%」看好几分钟。
 *
 * `number | null` 分不出 `0.9` 和 `90`。这一组测试钉的就是**分得出**。
 *
 * ## 抽掉修法会不会红
 *
 * · 把 `progressFraction` 改回"乘 100 再返回" → 第 1 条当场红。
 * · 把 `unreportable` 那一格加回一个 `value: null` 字段 → 第 4 条当场红。
 * · 让越界值悄悄通过（回到"静默夹紧"） → 第 2 条当场红。
 */
describe('#90 ProgressReading —— 刻度必须跟着值一起走', () => {
  it('★★ 0.9 进去就是 0.9 出来 —— 不许有人在中间乘 100', () => {
    const r = progressFraction(0.9, 'contract-test');
    assert.equal(r.kind, 'fraction');
    assert.equal(
      r.kind === 'fraction' ? r.value : null,
      0.9,
      '构造点把 0–1 改写成了别的刻度 —— 这正是 #90：转写任务因此恒显示 100%',
    );
  });

  it('★★ 90 不是一个合法读数：它降级成"报不出进度"，并且出声', () => {
    const errs: unknown[][] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void errs.push(a);
    let r;
    try {
      r = progressFraction(90, 'contract-test');
    } finally {
      console.error = original;
    }
    assert.equal(
      r.kind,
      'unreportable',
      '90 被当成了合法比例 —— 那是把百分比当小数传，界面会显示一个理直气壮的 100%',
    );
    assert.equal(r.kind === 'unreportable' ? r.reason : null, 'out_of_range');
    assert.equal(
      errs.length,
      1,
      '越界被静默吞掉了。夹紧可以，闭嘴不行 —— 一个 90 倍的偏差不该只留下一个好看的数字',
    );
  });

  it('0..1 的边界值照常通过（别把修法做成"什么都不信"）', () => {
    for (const v of [0, 0.001, 0.5, 1]) {
      const r = progressFraction(v, 'contract-test');
      assert.equal(r.kind, 'fraction', `${v} 应该是合法比例`);
      assert.equal(r.kind === 'fraction' ? r.value : null, v);
    }
  });

  it('★ "报不出进度"不携带任何数字 —— 于是 `?? 0` 写不出来', () => {
    const r = PROGRESS_UNREPORTABLE.no_denominator;
    assert.equal(r.kind, 'unreportable');
    assert.equal(
      Object.prototype.hasOwnProperty.call(r, 'value'),
      false,
      'unreportable 带上 value 就等于把 `value ?? 0` 重新变成可写的 —— ' +
        '而"这一步没有刻度"被渲染成"0%"正是同一族的另一半（"正在安装"停在 0%）',
    );
    assert.equal(fractionOf(r), null, '唯一读取点必须对"没有刻度"回答 null，不是 0');
  });

  it('没有分母时不编百分比（`total<=0` → no_denominator，不是 0%）', () => {
    assert.equal(progressOf(5, 0, 'contract-test').kind, 'unreportable');
    assert.equal(fractionOf(progressOf(3, 4, 'contract-test')), 0.75);
  });

  it('NaN / Infinity 也不许变成 0%', () => {
    assert.equal(progressFraction(Number.NaN, 'contract-test').kind, 'unreportable');
    assert.equal(progressFraction(Number.POSITIVE_INFINITY, 'contract-test').kind, 'unreportable');
  });

  it('★ 契约里只有 fraction 一种可传输量纲 —— percent 不是一格', () => {
    assert.deepEqual(
      [...PROGRESS_READING_KINDS],
      ['fraction', 'unreportable'],
      '一旦有人加进 percent 那一格，"两种量纲共用一个字段"就又写得出来了 —— ' +
        '百分比是显示形态，只许在渲染层现算',
    );
  });
});
