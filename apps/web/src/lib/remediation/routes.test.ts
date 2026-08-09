import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, globSync, readFileSync } from 'node:fs';

import {
  REMEDIATION_ROUTES,
  UNKNOWN_ACTION_FALLBACK,
  UNROUTED_ACTIONS,
  remediationTarget,
} from './routes';

/* ────────────────────────── 表本身的行为 ────────────────────────── */

describe('remediationTarget —— 一份表，三种结局', () => {
  test('★ installSiteExtractor 落在 /components，不是 /models 也不是 /tasks', () => {
    // 这一条就是 demo 上 `warn | tool.ytDlp | 未找到` 唯一会在界面上显形的出口：
    // 粘一个 YouTube 链接 → daemon 422 NO_MEDIA_SOURCE + 这个 action。
    // 改坏它 = 用户点了「查看如何支持该站点」被送到一个装不了 yt-dlp 的页面。
    assert.equal(
      remediationTarget({ action: 'installSiteExtractor', params: { input: 'x' } }),
      '/components',
    );
  });

  test('带 modelId 的 install_model 直达详情页，且 id 经过 URL 编码', () => {
    assert.equal(
      remediationTarget({ action: 'install_model', params: { modelId: 'asr/whisper-base' } }),
      '/models/asr%2Fwhisper-base',
    );
  });

  test('不带 modelId 时退回列表页，不拼出 /models/undefined', () => {
    assert.equal(
      remediationTarget({ action: 'install_model', params: { role: 'asr' } }),
      '/models',
    );
    assert.equal(remediationTarget({ action: 'install_model' }), '/models');
  });

  test('daemon 两种拼写（install_model / installModel）落到同一个地方', () => {
    const a = remediationTarget({ action: 'install_model', params: { modelId: 'm1' } });
    const b = remediationTarget({ action: 'installModel', params: { modelId: 'm1' } });
    assert.equal(a, b);
    assert.equal(a, '/models/m1');
  });

  test('transcribeFirst 带 noteUid 时跳那条笔记，不是笔记列表', () => {
    assert.equal(
      remediationTarget({ action: 'transcribeFirst', params: { noteUid: '01KZ1H8Y' } }),
      '/notes/01KZ1H8Y',
    );
  });

  test('★ 故意不给路由的 action 返回 null（= 不渲染按钮），不是掉进兜底', () => {
    for (const action of Object.keys(UNROUTED_ACTIONS)) {
      assert.equal(
        remediationTarget({ action }),
        null,
        `${action} 应该明确"没有落点"，而不是被送到 ${UNKNOWN_ACTION_FALLBACK}`,
      );
    }
  });

  test('认不出的 action 仍给一个落点（前端比 daemon 旧时，什么都不显示是最差的）', () => {
    assert.equal(
      remediationTarget({ action: 'somethingInventedNextMonth' }),
      UNKNOWN_ACTION_FALLBACK,
    );
  });

  test('两张表不许有交集 —— 同一个 action 不能既有路由又"故意没有"', () => {
    const both = Object.keys(REMEDIATION_ROUTES).filter((a) => a in UNROUTED_ACTIONS);
    assert.deepEqual(both, []);
  });
});

/* ─────────────── 守卫：daemon 发的每个 action 都得被认领 ─────────────── */

/**
 * 把源码里的注释剥掉再扫。
 *
 * 不剥的话，一段**被注释掉的** `action: 'foo'` 会被算成"daemon 会发 foo"，
 * 于是护栏为一个不存在的动作要求一条路由 —— 那是假红灯，
 * 而假红灯会训练人忽略告警（HANDOFF ⑤B）。
 *
 * 行注释要看引号状态：`url: 'https://…'` 里的 `//` 不是注释。
 *
 * ⚠️ 块注释用**等量换行**替换，不能直接删：直接删会把后面所有行号往上顶，
 * 于是护栏红的时候指着一个错误的位置 —— `[实测]` 第一版就把
 * `rest/notes.ts:128` 报成了 `:96`。**一条报错位置的护栏，等于让下一个人多查一遍。**
 */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    '\n'.repeat((m.match(/\n/g) ?? []).length),
  );
  return noBlock
    .split('\n')
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (quote) {
          if (ch === '\\') i++;
          else if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        else if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/**
 * daemon 源码里所有会被塞进 `remediation` 的 action 字面量。
 *
 * 判据是**结构**（`action:` 这一行出现在一个提到 remediation 的上下文里），
 * 不是关键词匹配某个具体动作名 —— 钉关键词的护栏在改名那天会一起哑掉。
 */
function scanDaemonActions(roots: string[]): Map<string, string[]> {
  /*
   * ⚠️ 扫的范围曾经**只有 `apps/daemon/src`**，而引导并不只从那里发出来。
   * `[实测 2026-08-09]` `packages/llm/` 里有 5 个 action
   * （openSettings / reduceChunkSize / checkLocalBackend /
   *  increaseMaxTokens / retryWithLargerModel）——
   * 它们既不在 REMEDIATION_ROUTES 也不在 UNROUTED_ACTIONS，
   * 也就是说 `RemediationButton` 对它们**一个按钮都不渲染**：
   * 产品告诉用户"去做 X"，而用户没有任何入口去做。
   *
   * **这道护栏本身是对的，只是它的窗口比现实窄。**
   * 一个看不见半个仓库的护栏，会让人以为"已经有人在盯了"。
   */
  const files = roots
    .flatMap((r) => globSync(`${r}/**/*.ts`))
    .filter((f) => !f.endsWith('.test.ts'));
  const found = new Map<string, string[]>();
  for (const file of files) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*action:\s*(.+?),?\s*$/.exec(lines[i]!);
      if (!m) continue;
      const expr = m[1]!;
      // `action: string`（函数签名）之类没有字面量的，不是 remediation
      if (!/['"]/.test(expr)) continue;
      /*
       * 上下文窗口取 16 行：`probeRemediation()` 的返回类型标注在 11 行之前，
       * 窗口给 8 行时它整条漏掉过（实测）。窗口给宽一点的代价是可能多收，
       * 而多收只会让人来这里补一条理由 —— 漏收才是会放行 bug 的方向。
       */
      const ctx = lines.slice(Math.max(0, i - 16), i + 1).join('\n');
      if (!/[Rr]emediation/.test(ctx)) continue;
      /*
       * 三目：`missing.includes('asr-model') ? 'install_model' : 'install_backend'`
       * —— 条件里的 `'asr-model'` 不是 action。取 `?` 之后的分支。
       */
      const branches = expr.includes('?') ? expr.slice(expr.indexOf('?') + 1) : expr;
      for (const s of branches.matchAll(/'([^']+)'|"([^"]+)"/g)) {
        const action = s[1] ?? s[2]!;
        const at = `${file}:${i + 1}`;
        found.set(action, [...(found.get(action) ?? []), at]);
      }
    }
  }
  return found;
}

describe('守卫：daemon 会发的 action，前端必须逐个认领过', () => {
  const daemonSrc = `${process.cwd()}/../daemon/src`;
  // 引导不只从 daemon 发出来：packages/llm 也发（见 scanDaemonActions 的说明）
  const scanRoots = [daemonSrc, `${process.cwd()}/../../packages/llm/src`];

  test('前提：daemon 源码目录找得到（找不到就不是"没问题"，是没在测）', () => {
    assert.equal(
      existsSync(daemonSrc),
      true,
      `扫不到 ${daemonSrc} —— 仓库布局变了，这条护栏已失效`,
    );
  });

  test('前提：扫得出东西（正则失效 → 空集 → 下面那条会假绿）', () => {
    const found = scanDaemonActions(scanRoots);
    assert.equal(
      found.size >= 10,
      true,
      `只扫到 ${found.size} 个 action（${[...found.keys()].join(', ')}）—— 扫描逻辑坏了`,
    );
    // 定点校准：这三个分别代表 HTTP 错误信封、job blocked 事件、返回类型标注三种写法。
    for (const anchor of ['installSiteExtractor', 'installModel', 'retry_probe']) {
      assert.equal(found.has(anchor), true, `扫描漏掉了 ${anchor} —— 上下文窗口或正则又收窄了`);
    }
  });

  test('★ 每个 action 要么有路由，要么在 UNROUTED_ACTIONS 里写明为什么没有', () => {
    const found = scanDaemonActions(scanRoots);
    const orphans = [...found.entries()]
      .filter(([a]) => !(a in REMEDIATION_ROUTES) && !(a in UNROUTED_ACTIONS))
      .map(([a, at]) => `${a}（${at.join(' ')}）`);
    assert.deepEqual(
      orphans,
      [],
      'daemon 新发了这些 action，前端一条都不认识 —— 它们会静默落进 ' +
        `${UNKNOWN_ACTION_FALLBACK}：\n  ${orphans.join('\n  ')}`,
    );
  });

  test('反向：表里不许留 daemon 根本不发的 action（旧表的 switch_source / configure_api_key 就是这么来的）', () => {
    const found = scanDaemonActions(scanRoots);
    const dead = [...Object.keys(REMEDIATION_ROUTES), ...Object.keys(UNROUTED_ACTIONS)].filter(
      (a) => !found.has(a),
    );
    assert.deepEqual(
      dead,
      [],
      `这些 action 全仓 daemon 都不发，却在表里占着位置：${dead.join(', ')}。` +
        '留着它们的代价是：读表的人以为覆盖到了，实际覆盖的是空气',
    );
  });
});
