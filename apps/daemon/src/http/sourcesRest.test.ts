/**
 * T-157 ④ —— `/api/models/sources**` 的可用性契约。
 *
 * 这三个端点一直是真的，缺的是界面。补界面时发现响应里**没有"能选哪些源"**：
 * 前端要么写死一张会漂移的表（清单加一个镜像它不知道、删一个它继续摆着一个点了没用的选项），
 * 要么在用户点过测速之前什么都不显示。所以 `GetSourcesResponse` 加了 `available`。
 *
 * ⚠️ **不在这里跑 `POST /api/models/sources/probe`** —— 它会真的对外发请求
 * （每个 provider 一次 256 KiB Range，5s 超时）。测试不该依赖外网，
 * 也不该在别人的机器上偷偷跑流量。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { SESSION_COOKIE, CSRF_HEADER } from './auth.js';
import { startDaemon } from '../main.js';

const ROOT = mkdtempSync(join(tmpdir(), 'omsrc-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** 仓库根 —— dist/http/ 上溯 3 层（与 modelCatalogTruth.test.ts 同一算法）。 */
const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'));
const MODEL_MANIFESTS = ['models-asr-support.json', 'models-whisper.json', 'models-llm.json'];

let portCursor = 19900;

interface Sources {
  selected: string;
  effective: string | null;
  available: string[];
  probes: { id: string }[];
}

/** 清单里真实出现过的 provider —— **读的是唯一出处，不是另抄一份判定逻辑**。 */
async function providersInManifests(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const f of MODEL_MANIFESTS) {
    const raw = JSON.parse(
      await readFile(join(REPO_ROOT, 'vendor', 'manifests', f), 'utf8'),
    ) as { models?: { files?: { mirrors?: { provider?: string }[] }[] }[] };
    for (const m of raw.models ?? []) {
      for (const file of m.files ?? []) {
        for (const mirror of file.mirrors ?? []) {
          if (mirror.provider) out.add(mirror.provider);
        }
      }
    }
  }
  return out;
}

describe('T-157 ④ GET /api/models/sources 必须说得出"能选哪些源"', () => {
  it('★ available 非空，且每一项都真的在模型清单的镜像里出现过', async () => {
    const port = portCursor++;
    const d = await startDaemon({ port, dataDir: join(ROOT, `src-${port}`), maxPort: port });
    try {
      const hs = await fetch(`http://127.0.0.1:${d.port}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${d.token}` },
      });
      const sid = /om_sid=([^;]+)/.exec(hs.headers.get('set-cookie') ?? '')?.[1] ?? '';
      const { csrf } = (await hs.json()) as { csrf: string };
      assert.ok(sid && csrf, '握手失败，后面的断言就没意义了');
      const base = `http://127.0.0.1:${d.port}`;
      const cookie = `${SESSION_COOKIE}=${sid}`;

      const s = (await (await fetch(`${base}/api/models/sources`, { headers: { Cookie: cookie } })).json()) as Sources;

      /*
       * 非空守卫先行：`available: []` 会让下面那条子集断言**恒真**，
       * 于是"字段从来没被填过"和"填对了"长得一模一样。
       * （⑤A 那一族：一条永远不会失败的断言。）
       */
      assert.ok(
        s.available.length > 0,
        'available 是空的 —— 界面上会一个源都选不了，而这条断言在空集上恒真',
      );

      const known = await providersInManifests();
      assert.ok(known.size > 0, '清单里一个 provider 都没读出来 —— 探针本身瞎了');
      const strays = s.available.filter((p) => !known.has(p));
      assert.deepEqual(
        strays,
        [],
        `available 里有清单中不存在的 provider：${strays.join(', ')} —— ` +
          '那会在界面上变成一个点了没用的选项',
      );
    } finally {
      await d.stop();
    }
  });

  it('★ 选一个源之后要真的记住（否则界面上的选中态是本地幻觉）', async () => {
    const port = portCursor++;
    const d = await startDaemon({ port, dataDir: join(ROOT, `sel-${port}`), maxPort: port });
    try {
      const hs = await fetch(`http://127.0.0.1:${d.port}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${d.token}` },
      });
      const sid = /om_sid=([^;]+)/.exec(hs.headers.get('set-cookie') ?? '')?.[1] ?? '';
      const { csrf } = (await hs.json()) as { csrf: string };
      const base = `http://127.0.0.1:${d.port}`;
      const cookie = `${SESSION_COOKIE}=${sid}`;

      const before = (await (await fetch(`${base}/api/models/sources`, { headers: { Cookie: cookie } })).json()) as Sources;
      assert.equal(before.selected, 'auto', '默认应当是 auto');
      const target = before.available.find((p) => p !== 'auto');
      assert.ok(target, 'available 里没有可选的源，这条用例无从下手');

      const res = await fetch(`${base}/api/models/sources/select`, {
        method: 'POST',
        headers: { Cookie: cookie, [CSRF_HEADER]: csrf, 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: target }),
      });
      const body = await res.text();
      assert.equal(res.status, 200, body);
      assert.equal((JSON.parse(body) as Sources).selected, target);

      // 判据是**再取一次还在**，不是"POST 回了 200"
      const after = (await (await fetch(`${base}/api/models/sources`, { headers: { Cookie: cookie } })).json()) as Sources;
      assert.equal(after.selected, target, '选完再取一次就变回去了 —— 那界面上的选中态只是本地幻觉');
      assert.equal(
        after.effective,
        target,
        '钉了源之后 effective 必须就是它（没探测过也一样：这是用户的显式选择，不是推断）',
      );
    } finally {
      await d.stop();
    }
  });

  it('认不出的 provider 一律 400，不静默改成 auto', async () => {
    const port = portCursor++;
    const d = await startDaemon({ port, dataDir: join(ROOT, `bad-${port}`), maxPort: port });
    try {
      const hs = await fetch(`http://127.0.0.1:${d.port}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${d.token}` },
      });
      const sid = /om_sid=([^;]+)/.exec(hs.headers.get('set-cookie') ?? '')?.[1] ?? '';
      const { csrf } = (await hs.json()) as { csrf: string };
      const res = await fetch(`http://127.0.0.1:${d.port}/api/models/sources/select`, {
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE}=${sid}`,
          [CSRF_HEADER]: csrf,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider: 'not-a-provider' }),
      });
      assert.equal(res.status, 400);
    } finally {
      await d.stop();
    }
  });
});
