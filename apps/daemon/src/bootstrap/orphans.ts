/**
 * 孤儿子进程回收（D-01 §2.7 B）。
 *
 * ## 为什么必须有
 *
 * 优雅退出能杀干净子进程，但 **SIGKILL 捕获不到** —— 用户在任务管理器里强杀 daemon 时，
 * `whisper-cli` 会被 init 收养并**继续跑到底**，吃满 CPU。
 * 实测复现（T-051）：`kill -9` daemon 之后 `whisper-cli` 仍在跑一个 30s 的 chunk。
 *
 * 这正是 D-07 那条复合失败里的一环：杀 daemon → 子进程活着吃 CPU。
 * 前面几环（取消、保留、permit、续跑）都验掉了，这一环之前**只是写在文档里没有实现**。
 *
 * ## 识别规则：按 dataDir 精确匹配，不按进程名
 *
 * 本机会同时跑多个 daemon（不同 dataDir），**绝不能按进程名批量杀** ——
 * 那会杀掉别人的任务。所幸我们的子进程命令行里一定带着自己数据目录下的路径
 * （`-f <dataDir>/tmp/job-xxx/audio16k.wav`），这是精确且唯一的判据。
 *
 * 同时要求它**已经是孤儿**（`ppid === 1`）：还挂在某个活着的父进程下的，
 * 说明那个 daemon 还在跑，不该动。
 */
import { readFile, readdir } from 'node:fs/promises';

export interface ReclaimResult {
  readonly scanned: number;
  readonly killed: readonly { pid: number; cmd: string }[];
}

async function readCmdline(pid: string): Promise<string | undefined> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    return raw.replace(/\0/g, ' ').trim();
  } catch {
    return undefined;
  }
}

async function readPpid(pid: string): Promise<number | undefined> {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const m = /^PPid:\s*(\d+)$/m.exec(status);
    return m?.[1] ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 回收属于本数据目录、且已成为孤儿的子进程。
 *
 * @param dataDir 本实例的数据目录（作为归属判据）
 * @returns 扫描与击杀结果，供启动日志打印
 */
export async function reclaimOrphans(dataDir: string): Promise<ReclaimResult> {
  // /proc 只有 Linux 有。其它平台先不做（macOS/Windows 需要各自的进程枚举方式）。
  if (process.platform !== 'linux') return { scanned: 0, killed: [] };

  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    return { scanned: 0, killed: [] };
  }

  const pids = entries.filter((e) => /^\d+$/.test(e));
  const killed: { pid: number; cmd: string }[] = [];
  const self = process.pid;

  for (const pid of pids) {
    const n = Number(pid);
    if (n === self) continue;

    const cmd = await readCmdline(pid);
    // 归属判据：命令行里出现本 dataDir。这是精确匹配，不会误伤别的 daemon。
    if (!cmd || !cmd.includes(dataDir)) continue;

    // 只处理**已经成为孤儿**的：还有活着的父进程说明那个 daemon 还在跑
    const ppid = await readPpid(pid);
    if (ppid !== 1) continue;

    try {
      process.kill(n, 'SIGTERM');
      killed.push({ pid: n, cmd: cmd.slice(0, 120) });
    } catch {
      /* 可能刚好自己退了，忽略 */
    }
  }

  // 给 SIGTERM 一点时间，没走的补 SIGKILL
  if (killed.length > 0) {
    await new Promise((r) => setTimeout(r, 1500));
    for (const k of killed) {
      try {
        process.kill(k.pid, 0);
        process.kill(k.pid, 'SIGKILL');
      } catch {
        /* 已经退了 */
      }
    }
  }

  return { scanned: pids.length, killed };
}
