/**
 * 工具链解析的结论 —— **三态,而且第三态不许被写成"什么都不缺"**（#87 步骤 1）。
 *
 * ## 为什么这是个判别联合,而不是 `string[] | null`
 *
 * 原来的形状是 `missing: readonly string[]`。它只有两种取值:
 * 有东西 = 缺;空数组 = **什么都不缺**。于是"我没能确认"无处可放,
 * 而每一个消费方都用同一种写法把它读掉:
 *
 * ```ts
 * const missing = data?.pipeline?.missing ?? [];   // ReadinessBanner / DiagnosticsPage
 * if (next.missing.length === 0 && queue_) { … }   // main.ts 的队列闸
 * ```
 *
 * 这两种写法把 UNKNOWN 塞进 OK 那一档。**前者只是界面说错话,后者会真的开始干活** ——
 * 在一条我们没能确认的流水线上解除任务阻塞,后果不是一句假话,
 * 是一堆用户看不懂的运行时失败。
 *
 * 改成可空数组救不了这一点:`?? []` 和 `?.length === 0` 照样写得出来,
 * 而且**照样编译通过**。所以这里用判别联合 ——
 * **让错误的写法不可表达,好过用纪律要求别人别那么写。**
 * 拿不到 `missing` 这个字段,就不可能"顺手当成空数组"。
 *
 * ## 三态的含义
 *
 * | kind | 意思 | 允许放行工作吗 |
 * |---|---|---|
 * | `known` + 空 `missing` | 查过了,齐了 | ✅ |
 * | `known` + 非空 `missing` | 查过了,缺这些 | ❌（缺件） |
 * | `unknown` | **没能查出来** | ❌，且必须说出原因 |
 *
 * ⚠️ `unknown` 与"缺件"是两件事,不许合并:缺件是**已知的坏消息**（能告诉用户装什么）,
 * `unknown` 是**没有消息**（只能告诉用户我们没查出来）。把后者显示成前者
 * 会让用户去装一个他其实已经有的东西 —— 那正是 #87 的病。
 */

/** 工具链此刻的结论。 */
export type ToolchainVerdict =
  | {
      readonly kind: 'known';
      /** 缺哪些工具（`ffmpeg` / `ffprobe` / `whisper-cli` / `asr-model` …）。空 = 齐了。 */
      readonly missing: readonly string[];
    }
  | {
      readonly kind: 'unknown';
      /**
       * **为什么没查出来** —— 必填。
       *
       * 这一格不是给日志用的装饰:`unknown` 时任何"没开始干活"的决定都要**说得出理由**,
       * 否则用户看到的是一个静默卡住的任务。**静默卡住比放行更坏** ——
       * 放行至少会吵闹地失败,静默卡住就是"什么都没发生"。
       */
      readonly reason: string;
    };

/** 查过了,而且齐了。 */
export const toolchainReady = (v: ToolchainVerdict): boolean =>
  v.kind === 'known' && v.missing.length === 0;

/**
 * 缺的那些;**`unknown` 时返回空数组不代表齐了** —— 调用方必须先自己分辨 `kind`。
 *
 * 之所以还提供它,是因为"把缺件列出来给用户看"这件事本身是合法的;
 * 之所以不叫 `missing`,是为了让 `toolchainMissing(v).length === 0` 这种写法
 * 读起来就不像"齐了"（它不是）。要判"能不能开工",用 {@link toolchainReady}。
 */
export const toolchainMissing = (v: ToolchainVerdict): readonly string[] =>
  v.kind === 'known' ? v.missing : [];
