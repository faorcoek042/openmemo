/**
 * 自签 TLS（`OPENMEMO_TLS=self-signed`）。**默认关闭**。
 *
 * ## 为什么必须有这个
 * 浏览器的 `navigator.mediaDevices`（录音）与 `navigator.locks`（标签页选主）
 * **都要求 secure context**：HTTPS 或 localhost。
 * `http://<IP>:<port>` 两者都是 `undefined` —— **任何浏览器都一样，不是浏览器旧**。
 *
 * 后果是 F3 录音转文字**在非回环的明文地址下根本用不了**，
 * 而界面只会说一句"当前浏览器不支持"，用户以为是自己浏览器的问题。
 *
 * 我们全员没发现，是因为**测试全在 `127.0.0.1` 上做** —— 而回环恰好被规范当作安全上下文。
 * 这是"本机测试看不出来"的又一例，和端口漂移、跨重启失效属于同一族。
 *
 * ## 默认仍是明文
 * 回环访问本来就是安全上下文，不需要 TLS。给所有人默认加上证书信任成本是不划算的，
 * 所以只有**显式开启**才走 TLS。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

export interface TlsMaterial {
  readonly key: string;
  readonly cert: string;
  readonly certPath: string;
  readonly keyPath: string;
  /** 证书里写进去的名字，用于告诉用户"哪些地址不会额外报错"。 */
  readonly sans: readonly string[];
}

/** 是否显式开启了 TLS。**只认显式值**，不做任何推断。 */
export function tlsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env['OPENMEMO_TLS']?.trim().toLowerCase();
  return v === 'self-signed' || v === '1' || v === 'true';
}

/** 本机所有非回环 IPv4/IPv6，写进证书 SAN。 */
function localAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (!ni.internal && ni.address) out.push(ni.address);
    }
  }
  return out;
}

/**
 * 证书还有效吗（剩余有效期 > 7 天）。
 *
 * 过期的证书浏览器会**硬拒**（不给"继续访问"的入口），比没有证书更糟 ——
 * 所以宁可提前一周重新生成。
 */
function stillValid(certPath: string): boolean {
  try {
    if (!existsSync(certPath)) return false;
    const out = execFileSync('openssl', ['x509', '-enddate', '-noout', '-in', certPath], {
      encoding: 'utf8',
    });
    const m = /notAfter=(.+)/.exec(out.trim());
    if (!m?.[1]) return false;
    return new Date(m[1]).getTime() - Date.now() > 7 * 24 * 3600 * 1000;
  } catch {
    return false;
  }
}

export class TlsUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'TlsUnavailableError';
  }
}

/**
 * 取出（必要时生成）自签证书。
 *
 * @param extraHosts 额外写进 SAN 的名字（`OPENMEMO_TLS_HOSTS`，逗号分隔）。
 *   NAT 场景下用户看到的外部 IP **不是本机网卡地址**，我们猜不到，
 *   所以提供这个口子让他显式加进去；不加也能用，只是浏览器会多报一次名称不匹配。
 */
export function ensureSelfSignedCert(
  runtimeDir: string,
  extraHosts: readonly string[] = [],
): TlsMaterial {
  const certPath = join(runtimeDir, 'tls-cert.pem');
  const keyPath = join(runtimeDir, 'tls-key.pem');

  const sans = [
    'localhost',
    '127.0.0.1',
    '::1',
    ...localAddresses(),
    ...extraHosts.map((h) => h.trim()).filter(Boolean),
  ];

  if (!stillValid(certPath) || !existsSync(keyPath)) {
    mkdirSync(runtimeDir, { recursive: true });
    const altNames = sans
      .map((h, i) => (/^[\d.]+$/.test(h) || h.includes(':') ? `IP.${i} = ${h}` : `DNS.${i} = ${h}`))
      .join('\n');
    const cnf = join(runtimeDir, 'tls-openssl.cnf');
    writeFileSync(
      cnf,
      `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=OpenMemo Local\n[v3]\nsubjectAltName=@alt\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n[alt]\n${altNames}\n`,
      { mode: 0o600 },
    );
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-sha256',
          '-days',
          '825', // 超过 825 天会被部分浏览器直接拒绝
          '-nodes', // 不加密私钥：daemon 无人值守启动，没人来输密码
          '-keyout',
          keyPath,
          '-out',
          certPath,
          '-config',
          cnf,
        ],
        { stdio: 'pipe' },
      );
    } catch (err) {
      /*
       * 生成失败**不能静默降级成明文** —— 用户显式要了 TLS，
       * 悄悄给他一个明文服务，等于让他以为录音能用而实际不能。
       */
      throw new TlsUnavailableError(
        `自签证书生成失败（需要 openssl）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      // 私钥必须只有属主可读
      if ((statSync(keyPath).mode & 0o077) !== 0)
        writeFileSync(keyPath, readFileSync(keyPath), { mode: 0o600 });
    } catch {
      /* 权限收紧失败不阻塞启动，但上面已尽力 */
    }
  }

  return {
    key: readFileSync(keyPath, 'utf8'),
    cert: readFileSync(certPath, 'utf8'),
    certPath,
    keyPath,
    sans,
  };
}
