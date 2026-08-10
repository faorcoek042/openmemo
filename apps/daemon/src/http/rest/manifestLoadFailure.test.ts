/**
 * T-153 腿：**「清单读不了」和「清单里就是零条」必须分得开。**
 *
 * ── 事故本体 ────────────────────────────────────────────────────────────────
 *
 * `manifests.ts` 的 `listManifestFiles()`：
 *
 * ```ts
 * try { names = await fs.readdir(manifestDir); }
 * catch { return []; }            // ← 静默
 * ```
 *
 * 于是 `loadModelCatalog()` / `loadBackendCatalog()` 在**目录不存在 / 没权限 / 不是目录**
 * 时安安静静地返回 `{ catalogVersion: '0', models: [] }` ——
 * **和「目录本来就是零条」在调用方眼里一模一样。**
 *
 * `[实测]` 用户双击打开之后看到的 `packs = 0`、组件页全空，真相是**目录压根没加载**。
 * 他会去找"为什么没有包可装"，而正确的问题是"为什么清单没读到"。
 * ⚠️ 这条**不依赖任何远端目录代码**，在本地这一条路上就已经可达。
 *
 * ── 仓库里早就有一句一字不差的判词 ──────────────────────────────────────────
 *
 * `apps/daemon/src/pipeline/probeShipping.test.ts:101`：
 *
 * > **「`backends.json` 解析出 0 个包 —— 空集不是"没问题"，是"什么都没检查"」**
 *
 * 同一条道理，在**模型目录**这一侧从来没有被贯彻。
 *
 * ── 判据形状 ────────────────────────────────────────────────────────────────
 *
 * 与本轮反复确立的那条同族：**`UNKNOWN` / 空 / 真零，三者必须分得开** ——
 * 和 `null` vs `[]`（解析器失败 vs 解析器说没有）、`UNDECIDED` vs 绿、
 * `N/A` vs `UNKNOWN` 是同一件事。
 *
 * ⚠️ **断言不许是"返回了空"** —— 那种断言在两种情形下都成立，等于什么都没钉。
 * 每一条都必须能回答**"为什么空"**。
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { runSelfCheck, type SelfCheckProbes } from '@openmemo/runtime';

import { loadBackendCatalog, loadModelCatalog } from './manifests.js';

/**
 * 仓库根 —— `dist/http/rest` 上溯 **5** 层（rest→http→dist→daemon→apps→仓库根）。
 * ⚠️ 与 `pipeline/*.test.ts` 里那些的 4 层**不一样**：它们在 `dist/pipeline/`，浅一层。
 * 我第一版照抄了 4，于是算出 `/root/memo/apps/vendor/manifests` —— 下面那条
 * 「真实清单必须读得到」当场把它抓了出来。**这正是那条锚点存在的理由**：
 * 没有它，上面几条"读不了"的用例会在一个**因为我自己算错路径而读不了**的目录上全部通过。
 */
const REPO_ROOT = resolve(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..'),
);
const REAL_MANIFEST_DIR = join(REPO_ROOT, 'vendor', 'manifests');

/** 一个**存在且可读、但一条清单都没有**的目录 —— 「真零」。 */
async function emptyDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'om-mf-empty-'));
}

/** 一个**存在、可读、里面有一份合法但零条目的清单**的目录 —— 也是「真零」。 */
async function dirWithEmptyManifest(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'om-mf-zero-'));
  await writeFile(
    join(d, 'models-none.json'),
    JSON.stringify({
      schemaVersion: 1,
      catalogVersion: '2026.01.01',
      generatedAt: '2026-01-01T00:00:00Z',
      models: [],
    }),
  );
  return d;
}

/** 一个**根本不存在**的目录 —— 「读不了」。 */
async function missingDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'om-mf-gone-'));
  return join(d, 'no-such-manifests');
}

/** 一个存在、但**没有读权限**的目录 —— 同样是「读不了」，而且成因完全不同。 */
async function unreadableDir(): Promise<string | null> {
  const d = await mkdtemp(join(tmpdir(), 'om-mf-noperm-'));
  const inner = join(d, 'manifests');
  await mkdir(inner);
  await writeFile(
    join(inner, 'models-x.json'),
    '{"schemaVersion":1,"catalogVersion":"1","generatedAt":"x","models":[]}',
  );
  await chmod(inner, 0o000);
  // root 无视 mode 位 —— 这台机器上跑 CI 时是 root，那就诚实地说"这条造不出来"，
  // 而不是让用例在一个没成立的前提上"通过"。
  try {
    const { readdir } = await import('node:fs/promises');
    await readdir(inner);
    await chmod(inner, 0o755);
    return null; // 读得动 ⇒ 造不出"没权限"的现场
  } catch {
    return inner;
  }
}

/** 一个**是文件、不是目录**的路径 —— 第三种"读不了"。 */
async function notADir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'om-mf-file-'));
  const f = join(d, 'manifests');
  await writeFile(f, 'not a directory');
  return f;
}

describe('T-153 「清单读不了」不许被降级成「清单里零条」', () => {
  it('★ 目录不存在 vs 目录是空的：两者的返回值必须能分辨', async () => {
    const gone = await loadModelCatalog(await missingDir());
    const empty = await loadModelCatalog(await emptyDir());

    /*
     * ⚠️ 这条断言刻意**不**写成 `assert.notDeepEqual(gone, empty)` 之外的形式：
     * 只要两者长得一样，调用方就没有任何办法把"没加载"与"没有内容"区分开 ——
     * 用户看到的那个 `packs 0` 就是这么来的。
     */
    assert.notDeepEqual(
      gone,
      empty,
      '「目录压根没找到」与「目录里就是零条」返回了同一个值 —— ' +
        '调用方无法分辨，界面上只能显示"0 个"，而真相是清单没加载',
    );
  });

  it('★ 读不了的时候，返回值里要说得出"为什么" —— 不能只是一个空数组', async () => {
    const gone = await loadModelCatalog(await missingDir());
    const reason = (gone as { loadError?: unknown }).loadError;
    assert.ok(
      reason,
      '读不了清单目录时没有留下任何可供调用方判断的痕迹；' +
        '"空集不是没问题，是什么都没检查"（probeShipping.test.ts:101 的原话）',
    );
  });

  it('★ 真的零条（目录在、清单在、models 是空数组）不许被当成故障', async () => {
    const zero = await loadModelCatalog(await dirWithEmptyManifest());
    assert.equal(zero.models.length, 0);
    assert.equal(
      (zero as { loadError?: unknown }).loadError ?? null,
      null,
      '把"目录里确实没有模型"报成故障就是假红灯 —— 与假绿灯一样要当 bug 修',
    );
  });

  it('★ 后端目录同一条规则（用户撞到的那个 packs 0 就在这一侧）', async () => {
    const gone = await loadBackendCatalog(await missingDir());
    const empty = await loadBackendCatalog(await emptyDir());
    assert.notDeepEqual(gone, empty, '后端清单读不了与零个包必须分得开');
    assert.ok(
      (gone as { loadError?: unknown }).loadError,
      'packs 0 的真相是"没加载"时，必须有地方说得出这件事',
    );
  });

  it('★ 路径是个文件而不是目录 —— 同样属于"读不了"', async () => {
    const bad = await loadModelCatalog(await notADir());
    assert.ok((bad as { loadError?: unknown }).loadError, 'ENOTDIR 也是读不了，不是"零条"');
  });

  it('★ 没有读权限 —— 第三种读不了（root 下造不出来时如实跳过并说明）', async (t) => {
    const dir = await unreadableDir();
    if (dir === null) {
      // 不是 skip 掉就完事：把"为什么没测"写进输出，否则它看起来像通过了
      t.diagnostic('当前用户能读 mode 000 的目录（多半是 root），这一档在本机造不出来');
      return;
    }
    const denied = await loadModelCatalog(dir);
    assert.ok((denied as { loadError?: unknown }).loadError, 'EACCES 也是读不了，不是"零条"');
  });

  it('★ 真实的 vendor/manifests 必须是"读到了且有内容" —— 否则上面几条在测空气', async () => {
    const real = await loadModelCatalog(REAL_MANIFEST_DIR);
    assert.equal(real.loadError, null, `连真实清单都读不了：${JSON.stringify(real.loadError)}`);
    assert.ok(real.models.length >= 30, `真实目录只解析出 ${real.models.length} 个模型`);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 界面要说得出话 —— 但**不是**给一个点了没用的按钮
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('T-153 读不了的时候，自检要说出"发生了什么"', () => {
  /** 只实现必答探针 + 本条要测的那个。 */
  const probesWith = (catalogLoad?: SelfCheckProbes['catalogLoad']): SelfCheckProbes => ({
    tools: () =>
      Promise.resolve({
        ffmpeg: null,
        ffprobe: null,
        whisperCli: null,
        whisperVad: null,
        vadModel: null,
        ytDlp: null,
      }),
    installed: () => Promise.resolve([]),
    installedByRole: () => Promise.resolve({ names: [], skippedWithoutRole: 0 }),
    chineseSearch: () => Promise.resolve(null),
    vecVersion: () => Promise.resolve(null),
    engines: () => Promise.resolve([]),
    selectFor: () => Promise.resolve(null),
    ...(catalogLoad ? { catalogLoad } : {}),
  });

  const runWith = async (catalogLoad?: SelfCheckProbes['catalogLoad']) => {
    const base = join(tmpdir(), 'om-mf-selfcheck');
    const report = await runSelfCheck({
      dataDir: base,
      storeRoot: join(base, 'models'),
      extensionsDir: join(base, 'bin', 'ext'),
      probes: probesWith(catalogLoad),
    });
    return report.results.find((r) => r.id === 'catalog.bundled');
  };

  it('★ 读不到目录 → fail(required)，而且话里要有"不是没有东西可装"这层意思', async () => {
    const c = await runWith(() =>
      Promise.resolve({
        loaded: false,
        dir: '/nope/vendor/manifests',
        models: 0,
        packs: 0,
        reasonZh:
          '不是"没有可用项"，是内置目录没能读取 —— 目录不存在。找的是：/nope/vendor/manifests',
        reasonEn: 'ENOENT: no such directory (/nope/vendor/manifests)',
      }),
    );
    assert.ok(c, '连 catalog.bundled 这一项都没有');
    assert.equal(c.status, 'fail');
    assert.equal(c.required, true, '装不了任何东西不是"降级"，是坏了');
    assert.match(c.detail, /没能读取|不是"没有可用项"/, '要否定用户默认会做的那个推断');
    assert.match(c.detail, /\/nope\/vendor\/manifests/, '要说出找的是哪个路径');
  });

  it('★ 读到了但零条 → warn，而且**不能**和"读不到"说同一句话', async () => {
    const zero = await runWith(() =>
      Promise.resolve({
        loaded: true,
        dir: '/tmp/m',
        models: 0,
        packs: 0,
        reasonZh: null,
        reasonEn: null,
      }),
    );
    const broken = await runWith(() =>
      Promise.resolve({
        loaded: false,
        dir: '/tmp/m',
        models: 0,
        packs: 0,
        reasonZh: '读不了',
        reasonEn: 'cannot read',
      }),
    );
    assert.ok(zero && broken);
    assert.equal(zero.status, 'warn');
    assert.notEqual(zero.status, broken.status, '两种"0 个"必须给不同的档');
    assert.notEqual(zero.detail, broken.detail, '两种"0 个"必须给不同的话');
  });

  it('★ 正常 → ok，且不给 remediation（没坏就不该有"下一步"）', async () => {
    const c = await runWith(() =>
      Promise.resolve({
        loaded: true,
        dir: '/tmp/m',
        models: 40,
        packs: 20,
        reasonZh: null,
        reasonEn: null,
      }),
    );
    assert.ok(c);
    assert.equal(c.status, 'ok');
    assert.equal(c.remediation, null);
  });

  it('★ 刻意不给可点的按钮：remediation 里不许出现应用内路由', async () => {
    const c = await runWith(() =>
      Promise.resolve({
        loaded: false,
        dir: '/tmp/m',
        models: 0,
        packs: 0,
        reasonZh: '读不了',
        reasonEn: 'cannot read',
      }),
    );
    assert.ok(c?.remediation, '坏了却一个字都不说 = 沉默，那是这条要修的东西');
    /*
     * `routes.ts` 记着 26 个调用点里 23 个刻意不给按钮：「给一个点了没用的按钮，
     * 比不给按钮更糟」。目录随产品出厂，应用内没有任何一页能修它 ——
     * 所以这里断言的是"**没有**把人往某一页送"，而不是"有没有 remediation"。
     */
    assert.equal(
      /\/(models|runtime|components|settings|tasks|notes)\b/.test(c.remediation),
      false,
      `指引里出现了应用内路由，但那些页面一个都修不了这件事：${c.remediation}`,
    );
  });

  it('★ 没给这个探针时，检查项**照常出现**（T-119：两个出口 id 集合必须一致）', async () => {
    const c = await runWith(undefined);
    assert.ok(c, '缺探针就少一条 —— 那会让 CLI 与端点的 id 集合对不上，正是 T-119 修掉的病');
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /未探测/);
  });

  it('英文字段里不许出现 CJK（本仓既有守卫的同一条规矩）', async () => {
    const c = await runWith(() =>
      Promise.resolve({
        loaded: false,
        dir: '/tmp/m',
        models: 0,
        packs: 0,
        reasonZh: '读不了',
        reasonEn: 'cannot read',
      }),
    );
    assert.ok(c);
    const cjk = /[一-鿿]/;
    assert.equal(cjk.test(c.label), false, `label 里有中文：${c.label}`);
    assert.equal(cjk.test(c.detailEn ?? ''), false, `detailEn 里有中文：${c.detailEn ?? ''}`);
    assert.equal(cjk.test(c.remediationEn ?? ''), false, `remediationEn 里有中文`);
  });
});
