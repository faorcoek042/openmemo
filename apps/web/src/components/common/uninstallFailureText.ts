/**
 * 「我们试着删了、没删动」那一档的措辞总表（#113）。
 *
 * ## 这个文件存在的理由
 *
 * `dropInstalledFiles()` 此前把 `fs.rm` 的失败整个吞掉（`.catch(() => undefined)`），
 * 而且吞掉之后**照样 `removed += 1`** —— 用户点卸载、看到成功、文件还在盘上。
 * 修法把它抬成契约里的第三档（`FailedFileReport`），而**契约那一半只解决了
 * "服务端说得出话"**：这句话真正要抵达的地方是屏幕。
 *
 * ## ★★ 为什么是 `Record<全部 kind, string>` 而不是 `switch` + `default`
 *
 * 与 `features/settings/proxyReasonText.ts` / `components/common/engineReasonText.ts`
 * 一字不差的那条规则：**契约里新增一格而没人给它写话，构建当场就红**。
 * 换成 `KEYS[k] ?? ''` 或者带万能 `default` 的 `switch`，新的一格会静默渲染成空白 ——
 * 而这里的空白说的是一句实打实的假话：横幅上会出现一个只有文件名、
 * **没有"能做什么"**的条目，也就是这次要修的那个形状原封不动地回来。
 *
 * ## ⚠️ 三格的措辞各自负责一件事，**别互相抄**
 *
 *   · `in_use`            → **可执行的建议**（关掉占用的程序 / 重启一次）。这一档存在的全部理由。
 *   · `permission_denied` → 两种可能都说（权限不足 / Windows 上文件正被打开着）。
 *                            挑一种说得斩钉截铁 = 替一个我们没查清的成因背书。
 *   · `unknown`           → **明说「原因我们没弄清」**，只给路径和系统原话，不给建议。
 *
 * 最后一格是判据的一部分，不是兜底的敷衍：`fs.rm` 能抛的东西没有边界，
 * **编一个成因比沉默更坏** —— 用户会照着那句编出来的话去做一件没有用的事。
 */

import type { FailedFileReport, RemovalFailureKind } from '@openmemo/shared';

/** `t()` 的最小形状 —— 这个模块不引 React，方便直接对它写用例。 */
type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * 一条「删不动」的每一种成因该说哪句话。**总表，三格一个都不许少。**
 *
 * 三句词条**都**吃 `{{name}}` 与 `{{path}}`：这一档的用户动作是他自己去删，
 * 而「在哪儿」这个问题在整条链上只有 `path` 答得出来（`fs.rm` 抛的那串
 * 不保证带完整路径，所以契约里单列了一格）。
 */
export const REMOVAL_FAILURE_KEYS: Readonly<Record<RemovalFailureKind, string>> = {
  in_use: 'uninstall.removalFailure.in_use',
  permission_denied: 'uninstall.removalFailure.permission_denied',
  unknown: 'uninstall.removalFailure.unknown',
};

/**
 * 线上那个 `kind` → 我们认得的一格；**认不出一律 `'unknown'`**。
 *
 * ## ⚠️ 必须在运行期收一道（同 `normalizeProbeDetail` 的理由）
 *
 * 它是从网线上来的。类型上写着联合，不代表它到手时就是：更新过的 daemon
 * 完全可能发一个**这份前端还不认识**的第四格（daemon 与 SPA 同包发布，
 * 但陈旧标签页真实存在 —— `lib/api/client.ts` 的自愈重连走的就是那条路）。
 * 收不住的后果是 `t(undefined)`：整条横幅崩掉，或者渲染出一行 `undefined`。
 *
 * ★ 退到 `'unknown'` 而不是丢掉这一条：那一格的措辞本来就是
 * 「没删掉、它在这儿、原因我们没弄清」—— 对一个我们真的不认识的 kind 来说，
 * **那句话是准确的**，而丢掉这一条会让用户回到"界面一个字都不说"。
 */
export function removalFailureKindOf(raw: unknown): RemovalFailureKind {
  // `hasOwnProperty.call` 而不是 `in`：`'toString' in KEYS` 是真的。
  if (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(REMOVAL_FAILURE_KEYS, raw)) {
    return raw as RemovalFailureKind;
  }
  return 'unknown';
}

/**
 * 一条 `FailedFileReport` → 用户读得懂的那句话（当前语言）。
 *
 * `t(key, {...})` 只摊 `name` / `path` 两个洞，**不把整个对象扔给 i18next**：
 * 那样「这一格该有哪几个洞」就变成运气 —— 少一个字段时渲染出来的是原样的
 * `{{path}}` 占位符，而不是一个编译错误（`proxyReasonText.ts` 同一条注释）。
 *
 * ⚠️ `detail`（系统原话）**不从这里出**：它由横幅用
 * `uninstall.verbatimSystemError` 单独渲染，因为那一句的职责是
 * **标出这一段不是我们写的**，混进正文就等于替它背书。
 */
export function removalFailureText(t: Translate, f: FailedFileReport): string {
  const kind = removalFailureKindOf(f.kind);
  return t(REMOVAL_FAILURE_KEYS[kind], { name: f.name, path: f.path });
}
