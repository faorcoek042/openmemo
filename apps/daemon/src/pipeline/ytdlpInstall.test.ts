/**
 * T-132 回归守卫：**yt-dlp 必须能从网页装上，装上之后必须真的被产品路径用到。**
 *
 * 事故本体（本轮实测）：
 *   `GET /api/selfcheck` 报 `warn | tool.ytDlp | 未找到`，F1「粘链接导入」全线不可用，
 *   而**两份清单里都没有 yt-dlp 条目** —— 用户在网页上没有任何办法把它装回来。
 *   这是同一个陷阱的第二次：ffmpeg 那回是只写进了 `components.json`、漏了 `backends.json`。
 *
 * 这个文件把四道独立的闸门分别钉住。**四道全开才叫"能用"，任何一道关上都是静默失败**：
 *
 *   ① 清单里有条目          —— 没有就没有下载地址（`findCatalogPack` → 404 / 409）
 *   ② 装完带可执行位        —— 没有 `isExecutable()` 恒为 false，工具发现看不见它
 *   ③ 扁平二进制找得到      —— `by-name/backend/<name>` 是文件不是目录，只扫目录就漏
 *   ④ 站点提取器默认开      —— 关着的话装了也白装，registry 里根本没有这个适配器
 *
 * 每一条都被**反向验证**过（拆掉修复 → 变红，输出贴在 `coordination/inbox/ytdlp-install.md`）。
 *
 * ⚠️ 关于「"yt-dlp" 这个字符串只许出现在 `media/sources/ytdlp.ts`」那条约定：
 * 它约束的是**业务代码**（业务只跟 `MediaSourceRegistry` 说话）。这里是专门守护
 * yt-dlp 安装链路的回归测试，不点名就无从断言，与该约定不冲突。
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { ArtifactStore, install } from '@openmemo/downloader';
import { buildDefaultRegistry, discoverTools, findInBackendPacks } from '@openmemo/pipeline';
import { validateBackendManifest, type BackendPack } from '@openmemo/shared';

import { siteExtractorEnabled } from './setup.js';

/** 仓库根 —— dist/pipeline/ 上溯 4 层。 */
const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'));
const MANIFEST_DIR = join(REPO_ROOT, 'vendor', 'manifests');

const readJson = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(join(MANIFEST_DIR, name), 'utf8'));

/**
 * ★ T-147：**落盘的文件名必须带平台后缀**，否则这一族用例在 Windows 上全是红的。
 *
 * `discoverTools()` 在 win32 上找的是 `yt-dlp.exe`（`tools.ts:346` 的 `exe()`），
 * 而这几条以前一律写死 `'yt-dlp'` 造文件 —— 于是 `tools.ytDlp` 在 Windows 上是 null，
 * 断言 `equal(tools.ytDlp, join(dir,'yt-dlp'))` 必然失败。
 * 这与本文件自己第 ① 组的断言是同一件事：清单里 win32 包给的就是 `yt-dlp.exe`。
 *
 * ⚠️ 这几条**至今没有在 Windows 上真跑过**：`pnpm -r test` 在 `packages/runtime`
 * 就 bail 了（D-11 §3.3 的 6 条红全在那儿），`apps/daemon` 一条都没轮到。
 * 所以这属于**按实测的平台事实推出来的修**，标 `[未在 CI 上观测到红]`。
 */
const YTDLP = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';

const tmpDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
after(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

/* ═══════════════ ① 清单：两份都要有，缺一份就装不上 ═══════════════ */

describe('T-132 ① yt-dlp 在下载清单里', () => {
  it('backends.json 通过 schema 校验（否则 daemon 起来就加载不了目录）', async () => {
    const v = validateBackendManifest(await readJson('backends.json'));
    assert.equal(v.ok, true, v.ok ? '' : v.errors.slice(0, 5).join('\n'));
  });

  /*
   * ★ T-144 守卫：**已被 ADR-016 砍掉的东西不许留在用户看得见的目录里。**
   *
   * 事故形状（本轮实测，`GET :10000/api/backends/catalog`）：ADR-016 决策 3 明确砍掉
   * 内置 llama.cpp（用户原话「语言模型我们不要本地自己接模型做」），但目录里
   * **7 个 `llamacpp-*` 包一条没删**，而 `/api/backends/catalog` 不按 engine 过滤：
   *
   *     llamacpp-cpu-linux-x64 | applicable=true | kind=applicable | recommended=true
   *
   * `RuntimePage` 把 `applicable` 的包放**主列表**（不适用的才折叠），
   * `BackendPackCard` 的按钮只在 `!pack.applicable || pendingCi` 时禁用 ——
   * 于是 `/runtime` 页上有一个**可点击且被标为「推荐」**的按钮，
   * 点下去会真的下载 16.4 MB 的 llama.cpp。**界面提供了一个已被否决的功能。**
   *
   * 判据钉的是 `engine`（结构）不是 id 前缀（关键词）：换个包名照样红。
   */
  it('目录里不得再出现本地 LLM 引擎的包（ADR-016 决策 3 砍掉内置 llama.cpp）', async () => {
    const v = validateBackendManifest(await readJson('backends.json'));
    assert.ok(v.ok);
    const packs = (v.data as { packs: BackendPack[] }).packs;
    // 集合非空，否则这条断言可以靠"目录是空的"永远通过。
    assert.ok(packs.length >= 5, '目录里包太少，这条断言失去意义');
    assert.deepEqual(
      packs.filter((p) => p.engine === 'llama.cpp').map((p) => p.id),
      [],
      'ADR-016 砍掉了内置 LLM 线；这些包会出现在 /runtime 页上、可点、可下载',
    );
  });

  it('本机平台（linux/x64）有一个可安装的 yt-dlp 包', async () => {
    const v = validateBackendManifest(await readJson('backends.json'));
    assert.ok(v.ok);
    const packs = (v.data as { packs: BackendPack[] }).packs;
    const pack = packs.find((p) => p.engine === 'yt-dlp' && p.os === 'linux' && p.arch === 'x64');
    assert.ok(pack, 'backends.json 里没有 linux/x64 的 yt-dlp 包 —— 网页上就装不了');

    // 「有条目」不等于「装得上」：没有 mirror 的 published 条目点下去必然失败。
    assert.equal(pack.availability, 'published');
    assert.ok(pack.files[0]?.mirrors.length > 0, '没有下载地址');
    assert.match(pack.files[0].sha256, /^[a-f0-9]{64}$/, 'sha256 必须是 64 位小写十六进制');

    /*
     * ★ 这条断言钉的是**后果**，不是形式（⑤A 规矩 7）。
     * `providesFiles` 里的名字必须与 `discoverTools()` 查找的名字逐字相同，
     * 否则安装报成功、工具发现照样为 null。
     * 上游资产叫 `yt-dlp_linux`，落盘必须改名成 `yt-dlp` —— 这正是 `name` 字段的作用。
     */
    assert.deepEqual(pack.providesFiles, ['yt-dlp']);
    assert.equal(pack.files[0].name, 'yt-dlp');
    // 上游发布的是单个 PyInstaller 可执行文件，不是压缩包。解包语义必须为空，
    // 否则安装器会拿一个不是归档的文件去解压。
    assert.ok(!pack.files[0].unpack);
    assert.equal(pack.totalSizeBytes, pack.files[0].sizeBytes);
    assert.match(
      pack.files[0].mirrors[0].url,
      /^https:\/\/github\.com\/yt-dlp\/yt-dlp\/releases\/download\//,
      '来源必须是 yt-dlp 官方 GitHub Release（用户要求：写明从哪里下载）',
    );
    assert.ok(
      pack.files[0].mirrors[0].url.includes(pack.engineVersion),
      'URL 必须钉在声明的版本上',
    );
  });

  it('Windows 包给的是 yt-dlp.exe（平台名不同，找错名字就等于没装）', async () => {
    const v = validateBackendManifest(await readJson('backends.json'));
    assert.ok(v.ok);
    const packs = (v.data as { packs: BackendPack[] }).packs;
    const win = packs.find((p) => p.engine === 'yt-dlp' && p.os === 'win32');
    assert.ok(win);
    // discoverTools() 在 win32 上查的是 `yt-dlp.exe`。
    assert.deepEqual(win.providesFiles, ['yt-dlp.exe']);
    assert.equal(win.files[0].name, 'yt-dlp.exe');
  });

  /*
   * ★★ 这条是 ffmpeg 那次事故的直接守卫 ★★
   *
   * 两份清单分工不同、都必需，而**没有任何东西检查它们是否对得上**：
   *   · `components.json` 回答"这是什么、从哪来、钉在哪个版本"（`GET /api/components`）
   *   · `backends.json`   回答"怎么下载、校验什么摘要"（`POST /api/backends/install`，
   *      也是 `POST /api/components/:id/update` 唯一的安装通道）
   * 只写前者 → 组件页看得见、点安装拿到 409 `NO_INSTALL_CHANNEL`（ffmpeg 的原症状）。
   * 只写后者 → 装得上，但用户查不到来源与许可证。
   */
  it('components.json 里每个"要下载的"组件都在 backends.json 里有安装通道', async () => {
    const comps = (await readJson('components.json')) as {
      components: { id: string; category: string; sizeBytes: number; sha256: string }[];
    };
    const be = (await readJson('backends.json')) as { packs: { id: string }[] };
    const ext = (await readJson('sqlite-ext.json')) as { packs: { id: string }[] };
    const installable = new Set([...be.packs, ...ext.packs].map((p) => p.id));

    /*
     * 判据 = **这条组件自己声称有一份要下载的制品**（真 sha256 + 非零体积），
     * 而不是按 category 一刀切。
     *
     * 为什么不能按 category：`sherpa-onnx-node` 的 category 也是 `backend-pack`，
     * 但它是 **B 类 npm 依赖**（`packages/pipeline` 的 dependencies，pnpm 装的），
     * 清单里如实写着 `sha256: "n/a"` / `sizeBytes: 0` —— 它本来就不该有下载通道。
     * `model` 类走模型目录（`/api/models`），daemon 也明确回 409 说明过。
     *
     * 反过来，只要一条组件写了真摘要，它就是"我们要去下载的东西"，
     * 那就必须有地方下载 —— ffmpeg 那次缺的正是这一半。
     */
    const needsChannel = comps.components.filter(
      (c) => c.category !== 'model' && c.sha256 !== 'n/a' && c.sizeBytes > 0,
    );
    // 集合不能是空的，否则这条断言可以靠"一个都不匹配"永远通过。
    assert.ok(needsChannel.length >= 2, '筛选条件把所有组件都排除了，这条断言就失去意义了');
    for (const id of ['media-tools-linux-x64', 'ytdlp-linux-x64']) {
      assert.ok(
        needsChannel.some((c) => c.id === id),
        `${id} 应当落在被检查的集合里`,
      );
    }

    const orphans = needsChannel.filter((c) => !installable.has(c.id));
    assert.deepEqual(
      orphans.map((c) => c.id),
      [],
      `这些组件只在 components.json 里、没有安装通道，点「安装」会拿到 409：${orphans
        .map((c) => c.id)
        .join(', ')}`,
    );
  });

  it('yt-dlp 的来源链在组件页可见（用户明确要求写明从哪里下载）', async () => {
    const comps = (await readJson('components.json')) as {
      components: {
        id: string;
        category: string;
        pinnedVersion: string;
        provenance: { repoUrl: string; releaseUrl: string; license: string };
        sha256: string;
      }[];
    };
    const c = comps.components.find((x) => x.id === 'ytdlp-linux-x64');
    assert.ok(c, 'components.json 里没有 yt-dlp —— 组件页看不到它从哪来');
    assert.equal(c.provenance.repoUrl, 'https://github.com/yt-dlp/yt-dlp');
    assert.ok(c.provenance.releaseUrl.includes(c.pinnedVersion), '发布页链接必须指向钉定的版本');
    // ADR-002：官方 PyInstaller 二进制按 GPLv3+ 分发（仓库源码是 Unlicense，两者不是一回事）。
    assert.equal(c.provenance.license, 'GPL-3.0-or-later');

    // 两份清单的摘要必须一致 —— 不一致意味着用户看到的和实际下载的不是同一个文件。
    const be = (await readJson('backends.json')) as {
      packs: { id: string; files: { sha256: string; sizeBytes: number }[] }[];
    };
    const pack = be.packs.find((p) => p.id === c.id);
    assert.ok(pack);
    assert.equal(c.sha256, pack.files[0].sha256);
  });
});

/* ═══════════════ ②③ 装完之后：可执行位 + 扁平布局能被发现 ═══════════════ */

describe('T-132 ②③ 装上了要真的找得到', () => {
  it('扁平布局（by-name/backend/<name> 是文件）能被 findInBackendPacks 找到', async () => {
    const root = await tempDir('om-ytdlp-flat-');
    const dir = join(root, 'by-name', 'backend');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, YTDLP), '#!/bin/sh\necho 2026.07.04\n');
    await chmod(join(dir, YTDLP), 0o755);

    assert.equal(await findInBackendPacks(root, YTDLP), join(dir, YTDLP));
    // discoverTools 是产品真正调用的入口，一起钉住（只钉底层函数会漏掉装配错误）。
    const tools = await discoverTools({ storeRoot: root });
    assert.equal(tools.ytDlp, join(dir, YTDLP));
  });

  it('没有可执行位就不算找到（否则会拿一个 spawn 必然 EACCES 的路径去报绿）', async () => {
    const root = await tempDir('om-ytdlp-noexec-');
    const dir = join(root, 'by-name', 'backend');
    await mkdir(dir, { recursive: true });
    // 这正是 `linkByName` 硬链出来的默认状态：0644。
    await writeFile(join(dir, YTDLP), '#!/bin/sh\n', { mode: 0o644 });
    await chmod(join(dir, YTDLP), 0o644);

    if (process.platform === 'win32') {
      /*
       * ★ 允许的 skip，而且**理由是可检验的**：Windows 上根本不存在"没有可执行位"
       * 这个状态。D-11 §3.1 实测：`chmod(0o755)` 读回来仍是 `666`，
       * 而 `access(X_OK)` 对任何可读文件都返回 true —— `installer.ts:283-284`
       * 「Windows 跳过 chmod」的理由正是这条。
       *
       * 所以这里不 return 了事，而是**把那个前提本身钉住**：
       * 哪天 Windows 真的开始认可执行位，这两句会红，
       * 上面那段"理由"就会当场被推翻，而不是继续被下一个人当真。
       */
      await access(join(dir, YTDLP), constants.X_OK); // 不抛 = 前提成立
      assert.notEqual(
        await findInBackendPacks(root, YTDLP),
        null,
        'Windows 上 X_OK 恒真，所以它必然"找得到" —— 这正是上面那条 POSIX 性质无法成立的原因',
      );
      return;
    }

    assert.equal(await findInBackendPacks(root, YTDLP), null);
    assert.equal((await discoverTools({ storeRoot: root })).ytDlp, null);
  });

  it('嵌套归档布局没有因为新增扁平分支而失效', async () => {
    const root = await tempDir('om-ytdlp-nested-');
    const deep = join(root, 'by-name', 'backend', 'whisper-bin.tar.gz', 'whisper-bin', 'bin');
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'whisper-cli'), '#!/bin/sh\n');
    await chmod(join(deep, 'whisper-cli'), 0o755);
    assert.equal(await findInBackendPacks(root, 'whisper-cli'), join(deep, 'whisper-cli'));
    assert.equal(await findInBackendPacks(root, 'nope-cli'), null);
  });

  /*
   * ★ 走**真实安装器**，不是模拟。
   *
   * 只测「文件放对地方就找得到」会漏掉真正的缺口：安装器写出来的文件是 0644。
   * 所以这里起一个本地源、让 `install()` 真的下载 → 校验 sha256 → 硬链 → 授权，
   * 然后用产品的 `discoverTools()` 去找它。判据是**最终能不能用**，
   * 不是「安装返回成功」（那正是 ffmpeg 那次的假绿灯）。
   */
  it('install() 装一个 role=binary 的单文件包之后，discoverTools 能找到并且可执行', async () => {
    const body = Buffer.from('#!/bin/sh\necho 2026.07.04\n');
    const sha256 = createHash('sha256').update(body).digest('hex');

    const server: Server = createServer((_req, res) => {
      res.writeHead(200, {
        'content-length': String(body.length),
        'accept-ranges': 'bytes',
        'content-type': 'application/octet-stream',
      });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    try {
      const root = await tempDir('om-ytdlp-install-');
      const store = new ArtifactStore(join(root, 'models'));
      await store.init();

      const result = await install({
        store,
        target: {
          id: 'ytdlp-test',
          kind: 'backend',
          displayName: 'yt-dlp (test)',
          files: [
            {
              role: 'binary',
              // 清单里 win32 包给的就是 `yt-dlp.exe`（本文件第 ① 组已断言过这一点）
              name: YTDLP,
              sizeBytes: body.length,
              sha256,
              mirrors: [
                { provider: 'github', url: `http://127.0.0.1:${port}/yt-dlp`, official: true },
              ],
            },
          ],
        },
      });

      assert.equal(result.files.length, 1);
      const installed = result.files[0].path;
      // ① 真的可执行（不是"文件存在"——⑤A 规矩 7：断言钉后果）
      await access(installed, constants.X_OK);
      // ② 产品的工具发现真的能拿到它
      const tools = await discoverTools({ storeRoot: store.root });
      assert.equal(tools.ytDlp, installed);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

/* ═══════════════ ④ 装上了，产品路径也得真的走到它 ═══════════════ */

describe('T-132 ④ 站点提取器默认是开的', () => {
  it('不设环境变量 = 开（ADR-002 用户决定 2：粘贴链接即用）', () => {
    assert.equal(siteExtractorEnabled({}), true);
  });

  it('=0 才关（TD-002 的逃生口仍在，只是极性反过来）', () => {
    assert.equal(siteExtractorEnabled({ OPENMEMO_ENABLE_SITE_EXTRACTOR: '0' }), false);
    assert.equal(siteExtractorEnabled({ OPENMEMO_ENABLE_SITE_EXTRACTOR: '1' }), true);
    assert.equal(siteExtractorEnabled({ OPENMEMO_ENABLE_SITE_EXTRACTOR: '' }), true);
  });

  /*
   * 光有开关不够：要证明 registry 里**真的有这个适配器**，且它能报告自己可用。
   * 「装了 + 开关开着」→ 适配器出现在候选里；「没装」→ 不出现（也不假装出现）。
   */
  it('yt-dlp 装好且开关默认时，registry 里真的有它；没装则如实缺席', async () => {
    const root = await tempDir('om-ytdlp-registry-');
    const dir = join(root, 'by-name', 'backend');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, YTDLP), '#!/bin/sh\n');
    await chmod(join(dir, YTDLP), 0o755);
    const tools = await discoverTools({ storeRoot: root });

    const registry = buildDefaultRegistry({
      tools,
      cwd: root,
      allowedRoot: root,
      enableSiteExtractor: siteExtractorEnabled({}),
    });
    const ids = registry.list().map((s) => s.id);
    assert.ok(ids.includes('yt-dlp'), `站点提取器不在 registry 里：${ids.join(', ')}`);

    const off = buildDefaultRegistry({
      tools,
      cwd: root,
      allowedRoot: root,
      enableSiteExtractor: siteExtractorEnabled({ OPENMEMO_ENABLE_SITE_EXTRACTOR: '0' }),
    });
    assert.ok(!off.list().some((s) => s.id === 'yt-dlp'), '关掉之后不该还在');

    // 没装的时候：适配器仍注册，但 isAvailable() 必须如实说不可用（不许假装能用）。
    const bare = buildDefaultRegistry({
      tools: { ...tools, ytDlp: null },
      cwd: root,
      allowedRoot: root,
      enableSiteExtractor: true,
    });
    const src = bare.list().find((s) => s.id === 'yt-dlp');
    assert.ok(src);
    const availability = await src.isAvailable();
    assert.equal(availability.ok, false);
  });
});
