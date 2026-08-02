/**
 * HTTP 响应helpers。
 *
 * 从 `server.ts` 抽出来，让各个路由模块（rest/*.ts）能共用同一套信封，
 * 避免每个模块各写各的 JSON 序列化与错误格式。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApiErrorBody, Remediation } from '@openmemo/shared';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
}

export interface SendErrorOptions {
  readonly retryable?: boolean;
  readonly details?: unknown;
  readonly remediation?: Remediation;
}

/** 错误信封以 `packages/shared` 的 `ApiErrorBody` 为准（D-01 §3.5 订正）。 */
export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  messageZh: string,
  opts: SendErrorOptions = {},
): void {
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      messageZh,
      retryable: opts.retryable ?? false,
      ...(opts.remediation ? { remediation: opts.remediation } : {}),
      ...(opts.details === undefined ? {} : { details: opts.details }),
    },
  };
  sendJson(res, status, body);
}

/** 读取并限制大小的 JSON body。超限直接抛，避免被大 body 打爆内存。 */
export async function readJsonBody(
  req: IncomingMessage,
  limitBytes = 1024 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    total += b.length;
    if (total > limitBytes) throw new Error('request body too large');
    chunks.push(b);
  }
  if (total === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
