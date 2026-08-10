#!/usr/bin/env node
/**
 * `release-upload.mjs` / `release-verify.mjs` 的**本机自检 + 反向验证**。
 *
 * ## 为什么必须有这个文件
 *
 * 这两个脚本要么在真 runner 上跑，要么根本不跑 —— 而它们**手里有 `contents: write`**。
 * 「读一遍代码说它不会建 release」正是 `build-backends.yml` 能带着 11 条错误活到
 * 第一次真跑的原因（T-144）。所以这里的判据是：
 *
 * > **每一条"必须红"的性质，都用一个坏输入证明它真的会红，并且贴出真实输出。**
 *
 * ## 为什么用桩服务器，而不是打真的 GitHub
 *
 * 三个原因，都不是洁癖：
 *   1. **"draft release 必须红"这条没法用真 API 验** —— 我们**无权创建 draft release**
 *      （创建 release 是要人确认的对外动作）。桩是唯一能让这条断言真的执行到的办法。
 *   2. 门禁不该依赖网络与 API 速率。一个"网断了就红"的门禁，会训练所有人忽略它。
 *   3. 桩还能验一件真 API 验不了的事：**这些脚本有没有发出未授权的请求**。
 *      桩对任何 `DELETE` / `PATCH` / `PUT`（以及打到 `/releases` 上的建库 POST）都记账，
 *      跑完断言"违规请求数 = 0"。
 *
 * ⚠️ 真 API 上的反向验证（"已存在但内容不同 → 红"、"匿名下载复算不符 → 红"）
 *    另外单独跑过，输出贴在 `coordination/inbox/ci-upload.md`。那两条不放进门禁，
 *    理由见第 2 点。
 *
 * ## §10：全部跑在 `/tmp` 的隔离副本上
 *
 * 每个用例一个 `mkdtemp`，共享工作树一个字节都不动 —— 反向验证的中间态不许被别人看见。
 *
 * 跑：`node scripts/ci/selftest-release-upload.mjs`（`pnpm test:ci-scripts` 会调）
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const UPLOAD = join(REPO_ROOT, 'scripts', 'ci', 'release-upload.mjs');
const VERIFY = join(REPO_ROOT, 'scripts', 'ci', 'release-verify.mjs');

const REPO = 'testowner/testrepo';
const TAG = 'test-tag-2026.08.06';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

let passed = 0;
const failures = [];
function check(name, fn) {
  return (async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ✔ ${name}`);
    } catch (e) {
      failures.push(
        `${name}\n      ${e instanceof Error ? e.message.split('\n').join('\n      ') : String(e)}`,
      );
      console.log(`  ✘ ${name}`);
    }
  })();
}

/* ── 桩服务器 ─────────────────────────────────────────────────────────────────────── */

/**
 * 只实现被授权的两个端点，外加匿名下载。
 * **任何其它方法/路径都记进 `violations`** —— 那正是这个桩最有价值的地方：
 * 它能回答"这个脚本除了我们授权的两件事之外还干了什么"。
 */
function startStub({ draft = false, exists = true, assets = new Map() } = {}) {
  const state = { draft, exists, assets, violations: [], uploads: [] };
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.method !== 'POST') {
      state.violations.push(`${req.method} ${u.pathname}`);
      return json(405, { message: 'method not allowed by this stub' });
    }
    const base = `http://127.0.0.1:${server.address().port}`;
    const releaseBody = () => ({
      id: 1,
      draft: state.draft,
      prerelease: true,
      html_url: `${base}/${REPO}/releases/tag/${TAG}`,
      upload_url: `${base}/repos/${REPO}/releases/1/assets{?name,label}`,
      assets: [...state.assets].map(([name, spec]) => ({
        name,
        size: spec.buf.length,
        state: spec.state ?? 'uploaded',
        digest: spec.noDigest ? null : `sha256:${sha(spec.buf)}`,
        browser_download_url: `${base}/${REPO}/releases/download/${TAG}/${encodeURIComponent(name)}`,
      })),
    });

    /* 授权面 ①：GET releases/tags/<tag> */
    if (req.method === 'GET' && u.pathname === `/repos/${REPO}/releases/tags/${TAG}`) {
      return state.exists ? json(200, releaseBody()) : json(404, { message: 'Not Found' });
    }
    if (req.method === 'GET' && u.pathname === `/repos/${REPO}/releases/1`) {
      return json(200, releaseBody());
    }
    /* 授权面 ②：POST releases/<id>/assets?name= */
    if (req.method === 'POST' && u.pathname === `/repos/${REPO}/releases/1/assets`) {
      const name = u.searchParams.get('name');
      if (state.assets.has(name)) return json(422, { message: 'already_exists' });
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        state.assets.set(name, { buf });
        state.uploads.push({ name, size: buf.length });
        json(201, { name, size: buf.length, state: 'uploaded' });
      });
      return undefined;
    }
    /* 建 release 就是打到这条路径上的 POST —— 授权之外，记账。 */
    if (req.method === 'POST' && u.pathname === `/repos/${REPO}/releases`) {
      state.violations.push(`POST ${u.pathname}（建 release）`);
      return json(403, { message: 'not authorised' });
    }
    /* 匿名下载。draft 的附件匿名下不到 —— 这是真 GitHub 的行为，桩照抄。 */
    const dl = `/${REPO}/releases/download/${TAG}/`;
    if (req.method === 'GET' && u.pathname.startsWith(dl)) {
      const name = decodeURIComponent(u.pathname.slice(dl.length));
      if (state.draft) return json(404, { message: 'Not Found' });
      const spec = state.assets.get(name);
      if (!spec) return json(404, { message: 'Not Found' });
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(spec.buf);
    }
    state.violations.push(`${req.method} ${u.pathname}`);
    return json(404, { message: 'unexpected request' });
  });
  return new Promise((r) => {
    server.listen(0, '127.0.0.1', () =>
      r({ state, server, base: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

/* ── 跑脚本 ───────────────────────────────────────────────────────────────────────── */

const NO_PROXY = { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };

/**
 * ⚠️ **必须是异步的 `spawn`，不能是 `spawnSync`。**
 *
 * 第一版用了 `spawnSync`，结果整个自检**当场死锁**：桩服务器就跑在这个进程里，
 * 而 `spawnSync` 会把父进程的事件循环整个挡住 —— 子进程发来的 HTTP 请求
 * 永远没人应答，子进程等响应，父进程等子进程退出。
 *
 * 值得记一条：它的表现**不是报错，是"什么都不输出地卡住"** ——
 * 看起来像网络问题、像 GitHub 慢、像别人把机器弄卡了。
 * （和 PROTOCOL §8 那条 OOM 是同一族：真正的成因在别处，症状伪装成环境问题。）
 */
/*
 * ★ 夹具用的许可证清单（2026-08-08，`prebuilt`）。
 *
 * `release-upload.mjs` 现在有一道许可证闸门：**资产必须在清单里被声明，
 * 且声明的许可证必须是宽松的**，否则拒绝上传。它堵的是
 * 「有 GPL 字节进入我们自己的 Release」这条路（D-17 §1.2 数出三条通往那里的路，
 * 且三条都不会报错）。
 *
 * 本自检的夹具包是凭空造的 `pack-a.tar.gz` / `pack-b.tar.gz`，
 * 真清单里当然没有它们 —— 所以这里给一份**夹具清单**，把它们声明成 MIT。
 * 这不削弱闸门：**RV11 用同一个机制把同一个包声明成 GPL，然后断言它被拒**，
 * RV12 则把清单清空，断言"查不到许可证"同样被拒。
 * 也就是说这个覆盖点本身是被反向验证过的，不是一个只会放行的旁路。
 */
const FIXTURE_MANIFESTS = mkdtempSync(join(tmpdir(), 'ci-upload-manifests-'));
writeFileSync(
  join(FIXTURE_MANIFESTS, 'fixture.json'),
  JSON.stringify({
    schemaVersion: 1,
    catalogVersion: 'selftest',
    packs: [
      { id: 'pack-a', license: { id: 'MIT' }, files: [{ name: 'pack-a.tar.gz' }] },
      { id: 'pack-b', license: { id: 'MIT' }, files: [{ name: 'pack-b.tar.gz' }] },
      { id: 'tokens', license: { id: 'MIT' }, files: [{ name: 'tokens.txt' }] },
    ],
  }),
);

function run(script, args, extraEnv = {}) {
  // 跑 release-upload 时，调用方没显式给 --manifests 就补上夹具那份。
  if (script === UPLOAD && !args.includes('--manifests')) {
    args = [...args, '--manifests', FIXTURE_MANIFESTS];
  }
  /* 干净环境：真凭证一律不带进来（尤其对 release-verify 而言那是它要断言不存在的东西）。 */
  const env = { ...process.env, ...NO_PROXY, ...extraEnv };
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_API_TOKEN']) {
    if (!(k in extraEnv)) delete env[k];
  }
  return new Promise((res) => {
    const c = spawn(process.execPath, [script, ...args], { env });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (status) => res({ status, out }));
  });
}

async function makeSrc(files, { extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-upload-src-'));
  const sub = join(dir, 'artifact-a');
  await mkdir(sub, { recursive: true });
  const lines = [];
  for (const [name, content] of Object.entries(files)) {
    const buf = Buffer.from(content);
    await writeFile(join(sub, name), buf);
    lines.push(`${sha(buf)}  ${name}`);
  }
  await writeFile(join(sub, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  for (const [name, content] of Object.entries(extra)) await writeFile(join(sub, name), content);
  return dir;
}

const tmpDirs = [];
const stage = () => {
  const d = mkdtempSync(join(tmpdir(), 'ci-upload-stage-'));
  tmpDirs.push(d);
  return d;
};

/* ── 用例 ─────────────────────────────────────────────────────────────────────────── */

console.log('');
console.log('══ selftest-release-upload ══════════════════════════════════════════════════');
console.log('   全部跑在 /tmp 的隔离副本上（PROTOCOL §10），共享工作树未被触碰');
console.log('');
console.log('① 正向：release 已存在且已发布，资产还没有 → 串行上传 → 匿名下载复算一致');

{
  const stub = await startStub();
  const src = await makeSrc({ 'pack-a.tar.gz': 'AAAA', 'pack-b.tar.gz': 'BBBB' });
  tmpDirs.push(src);
  const st = stage();
  const up = await run(
    UPLOAD,
    [
      '--repo',
      REPO,
      '--tag',
      TAG,
      '--from',
      src,
      '--stage',
      st,
      '--api-base',
      stub.base,
      '--download-base',
      stub.base,
    ],
    { GITHUB_TOKEN: 'stub-token' },
  );
  await check('① 上传成功退出 0，且真的传了 2 个', () => {
    assert.equal(up.status, 0, up.out);
    assert.equal(
      stub.state.uploads.length,
      2,
      `实际上传 ${stub.state.uploads.length} 个\n${up.out}`,
    );
  });
  const vout = stage();
  const ve = await run(VERIFY, ['--plan', st, '--out', vout]);
  await check('① 匿名复算通过（下载 URL 上没有凭证）', () => {
    assert.equal(ve.status, 0, ve.out);
    assert.match(ve.out, /全部匿名下得到/);
  });
  await check('① 桩没有收到任何未授权请求（无 DELETE / PATCH / 建 release）', () => {
    assert.deepEqual(stub.state.violations, []);
  });
  /* 重跑一遍：这次两个资产都已存在且一致 → 必须**跳过**，且不再发 POST。 */
  const st2 = stage();
  const again = await run(
    UPLOAD,
    [
      '--repo',
      REPO,
      '--tag',
      TAG,
      '--from',
      src,
      '--stage',
      st2,
      '--api-base',
      stub.base,
      '--download-base',
      stub.base,
    ],
    { GITHUB_TOKEN: 'stub-token' },
  );
  await check('① 重跑：已存在且 sha256 一致 → 跳过并说明理由，不重复上传', () => {
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /跳过：已存在且 sha256 一致/);
    assert.equal(stub.state.uploads.length, 2, '重跑不该再产生上传');
  });
  stub.server.close();
}

/* ①b · 没有清单的目录整个被跳过 —— 但必须**出声**（build artifact 里的 probe 就是这个形状）。 */
{
  const stub = await startStub();
  const src = await makeSrc({ 'pack-a.tar.gz': 'AAAA' });
  tmpDirs.push(src);
  await mkdir(join(src, 'probe'), { recursive: true });
  await writeFile(join(src, 'probe', 'openmemo-probe'), 'ELF-ish');
  const r = await run(
    UPLOAD,
    [
      '--repo',
      REPO,
      '--tag',
      TAG,
      '--from',
      src,
      '--stage',
      stage(),
      '--api-base',
      stub.base,
      '--download-base',
      stub.base,
    ],
    { GITHUB_TOKEN: 'stub-token' },
  );
  await check('①b 没有清单的目录整个跳过，且逐个报出文件名（不许一个字不说地跳过）', () => {
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /⏭ 整个跳过[\s\S]*openmemo-probe/);
    assert.equal(stub.state.uploads.length, 1, '只该传 pack-a');
  });
  stub.server.close();
}

/*
 * ①c · `build-bundle.mjs` 自己的顶层产物描述（`openmemo-<version>-<target>.json`）也要
 * 被认出来 —— 它和 `emit-pack-manifest.mjs` 的 fragment 是姊妹格式，不是同一个格式。
 *
 * `[实测 2026-08-10]` `release-upload` 第一次对着真的三平台包跑 dry-run，四个来源目录
 * （三个 `bundle-<target>` + 一个 `bundles-complete`）**全部**被判成
 * "既没有 SHA256SUMS 也没有 pack fragment" 而整个跳过——但 sha256 其实从来没有丢，
 * 只是识别端没认得这第二种形状。这条用例同时验证第三种形状
 * （`bundles-complete.json`，`targets.<t>.archive` 是文件名字符串而不是对象）
 * **不会**被误认成资产来源——它自己的目录里确实没有可上传的字节。
 */
{
  const stub = await startStub();
  const dir = mkdtempSync(join(tmpdir(), 'ci-upload-src-'));
  tmpDirs.push(dir);

  const bundleDir = join(dir, 'bundle-linux-x64');
  await mkdir(bundleDir, { recursive: true });
  const buf = Buffer.from('FAKE-ARCHIVE-BYTES');
  await writeFile(join(bundleDir, 'openmemo-0.7.0-linux-x64.tar.xz'), buf);
  await writeFile(
    join(bundleDir, 'openmemo-0.7.0-linux-x64.json'),
    JSON.stringify({
      name: 'openmemo-0.7.0-linux-x64',
      version: '0.7.0',
      target: 'linux-x64',
      nodeVersion: 'v22.23.1',
      rawBytes: 12345,
      archive: { file: 'openmemo-0.7.0-linux-x64.tar.xz', bytes: buf.length, sha256: sha(buf) },
      generatedAt: new Date().toISOString(),
    }),
  );

  const completeDir = join(dir, 'bundles-complete');
  await mkdir(completeDir, { recursive: true });
  await writeFile(
    join(completeDir, 'bundles-complete.json'),
    JSON.stringify({
      schemaVersion: 1,
      version: '0.7.0',
      targets: {
        'linux-x64': {
          name: 'openmemo-0.7.0-linux-x64',
          archive: 'openmemo-0.7.0-linux-x64.tar.xz',
          sha256: sha(buf),
          bytes: buf.length,
        },
      },
    }),
  );

  const r = await run(
    UPLOAD,
    [
      '--repo',
      REPO,
      '--tag',
      TAG,
      '--from',
      dir,
      '--stage',
      stage(),
      '--api-base',
      stub.base,
      '--download-base',
      stub.base,
    ],
    { GITHUB_TOKEN: 'stub-token' },
  );
  await check(
    '①c build-bundle.mjs 的顶层 meta 被认出来并正确上传；bundles-complete 形状仍被跳过',
    () => {
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /模式=pack-fragment/);
      assert.match(r.out, /⏭ 整个跳过[\s\S]*bundles-complete\.json/);
      assert.equal(stub.state.uploads.length, 1, `应只传 1 个归档\n${r.out}`);
      assert.equal(stub.state.uploads[0]?.name, 'openmemo-0.7.0-linux-x64.tar.xz');
    },
  );
  stub.server.close();
}

console.log('');
console.log('② 反向验证 —— 每一条都必须红');

/* RV1 · 本地产物与自带清单对不上（"故意让一个 sha256 对不上"）。 */
{
  const stub = await startStub();
  const src = await makeSrc({ 'pack-a.tar.gz': 'AAAA' });
  tmpDirs.push(src);
  await writeFile(join(src, 'artifact-a', 'pack-a.tar.gz'), 'TAMPERED');
  const r = await run(
    UPLOAD,
    [
      '--repo',
      REPO,
      '--tag',
      TAG,
      '--from',
      src,
      '--stage',
      stage(),
      '--api-base',
      stub.base,
      '--download-base',
      stub.base,
    ],
    { GITHUB_TOKEN: 'stub-token' },
  );
  await check('RV1 · 产物 sha256 与自带清单不符 → 红，且一个字节都没传上去', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /本地实算/);
    assert.equal(stub.state.uploads.length, 0, '校验没过却传了东西');
  });
  stub.server.close();
}

/* RV2 · release 上已经有同名资产但内容不同（"故意传一个已存在但内容不同的资产"）。 */
{
  const stub = await startStub({
    assets: new Map([['pack-a.tar.gz', { buf: Buffer.from('OLD-BYTES') }]]),
  });
  const src = await makeSrc({ 'pack-a.tar.gz': 'NEW-BYTES' });
  tmpDirs.push(src);
  const r = await run(
    UPLOAD,
    [
      '--repo',
      REPO,
      '--tag',
      TAG,
      '--from',
      src,
      '--stage',
      stage(),
      '--api-base',
      stub.base,
      '--download-base',
      stub.base,
    ],
    { GITHUB_TOKEN: 'stub-token' },
  );
  await check('RV2 · 同名资产内容不同 → 红（不 clobber、不删、不改名）', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /已有同名资产，但\*\*内容不同\*\*/);
    assert.equal(stub.state.uploads.length, 0);
    assert.deepEqual(stub.state.violations, [], '不许为了覆盖而发 DELETE');
  });
  stub.server.close();
}

/* RV3 · draft release（"故意在 draft release 上跑"）。 */
{
  const stub = await startStub({ draft: true });
  const src = await makeSrc({ 'pack-a.tar.gz': 'AAAA' });
  tmpDirs.push(src);
  const r = await run(
    UPLOAD,
    [
      '--repo',
      REPO,
      '--tag',
      TAG,
      '--from',
      src,
      '--stage',
      stage(),
      '--api-base',
      stub.base,
      '--download-base',
      stub.base,
    ],
    { GITHUB_TOKEN: 'stub-token' },
  );
  await check('RV3 · draft release → 红，且**不会**替你 publish（那需要 PATCH）', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /是 \*\*draft\*\*/);
    assert.equal(stub.state.uploads.length, 0);
    assert.deepEqual(stub.state.violations, [], '不许为了继续而去改 release');
  });
  stub.server.close();
}

/* RV3b · draft 的第二道防线：就算资产真在上面，匿名也下不到 → 校验那一步同样红。 */
{
  const buf = Buffer.from('AAAA');
  const stub = await startStub({ draft: true, assets: new Map([['pack-a.tar.gz', { buf }]]) });
  const st = stage();
  await writeFile(join(st, 'SHA256SUMS'), `${sha(buf)}  pack-a.tar.gz\n`);
  await writeFile(
    join(st, 'RELEASE-UPLOAD-PLAN.json'),
    JSON.stringify({
      repo: REPO,
      tag: TAG,
      downloadBase: stub.base,
      assets: [{ name: 'pack-a.tar.gz', sha256: sha(buf), sizeBytes: buf.length, action: 'skip' }],
    }),
  );
  const r = await run(VERIFY, ['--plan', st, '--out', stage()]);
  await check('RV3b · draft 的附件匿名下不到 → 校验红，并点名 draft 是最常见成因', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /HTTP 404/);
    assert.match(r.out, /draft/);
  });
  stub.server.close();
}

/* RV4 · release 根本不存在 → 红，且**绝不创建**。 */
{
  const stub = await startStub({ exists: false });
  const src = await makeSrc({ 'pack-a.tar.gz': 'AAAA' });
  tmpDirs.push(src);
  const r = await run(
    UPLOAD,
    [
      '--repo',
      REPO,
      '--tag',
      TAG,
      '--from',
      src,
      '--stage',
      stage(),
      '--api-base',
      stub.base,
      '--download-base',
      stub.base,
    ],
    { GITHUB_TOKEN: 'stub-token' },
  );
  await check(
    'RV4 · tag 不存在 → 红，并明说"本 job 不会替你建"；桩没收到建 release 的 POST',
    () => {
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /不会替你建/);
      assert.deepEqual(stub.state.violations, []);
    },
  );
  stub.server.close();
}

/* RV5 · 校验时清单与线上字节不符 → 红。 */
{
  const buf = Buffer.from('REAL-BYTES');
  const stub = await startStub({ assets: new Map([['pack-a.tar.gz', { buf }]]) });
  const st = stage();
  const wrong = sha(Buffer.from('SOMETHING-ELSE'));
  await writeFile(join(st, 'SHA256SUMS'), `${wrong}  pack-a.tar.gz\n`);
  await writeFile(
    join(st, 'RELEASE-UPLOAD-PLAN.json'),
    JSON.stringify({
      repo: REPO,
      tag: TAG,
      downloadBase: stub.base,
      assets: [{ name: 'pack-a.tar.gz', sha256: wrong, sizeBytes: buf.length, action: 'upload' }],
    }),
  );
  const r = await run(VERIFY, ['--plan', st, '--out', stage()]);
  await check('RV5 · 从公开 URL 下下来复算与清单不符 → 红', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /sha256 不符/);
  });
  stub.server.close();
}

/* RV6 · 校验那一步被喂了 token → 红。这条守的是"匿名"这个结论本身。 */
{
  const buf = Buffer.from('REAL-BYTES');
  const stub = await startStub({ assets: new Map([['pack-a.tar.gz', { buf }]]) });
  const st = stage();
  await writeFile(join(st, 'SHA256SUMS'), `${sha(buf)}  pack-a.tar.gz\n`);
  await writeFile(
    join(st, 'RELEASE-UPLOAD-PLAN.json'),
    JSON.stringify({
      repo: REPO,
      tag: TAG,
      downloadBase: stub.base,
      assets: [{ name: 'pack-a.tar.gz', sha256: sha(buf), sizeBytes: buf.length, action: 'skip' }],
    }),
  );
  const clean = await run(VERIFY, ['--plan', st, '--out', stage()]);
  const dirty = await run(VERIFY, ['--plan', st, '--out', stage()], {
    GITHUB_TOKEN: 'oops-someone-added-this',
  });
  await check('RV6 · 环境里出现 GITHUB_TOKEN → 红（同一份输入，不带 token 时是绿的）', () => {
    assert.equal(clean.status, 0, `不带 token 本该绿：\n${clean.out}`);
    assert.equal(dirty.status, 1, dirty.out);
    assert.match(dirty.out, /环境里有凭证/);
  });
  stub.server.close();
}

/* RV7 · 两个来源里同名但内容不同 —— pack-publish 点名的那颗 `tokens.txt` 雷。 */
{
  const stub = await startStub();
  const dir = mkdtempSync(join(tmpdir(), 'ci-upload-src-'));
  tmpDirs.push(dir);
  for (const [sub, content] of [
    ['a', 'FROM-A'],
    ['b', 'FROM-B'],
  ]) {
    await mkdir(join(dir, sub), { recursive: true });
    await writeFile(join(dir, sub, 'tokens.txt'), content);
    await writeFile(join(dir, sub, 'SHA256SUMS'), `${sha(Buffer.from(content))}  tokens.txt\n`);
  }
  const r = await run(
    UPLOAD,
    [
      '--repo',
      REPO,
      '--tag',
      TAG,
      '--from',
      dir,
      '--stage',
      stage(),
      '--api-base',
      stub.base,
      '--download-base',
      stub.base,
    ],
    { GITHUB_TOKEN: 'stub-token' },
  );
  await check('RV7 · 两个 artifact 里同名不同内容 → 红（否则后一个会顶掉前一个且不报错）', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /资产名 tokens\.txt 在两个来源里内容不同/);
    assert.equal(stub.state.uploads.length, 0);
  });
  stub.server.close();
}

/* RV8 · 目录里有文件却没写进 SHA256SUMS → 红（"悄悄不传"比"传错"更难发现）。 */
{
  const stub = await startStub();
  const src = await makeSrc({ 'pack-a.tar.gz': 'AAAA' }, { extra: { 'forgotten.bin': 'ZZZZ' } });
  tmpDirs.push(src);
  const r = await run(
    UPLOAD,
    [
      '--repo',
      REPO,
      '--tag',
      TAG,
      '--from',
      src,
      '--stage',
      stage(),
      '--api-base',
      stub.base,
      '--download-base',
      stub.base,
    ],
    { GITHUB_TOKEN: 'stub-token' },
  );
  await check('RV8 · 有文件没列进 SHA256SUMS → 红', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /forgotten\.bin/);
    assert.equal(stub.state.uploads.length, 0);
  });
  stub.server.close();
}

/* RV9 · 一个资产都没有 → 红。"什么都没传却报成功"是本仓最贵的那类失败。 */
{
  const stub = await startStub();
  const dir = mkdtempSync(join(tmpdir(), 'ci-upload-src-'));
  tmpDirs.push(dir);
  const r = await run(
    UPLOAD,
    [
      '--repo',
      REPO,
      '--tag',
      TAG,
      '--from',
      dir,
      '--stage',
      stage(),
      '--api-base',
      stub.base,
      '--download-base',
      stub.base,
    ],
    { GITHUB_TOKEN: 'stub-token' },
  );
  await check('RV9 · 空目录 → 红（不许"什么都没传"却绿灯）', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /没有找到任何可上传的 artifact 目录/);
  });
  stub.server.close();
}

/* RV10 · 上次上传中断留下的 `state != uploaded` 残骸 → 红，而不是"再传一次盖过去"。 */
{
  const stub = await startStub({
    assets: new Map([['pack-a.tar.gz', { buf: Buffer.from('AAAA'), state: 'starter' }]]),
  });
  const src = await makeSrc({ 'pack-a.tar.gz': 'AAAA' });
  tmpDirs.push(src);
  const r = await run(
    UPLOAD,
    [
      '--repo',
      REPO,
      '--tag',
      TAG,
      '--from',
      src,
      '--stage',
      stage(),
      '--api-base',
      stub.base,
      '--download-base',
      stub.base,
    ],
    { GITHUB_TOKEN: 'stub-token' },
  );
  await check('RV10 · 同名资产卡在 state=starter → 红，并说明本 job 无权删除', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /state=starter/);
    assert.match(r.out, /没有删除能力/);
  });
  stub.server.close();
}

/*
 * RV11 / RV12 · 许可证闸门（2026-08-08，`prebuilt`）。
 *
 * 这两条守的是 D-17 §1 的整套 GPL 结论：它成立的前提是
 * **我们自己的 Release 上没有 copyleft 的字节**。而通往那里的路有三条，
 * 且三条都不会报错（build-media-tools.sh 重打包 GPL ffmpeg、
 * mirror-model-blobs 的白名单没有许可证闸门、本脚本此前只看 sha256）。
 * 闸门放在汇流处 = **跑错了也不会造成后果**，而不是"要记得别跑"。
 */
{
  const stub = await startStub();
  const src = await makeSrc({ 'pack-a.tar.gz': 'AAAA' });
  tmpDirs.push(src);
  // 同一个包，只把清单里的许可证从 MIT 改成 GPL-3.0-or-later
  const gplDir = mkdtempSync(join(tmpdir(), 'ci-upload-manifests-gpl-'));
  tmpDirs.push(gplDir);
  writeFileSync(
    join(gplDir, 'fixture.json'),
    JSON.stringify({
      schemaVersion: 1,
      catalogVersion: 'selftest',
      packs: [
        { id: 'pack-a', license: { id: 'GPL-3.0-or-later' }, files: [{ name: 'pack-a.tar.gz' }] },
      ],
    }),
  );
  const r = await run(
    UPLOAD,
    [
      '--repo',
      REPO,
      '--tag',
      TAG,
      '--from',
      src,
      '--stage',
      stage(),
      '--api-base',
      stub.base,
      '--download-base',
      stub.base,
      '--manifests',
      gplDir,
    ],
    { GITHUB_TOKEN: 'stub-token' },
  );
  await check('RV11 · 资产的许可证是 GPL → 红，且一个字节都没传上去', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /GPL-3\.0-or-later/);
    assert.match(r.out, /硬阻断|conveying/);
    assert.equal(
      stub.state.uploads.length,
      0,
      `不该传任何东西，实际传了 ${stub.state.uploads.length} 个`,
    );
  });
  stub.server.close();
}

{
  const stub = await startStub();
  const src = await makeSrc({ 'pack-a.tar.gz': 'AAAA' });
  tmpDirs.push(src);
  // 空清单：包没有被声明过
  const emptyDir = mkdtempSync(join(tmpdir(), 'ci-upload-manifests-empty-'));
  tmpDirs.push(emptyDir);
  writeFileSync(join(emptyDir, 'fixture.json'), JSON.stringify({ schemaVersion: 1, packs: [] }));
  const r = await run(
    UPLOAD,
    [
      '--repo',
      REPO,
      '--tag',
      TAG,
      '--from',
      src,
      '--stage',
      stage(),
      '--api-base',
      stub.base,
      '--download-base',
      stub.base,
      '--manifests',
      emptyDir,
    ],
    { GITHUB_TOKEN: 'stub-token' },
  );
  await check('RV12 · 资产查不到许可证 → 红（"不认识就放行"的闸门等于没有闸门）', () => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /查不到许可证/);
    assert.equal(
      stub.state.uploads.length,
      0,
      `不该传任何东西，实际传了 ${stub.state.uploads.length} 个`,
    );
  });
  stub.server.close();
}

/* ── 收尾 ─────────────────────────────────────────────────────────────────────────── */

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });

console.log('');
if (failures.length > 0) {
  console.log(
    `✘ selftest-release-upload: ${failures.length} 个用例失败（共 ${passed + failures.length} 个）`,
  );
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`✔ selftest-release-upload: ${passed} 个用例全部通过（3 组正向 + 10 组反向）`);
