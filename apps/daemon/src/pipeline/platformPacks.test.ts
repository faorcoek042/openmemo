/**
 * T-146 回归守卫：**每个我们声称支持的平台，都必须能把"转写必需的东西"装齐。**
 *
 * ── 事故本体（2026-08-06 之前的真实状态） ─────────────────────────────────────
 *
 * `backends.json` 里 `engine === 'ffmpeg'` 的包**全仓只有一个**（`media-tools-linux-x64`）。
 * 而 Windows 那一格里躺着**两个**能装的 whisper.cpp 包（cpu 与 cuda 12.4）。
 * 于是 Windows 用户看到的是：
 *
 *     /runtime 页 → 「whisper.cpp · CPU 后端（Windows x64）」可点、可装、装完 succeeded
 *     自检       → tool.whisperCli ok
 *     实际转写   → 全废
 *
 * 因为 `packages/pipeline/src/transcribe.ts` 的**每一条**路径都要先
 * `normalizeToPcm16k` + `probeMedia`，两者都 spawn ffmpeg/ffprobe。
 * **引擎在、前置工具不在 —— 而界面上没有任何一处会说这件事。**
 *
 * macOS 更彻底：`ci-runner` 在 macos-26 runner 上屏蔽宿主 PATH 后实测
 * （D-11 §7.1），19 个包里只有 3 个适用于 macOS，ffmpeg / ffprobe / whisper-cli
 * **三个全部解析到了假二进制** —— 也就是说产品会**安静地借用宿主的 Homebrew ffmpeg**，
 * 自检给的是 `warn` 不是 `fail`。用户换一台没装 Homebrew 的 Mac，同一个版本就不工作了，
 * 而中间什么都没变过。
 *
 * ── 这个文件钉的四条 ─────────────────────────────────────────────────────────
 *
 *   ① 有 ASR 引擎的平台**必须**有 ffmpeg —— 判据是后果（转写能不能跑），不是包的数量
 *   ② `providesFiles` 的名字必须与 `discoverTools()` 在该平台查找的名字逐字相同
 *      （win32 上是 `ffmpeg.exe`；名字差一个后缀 = 装成功 + 永远找不到）
 *   ③ **两份清单双向对齐** —— T-132 只查了 components → backends 一个方向，
 *      `platform` T-141 §3 实测反方向有 20 个包在 `components.json` 里一条都没有：
 *      「一个 Mac / Windows 用户打开「组件与来源」页，他自己那台机器上要装的每一个组件，
 *        来源与许可证一条都查不到」。这条守卫补上反方向。
 *   ④ 下载地址必须钉在声明的版本上（结构断言：URL 里必须出现 pinned 的那个 tag）
 *
 * 反向验证（撤掉条目 → 变红）的真实输出贴在 `coordination/inbox/pack-publish.md`。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { coreMlEncoderNameFor } from '@openmemo/runtime';
import { validateBackendManifest, type BackendPack } from '@openmemo/shared';

/** 仓库根 —— dist/pipeline/ 上溯 4 层。 */
const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'));
const MANIFEST_DIR = join(REPO_ROOT, 'vendor', 'manifests');

const readJson = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(join(MANIFEST_DIR, name), 'utf8'));

interface PackLike {
  id: string;
  engine: string;
  os: string;
  arch: string;
  availability?: string;
  providesFiles: string[];
  engineVersion: string;
  files: { name: string; sha256: string; sizeBytes: number; mirrors: { url: string }[] }[];
}

async function backendPacks(): Promise<BackendPack[]> {
  const v = validateBackendManifest(await readJson('backends.json'));
  assert.equal(v.ok, true, v.ok ? '' : v.errors.slice(0, 5).join('\n'));
  assert.ok(v.ok);
  return (v.data as { packs: BackendPack[] }).packs;
}

/**
 * `discoverTools()` 在 win32 上查的是 `<name>.exe`（`packages/pipeline/src/tools.ts` 的
 * `exe()`）。这里复刻同一条规则，而不是把期望值抄成字面量 —— 抄字面量的话，
 * 产品那边改了规则这里不会红。
 */
const exeName = (os: string, name: string): string => (os === 'win32' ? `${name}.exe` : name);

/* ═════════ ① 有引擎就必须有 ffmpeg：判据是"能不能转写"，不是"有几个包" ═════════ */

describe('T-146 ① 每个有 ASR 引擎的平台都必须能装到 ffmpeg', () => {
  it('backends.json 通过 schema 校验', async () => {
    const packs = await backendPacks();
    assert.ok(packs.length >= 8, '目录里包太少，后面的断言会失去意义');
  });

  it('★ 任何一个能装 whisper.cpp 的平台，同一个平台必须也能装 ffmpeg', async () => {
    const packs = await backendPacks();
    const key = (p: BackendPack): string => `${p.os}/${p.arch}`;

    const withEngine = new Set(
      packs.filter((p) => p.engine === 'whisper.cpp' && p.availability === 'published').map(key),
    );
    const withFfmpeg = new Set(
      packs.filter((p) => p.engine === 'ffmpeg' && p.availability === 'published').map(key),
    );

    /*
     * 集合非空守卫：`node --test` 对空集返回绿，一条筛空了的断言等于没写。
     * ⚠️ **只守 `withEngine`，不守 `withFfmpeg`** —— 第一版两个都守，反向验证时
     * 先炸的是「有 ffmpeg 的平台只有 1 个」，而真正该说的那句
     * 「这些平台有转写引擎但装不到 ffmpeg」**一个字都没印出来**。
     * 守卫的作用是防止空集假绿，`withFfmpeg` 变空恰恰是本条要报告的**内容**，不是前提。
     */
    assert.ok(withEngine.size >= 2, `有引擎的平台只有 ${withEngine.size} 个，断言失去意义`);

    const stranded = [...withEngine].filter((k) => !withFfmpeg.has(k)).sort();
    assert.deepEqual(
      stranded,
      [],
      `这些平台有转写引擎但装不到 ffmpeg —— 装完自检会绿，转写会全废（transcribe.ts 每条路径都要 normalizeToPcm16k + probeMedia）：${stranded.join(', ')}`,
    );
  });

  it('ffmpeg 包必须同时提供 ffmpeg 与 ffprobe（少一个都不够）', async () => {
    const packs = await backendPacks();
    const ff = packs.filter((p) => p.engine === 'ffmpeg');
    assert.ok(ff.length >= 3, `ffmpeg 包只有 ${ff.length} 个`);
    for (const p of ff) {
      /*
       * ffprobe 不是可有可无：D-01 §8.5 要求真实媒体类型只能来自 ffprobe（不能信扩展名
       * 或 Content-Type），而 T-026 那个安全修复靠 ffprobe 的 `format_name` 认出被改名的
       * `.m3u8`。当年否掉 `ffmpeg-static` 的唯一理由就是它只有 ffmpeg 没有 ffprobe。
       */
      assert.ok(
        p.providesFiles.includes(exeName(p.os, 'ffmpeg')),
        `${p.id} 的 providesFiles 里没有 ${exeName(p.os, 'ffmpeg')}`,
      );
      assert.ok(
        p.providesFiles.includes(exeName(p.os, 'ffprobe')),
        `${p.id} 的 providesFiles 里没有 ${exeName(p.os, 'ffprobe')}`,
      );
    }
  });
});

/* ═════════ ② 名字必须与工具发现查的一致；地址必须钉在声明的版本上 ═════════ */

describe('T-146 ② 新增的平台包本身是可安装的', () => {
  it('Windows x64 的 ffmpeg 来自我们已经钉住的那个 BtbN tag', async () => {
    const packs = await backendPacks();
    const p = packs.find((x) => x.engine === 'ffmpeg' && x.os === 'win32' && x.arch === 'x64');
    assert.ok(p, 'backends.json 里没有 win32/x64 的 ffmpeg 包 —— Windows 上转写全废');
    assert.equal(p.availability, 'published');
    const f = p.files[0];
    assert.ok(f && f.mirrors.length > 0, '没有下载地址');
    assert.match(f.sha256, /^[a-f0-9]{64}$/);
    assert.equal(p.totalSizeBytes, f.sizeBytes);
    assert.deepEqual(p.providesFiles, ['ffmpeg.exe', 'ffprobe.exe']);
    assert.match(
      f.mirrors[0].url,
      /^https:\/\/github\.com\/BtbN\/FFmpeg-Builds\/releases\/download\//,
      '来源必须写明（用户要求）',
    );
    /*
     * ★ 与 Linux 包**同一个不可变 tag**。这条不是洁癖：BtbN 的 `latest` 是移动 tag，
     * 钉在同一个日期 tag 上，两个平台的 ffmpeg 才是同一次上游构建。
     */
    const linux = packs.find((x) => x.engine === 'ffmpeg' && x.os === 'linux');
    assert.ok(linux);
    const tagOf = (u: string): string => u.split('/releases/download/')[1]?.split('/')[0] ?? '';
    assert.equal(tagOf(f.mirrors[0].url), tagOf(linux.files[0].mirrors[0].url));
  });

  it('macOS Apple Silicon 的 ffmpeg 有地址、有摘要、钉在声明的版本上', async () => {
    const packs = await backendPacks();
    const p = packs.find((x) => x.engine === 'ffmpeg' && x.os === 'darwin' && x.arch === 'arm64');
    assert.ok(p, 'backends.json 里没有 darwin/arm64 的 ffmpeg 包');
    assert.equal(p.availability, 'published');
    const f = p.files[0];
    assert.ok(f && f.mirrors.length > 0);
    assert.match(f.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(p.providesFiles, ['ffmpeg', 'ffprobe']);
    // 结构断言：URL 里必须出现 engineVersion，换一个 tag 就当场红。
    assert.ok(
      f.mirrors[0].url.includes(p.engineVersion),
      `URL 没有钉在声明的版本 ${p.engineVersion} 上：${f.mirrors[0].url}`,
    );
    /*
     * `requiresDriver.macosVersion` 不是抄的：本机解析该 Mach-O 的 LC_BUILD_VERSION
     * 得到 minos = 12.0。emit-pack-manifest 的规矩是「没测过写 null」，测过就写。
     */
    assert.equal(p.requiresDriver?.macosVersion, '12.0');
  });
});

/* ═════════ ③ 两份清单双向对齐（T-132 只做了一个方向） ═════════ */

describe('T-146 ③ backends/sqlite-ext → components 反方向也必须齐', () => {
  it('★ 每个可下载的包都必须在 components.json 里查得到来源与许可证', async () => {
    const be = (await readJson('backends.json')) as { packs: PackLike[] };
    const ext = (await readJson('sqlite-ext.json')) as { packs: PackLike[] };
    const comps = (await readJson('components.json')) as { components: { id: string }[] };
    const documented = new Set(comps.components.map((c) => c.id));

    /*
     * `pending-ci` 的包**刻意排除**：它是"构建出来了但还没有下载地址"的诚实状态
     * （`BackendManifestSchema` 的 superRefine 允许它 `mirrors: []`，前端会禁用安装按钮）。
     * 一个用户下不下来的东西不该出现在「组件与来源」页上。
     */
    const publishable = [...be.packs, ...ext.packs].filter((p) => p.availability !== 'pending-ci');
    assert.ok(publishable.length >= 15, `可下载的包只有 ${publishable.length} 个，断言失去意义`);

    const undocumented = publishable.filter((p) => !documented.has(p.id)).map((p) => p.id).sort();
    assert.deepEqual(
      undocumented,
      [],
      `这些包装得上、但用户在「组件与来源」页查不到它从哪来、什么许可证（ADR-001 可追溯性）：${undocumented.join(', ')}`,
    );
  });

  it('两份清单里同一个 id 的体积与摘要必须一致（两处描述同一个东西）', async () => {
    const be = (await readJson('backends.json')) as { packs: PackLike[] };
    const ext = (await readJson('sqlite-ext.json')) as { packs: PackLike[] };
    const comps = (await readJson('components.json')) as {
      components: { id: string; sizeBytes: number; sha256: string }[];
    };
    const byId = new Map(comps.components.map((c) => [c.id, c]));

    let checked = 0;
    for (const p of [...be.packs, ...ext.packs]) {
      const c = byId.get(p.id);
      if (!c) continue;
      const f = p.files[0];
      assert.equal(c.sizeBytes, f.sizeBytes, `${p.id} 两份清单的体积对不上`);
      assert.equal(c.sha256, f.sha256, `${p.id} 两份清单的 sha256 对不上`);
      checked += 1;
    }
    // 数了几个就说几个 —— 零个也能"全部通过"，那正是 C5 修掉的那种守卫。
    assert.ok(checked >= 15, `只核对了 ${checked} 个，说明两边几乎没有交集`);
  });
});

/* ═════════ ④ CoreML / ANE：路径规则必须与 whisper.cpp 自己算的一致 ═════════ */

describe('T-146 ④ CoreML encoder 的路径规则', () => {
  /*
   * `whisper-cli` **不接受**一个 `.mlmodelc` 路径参数 —— 它自己从 `-m` 那个 `.bin`
   * 推出来（`vendor/whisper.cpp/src/whisper.cpp:3326-3348`）。
   * 也就是说：文件名差一个字，ANE 就静默不生效，而且 `--no-prints` 把那行 ERROR 关掉了
   * （`examples/cli/cli.cpp:1039-1040`）。所以这条规则必须被钉住。
   */
  it('复刻上游规则：去扩展名 → 去 -qX_X → 加 -encoder.mlmodelc', () => {
    assert.equal(coreMlEncoderNameFor('ggml-large-v3.bin'), 'ggml-large-v3-encoder.mlmodelc');
    // ★ 量化档位会被剥掉 —— 这是上游**显式支持**「量化模型配 CoreML」的地方。
    assert.equal(
      coreMlEncoderNameFor('ggml-large-v3-turbo-q5_0.bin'),
      'ggml-large-v3-turbo-encoder.mlmodelc',
    );
    assert.equal(coreMlEncoderNameFor('ggml-tiny-q8_0.bin'), 'ggml-tiny-encoder.mlmodelc');
    // `.en` 里的点不是扩展名分隔符之外的东西；`-base.en` 长度不是 5，不该被当成量化后缀。
    assert.equal(coreMlEncoderNameFor('ggml-base.en-q5_1.bin'), 'ggml-base.en-encoder.mlmodelc');
    assert.equal(coreMlEncoderNameFor('ggml-base.en.bin'), 'ggml-base.en-encoder.mlmodelc');
  });

  it('★ 清单里每个 coreml-encoder 文件名，必须正好是 whisper 会去找的那个', async () => {
    const wm = (await readJson('models-whisper.json')) as {
      models: { id: string; files: { role: string; name: string }[] }[];
    };
    let checked = 0;
    for (const m of wm.models) {
      const weights = m.files.find((f) => f.role === 'weights');
      const coreml = m.files.find((f) => f.role === 'coreml-encoder');
      if (!weights || !coreml) continue;
      // 清单里是 `<name>.zip`，解出来才是目录。
      assert.match(coreml.name, /\.mlmodelc\.zip$/, `${m.id} 的 coreml 文件名不像 mlmodelc 归档`);
      assert.equal(
        coreml.name.replace(/\.zip$/, ''),
        coreMlEncoderNameFor(weights.name),
        `${m.id}：装上去 whisper 也找不到 —— 它会去找 ${coreMlEncoderNameFor(weights.name)}`,
      );
      checked += 1;
    }
    // 数了几个说几个：零个也能"全部通过"，那正是要避免的空集假绿。
    assert.ok(checked >= 2, `只核对了 ${checked} 个 coreml-encoder 条目`);
  });
});
