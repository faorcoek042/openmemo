/**
 * REST 路由的请求侧小工具。
 *
 * 刻意不引入校验框架：这里只做"把 `unknown` 收窄成能安全用的东西"，
 * 真正的领域校验（manifest / hardware）走 `@openmemo/shared` 的 zod schema。
 */
import type { IncomingMessage } from 'node:http';

import { readJsonBody } from '../respond.js';

/**
 * 读取 JSON body，**畸形/空 body 一律当作 `{}`**。
 *
 * 复用 respond.ts 的实现（含 1 MiB 上限），只是把 JSON.parse 的异常吞掉：
 * 对这些 endpoint 来说，畸形 body 的正确反应是下游给出"缺少 xxx"的 400，
 * 而不是冒泡成 500。超限异常仍然向上抛。
 */
export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
  return asRecord(raw);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 非空字符串，否则 null。空串一律当作"没传"。 */
export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * 路径参数解码。
 *
 * 前端用 `encodeURIComponent(id)`，而模型 id 本身含 `/`（`asr/whisper-…`），
 * 所以必须解码；`%zz` 这类畸形输入 decodeURIComponent 会抛，按原样返回让上层 404。
 */
export function decodePathSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
