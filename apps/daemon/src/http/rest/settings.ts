/**
 * 设置 / 密钥 的 REST 路由。
 *
 * ─── ADR-006 决策 1（API Key 存储）的落地点 ───────────────────────────────
 * 决策原文的**强制条件**：「设置页必须显式告知『API Key 以明文存储在 <路径>，权限 0600』，
 * 不许含糊。」UI 拿不到它就没法渲染这段告知，所以 `GET /api/secrets` 的响应里
 * **必须**带上 `disclosure`（来自 `SecretStore.disclosure()`），这不是可选字段。
 *
 * ⚠️ **密钥明文绝不出现在任何响应、日志、错误信息里**（D-02 §1.2 / D-01 §8.6）。
 * 本文件从头到尾只碰 `SecretStore.list()` 给出的掩码形状；
 * `SecretStore.get()` 在这里一次都没有被调用，也不许被调用。
 *
 * 依赖注入用**结构化类型**而不是 `import { SecretStore } from '@openmemo/llm'`：
 * `apps/daemon` 的 package.json / tsconfig references 里目前**没有** `@openmemo/llm`，
 * 而那两个文件不在本次改动范围内。用结构类型既能通过编译，
 * 又能让 main.ts 直接把真正的 `SecretStore` 实例传进来（形状完全兼容）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { DatabaseHandle } from '@openmemo/db';
import type { MaskedSecret, SecretsDisclosure } from '@openmemo/shared';

import { Repos } from '../../db/repos.js';
import { readJsonBody, sendError, sendJson } from '../respond.js';

/*
 * ★ 这里原来是两个**手写的"结构兼容"影子**（`MaskedSecretLike` / `SecretsDisclosureLike`），
 *   现在直接就是契约本身（`@openmemo/shared`）。
 *
 *   ⚠️ **解耦的意图是对的、形状是错的。** 上面文件头说得没错：路由层不该
 *   `import { SecretStore } from '@openmemo/llm'`（那会把 `chmodSync` 拖进依赖图）。
 *   但正确的解耦是**两边都指向同一个契约**，而不是各写一个"兼容"的影子 ——
 *   影子当时把 `storage: 'plaintext-file'` 与 `enc: SecretEncoding` **双双放宽成了
 *   `string`**，注释里还写着"（可赋给 string）"当理由。放宽之后编译器就再也拦不住
 *   「这里发了一个谁也不认识的值」，而那正是它唯一能帮上忙的地方。
 *   指向 shared 既保住了解耦（shared 是纯类型、无 I/O、daemon 早就依赖它），
 *   又把那两格收窄回去。`SecretStoreLike` 的结构化注入照旧。
 */
export type { MaskedSecret, SecretsDisclosure };

/** `packages/llm` 的 `SecretStore` 满足此接口。**刻意不含 `get()`** —— 路由层无权读明文。 */
export interface SecretStoreLike {
  set(key: string, value: string): void;
  delete(key: string): void;
  list(): readonly MaskedSecret[];
  disclosure(): SecretsDisclosure;
}

export interface SettingsRoutesDeps {
  readonly db: DatabaseHandle;
  readonly secretStore: SecretStoreLike;
}

/**
 * 设置键 / 密钥键的点分命名空间（D-02 §1.2 约定：`ui.theme`、`llm.openai.apiKey` …）。
 * 收紧到这个形状是为了让 key 永远能安全地当 JSON 对象键与 UI 分组前缀用。
 */
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/;

const MAX_KEY_LEN = 128;
const MAX_SECRET_LEN = 8192;

export function createSettingsRoutes(deps: SettingsRoutesDeps): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
} {
  // 路由层不写 SQL（与 notes.ts / repos.ts 的分层一致）：
  // deps 按约定给的是 DatabaseHandle，这里就地包一层仓储，SQL 全在 repos.ts。
  const repos = new Repos(deps.db);
  const { secretStore } = deps;

  return {
    async handle(req, res, url, method): Promise<boolean> {
      const p = url.pathname;

      // ---- /api/settings ----
      if (p === '/api/settings') {
        if (method === 'GET') {
          sendJson(res, 200, { settings: readSettings(repos) });
          return true;
        }
        if (method === 'PATCH') {
          const body = await parseBody(req, res);
          if (body === BAD_JSON) return true;
          if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            sendError(
              res,
              400,
              'BAD_REQUEST',
              'body must be a JSON object of key → value',
              '请求体必须是「设置键 → 值」的 JSON 对象',
            );
            return true;
          }

          /*
           * ★ 同时接受两种形状：扁平 `{k: v}` 与信封 `{settings: {k: v}}`。
           *
           * 起因是一个**我们自己造的陷阱**：`GET` 回的是 `{settings: {...}}`，
           * 而 `PATCH` 只收扁平的。任何人把 GET 的结果原样 PATCH 回去（最自然的用法），
           * 都会得到一个**字面名叫 `settings` 的键**，于是读的人永远找不到
           * `llm.defaultProviderId` —— 存进去了、也读回来了，但键名对不上。
           * 协调者复现时正是踩的这个。前端发的是扁平的，所以前端没错。
           *
           * 修法不是"要求调用方记住不对称"，而是**让读写形状可以互换**。
           */
          const raw = body as Record<string, unknown>;
          const keys = Object.keys(raw);
          const inner =
            keys.length === 1 &&
            keys[0] === 'settings' &&
            typeof raw['settings'] === 'object' &&
            raw['settings'] !== null &&
            !Array.isArray(raw['settings'])
              ? (raw['settings'] as Record<string, unknown>)
              : raw;

          const entries: { key: string; valueJson: string }[] = [];
          for (const [key, value] of Object.entries(inner)) {
            /*
             * `settings` 作为**设置键名**一律拒绝：它只可能来自"信封套了两层"的误用，
             * 而一旦存进去就会产生那个谁也查不出来的嵌套 blob。
             * 宁可报一个说得清的 400，也不要静默生成坏数据。
             */
            if (key === 'settings') {
              sendError(
                res,
                400,
                'BAD_SETTING_KEY',
                'the key "settings" is reserved (did you wrap the payload twice?)',
                '「settings」是保留键名 —— 你可能把请求体多套了一层信封。直接发 {"键":"值"} 或 {"settings":{"键":"值"}} 均可。',
              );
              return true;
            }
            if (key.length > MAX_KEY_LEN || !KEY_RE.test(key)) {
              sendError(
                res,
                400,
                'BAD_SETTING_KEY',
                `invalid setting key: ${key.slice(0, MAX_KEY_LEN)}`,
                `设置项键名不合法：${key.slice(0, 64)}（只允许字母开头的点分命名，如 ui.theme）`,
              );
              return true;
            }
            let valueJson: string;
            try {
              valueJson = JSON.stringify(value);
            } catch {
              // 循环引用等：JSON body 理论上不会出现，但不能让它变成 500
              sendError(
                res,
                400,
                'BAD_SETTING_VALUE',
                `value of ${key} is not JSON-serializable`,
                `设置项 ${key} 的值无法序列化为 JSON`,
              );
              return true;
            }
            if (valueJson === undefined) {
              sendError(
                res,
                400,
                'BAD_SETTING_VALUE',
                `value of ${key} is undefined`,
                `设置项 ${key} 的值不能为 undefined（要清空请显式传 null）`,
              );
              return true;
            }
            entries.push({ key, valueJson });
          }

          repos.upsertSettings(entries);
          // 回全量而不是回增量：前端拿到就是权威快照，省掉一次 GET，也避免本地合并出偏差
          sendJson(res, 200, { settings: readSettings(repos) });
          return true;
        }
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET or PATCH', '方法不允许');
        return true;
      }

      // ---- GET /api/secrets ----
      if (p === '/api/secrets') {
        if (method !== 'GET') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET', '方法不允许');
          return true;
        }
        sendJson(res, 200, {
          // 只有掩码形状；明文永不出现在这里
          secrets: secretStore.list().map(toMasked),
          // ADR-006 决策 1 的强制告知，UI 必须原样展示
          disclosure: secretStore.disclosure(),
        });
        return true;
      }

      // ---- /api/secrets/:key ----
      const secretMatch = /^\/api\/secrets\/(.+)$/.exec(p);
      if (secretMatch) {
        const key = decodeSegment(secretMatch[1]);
        if (key.length > MAX_KEY_LEN || !KEY_RE.test(key)) {
          sendError(
            res,
            400,
            'BAD_SECRET_KEY',
            'invalid secret key',
            '密钥键名不合法（只允许字母开头的点分命名，如 llm.openai.apiKey）',
          );
          return true;
        }

        if (method === 'PUT') {
          const body = await parseBody(req, res);
          if (body === BAD_JSON) return true;
          const value = (body as { value?: unknown } | undefined)?.value;
          if (typeof value !== 'string' || value.length === 0) {
            // ⚠️ 错误信息里绝不回显 value 本身
            sendError(
              res,
              400,
              'BAD_REQUEST',
              'value must be a non-empty string',
              '缺少 value（必须是非空字符串）',
            );
            return true;
          }
          if (value.length > MAX_SECRET_LEN) {
            sendError(
              res,
              400,
              'SECRET_TOO_LONG',
              `value exceeds ${MAX_SECRET_LEN} chars`,
              `密钥过长（超过 ${MAX_SECRET_LEN} 字符），请确认粘贴内容正确`,
            );
            return true;
          }

          secretStore.set(key, value);
          const stored = secretStore.list().find((s) => s.key === key);
          if (!stored) {
            sendError(
              res,
              500,
              'SECRET_WRITE_FAILED',
              'secret not readable after write',
              '密钥写入后无法读回，请检查数据目录权限',
              { retryable: true },
            );
            return true;
          }
          sendJson(res, 200, { secret: toMasked(stored), disclosure: secretStore.disclosure() });
          return true;
        }

        if (method === 'DELETE') {
          secretStore.delete(key);
          sendJson(res, 200, { ok: true });
          return true;
        }

        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use PUT or DELETE', '方法不允许');
        return true;
      }

      return false;
    },
  };
}

/**
 * `value_json` 是 TEXT 里的 JSON，逐条解析成真值。
 *
 * 解析失败**不丢键**：原样把文本回给前端，用户至少能看见这项坏了并改掉；
 * 静默跳过会让设置页凭空少一项，排障时根本查不到。
 */
function readSettings(repos: Repos): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of repos.listSettings()) {
    try {
      out[row.key] = JSON.parse(row.value_json);
    } catch {
      out[row.key] = row.value_json;
    }
  }
  return out;
}

/**
 * 只挑掩码形状里该发的四格出去。
 *
 * ⚠️ 返回类型是 `MaskedSecret` 本身（原来是一个手写的、`enc` 放宽成 `string` 的
 * 匿名结构）—— 这样"多发了一个字段"或"少发了一个字段"都是**编译期**错误。
 */
function toMasked(s: MaskedSecret): MaskedSecret {
  return { key: s.key, masked: s.masked, enc: s.enc, updatedAt: s.updatedAt };
}

/** 畸形 JSON 的哨兵值。用独立对象而不是 `undefined`，因为空 body 本身是合法的 `undefined`。 */
const BAD_JSON = Symbol('bad-json');

/** 读 body；JSON 语法错误就地回 400（否则会冒泡成 500，对用户毫无意义）。 */
async function parseBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  try {
    return await readJsonBody(req);
  } catch (err) {
    if (err instanceof SyntaxError) {
      sendError(res, 400, 'BAD_JSON', 'malformed JSON body', '请求体不是合法的 JSON');
      return BAD_JSON;
    }
    throw err;
  }
}

/** 前端用 encodeURIComponent 传 key；`%zz` 这类畸形输入按原样返回，交给上面的 KEY_RE 拒掉。 */
function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
