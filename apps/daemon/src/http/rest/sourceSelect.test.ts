/**
 * T-171（A-6）—— `POST /api/models/sources/select`：**删掉 `sourceBaseUrl` 这半个功能**
 *
 * ## 被删掉的是什么
 *
 * `Prefs.sourceBaseUrl` 是一个**零读取方**的字段：`models.ts` 写它、随 `prefs.json` 落盘，
 * 而全仓没有任何一处读它 —— 它不出现在 `buildSources()` 的返回里，
 * 也不在 `GetSourcesResponse` 上，所以连"泄漏给客户端"都做不到。
 *
 * 零读取方字段最坏的地方**不是浪费空间，是下一个人会以为它在起作用**。
 * 这个仓库刚因为同一个形状吃过亏：一个从未被调用的验签函数，让人以为目录是被验签的。
 *
 * ## 为什么不是"只删字段"，还要连 `custom` 一起拒绝
 *
 * 删字段之前，这个端点有两条支路：
 *   · `custom` 且没给 `baseUrl` → 400；
 *   · `custom` 且给了 `baseUrl` → **200**，`sourceProvider='custom'` 落盘。
 *
 * 第二条才是坏的那条。`orderSourcesForDownload()`（`packages/downloader/src/probe.ts:139-143`）
 * 拿 pinned 去 filter 镜像，而清单里**没有任何 provider 为 `custom` 的镜像**，
 * 于是 `hit=[]`，返回未经排序的全表 —— **按实测吞吐选源被静默关掉了**，
 * 下载还能跑，没有任何地方报错。用户以为自己设了个自定义源，实际上只是把排序关了。
 *
 * 所以只把 `baseUrl` 删掉是不够的：那样 `custom` 会从"400"变成"200 且静默降级"，
 * 洞反而更大。**要么补上真实读者，要么整半个功能一起拆掉** —— 这里选后者，
 * 因为"自定义源"从来没有实现过。
 *
 * ## 判据取"后果"，不取"字段不存在"
 *
 * 断言 `prefs.json` 里没有 `sourceBaseUrl` 这个键，比断言 TS 接口上没有它更有用：
 * 接口是编译期的，而**落盘内容是下一个版本要去读的东西**。
 *
 * ## 端口
 *
 * 19_100 段：与在用的 19000 / 19271 / 19340 / … 各隔 ≥30（`testPorts.test.ts` 的规矩）。
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { backendPrefsPath } from '@openmemo/pipeline';
import { resolveModelsRoot } from '@openmemo/downloader';

import { startDaemon } from '../../main.js';

let base = '';
let token = '';
let dataDir = '';
let stop: (() => Promise<void>) | undefined;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'om-source-select-'));
  const port = 19_100 + Math.floor(Math.random() * 10);
  const d = await startDaemon({ port, dataDir, maxPort: port + 20 });
  base = `http://127.0.0.1:${d.port}`;
  token = d.token;
  stop = d.stop;
});

after(async () => {
  await stop?.();
});

async function selectSource(
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}/api/models/sources/select`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

describe('POST /api/models/sources/select —— A-6：零读取方字段与它带来的半个功能', () => {
  it('★ provider:"custom" 必须被拒绝（此前给了 baseUrl 就会 200，然后静默关掉按速度选源）', async () => {
    const r = await selectSource({ provider: 'custom', baseUrl: 'https://example.invalid/' });
    assert.equal(
      r.status,
      400,
      `custom 必须 400。拿到 ${String(r.status)}：${JSON.stringify(r.json)}\n` +
        '（200 = 那半个功能又回来了：下载仍然能跑，只是不再按实测吞吐选源，且没有任何地方会报错。）',
    );
  });

  it('★ 不给 baseUrl 的 custom 同样被拒 —— 拒绝的理由是"没实现"，不是"参数少了"', async () => {
    const r = await selectSource({ provider: 'custom' });
    assert.equal(r.status, 400);
    /*
     * 这条与上一条一起，钉的是**两支合并成了一支**。
     * 从前这两个请求走的是不同分支（一个 400 一个 200）；现在必须完全一样 ——
     * 否则说明 `baseUrl` 又被读回去了。
     */
    const withUrl = await selectSource({ provider: 'custom', baseUrl: 'https://example.invalid/' });
    assert.equal(
      r.status,
      withUrl.status,
      '带不带 baseUrl 必须得到同一个结果 —— 不一样就说明又有人读它了',
    );
  });

  it('★ 正常 provider 仍然能选，且落盘的 prefs.json 里不许再有 sourceBaseUrl', async () => {
    const r = await selectSource({ provider: 'github' });
    assert.equal(r.status, 200, `github 应当被接受：${JSON.stringify(r.json)}`);
    assert.equal(r.json['selected'], 'github');

    /*
     * 落盘内容才是下一个版本要去读的东西 —— 接口上没有它不代表磁盘上没有。
     * 路径用产品自己的两个函数拼，不在测试里手写 'models/prefs.json'：
     * 手写的话，产品换了布局这条断言会**读不到文件而不是变红**（又一个假绿）。
     */
    const prefsPath = backendPrefsPath(resolveModelsRoot(dataDir));
    const text = await fs.readFile(prefsPath, 'utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    assert.equal(
      'sourceBaseUrl' in parsed,
      false,
      `prefs 里仍然写着 sourceBaseUrl —— 零读取方的字段又回到磁盘上了：${text}`,
    );
    assert.equal(parsed['sourceProvider'], 'github', '真正该落盘的那个字段必须还在');
  });

  it('auto 仍然可选（回到不钉源的状态）', async () => {
    const r = await selectSource({ provider: 'auto' });
    assert.equal(r.status, 200);
    assert.equal(r.json['selected'], 'auto');
  });

  it('不认识的 provider 仍然 400（这条没有被本次改动影响）', async () => {
    const r = await selectSource({ provider: 'definitely-not-a-provider' });
    assert.equal(r.status, 400);
  });
});
