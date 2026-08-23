/**
 * T-196 ④ 护栏：**「能不能装」这道闸，服务端也必须有。**
 *
 * ── 事故本体 ────────────────────────────────────────────────────────────────
 *
 * 用户真机 Windows v0.7.0 报「whisper.cpp Vulkan 后端没得下载安装使用」。
 * 表层是网页按钮恒灰（`availability: "pending-ci"` → `disabled`）。
 * 但同一枚硬币的**背面**是：`POST /api/backends/install` 只查 `id` + `applicability()`，
 * **零处读 `availability`**。于是同一个问题两个答案：
 *
 *   · 网页：按钮灰，文案「尚未发布，暂不可安装」
 *   · 服务端：照样 **202**，起一个**必然失败**的 job
 *
 * 「必然失败」不是修辞 —— `pending-ci` 的语义就是"还没有可下载的地址"。
 * 一个 202 把一句本可以立刻说清的话，推迟成了几十秒后才出现、
 * 且把用户指向**错误方向**（"为什么下载失败"而不是"这东西还没发布"）的失败。
 *
 * ── 为什么用例要自己造 pending-ci 包 ────────────────────────────────────────
 *
 * ⚠️ `b0cbf08` 之后目录里**一个 `pending-ci` 都没有了**，所以这道闸今天在数据层
 * 打不起来，只在代码层成立。如果用例去目录里找一个 pending-ci 的包来喂，
 * 它今天就会筛出空集 → 断言恒真 → **这道闸没有任何覆盖，而测试是绿的**。
 * 所以夹具自己造。判据是闸门的行为，不是目录此刻恰好长什么样。
 */

/*
 * ⚠️ PROTOCOL §9-bis：模块顶层重定向，窗口为零。
 * `RestState.create()` 会 mkdir 模型根、读写 active.json ——
 * 不重定向就会去动这台机器上真实的数据目录。
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-t196-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { isPackApplicable } from '@openmemo/runtime';
import type { Backend } from '@openmemo/shared';

import { SseHub } from '../sse.js';
import { RestState } from './state.js';
import { currentPlatform, handleBackendRoutes } from './backends.js';

const REPO_ROOT = resolve(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..'),
);
const REAL_MANIFESTS = join(REPO_ROOT, 'vendor', 'manifests');

/** 攒起响应的假 `ServerResponse` —— 只要 handler 用到的那几个成员。 */
interface Captured {
  status: number;
  body: unknown;
}
function fakeRes(): { res: never; captured: () => Captured } {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    // ⚠️ `sendJson` 写的是 **Buffer** 不是 string —— 只收 string 的话
    // 状态码断言会过、而 body 恒为 null，那是一条"看起来在测内容、其实只测了状态码"的用例。
    end(chunk?: unknown) {
      if (typeof chunk === 'string') raw += chunk;
      else if (Buffer.isBuffer(chunk)) raw += chunk.toString('utf8');
      return this;
    },
    write(chunk?: unknown) {
      if (typeof chunk === 'string') raw += chunk;
      else if (Buffer.isBuffer(chunk)) raw += chunk.toString('utf8');
      return true;
    },
  };
  return {
    res: res as never,
    captured: () => ({ status, body: raw ? JSON.parse(raw) : null }),
  };
}

/** 假 `IncomingMessage`，只提供 body 流。 */
function fakeReq(body: unknown): never {
  const text = JSON.stringify(body);
  async function* gen(): AsyncGenerator<Buffer> {
    yield Buffer.from(text, 'utf8');
  }
  const it = gen();
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(text.length) },
    [Symbol.asyncIterator]: () => it,
    on() {
      return this;
    },
  } as never;
}

/**
 * 造一份**只含一个包**的清单目录，包的 `availability` 由调用方决定。
 *
 * 字段照抄真目录里的 `whispercpp-cpu-linux-x64`（免得夹具自己写歪某个字段，
 * 在别的断言上出事），但 **`os`/`arch` 是按跑用例这台机器现合成的**，不是抄来的。
 *
 * ── ⚠️ 为什么必须合成，而不是照抄捐赠者的 `linux/x64` ─────────────────────────────
 *
 * 这段注释原文写的是"复制真目录里**一个本机适用的包**" —— 那句话**只在 linux/x64 上是真的**。
 * 捐赠者带着 `"os":"linux","arch":"x64"`，而 `applicability.ts:192` 的平台闸
 * （`pack.os !== platform.os || pack.arch !== platform.arch`）排在**所有其它判据之前**。
 * 于是在 **macOS（darwin/arm64）或 Windows** 上跑这个文件时：
 *
 *   四条用例全部拿到 409 `platform_mismatch` —— **包括那两条断言 202 的**，
 *   而它们本来要测的 `availability` 闸**一次都没被执行到**。
 *
 * 「pending-ci 必须 409」那条甚至**照旧是绿的**：它等的就是 409，只是理由完全是另一个。
 * 也就是说这份夹具在非 linux 上是「两条假红 + 一条假绿」，而假绿的那条正是本文件的主张。
 *
 * `backend` 保持捐赠者的 `cpu` 不动：`applicability.ts` 的 `L1_BACKENDS = ['cpu']`，
 * `isAlwaysApplicable()` 对 cpu **不看 os**，所以只要 os/arch 对得上，
 * 三个平台上它都是 L1 无条件适用 —— 不依赖这台机器探到了什么硬件。
 */
function manifestDirWith(availability: string | null): string {
  const dir = mkdtempSync(join(TEST_ROOT, 'mf-'));
  const be = JSON.parse(readFileSync(join(REAL_MANIFESTS, 'backends.json'), 'utf8')) as {
    packs: Record<string, unknown>[];
  };
  const donor = be.packs.find((p) => p['id'] === 'whispercpp-cpu-linux-x64');
  assert.ok(donor, '真目录里没有 whispercpp-cpu-linux-x64，夹具的前提不成立');
  const host = currentPlatform();
  const pack: Record<string, unknown> = {
    ...donor,
    id: 'test-pack-under-gate',
    os: host.os,
    arch: host.arch,
  };
  if (availability === null) delete pack['availability'];
  else pack['availability'] = availability;
  /*
   * ★ 前提断言：合成出来的这个包**在本机真的适用**。
   *
   * 没有它，平台闸一旦重新挡住夹具（改了 arch 命名、加了新的前置闸……），
   * 这个文件会以"四条断言各自离奇地失败/或那条 409 假绿"的方式告诉你，
   * 而真正的原因是夹具的前提没了。这一行让它直说「前提不成立」。
   * `hardware` 传 `null`（= 探针从没跑成）是刻意的：cpu 是 L1，本就不该依赖探测结果，
   * 传 null 恰好把"唯一可能挡住它的就是平台闸"这件事钉住。
   */
  const pre = isPackApplicable(
    { id: String(pack['id']), backend: pack['backend'] as Backend, os: host.os, arch: host.arch },
    host,
    null,
  );
  assert.equal(
    pre.applicable,
    true,
    `前提不成立：夹具包在本机（${host.os}/${host.arch}）上不适用，` +
      `安装闸根本走不到 availability 那一步 —— ${JSON.stringify(pre.reason)}`,
  );
  writeFileSync(join(dir, 'backends.json'), JSON.stringify({ ...be, packs: [pack] }, null, 2));
  mkdirSync(join(dir, 'x'), { recursive: true });
  return dir;
}

async function postInstall(availability: string | null): Promise<Captured> {
  const dataDir = mkdtempSync(join(TEST_ROOT, 'data-'));
  process.env['OPENMEMO_MODELS'] = join(dataDir, 'models');
  const state = await RestState.create({
    sse: new SseHub(),
    dataDir,
    manifestDir: manifestDirWith(availability),
  });
  const { res, captured } = fakeRes();
  const handled = await handleBackendRoutes(
    state,
    fakeReq({ id: 'test-pack-under-gate' }),
    res,
    '/api/backends/install',
    'POST',
  );
  assert.equal(handled, true, '路由根本没接住这个请求，后面的断言无意义');
  return captured();
}

describe('T-196 ④ 服务端也要有「能不能装」这道闸', () => {
  it('★★ pending-ci 的包：直接 POST 必须 409，不许静默 202 起一个必然失败的 job', async () => {
    const r = await postInstall('pending-ci');
    assert.equal(
      r.status,
      409,
      '202 = 服务端替一个"还没发布"的东西排了队，失败被推迟到几十秒后且指向错误方向',
    );
    const err = (r.body as { error?: Record<string, unknown> }).error;
    assert.ok(err, '409 却没有错误信封');
    assert.equal(err['code'], 'CONFLICT');
    // 话要说清"不是你的机器的问题" —— 否则用户会去查自己的网络/驱动
    assert.match(String(err['messageZh']), /尚未发布|不是你的机器/);
  });

  it('★ published 的包照常 202（这道闸不许误伤正常安装）', async () => {
    const r = await postInstall('published');
    assert.equal(r.status, 202, `published 被挡住了 —— 那是假红灯：${JSON.stringify(r.body)}`);
  });

  it('★ 字段缺失照常 202（目录里 12/14 个包根本没写这个字段）', async () => {
    const r = await postInstall(null);
    assert.equal(r.status, 202, '把"没写"读成"未发布"会一次性挡住大多数包');
  });

  it('★ 409 带 remediation，且它的 action 在前端两张表里有登记（不许掉进兜底）', async () => {
    const r = await postInstall('pending-ci');
    const rem = (r.body as { error?: { remediation?: { action?: string } } }).error?.remediation;
    assert.ok(rem, '没有 remediation —— 用户只拿到一个 409 数字');
    assert.equal(rem.action, 'upgradeApp');
    /*
     * 前端 `routes.test.ts` 会扫 daemon 源码，要求每个 action 要么有路由、
     * 要么在 `UNROUTED_ACTIONS` 里写明理由。这里把"必须登记"这件事在 daemon 侧也钉一遍 ——
     * 两边各自会红，而不是等一个人同时想起两处。
     */
    const routes = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'lib', 'remediation', 'routes.ts'),
      'utf8',
    );
    assert.match(
      routes,
      /upgradeApp:/,
      'daemon 发了 upgradeApp，但前端两张表里没有它 —— 会掉进兜底路由',
    );
  });
});
