/**
 * Resource lane semaphores. D-01 §4.2.
 *
 * There is no "global concurrency limit" here, because that is the wrong abstraction: a
 * download and a GPU inference do not compete for the same resource. Each step declares
 * which lane it consumes and waits for a permit in that lane only.
 *
 * The one rule that actually matters: **VRAM cannot be oversold.** `gpu.asr` and
 * `gpu.llm` are 1 each AND mutually exclusive through a shared `gpu.exclusive` permit —
 * running whisper-large and an 8B LLM on one card at the same time is an OOM, and an OOM
 * mid-transcription costs the user everything since the last chunk.
 */

export const LANES = [
  'net.download',
  'net.llm',
  'cpu.media',
  'gpu.asr',
  'gpu.llm',
  'io.local',
] as const;

export type Lane = (typeof LANES)[number];

export interface LaneCapacities {
  'net.download': number;
  'net.llm': number;
  'cpu.media': number;
  'gpu.asr': number;
  'gpu.llm': number;
  'io.local': number;
}

/** D-01 §4.2 defaults, with cpu.media scaled to the machine. */
export function defaultCapacities(cpuCount: number): LaneCapacities {
  return {
    'net.download': 2,
    'net.llm': 2,
    'cpu.media': Math.max(1, Math.min(4, Math.floor(cpuCount / 4))),
    'gpu.asr': 1,
    'gpu.llm': 1,
    'io.local': 4,
  };
}

/** FIFO counting semaphore. FIFO matters: LIFO would starve the first arrival. */
class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(private capacity: number) {
    this.available = capacity;
  }

  get inUse(): number {
    return this.capacity - this.available;
  }

  get queueLength(): number {
    return this.waiters.length;
  }

  getCapacity(): number {
    return this.capacity;
  }

  /**
   * Capacity can change at runtime — `hardware.changed` (a GPU appearing, a backend
   * being installed) recomputes the lanes. Growing releases waiters immediately;
   * shrinking never preempts a permit already granted, it just stops issuing new ones.
   */
  setCapacity(next: number): void {
    const delta = next - this.capacity;
    this.capacity = next;
    this.available += delta;
    this.drain();
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw new Error('aborted while queued');

    if (this.available > 0) {
      this.available -= 1;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('aborted while queued'));
      };
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    this.available += 1;
    this.drain();
  }

  private drain(): void {
    while (this.available > 0 && this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (next === undefined) break;
      this.available -= 1;
      next();
    }
  }
}

export interface LaneStats {
  lane: Lane;
  capacity: number;
  inUse: number;
  queued: number;
}

export class LaneManager {
  private readonly semaphores = new Map<Lane, Semaphore>();
  /** Couples gpu.asr and gpu.llm so they can never run together. */
  private readonly gpuExclusive = new Semaphore(1);

  constructor(capacities: LaneCapacities) {
    for (const lane of LANES) {
      this.semaphores.set(lane, new Semaphore(capacities[lane]));
    }
  }

  private isGpuLane(lane: Lane): boolean {
    return lane === 'gpu.asr' || lane === 'gpu.llm';
  }

  /**
   * Run `fn` holding a permit for `lane`.
   *
   * GPU lanes take `gpu.exclusive` FIRST, then the lane-specific permit. A consistent
   * global ordering is what prevents deadlock between two callers wanting different GPU
   * lanes; acquiring in opposite orders would be a textbook lock-order inversion.
   */
  async withLane<T>(lane: Lane, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const sem = this.semaphores.get(lane);
    if (sem === undefined) throw new Error(`unknown lane: ${lane}`);

    const needsExclusive = this.isGpuLane(lane);
    if (needsExclusive) await this.gpuExclusive.acquire(signal);

    try {
      await sem.acquire(signal);
    } catch (err) {
      if (needsExclusive) this.gpuExclusive.release();
      throw err;
    }

    try {
      return await fn();
    } finally {
      sem.release();
      if (needsExclusive) this.gpuExclusive.release();
    }
  }

  setCapacity(lane: Lane, capacity: number): void {
    this.semaphores.get(lane)?.setCapacity(Math.max(0, capacity));
  }

  stats(): LaneStats[] {
    return LANES.map((lane) => {
      const s = this.semaphores.get(lane)!;
      return { lane, capacity: s.getCapacity(), inUse: s.inUse, queued: s.queueLength };
    });
  }
}

// =========================================================================================
// Priority (D-01 §4.3)
// =========================================================================================

export const PRIORITY = {
  /** The note the user is looking at right now; live recording. */
  INTERACTIVE: 0,
  NORMAL: 10,
  BATCH: 20,
  MAINTENANCE: 30,
} as const;

export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

/**
 * Cooperative preemption at chunk boundaries.
 *
 * D-01 §4.3 explicitly rules out hard preemption: killing a running inference throws
 * away compute already spent. Instead the worker asks, after each chunk, whether
 * something more urgent is waiting — and if so yields the lane while keeping its
 * checkpoint. This is the second reason the Chunk layer exists.
 */
export interface PreemptionCheck {
  shouldYield(currentPriority: number): boolean;
}

export class PriorityTracker implements PreemptionCheck {
  private readonly waiting = new Map<string, number>();

  enqueue(jobId: string, priority: number): void {
    this.waiting.set(jobId, priority);
  }

  dequeue(jobId: string): void {
    this.waiting.delete(jobId);
  }

  /** Strictly-higher priority only (lower number). Equal priority must not thrash. */
  shouldYield(currentPriority: number): boolean {
    for (const p of this.waiting.values()) {
      if (p < currentPriority) return true;
    }
    return false;
  }

  highestWaiting(): number | null {
    let best: number | null = null;
    for (const p of this.waiting.values()) {
      if (best === null || p < best) best = p;
    }
    return best;
  }
}
