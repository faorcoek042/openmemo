/**
 * 已裁掉的 role **不许还能从 API 拉下来**。
 *
 * ## 守的是什么
 *
 * `ADR-016` 决策 3 砍掉了内置本地 LLM，但 `vendor/manifests/models-llm.json` 的 5 条 GGUF
 * 一直留在清单里。`[实测 2026-08-08]` 那时候：
 *
 * - 服务端**没有任何过滤** —— `manifests.ts` 列目录加载所有 `*.json`，
 *   于是这 5 条**确实到达 `/api/models/catalog`**；
 * - 只有 `apps/web` 的 `ASR_TAB_ROLES = ['asr','vad','punctuation']` 把它们挡在界面外。
 *
 * 也就是**一个活着的 API 面，只是今天没人走**：`POST /api/models/pull` 直接喂
 * `llm/…` 仍然能下载一个已经被裁掉的东西。
 *
 * Manager 2026-08-08 裁定关掉，并划了两条底线：
 * **(a) 前端过滤是装饰不是闸门，要关在服务端；(b) 历史要按 §13 写进原文，别静悄悄删。**
 *
 * ## 所以这个文件断言的是「服务端」
 *
 * 两条路都要堵，而且**必须分别断言** —— 只测目录不测 pull，
 * 就会漏掉"目录里看不见但按 id 仍然拉得到"这种最难发现的形态
 * （本仓的假绿灯里，"列表过滤了"与"入口关了"被当成同一件事已经不止一次）。
 *
 * ⚠️ **反方向也钉**：`asr` / `vad` 这些还活着的 role 一条都不许被误伤。
 * 一个"把什么都过滤掉"的实现同样能让上面两条通过。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-retired-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SseHub } from '../sse.js';
import { RestState } from './state.js';

/*
 * ★ 夹具**直接用真清单里的条目**，不手搓。
 *
 * 手搓过一版，连撞两轮 schema 校验（`arch`/`format`/`quantTier`/`speedClass`/`tags`、
 * 然后 `requirements`/`source`/`benchmark`/`speedEvidence`、文件名不许带路径分隔符）——
 * 而那些字段与本测试要验的事情**一点关系都没有**。更重要的是：
 * 用真条目意味着「那 5 条 GGUF 进不来」这句话是**字面为真**的，不是一个近似复现。
 */
const MANIFEST_DIR = fileURLToPath(new URL('../../../../../vendor/manifests', import.meta.url));

function realModels(file: string): Record<string, unknown>[] {
  const raw = JSON.parse(readFileSync(join(MANIFEST_DIR, file), 'utf8')) as {
    models?: Record<string, unknown>[];
  };
  return raw.models ?? [];
}

async function seed(): Promise<{ state: RestState; llmIds: string[]; liveIds: string[] }> {
  const llm = realModels('models-llm.json');
  const whisper = realModels('models-whisper.json').slice(0, 2);
  assert.ok(llm.length > 0, '真清单里没有 role=llm 的条目 —— 这个测试的前提没了，先查清单');
  assert.ok(whisper.length > 0, '真清单里没有 whisper 条目');

  const dataDir = mkdtempSync(join(TEST_ROOT, 'data-'));
  process.env['OPENMEMO_MODELS'] = join(dataDir, 'models');
  const manifestDir = mkdtempSync(join(TEST_ROOT, 'manifests-'));
  await writeFile(
    join(manifestDir, 'models-test.json'),
    JSON.stringify({
      schemaVersion: 1,
      catalogVersion: '2026.08.08',
      generatedAt: '2026-08-08T00:00:00.000Z',
      models: [...whisper, ...llm],
    }),
    'utf8',
  );
  const state = await RestState.create({ sse: new SseHub(), dataDir, manifestDir });
  return {
    state,
    llmIds: llm.map((m) => String(m['id'])),
    liveIds: whisper.map((m) => String(m['id'])),
  };
}

describe('ADR-016 裁掉的 role：API 面必须在服务端关掉', () => {
  it('★★ 目录里不许再出现 role=llm 的条目', async () => {
    const { state, llmIds } = await seed();
    const ids = new Set(state.modelCatalog.models.map((m) => m.id));
    for (const id of llmIds) {
      assert.equal(ids.has(id), false, `${id} 到达过 /api/models/catalog —— 前端挡住不算关掉`);
    }
  });

  it('★★ 按 id 直接找也必须找不到 —— 这条才是 POST /api/models/pull 的闸门', async () => {
    const { state, llmIds } = await seed();
    for (const id of llmIds) {
      assert.equal(
        state.findCatalogModel(id),
        null,
        `pull 走的是 findCatalogModel()；只过滤列表不堵这里，按 id 仍然拉得到 ${id}`,
      );
    }
  });

  it('★★ 反方向：还活着的 role 一条都不许被误伤', async () => {
    const { state, liveIds } = await seed();
    for (const id of liveIds) {
      assert.notEqual(state.findCatalogModel(id), null, `${id} 被误伤了`);
    }
    assert.equal(state.modelCatalog.models.length, liveIds.length);
  });

  it('★ role=llm 一条都不剩', async () => {
    const { state } = await seed();
    assert.equal(
      state.modelCatalog.models.some((m) => m.role === 'llm'),
      false,
    );
  });
});
