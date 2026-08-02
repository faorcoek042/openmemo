/**
 * DNS rebinding + CSRF 防护（D-01 §8.2）。
 *
 * 我们监听 127.0.0.1，但**这不等于安全**：
 * - 任意网页都能向 http://127.0.0.1:17650 发请求（这就是 CSRF 面）。
 * - DNS rebinding：攻击者的域名先解析到自己 IP，再重绑到 127.0.0.1，
 *   浏览器会认为同源 —— **`Host` 头校验是唯一可靠的拦截点**。
 */
import type { IncomingMessage } from 'node:http';

const ALLOWED_HOSTS = new Set(['127.0.0.1', '[::1]', '::1']);

export interface GuardResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * 校验 Host 头。只接受回环 IP 字面量 —— **不接受任何域名**（含 `localhost`）。
 * 这一条就挡死了 DNS rebinding：攻击者控制的域名永远进不了白名单。
 */
export function checkHost(req: IncomingMessage, allowedPorts: readonly number[]): GuardResult {
  const host = req.headers['host'];
  if (!host) return { ok: false, reason: 'missing Host header' };

  // 拆 host:port，注意 IPv6 的 [::1]:17650 形式
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
  if (!m) return { ok: false, reason: `unparsable Host: ${host}` };
  const hostname = m[1] ?? '';
  const port = m[2] ? Number(m[2]) : 80;

  if (!ALLOWED_HOSTS.has(hostname)) {
    return {
      ok: false,
      reason: `Host 不在回环白名单内: ${hostname}（DNS rebinding 防护，域名一律拒绝）`,
    };
  }
  if (allowedPorts.length && !allowedPorts.includes(port)) {
    return { ok: false, reason: `Host 端口不匹配: ${port}` };
  }
  return { ok: true };
}

/**
 * 校验 Origin（存在时）。
 * WebSocket **不受 SameSite 完全保护**，必须显式校验 Origin ——
 * 否则任意网页都能发起跨源 WS，这是 WS 的经典坑（D-01 §3.4）。
 */
export function checkOrigin(
  req: IncomingMessage,
  allowedPorts: readonly number[],
  { required = false }: { required?: boolean } = {},
): GuardResult {
  const origin = req.headers['origin'];
  if (!origin) {
    return required ? { ok: false, reason: 'missing Origin header' } : { ok: true };
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, reason: `unparsable Origin: ${origin}` };
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return { ok: false, reason: `Origin 主机不在白名单: ${parsed.hostname}` };
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  if (allowedPorts.length && !allowedPorts.includes(port)) {
    return { ok: false, reason: `Origin 端口不匹配: ${port}` };
  }
  return { ok: true };
}

/**
 * `Sec-Fetch-Site` 是浏览器强制附加、页面无法伪造的头 —— 比 Origin 更可信。
 * 只在它存在时校验（非浏览器客户端如 curl/CLI 不会发）。
 */
export function checkSecFetch(req: IncomingMessage): GuardResult {
  const site = req.headers['sec-fetch-site'];
  if (typeof site !== 'string') return { ok: true };
  if (site === 'same-origin' || site === 'same-site' || site === 'none') return { ok: true };
  return { ok: false, reason: `Sec-Fetch-Site 表明是跨站请求: ${site}` };
}

/** 组合闸门。任一不过即拒。 */
export function guardRequest(
  req: IncomingMessage,
  allowedPorts: readonly number[],
  opts: { requireOrigin?: boolean } = {},
): GuardResult {
  const host = checkHost(req, allowedPorts);
  if (!host.ok) return host;
  const origin = checkOrigin(req, allowedPorts, { required: opts.requireOrigin ?? false });
  if (!origin.ok) return origin;
  return checkSecFetch(req);
}
