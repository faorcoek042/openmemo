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
 * 判断是否为 IP 字面量（IPv4 点分十进制 / IPv6，含 `[...]` 包裹形式）。
 *
 * **为什么这是 DNS rebinding 防护的正确判据**：
 * rebinding 攻击的机制是「攻击者控制的**域名**先解析到自己 IP、再重绑到目标 IP」，
 * 借浏览器的同源信任打本机服务 —— **整条攻击链必须有 DNS 参与**。
 * 裸 IP 字面量不经过 DNS，攻击者无法让 `100.64.135.105` "重新解析"成别的东西，
 * 因此**接受 IP 字面量不削弱 rebinding 防护**；真正必须挡死的是域名。
 *
 * 原实现把「只接受回环」和「只接受 IP 字面量」两件事混在了一起：
 * 前者是**暴露面**决策（该由部署配置决定），后者才是 **rebinding** 防护。
 * 拆开后，NAT/反代等合法场景不再被误伤，而防护本身一分未减。
 */
function isIpLiteral(hostname: string): boolean {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  // IPv4 点分十进制，逐段 0-255
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare)) {
    return bare.split('.').every((seg) => Number(seg) <= 255);
  }
  // IPv6：必须含 ':' 且只由十六进制、冒号、以及可选的内嵌 IPv4 组成
  if (bare.includes(':')) return /^[0-9A-Fa-f:.]+$/.test(bare);
  return false;
}

/**
 * 校验 Host 头。**接受任意 IP 字面量，拒绝一切域名**（含 `localhost`）。
 * 域名被拒这一条就挡死了 DNS rebinding —— 见 `isIpLiteral` 的说明。
 *
 * 绑定地址（是否只监听回环）是**另一个维度**，由启动参数决定，不在本函数职责内。
 */
export function checkHost(req: IncomingMessage, allowedPorts: readonly number[]): GuardResult {
  const host = req.headers['host'];
  if (!host) return { ok: false, reason: 'missing Host header' };

  // 拆 host:port，注意 IPv6 的 [::1]:17650 形式
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
  if (!m) return { ok: false, reason: `unparsable Host: ${host}` };
  const hostname = m[1] ?? '';
  const port = m[2] ? Number(m[2]) : 80;

  if (!ALLOWED_HOSTS.has(hostname) && !isIpLiteral(hostname)) {
    return {
      ok: false,
      reason: `Host 必须是 IP 字面量，域名一律拒绝（DNS rebinding 防护）: ${hostname}`,
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

  // **Origin 必须与本次请求严格同源，绝不照搬 Host 的"允许 IP 字面量"规则。**
  // 否则攻击者只要把页面挂在任意裸 IP 上，就带着一个"合法"的 Origin 打过来 —— CSRF 直接开门。
  // Host 放宽的是"这个 daemon 能通过哪些地址被访问"，
  // Origin 管的是"这个请求是不是从我们自己这一页发出来的"，两者职责不同。
  const rawHost = req.headers['host'] ?? '';
  const hm = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(rawHost);
  const reqHostname = hm?.[1] ?? '';
  // URL.hostname 会剥掉 IPv6 的方括号，比较前统一形式
  const originHostname = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname;
  const normalizedReqHost = reqHostname.startsWith('[') ? reqHostname : reqHostname;
  if (originHostname !== normalizedReqHost) {
    return {
      ok: false,
      reason: `Origin 与请求 Host 不同源: origin=${originHostname} host=${normalizedReqHost}`,
    };
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
