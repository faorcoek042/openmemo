/**
 * 「当前 daemon 需不需要鉴权」—— **唯一判断点**（T-112）。
 *
 * ## 为什么要收口成一个函数
 *
 * 鉴权这条线今天已经长出四处独立机制：CSRF 令牌的内存副本、401 自愈、
 * 403 CSRF 自愈、写请求前的补握手。用户要求「删除 token 接入，
 * 反正也是本地运行的东西」之后，这四处在免鉴权模式下**全是空转**。
 *
 * 如果每处各判各的"现在要不要鉴权"，就会重演今天栽过的形状 ——
 * 四个地方迟早有一个先忘。所以只留这一个判断点，四处都问它。
 *
 * ⚠️ **`token` 模式下那四处必须仍然有效**：用户关掉的是默认行为，
 * 不是把能力删掉。`OPENMEMO_AUTH=token` 时一切照旧。
 *
 * ## 判据的优先级（**不猜服务端行为**）
 *
 * 我今天刚因为"前端单方面想象了一个服务端并不存在的兜底"（那句
 * 「由 Origin 校验兜底」）而让所有保存静默失败。所以这里的顺序是：
 *
 * 1. **服务端明说** —— `/api/health` 里的鉴权模式字段。这是唯一权威。
 * 2. **观察到的行为** —— 服务端没明说时，用"未携带任何凭证的请求是否被接受"
 *    来判定。注意这**不是猜字段名**，而是拿真实响应说话。
 * 3. 两者都拿不到 → `unknown`，**按需要鉴权处理**（保守方向：
 *    多带一个头不会坏事，少带会静默失败）。
 *
 * ⚠️ `oss-scout` 的契约尚未落地，第 1 条的读取写成了**宽容读**（接受几种写法）。
 * 契约定稿后请把 `readDeclaredMode()` 收紧成单一字段，并删掉这条注释。
 */

export type AuthMode = 'none' | 'token' | 'unknown';

let mode: AuthMode = 'unknown';

export function getAuthMode(): AuthMode {
  return mode;
}

/** 需要带 CSRF / 走握手吗？`unknown` 保守地按"要"处理。 */
export function authRequired(): boolean {
  return mode !== 'none';
}

export function setAuthMode(next: AuthMode): void {
  mode = next;
}

/** 仅供测试重置模块级状态。 */
export function resetAuthMode(): void {
  mode = 'unknown';
}

/**
 * 从 `/api/health` 读服务端**明确声明**的鉴权模式。
 *
 * 宽容读只是为了等契约落地，**不是让前端去猜**：认不出来就返回 `null`，
 * 交给行为探测，而不是自作主张当成免鉴权。
 */
export function readDeclaredMode(health: unknown): AuthMode | null {
  if (!health || typeof health !== 'object') return null;
  const h = health as Record<string, unknown>;

  const raw =
    (typeof h['auth'] === 'string' ? h['auth'] : null) ??
    (typeof h['authMode'] === 'string' ? h['authMode'] : null) ??
    (h['auth'] && typeof h['auth'] === 'object'
      ? ((h['auth'] as Record<string, unknown>)['mode'] as string | undefined)
      : undefined) ??
    null;

  if (raw === 'none' || raw === 'off' || raw === 'disabled') return 'none';
  if (raw === 'token' || raw === 'bearer') return 'token';

  // 布尔写法：authRequired: false
  if (typeof h['authRequired'] === 'boolean') return h['authRequired'] ? 'token' : 'none';
  return null;
}
