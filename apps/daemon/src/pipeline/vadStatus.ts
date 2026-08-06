/**
 * 「这一台机器上，转写实际用的是哪种切分」—— 进程内的一格状态（T-148）。
 *
 * ## 为什么需要它
 *
 * `buildPipeline()` 能回答的只有**静态**那一半：VAD 权重解析到没有、是不是
 * whisper.cpp 能加载的 ggml 格式。它回答不了**运行期**那一半 ——
 * 权重挑对了、二进制也在，`whisper-vad-speech-segments` 仍然可能跑失败
 * （缺共享库、被杀、超时、上游换了输出格式……）。
 *
 * 修完根因之后如果只报静态那一半，就会造出一个**新的假绿灯**：
 * 诊断页说「VAD 可用：按静音切分」，而每一次转写都在悄悄退回固定窗口。
 * 「结果给了，代价没说」正是本仓最贵的那一类 bug，不能一边修它一边复现它。
 *
 * ## 为什么是进程内变量而不是落盘
 *
 * PROTOCOL §9 的判据：把进程 `kill -9` 在最坏的那一行上，机器会留下什么。
 * 这里的答案是**什么都不留** —— 进程一退状态就没了，下次启动重新观测。
 * 落盘反而会造出"上次坏过，这次修好了却一直报红"的假红灯，
 * 而假红灯会训练人忽略告警（HANDOFF ⑤B）。
 */

/** 最近一次转写里 VAD 真的跑失败了。null = 没观测到失败（**不等于**观测到成功）。 */
let lastFailure: { readonly atMs: number; readonly reasonZh: string } | null = null;

/** 转写 runner 在退回固定窗口时调用。`reasonZh` 应当是能给用户看的一句话。 */
export function noteVadRuntimeFailure(reasonZh: string): void {
  lastFailure = { atMs: Date.now(), reasonZh };
}

/** VAD 成功跑完一次 —— 把上一次的失败记录清掉，否则修好了也一直报红。 */
export function noteVadRuntimeSuccess(): void {
  lastFailure = null;
}

export function vadRuntimeFailure(): { readonly atMs: number; readonly reasonZh: string } | null {
  return lastFailure;
}

/** 仅供测试：把这一格恢复成"没观测过"。 */
export function resetVadRuntimeStatus(): void {
  lastFailure = null;
}

/** `/api/health` 里 `pipeline.vad` 那一块的形状。诊断页直接读它。 */
export interface VadHealth {
  readonly model: string | null;
  /** 实际会用哪种切分。**判据是后果，不是"文件在不在"。** */
  readonly chunking: 'vad' | 'fixed';
  readonly reasonZh: string;
  /** 存在但 whisper.cpp 加载不了的候选（典型：sherpa 的 `silero_vad.onnx`）。 */
  readonly rejected: readonly string[];
}

/**
 * 把「静态解析结果」与「运行期观测」合成一句话。
 *
 * **运行期失败优先**：权重挑对了不代表跑得起来，而用户关心的是后者。
 * 只报静态那一半的话，诊断页会在每一次转写都降级的情况下显示绿灯。
 */
export function vadHealth(resolved: {
  path: string | null;
  reasonZh: string;
  rejected: readonly string[];
}): VadHealth {
  const runtime = vadRuntimeFailure();
  if (runtime !== null) {
    return {
      model: resolved.path,
      chunking: 'fixed',
      reasonZh: runtime.reasonZh,
      rejected: resolved.rejected,
    };
  }
  return {
    model: resolved.path,
    chunking: resolved.path === null ? 'fixed' : 'vad',
    reasonZh: resolved.reasonZh,
    rejected: resolved.rejected,
  };
}
