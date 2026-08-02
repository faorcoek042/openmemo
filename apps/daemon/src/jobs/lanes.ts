/**
 * 资源 lane 信号量（D-01 §4.2）。
 *
 * 刻意**不设"全局并发数"** —— 那是错的抽象：下载和 GPU 推理抢的根本不是同一种资源。
 * 改为按资源类别的信号量池，每个 step 声明它占用哪个 lane。
 */
import { cpus } from 'node:os';

export const LANES = [
  'net.download',
  'net.llm',
  'cpu.media',
  'gpu.asr',
  'gpu.llm',
  'io.local',
] as const;
export type Lane = (typeof LANES)[number];

/**
 * `gpu.asr` 与 `gpu.llm` **互斥**：同一块卡上同时跑 whisper large 和 8B LLM 会 OOM。
 * 用一个更粗的 `gpu.exclusive` 信号量（并发 1）把两者串起来。
 */
export const GPU_EXCLUSIVE = 'gpu.exclusive';
const GPU_LANES = new Set<Lane>(['gpu.asr', 'gpu.llm']);

export function defaultCapacities(coreCount = cpus().length): Readonly<Record<Lane, number>> {
  return {
    'net.download': 2, // 家用带宽
    'net.llm': 2, // 云 API 速率
    'cpu.media': Math.min(Math.max(Math.floor(coreCount / 4), 1), 4), // ffmpeg 自己会吃多核
    'gpu.asr': 1, // 显存不可超卖
    'gpu.llm': 1, // 同上
    'io.local': 4, // 磁盘
  };
}

interface Waiter {
  resolve: (release: () => void) => void;
  readonly lane: Lane;
}

/**
 * 计数信号量池。`acquire()` 返回一个 release 函数（**必须**在 finally 里调用）。
 */
export class LanePool {
  #capacity: Record<string, number>;
  readonly #inUse: Record<string, number> = {};
  readonly #waiters: Waiter[] = [];

  constructor(capacities: Readonly<Record<Lane, number>> = defaultCapacities()) {
    this.#capacity = { ...capacities, [GPU_EXCLUSIVE]: 1 };
    for (const k of Object.keys(this.#capacity)) this.#inUse[k] = 0;
  }

  /** 硬件探测结果变化时重算容量（D-01 §4.2：lane 容量随 hardware.changed 动态调整）。 */
  reconfigure(capacities: Partial<Record<Lane, number>>): void {
    this.#capacity = { ...this.#capacity, ...capacities };
    this.#drain();
  }

  capacityOf(lane: Lane): number {
    return this.#capacity[lane] ?? 1;
  }

  inUseOf(lane: Lane): number {
    return this.#inUse[lane] ?? 0;
  }

  /** 一个 lane 实际要占用的所有信号量（GPU lane 额外占 gpu.exclusive）。 */
  #keysFor(lane: Lane): string[] {
    return GPU_LANES.has(lane) ? [lane, GPU_EXCLUSIVE] : [lane];
  }

  #canTake(lane: Lane): boolean {
    return this.#keysFor(lane).every((k) => (this.#inUse[k] ?? 0) < (this.#capacity[k] ?? 1));
  }

  #take(lane: Lane): () => void {
    for (const k of this.#keysFor(lane)) this.#inUse[k] = (this.#inUse[k] ?? 0) + 1;
    let released = false;
    return () => {
      if (released) return; // 幂等：重复 release 不该把计数弄负
      released = true;
      for (const k of this.#keysFor(lane)) this.#inUse[k] = Math.max(0, (this.#inUse[k] ?? 1) - 1);
      this.#drain();
    };
  }

  tryAcquire(lane: Lane): (() => void) | undefined {
    return this.#canTake(lane) ? this.#take(lane) : undefined;
  }

  acquire(lane: Lane): Promise<() => void> {
    const immediate = this.tryAcquire(lane);
    if (immediate) return Promise.resolve(immediate);
    return new Promise<() => void>((resolve) => {
      this.#waiters.push({ lane, resolve });
    });
  }

  #drain(): void {
    for (let i = 0; i < this.#waiters.length; i++) {
      const w = this.#waiters[i];
      if (!w) continue;
      if (this.#canTake(w.lane)) {
        this.#waiters.splice(i, 1);
        i--;
        w.resolve(this.#take(w.lane));
      }
    }
  }

  snapshot(): Record<string, { capacity: number; inUse: number }> {
    const out: Record<string, { capacity: number; inUse: number }> = {};
    for (const k of Object.keys(this.#capacity)) {
      out[k] = { capacity: this.#capacity[k] ?? 0, inUse: this.#inUse[k] ?? 0 };
    }
    return out;
  }
}
