/**
 * ★ 仓库级守卫：D-01 §8.4 L1「子进程只从一个出口出去」**现在真的有机器在执行了**。
 *
 * ## 这条守的是什么
 *
 * `D-01:1061`、`docs/SECURITY.md:109`、`D-06:330` 三份文档都写着
 * 「CI 用 `no-restricted-imports` 强制，`…/subprocess/**` 之外禁止 import `node:child_process`」，
 * D-01 的 TL;DR 还特意声明这是「**架构强制点，不是编码规范建议**」。
 *
 * `[实测]`（`debt-cleanup` T-152）：**这条规则从未存在过**。
 * `eslint.config.js` 里 `no-restricted-imports` 恰好出现三处，**全是前端分层护栏**，
 * 与子进程无关；D-01 点名的那个目录（`apps/daemon/src/subprocess/`）**也不存在**。
 * 三份文档互相引用同一条不存在的控制，形成「看起来被三处证实」的假象 ——
 * 这比没有防线更糟，因为它让审计的人以为这一格已经绿了。
 *
 * T-153 补上了规则 + 白名单。**本文件的职责是让"补上了"这句话本身可被证伪。**
 *
 * ## 为什么用真的 eslint 跑，而不是读 eslint.config.js 的字段
 *
 * flat config 里同名规则是**整体覆盖**不是合并，谁在后面谁说了算。
 * 「配置里有这一段」和「这一段对某个文件真的生效」是两件事 ——
 * 一个写在 `apps/web` 块后面的宽范围块，会**悄悄吃掉**前面两条前端分层护栏，
 * 而配置文件读起来一切正常。所以这里问的是 eslint 自己：
 * `--stdin --stdin-filename <路径>` 让它按那个路径解析配置并真的 lint 一遍，
 * **不落任何文件**（往仓库里写临时源码文件本身就是一种污染）。
 *
 * ## 四条断言，各钉一个不同的失效形态
 *
 *   1. 产品代码里 import `node:child_process` → **error**（规则真的生效了）
 *   2. 白名单里的 7 个文件 → **不报**（否则是假红灯，会训练人加 eslint-disable）
 *   3. `await import('node:child_process')` → **不报**，且这是**已知盲区**，
 *      写进断言是为了不让下一个人因为"有规则了"再把文档改回"已强制"
 *   4. 两条前端分层护栏仍然 error（证明第 1 条那个块没有覆盖掉它们）
 *
 * ## 为什么住在 packages/pipeline 里
 *
 * 与 `sourceIsGreppable.test.ts` 同一个理由：事实上的门禁是 `pnpm -r test`，
 * 而 `pnpm -r` **默认不含 workspace root**，挂在根 `package.json` 上的守卫不会被跑到。
 * 而 L1 说的那个"唯一出口"就在本目录（`../runner.ts`）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/** 仓库根 —— `dist/subprocess/__tests__/` 上溯 5 层。 */
const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..'));
const ESLINT_BIN = join(REPO, 'node_modules', 'eslint', 'bin', 'eslint.js');

/**
 * 用真的 eslint lint 一段源码，**按 `asPath` 解析配置**。文件系统一个字节都不写。
 *
 * 返回命中的 ruleId 列表（去重排序）。解析失败一律抛，不返回空数组 ——
 * 「eslint 没跑起来」和「eslint 说没问题」返回同一个值，是本仓最贵的那类假绿灯。
 */
function lintAs(asPath: string, source: string): string[] {
  const r = spawnSync(
    process.execPath,
    [ESLINT_BIN, '--stdin', '--stdin-filename', asPath, '--format', 'json'],
    { cwd: REPO, input: source, encoding: 'utf8', timeout: 120_000 },
  );
  if (r.error) throw new Error(`eslint 没跑起来：${r.error.message}`);
  const out = (r.stdout ?? '').trim();
  if (!out.startsWith('[')) {
    throw new Error(
      `eslint 没有输出 JSON（exit=${String(r.status)}）。stdout=${out.slice(0, 400)} stderr=${(r.stderr ?? '').slice(0, 400)}`,
    );
  }
  const parsed = JSON.parse(out) as { messages: { ruleId: string | null }[] }[];
  const ids = (parsed[0]?.messages ?? []).map((m) => m.ruleId ?? '<fatal>');
  return [...new Set(ids)].sort();
}

const CHILD_PROCESS_IMPORT =
  "import { spawn } from 'node:child_process';\nexport const x = spawn;\n";

/**
 * L1 白名单 —— 必须与 `eslint.config.js` 里那一块**逐字一致**，也与 D-01 §8.4 的表一致。
 * 每一行后面的性质写在 `eslint.config.js` 上，不在这里重复（一份说明两处抄 = 迟早分叉）。
 */
const ALLOWLIST = [
  'packages/pipeline/src/subprocess/runner.ts',
  'packages/pipeline/src/asr/whisperServer.ts',
  'apps/daemon/src/main.ts',
  'apps/daemon/src/bootstrap/tls.ts',
  'packages/runtime/src/probe/runProbe.ts',
  'packages/runtime/src/detect/system.ts',
  'packages/runtime/src/selfTest.ts',
] as const;

describe('★ D-01 §8.4 L1：子进程出口的 lint 护栏（T-153 补上的机器执行者）', () => {
  it('先证明 eslint 真的能跑（跑不起来的话下面每条都会"通过"）', () => {
    assert.equal(existsSync(ESLINT_BIN), true, `找不到 eslint：${ESLINT_BIN}`);
    // 拿一段必然干净的源码探路：它返回 [] 才说明"[] = 没问题"这个解读成立。
    assert.deepEqual(
      lintAs('packages/pipeline/src/__probe__.ts', 'export const ok = 1;\n'),
      [],
      '一段干净源码都报错了 —— 说明下面几条的"报没报"没有意义',
    );
  });

  it('★ 产品源码里 import node:child_process 必须报错', () => {
    for (const p of [
      'apps/daemon/src/http/rest/__probe__.ts',
      'packages/pipeline/src/media/__probe__.ts',
      'packages/downloader/src/__probe__.ts',
      'packages/db/src/__probe__.ts',
    ]) {
      assert.deepEqual(
        lintAs(p, CHILD_PROCESS_IMPORT),
        ['no-restricted-imports'],
        `${p} 里 import node:child_process 没有被拦下 —— L1 又变回一句空话了`,
      );
    }
  });

  it('★ 白名单里的 7 个文件不许报（假红灯会被人用 eslint-disable 关掉，例外从此不可清点）', () => {
    const noisy = ALLOWLIST.filter((p) => lintAs(p, CHILD_PROCESS_IMPORT).length > 0);
    assert.deepEqual(
      noisy,
      [],
      `这些文件架构上就绕不开 child_process，规则却在报它们：${noisy.join(', ')}`,
    );
  });

  it('白名单文件必须真的存在（改名/删除后要么更新白名单，要么把它拿掉）', () => {
    const missing = ALLOWLIST.filter((p) => !existsSync(join(REPO, p)));
    assert.deepEqual(missing, [], `白名单指向了不存在的文件：${missing.join(', ')}`);
  });

  it('★ 已知盲区：动态 import 这条规则拦不住 —— 别再把文档写成"已强制"', () => {
    /*
     * `packages/downloader/scripts/verify-offline.mjs:640` 就是这个形状：
     *   const { execFileSync } = await import('node:child_process');
     *
     * 断言"它不报"看起来很怪，但它钉住的是一件真东西：**这条规则的边界**。
     * 上一次的教训正是"文档声称有一条不存在的防线"；这一次防线有了，
     * 而如果没人写下它拦不住什么，下一份文档就会再次高报一格。
     *
     * 这条红了不代表出了 bug —— 它代表 eslint 变得更强了，
     * 那时请去掉这条断言并**同时**更新 D-01 §8.4 与 SECURITY.md 的那句话。
     */
    assert.deepEqual(
      lintAs(
        'apps/daemon/src/__probe__.ts',
        "const m = await import('node:child_process');\nexport const x = m;\n",
      ),
      [],
      'eslint 现在能抓动态 import 了 —— 请更新 D-01 §8.4 / SECURITY.md 里"静态规则抓不到"那句话',
    );
  });

  it('★ 前端两条分层护栏仍然生效（新块的 files 范围没有把它们覆盖掉）', () => {
    assert.deepEqual(
      lintAs(
        'apps/web/src/features/models/__probe__.tsx',
        "import { x } from '../notes/thing';\nexport const y = x;\n",
      ),
      ['no-restricted-imports'],
      'features/A → features/B 不再报错了 —— flat config 里同名规则是整体覆盖，新块吃掉了它',
    );
    assert.deepEqual(
      lintAs(
        'apps/web/src/lib/api/__probe__.ts',
        "import { x } from '../../features/notes/thing';\nexport const y = x;\n",
      ),
      ['no-restricted-imports'],
      'lib/ → features/ 不再报错了 —— 同上',
    );
  });
});
