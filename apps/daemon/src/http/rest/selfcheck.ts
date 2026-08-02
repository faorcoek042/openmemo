/**
 * `GET /api/selfcheck` —— 功能级自检（不是"组件是否加载"）。
 *
 * 核心实现在 `@openmemo/runtime` 的 `runSelfCheck()`，**一份实现两个出口**：
 * `gpu-runtime` 的 CLI 与这个 HTTP 端点共用它，不会漂移。
 *
 * `packages/runtime` **刻意不 import `packages/pipeline`**（那会成环 —— pipeline 已经依赖
 * runtime），所以它把探针以回调形式声明出来，由调用方注入。daemon 正好两边都能拿到：
 * 流水线（工具路径、引擎候选）在 `PipelineBundle` 里，中文分词与向量扩展在打开的 DB 上。
 *
 * 这正是 `architect` 诊断页需要的东西 —— 他自己标注过
 * 「我这页查的是**组件是否加载**、不是**功能是否可用**，**绿灯不等于功能可用**」。
 * 这里查的是后者：中文真的搜得到吗、引擎真的选得出来吗。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { DatabaseHandle } from '@openmemo/db';
import { CHINESE_PROBE_WORDS, listByName, runSelfCheck } from '@openmemo/runtime';

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

      const report = await runSelfCheck({
        dataDir: deps.paths.dataDir,
        storeRoot: deps.paths.modelsDir,
        extensionsDir: deps.extensionsDir,
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
        },
      });

      // 自检报告本身永远是 200 —— 报告"不健康"不是 HTTP 错误。
      // 用 report.ok / counts 让前端决定怎么渲染。
      sendJson(res, 200, report);
      return true;
    },
  };
}
