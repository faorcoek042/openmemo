/**
 * `GET /api/selfcheck` —— 功能级自检（不是"组件是否加载"）。
 *
 * 核心实现在 `@openmemo/runtime` 的 `runSelfCheck()`，**一份实现两个出口**：
 * `gpu-runtime` 的 CLI（`scripts/selfcheck.mjs`）与这个端点共用它。
 *
 * ─── T-119 ─────────────────────────────────────────────────────────────────────────
 * 在此之前这个端点是 CLI 的**真子集**：缺硬件探测、数据目录自洽性、本地 LLM 探测、代理。
 * 于是**网页绿 ≠ CLI 绿**，而两个都自称"自检" —— 一个自检工具自己两个出口不一致，
 * 比没有自检更糟，因为它会让人对绿灯失去判断力。
 *
 * 现在这里的职责只剩**把探针接上**：判据一条都不在本文件里。
 * `scripts/selfcheck.mjs --daemon …` 会逐 id 比对两边的结论，漂移直接报 required 失败。
 *
 * `packages/runtime` **刻意不 import `packages/pipeline`**（那会成环 —— pipeline 已经依赖
 * runtime），所以它把探针以回调形式声明出来，由调用方注入。daemon 正好全都拿得到：
 * 工具路径与引擎候选在 `PipelineBundle` 里，分词器/向量扩展在打开的 DB 上，
 * 代理与 Key 在设置表与密钥库里。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { testProxyConnectivity } from '@openmemo/downloader';
import { detectLocalBackends } from '@openmemo/llm';
import { ffmpegProxySupport, findInBackendPacks } from '@openmemo/pipeline';
import type { DatabaseHandle } from '@openmemo/db';
import { CHINESE_PROBE_WORDS, listByName, runSelfCheck } from '@openmemo/runtime';
import { redactProxyUrl, type ProxyConfig } from '@openmemo/shared';

import type { AppPaths } from '../../config/paths.js';
import type { PipelineBundle } from '../../pipeline/setup.js';
import { sendError, sendJson } from '../respond.js';

export interface SelfCheckRoutesDeps {
  readonly paths: AppPaths;
  readonly db: DatabaseHandle;
  /** 扩展加载结果（libsimple / sqlite-vec 是否真的加载上了）。 */
  readonly extensions: { readonly libsimple: boolean; readonly sqliteVec: boolean };
  readonly bundle: () => PipelineBundle | undefined;
  readonly extensionsDir: string;
  /** 当前代理配置（`readProxyConfig(repos)`）。 */
  readonly proxyConfig: () => ProxyConfig;
  /** 已存密钥的**键名**（掩码列表即可）。**绝不接受明文。** */
  readonly secretKeys: () => readonly string[];
}

function readSetting(db: DatabaseHandle, key: string): unknown {
  try {
    const row = db
      .prepare<{ value_json: string }>('SELECT value_json FROM settings WHERE key = :k')
      .get({ k: key });
    return row ? JSON.parse(row.value_json) : undefined;
  } catch {
    return undefined;
  }
}

export function createSelfCheckRoutes(deps: SelfCheckRoutesDeps): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
} {
  return {
    async handle(_req, res, url, method): Promise<boolean> {
      if (url.pathname !== '/api/selfcheck') return false;
      if (method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET', '方法不允许');
        return true;
      }

      const bundle = deps.bundle();
      // 真发外网请求验代理是**显式动作**，默认不做：自检必须能离线跑完。
      const proxyTest = url.searchParams.get('proxyTest') === '1';

      const report = await runSelfCheck({
        dataDir: deps.paths.dataDir,
        storeRoot: deps.paths.modelsDir,
        extensionsDir: deps.extensionsDir,
        proxyTest,
        probes: {
          tools: () =>
            Promise.resolve({
              ffmpeg: bundle?.tools.ffmpeg || null,
              ffprobe: bundle?.tools.ffprobe || null,
              whisperCli: bundle?.tools.whisperCli ?? null,
              whisperVad: bundle?.tools.whisperVad ?? null,
              vadModel: bundle?.tools.vadModel ?? null,
              ytDlp: bundle?.tools.ytDlp ?? null,
            }),

          installed: (kind) => listByName(deps.paths.modelsDir, kind),

          // probe 挨着 libggml-base 装在后端包**内部**，固定路径永远找不到它。
          probePath: () =>
            findInBackendPacks(
              deps.paths.modelsDir,
              process.platform === 'win32' ? 'openmemo-probe.exe' : 'openmemo-probe',
            ),

          /*
           * 中文检索探针 —— 整个自检里最有价值的一条，但**必须测在自带语料上**。
           *
           * 它要复现的是 T-028 那个静默失效：分词器"装上了"但查询路径返回 0 条，
           * 而组件级检查（"libsimple 加载了吗"）对这种情况一律亮绿灯。
           *
           * ⚠️ 最初我把它查在**用户的 `segments_fts`** 上，结果全新安装（库是空的）
           * 四个词全 0 → 报 `required` 的 ❌。**红灯不代表坏了** ——
           * 这和"绿灯不代表能用"是同一个病的两面，而且更糟：
           * 新用户第一次打开诊断页就看到红叉，久了就学会无视红灯。
           *
           * "这四个中文词能不能被切出来并命中"是**分词器自身的性质**，与用户有没有笔记无关。
           * 所以改成建一张**临时表 + 自带句子**来测，结果确定、与用户数据无关。
           */
          chineseSearch: () => {
            if (!deps.extensions.libsimple) return Promise.resolve(null);
            const table = `selfcheck_zh_${String(Date.now())}`;
            try {
              deps.db.exec(
                `CREATE VIRTUAL TABLE temp.${table} USING fts5(body, tokenize='simple')`,
              );
              deps.db
                .prepare(`INSERT INTO temp.${table}(body) VALUES (:t)`)
                .run({ t: '推特的用户遍布中国各地，这项服务面向所有用户。' });

              const out: Record<string, number> = {};
              for (const w of CHINESE_PROBE_WORDS) {
                const row = deps.db
                  .prepare<{ c: number }>(
                    // ⚠️ MATCH 左操作数必须是**裸表名**：写 `temp.X MATCH …` 会报
                    // `no such column: temp.X`（FTS5 把带 schema 前缀的当成列名了）。
                    `SELECT COUNT(*) c FROM temp.${table} WHERE ${table} MATCH simple_query(:q)`,
                  )
                  .get({ q: w });
                out[w] = row?.c ?? 0;
              }
              return Promise.resolve(out);
            } catch {
              // 建表/查询本身炸了 = 分词器装了但用不了，与"没装"要区分开
              return Promise.resolve(null);
            } finally {
              try {
                deps.db.exec(`DROP TABLE IF EXISTS temp.${table}`);
              } catch {
                /* 临时表清理失败无所谓，连接关掉就没了 */
              }
            }
          },

          vecVersion: () => {
            if (!deps.extensions.sqliteVec) return Promise.resolve(null);
            try {
              const row = deps.db.prepare<{ v: string }>('select vec_version() as v').get();
              return Promise.resolve(row?.v ?? null);
            } catch {
              return Promise.resolve(null);
            }
          },

          engines: () =>
            Promise.resolve(
              (bundle?.candidates ?? []).map((c) => ({
                id: c.engine.id,
                available: c.available,
                ...(c.unavailableReason ? { reason: c.unavailableReason } : {}),
              })),
            ),

          selectFor: (language) => {
            const sel = bundle?.pickEngine(language);
            return Promise.resolve(sel ? { engineId: sel.engineId, reason: sel.reason } : null);
          },

          mediaAssets: () => {
            try {
              const rows = deps.db
                .prepare<{ role: string; rel_path: string }>(
                  'SELECT role, rel_path FROM media_assets',
                )
                .all();
              return Promise.resolve(rows.map((r) => ({ role: r.role, relPath: r.rel_path })));
            } catch {
              return Promise.resolve(null);
            }
          },

          localLlmServices: async () => {
            try {
              const found = await detectLocalBackends({ timeoutMs: 1200 });
              return found.map((d) => ({ label: d.label, models: d.models?.length ?? 0 }));
            } catch {
              return null;
            }
          },

          /*
           * 档 1 只报"配没配"。
           * **绝不代用户发一次真请求去验 Key** —— 那要花他的钱，
           * 还可能在他不知情时把 Key 发出去。这里也只看密钥的**键名**，不碰明文。
           */
          llmKeyConfig: () => {
            const p = readSetting(deps.db, 'llm.defaultProviderId');
            return Promise.resolve({
              providerId: typeof p === 'string' && p.trim() ? p.trim() : null,
              hasKey: deps.secretKeys().some((k) => /^llm\..+\.apiKey$/.test(k)),
            });
          },

          proxy: () => {
            const cfg = deps.proxyConfig();
            const url_ =
              cfg.mode === 'manual'
                ? (cfg.socks5 ?? cfg.httpsProxy ?? cfg.httpProxy ?? null)
                : null;
            const support = ffmpegProxySupport(url_ ? { url: url_ } : null);
            return Promise.resolve({
              mode: cfg.mode,
              activeUrl: url_ ? redactProxyUrl(url_) : null,
              ffmpegSupported: support.supported,
              ffmpegReason: support.reason ?? null,
            });
          },

          proxyConnectivity: async () => {
            try {
              const rep = await testProxyConnectivity(deps.proxyConfig());
              return {
                ok: rep.ok,
                probes: (rep.probes ?? []).map((p) => ({
                  target: p.target,
                  result: p.result,
                  viaProxy: p.viaProxy === true,
                })),
              };
            } catch {
              return null;
            }
          },
        },
      });

      // 自检报告本身永远是 200 —— 报告"不健康"不是 HTTP 错误。
      // 用 report.ok / counts 让前端决定怎么渲染。
      sendJson(res, 200, report);
      return true;
    },
  };
}
