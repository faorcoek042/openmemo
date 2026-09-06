#!/usr/bin/env node
/**
 * 跑测试之前提一句：**这棵树是脏的，你测的不是 master。**
 *
 * ## 它挡的是一次真事故
 *
 * Manager 在共享工作区 `/root/memo` 跑 `pnpm -r test`，看到红就当成 **master 红**，
 * 还据此派了工去找"引入点" —— **而根本没有引入点，master 全绿**。
 *
 * 判据是那条腿的人后来讲清楚的：
 *
 * > `/root/memo` 里的 `pnpm -r test` 测的是
 * > **「master ∪ 每一位 agent 在那一瞬间的未提交改动」** ——
 * > 一个**从来没有存在过的组合**，而且**没有任何人承诺过它是绿的**。
 * > **在那里红，不能归因于 master；在那里绿，同样不能证明 master 是绿的。**
 *
 * PROTOCOL §12 已经写了"树脏时用隔离 worktree"，但**没有任何东西在那一刻告诉你树是脏的**
 * —— 而**一条要靠记住的规则，是一条迟早会被打破的规则**。这个脚本就是那个"当场告诉你"。
 *
 * ## 三条不可协商的性质
 *
 * ① **它永远不会让任何命令变红。** 树脏是**常态不是故障**。
 *    做成红门禁就是本仓那条「一条永远红的守卫等于一条被删掉的守卫」——
 *    大家会先学会忽略它，然后学会删掉它。所以整段逻辑包在 try/catch 里，
 *    **任何异常都吞掉并 exit 0**：连它自己坏掉都不许拖累别人。
 * ② **两个方向都要说。** 红了要提醒"可能不是 master 的锅"；
 *    **绿了也要提醒"这不证明 master 绿"** —— 后半句更容易被忘，而它同样能骗人：
 *    一次"本地全绿"会让人放心地把一个在 master 上根本没跑过的组合当成验过了。
 * ③ **不许慢、不许吵。** 它挂在所有人最常跑的那条命令上。
 *    只有一次 `git status --porcelain`，无网络；同一次 pnpm 调用里**只打一遍**（见下）。
 *
 * ## 为什么"只打一遍"要靠 ppid
 *
 * `pnpm -r test` 会在 **9 个包**里各跑一次包自己的 test 脚本，而本通知挂在
 * `check-test-scripts.mjs`（8 个包的 test 脚本都调它）——不去重就会打 9 遍。
 *
 * `[实测]` 同一次 `pnpm -r` 里，各个包脚本看到的 `process.ppid` **完全相同**
 * （9 个包全是 `98087`）——因为它们都由同一个 pnpm 进程拉起。
 * 所以用 ppid 当键写一个空标记文件：**同一次调用只打一遍，不同调用互不影响**
 * （并发跑的两个人 ppid 不同，不会互相吞掉对方的提示）。
 *
 * ⚠️ 标记文件写在系统临时目录、零字节、以 ppid 命名 —— 不是机器级状态，
 *    被 kill 也只留下一个空文件（PROTOCOL §9-bis 的判据：最坏那一行 kill -9，
 *    机器上剩下什么？剩一个 0 字节的临时文件，不影响任何东西）。
 *
 * ## 用法
 *
 *   node scripts/dirty-tree-notice.mjs            # 跑之前提醒（会去重）
 *   node scripts/dirty-tree-notice.mjs --after    # 全绿之后再提醒一次（不去重）
 *   node scripts/dirty-tree-notice.mjs --force    # 不去重
 */
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDirectRun } from './lib/entrypoint.mjs';

/** 最多列几个文件 —— 树很脏时不要刷屏。 */
const MAX_LIST = 12;

/**
 * 打印提示。**永远不抛、永远不退出进程** —— 调用方（含门禁脚本）不该因它出事。
 *
 * ★ 做成可 import 的函数而不是只有 CLI：`pnpm -r test` 会在 9 个包里各调一次，
 *   每次 `spawnSync` 一个 node 就是 9 次进程启动（`[实测]` 端到端中位 115.5 ms/次）。
 *   直接 import 之后只有第一次真干活，其余 8 次是一个已被去重挡住的函数调用。
 */
export function dirtyTreeNotice({ after = false, force = false } = {}) {
  const FORCE = force || after;
  try {
    /*
     * ★ 去重放在 `git status` **之前**。
     *   放后面的话，`pnpm -r test` 的 9 次调用每次都要付一遍 git status
     *   （`[实测]` 中位 33.6 ms）——那是白付的，因为后 8 次根本不会打印。
     */
    let marker = null;
    if (!FORCE) {
      marker = join(tmpdir(), `openmemo-dirty-notice-${process.ppid}`);
      if (existsSync(marker)) return;
    }

    const r = spawnSync('git', ['status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    // 不在 git 仓库里、git 不在、超时 —— 一律安静退出。它没有资格打扰任何人。
    if (r.status !== 0 || typeof r.stdout !== 'string') return;

    const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);
    // ★ 干净树 = 一个字都不说。这是它能被长期容忍的前提。
    if (lines.length === 0) return;

    if (marker !== null) {
      try {
        writeFileSync(marker, '');
      } catch {
        /* 写不了标记就多打一遍，无所谓 —— 绝不因此报错 */
      }
    }

    const bar = '─'.repeat(78);
    const out = [''];
    out.push(bar);
    out.push(
      after
        ? '  ⚠️ 全绿了，但**这不证明 master 是绿的**。'
        : `  ⚠️ 工作区不干净：${lines.length} 处未提交改动。**本次测的不是 master。**`,
    );
    out.push(bar);

    if (!after) {
      for (const l of lines.slice(0, MAX_LIST)) out.push(`     ${l}`);
      if (lines.length > MAX_LIST) out.push(`     …… 另外 ${lines.length - MAX_LIST} 处`);
      out.push('');
    }

    /*
     * ★ 两个方向都说。绿的那一句不是客套 —— 它挡的是
     *   "本地全绿 ⇒ 可以合了/可以发了"，而本地那个组合从来没有存在过。
     *   `--after` 那一支没有列文件，所以别说"上面这些"（指着一个不存在的列表会让人以为漏打了）。
     */
    out.push(
      after
        ? '  刚才测的是 **master ∪ 那些未提交改动** —— 一个从来没有存在过的组合，'
        : '  本次测的是 **master ∪ 上面这些未提交改动** —— 一个从来没有存在过的组合，',
    );
    out.push('  没有任何人承诺过它是绿的。所以：');
    out.push('     · **红了** → 先看那些改动，不要直接归因于 master（有人为此派错过工）。');
    out.push('     · **绿了** → 也**不能**据此说 master 是绿的：你验的不是它。');
    out.push('');
    out.push(
      '  要对 master 下结论，按 PROTOCOL §12 在隔离 worktree 上检出你自己那个 commit 再跑。',
    );
    out.push(bar);
    out.push('');
    console.log(out.join('\n'));
  } catch {
    /*
     * ★ 连它自己炸了也必须安静收场。
     *   一个"提醒你别误判"的东西，绝不能反过来变成别人排查的噪音源。
     */
  }
}

/* ── CLI 入口：只有被直接执行时才跑，被 import 时不动 ──
 * ⚠️ 只许用 `isDirectRun()`（判据见 scripts/lib/entrypoint.mjs 文件头）：
 * `pathToFileURL(argv[1]).href === import.meta.url` 只修了百分号编码那一半，
 * 软链那一半仍然会静默失配 —— 而失配的表现是这个脚本整个不出声。 */
if (isDirectRun(import.meta.url, process.argv[1])) {
  const argv = process.argv.slice(2);
  dirtyTreeNotice({ after: argv.includes('--after'), force: argv.includes('--force') });
  // ★ 永远 0：树脏是常态不是故障（做成红门禁 = 一条迟早被删掉的守卫）。
  process.exit(0);
}
