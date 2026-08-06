/**
 * `runSelfCheck` —— T-119 同源化的回归测试。
 *
 * 这里守的不是"某条检查算得对不对"，而是**两个出口不会再分叉**：
 *   1. 探针给不出答案时，检查项**照常出现**（只是报 warn）。
 *      少一条就意味着 CLI 与端点的 id 集合可能不同 —— 那正是
 *      "网页绿 ≠ CLI 绿" 的直接成因，而两边都自称"自检"。
 *   2. `diffSelfCheckReports` 真的抓得到漂移。
 *      如果它恒返回空数组，那句"24 项逐 id 一致"就是句空话，
 *      而空话式的绿灯比没有绿灯更危险。
 *   3. 判据不许降级成"文件在不在"：分词器测的是**那四个词能不能命中**。
 *
 * Run: node --test packages/runtime/dist/selfcheck.test.js
 */
import assert from 'node:assert/strict';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { GGML_FILE_MAGIC } from '@openmemo/downloader';

import {
  checkBackendSymlinks,
  diffSelfCheckReports,
  runSelfCheck,
  type SelfCheckProbes,
  type SelfCheckReport,
} from './selfcheck.js';

const BASE = {
  dataDir: '/nonexistent/data',
  storeRoot: '/nonexistent/data/models',
  extensionsDir: '/nonexistent/data/bin/ext',
};

/** 只实现"必答"的六个探针；四类新检查故意不给，用来验证它们仍然出现。 */
function minimalProbes(over: Partial<SelfCheckProbes> = {}): SelfCheckProbes {
  return {
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
    chineseSearch: () => Promise.resolve(null),
    vecVersion: () => Promise.resolve(null),
    engines: () => Promise.resolve([]),
    selectFor: () => Promise.resolve(null),
    ...over,
  };
}

const idsOf = (r: SelfCheckReport): string[] => r.results.map((x) => x.id);
const byId = (r: SelfCheckReport, id: string) => r.results.find((x) => x.id === id);

/* ---- T-128 用的临时后端目录 -------------------------------------------------------- */

const tmpRoots: string[] = [];
after(async () => {
  for (const d of tmpRoots) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/**
 * 造一个 `<storeRoot>/by-name/backend/<pack>/` —— **两级相对链**，
 * 与 whisper.cpp 官方 tarball 的形状一致（`.so → .so.1 → .so.1.9.1`）。
 */
async function seedBackend(opts: { broken: boolean }): Promise<string> {
  const storeRoot = mkdtempSync(join(tmpdir(), 'om-sc-so-'));
  tmpRoots.push(storeRoot);
  const pack = join(storeRoot, 'by-name', 'backend', 'whisper-bin-ubuntu-x64');
  await fs.mkdir(pack, { recursive: true });
  // 真 ELF 魔数：判据要读到内容，就得有内容可读
  await fs.writeFile(join(pack, 'libwhisper.so.1.9.1'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]));
  await fs.symlink('libwhisper.so.1.9.1', join(pack, 'libwhisper.so.1'));
  await fs.symlink('libwhisper.so.1', join(pack, 'libwhisper.so'));
  if (opts.broken) {
    // 精确复现事故形态：链接被改写成指向一个**已经不存在的旧数据目录**
    await fs.unlink(join(pack, 'libwhisper.so.1'));
    await fs.symlink('/tmp/om-gone/models/by-name/backend/x/libwhisper.so.1.9.1', join(pack, 'libwhisper.so.1'));
  }
  return storeRoot;
}

describe('检查项集合稳定（两个出口不会分叉）', () => {
  it('四类新检查在探针缺席时仍然出现，只是报"未探测"', async () => {
    const r = await runSelfCheck({ ...BASE, probes: minimalProbes() });
    for (const id of [
      'hw.os',
      'hw.cpu',
      'hw.memory',
      'hw.probe',
      'llm.tier1',
      'llm.tier2',
      'datadir.assetsContained',
      'datadir.assetsPresent',
      'proxy.config',
      'proxy.ffmpeg',
    ]) {
      assert.ok(idsOf(r).includes(id), `缺了 ${id} —— 两个出口的 id 集合就会不一致`);
    }
    // 硬件这三条 runtime 自己就能答，不需要注入
    assert.equal(byId(r, 'hw.os')?.status, 'ok');
    // 需要注入的那些如实说"没测"，而不是消失、也不是假装通过
    assert.equal(byId(r, 'hw.probe')?.status, 'warn');
    assert.match(byId(r, 'llm.tier1')?.detail ?? '', /未探测/);
    assert.equal(byId(r, 'datadir.assetsContained')?.status, 'warn');
  });

  it('探针全给和全不给，id 集合完全一样', async () => {
    const bare = await runSelfCheck({ ...BASE, probes: minimalProbes() });
    const full = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({
        probePath: () => Promise.resolve(null),
        mediaAssets: () => Promise.resolve([]),
        localLlmServices: () => Promise.resolve([]),
        llmKeyConfig: () => Promise.resolve({ providerId: null, hasKey: false }),
        proxy: () =>
          Promise.resolve({ mode: 'system', activeUrl: null, ffmpegSupported: true, ffmpegReason: null }),
      }),
    });
    assert.deepEqual(idsOf(bare), idsOf(full));
  });

  it('proxyTest 关闭时不产生 proxy.connectivity —— 自检必须能离线跑完', async () => {
    let called = 0;
    const probes = minimalProbes({
      proxy: () =>
        Promise.resolve({ mode: 'system', activeUrl: null, ffmpegSupported: true, ffmpegReason: null }),
      proxyConnectivity: () => {
        called += 1;
        return Promise.resolve({ ok: true, probes: [] });
      },
    });
    const off = await runSelfCheck({ ...BASE, probes });
    assert.ok(!idsOf(off).includes('proxy.connectivity'));
    assert.equal(called, 0, '没要求就不许真发外网请求');

    const on = await runSelfCheck({ ...BASE, probes, proxyTest: true });
    assert.ok(idsOf(on).includes('proxy.connectivity'));
    assert.equal(called, 1);
  });
});

describe('判据没有被降级成"文件在不在"', () => {
  it('分词器测的是那四个词能不能命中，命中 0 就是 fail', async () => {
    const miss = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({
        // 扩展"加载成功"了，但一个词都切不出来 —— 正是 trigram 退化的样子
        chineseSearch: () => Promise.resolve({ 用户: 0, 推特: 0, 中国: 0, 服务: 0 }),
      }),
    });
    const c = byId(miss, 'ext.chineseSearch');
    assert.equal(c?.status, 'fail');
    assert.equal(c?.required, true);
    assert.match(c?.remediation ?? '', /trigram/);

    const hit = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({
        chineseSearch: () => Promise.resolve({ 用户: 1, 推特: 2, 中国: 1, 服务: 2 }),
      }),
    });
    assert.equal(byId(hit, 'ext.chineseSearch')?.status, 'ok');
  });

  it('by-name/asr 里只有 VAD 模型 ≠ ASR 就绪', async () => {
    const r = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({
        installed: (kind) =>
          Promise.resolve(kind === 'asr' ? ['ggml-silero-v6.2.0.bin'] : []),
      }),
    });
    const m = byId(r, 'model.asr');
    assert.equal(m?.status, 'fail', '把 VAD 当 ASR 报绿就是假绿灯');
    assert.match(m?.detail ?? '', /非 ASR 角色/);
  });

  /*
   * ★ T-148 —— 这一条以前查的是 `access(R_OK)`：**"有没有一个文件"**。
   *
   * `by-name/asr` 里合法地同时躺着 whisper.cpp 的 ggml 权重与 sherpa 的
   * `silero_vad.onnx`，两者互相加载不了。存在性检查对二者一视同仁，于是
   * daemon 把 ONNX 交给 whisper、整单转写死掉的同时，这条自检是 **ok**
   * （`[CI 实测]` cold-start-audit run 31039460495）。
   *
   * 判据现在是「whisper.cpp 真的加载得了吗」—— 读头四字节比 ggml 魔数，
   * 与 `whisper_vad_init_with_params` 的第一步逐字对应。
   */
  describe('★ model.vad 判的是"whisper.cpp 加载得了吗"，不是"文件在不在"', () => {
    const seedVad = async (
      name: string,
      bytes: Buffer,
    ): Promise<string> => {
      const d = mkdtempSync(join(tmpdir(), 'om-sc-vad-'));
      tmpRoots.push(d);
      await fs.writeFile(join(d, name), bytes);
      return join(d, name);
    };
    const ggmlMagic = ((): Buffer => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(GGML_FILE_MAGIC, 0);
      return b;
    })();
    const vadCheck = async (vadModel: string | null, asrBucket: string[] = []) =>
      byId(
        await runSelfCheck({
          ...BASE,
          probes: minimalProbes({
            tools: () =>
              Promise.resolve({
                ffmpeg: null,
                ffprobe: null,
                whisperCli: null,
                whisperVad: null,
                vadModel,
                ytDlp: null,
              }),
            installed: (kind) => Promise.resolve(kind === 'asr' ? asrBucket : []),
          }),
        }),
        'model.vad',
      );

    it('★ 文件在、但不是 ggml → fail（旧判据在这里给的是 ok）', async () => {
      // ONNX 是 protobuf，头一字节是字段 tag 0x08
      const onnx = await seedVad('silero_vad.onnx', Buffer.from([0x08, 0x07, 0x12, 0x0c]));
      const c = await vadCheck(onnx);
      assert.equal(c?.status, 'fail', '存在性检查会把它读成 ok —— 那正是事故那天的样子');
      assert.match(c?.detail ?? '', /bad magic|ggml/);
    });

    it('★ 是 ggml → ok', async () => {
      const good = await seedVad('ggml-silero-v6.2.0.bin', Buffer.concat([ggmlMagic, Buffer.alloc(32)]));
      const c = await vadCheck(good);
      assert.equal(c?.status, 'ok');
      assert.equal(c?.detail, good);
    });

    it('★ 解析器已经拒绝交出坏文件时，仍要说清"你装的那个 whisper 用不了"', async () => {
      // 修复后的真实状态：tools.vadModel = null，而 by-name/asr 里那份 ONNX 还在
      const c = await vadCheck(null, ['silero_vad.onnx', 'ggml-tiny-q5_1.bin']);
      assert.equal(c?.status, 'warn');
      assert.match(c?.detail ?? '', /silero_vad\.onnx/);
      assert.match(c?.remediation ?? '', /silero-vad-ggml/);
    });

    it('一个 VAD 都没装 → warn，且**不能**说成"装了个用不了的"（那是假红灯）', async () => {
      const c = await vadCheck(null, ['ggml-tiny-q5_1.bin']);
      assert.equal(c?.status, 'warn');
      assert.match(c?.detail ?? '', /未安装/);
    });
  });

  it('资产路径逃出 dataDir = fail（搬家后会取不到）', async () => {
    const r = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({
        mediaAssets: () =>
          Promise.resolve([
            { role: 'original', relPath: 'a.wav' },
            { role: 'audio16k', relPath: '/somewhere/else/tmp/job-1/audio16k.wav' },
          ]),
      }),
    });
    const d = byId(r, 'datadir.assetsContained');
    assert.equal(d?.status, 'fail');
    assert.equal(d?.required, true);
    assert.match(d?.detail ?? '', /1\/2/);
  });
});

/* ---- T-136：datadir.assetsPresent ---------------------------------------------------- */

/**
 * 造一个**状态已知**的数据目录：哪几条真在、哪几条真不在，由这里说了算。
 * 每份内容都不同 —— 报告里给的"首 4 字节"因此可以反查它到底读的是哪个文件。
 */
async function seedDataDir(files: Record<string, string>): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), 'om-sc-assets-'));
  tmpRoots.push(d);
  await fs.mkdir(join(d, 'media'), { recursive: true });
  await fs.mkdir(join(d, 'tmp'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(d, rel);
    await fs.mkdir(join(abs, '..'), { recursive: true });
    await fs.writeFile(abs, body);
  }
  return d;
}

const assetsPresent = async (
  dataDir: string,
  rows: Array<{ role: string; relPath: string }>,
): Promise<ReturnType<typeof byId>> => {
  const r = await runSelfCheck({
    ...BASE,
    dataDir,
    probes: minimalProbes({ mediaAssets: () => Promise.resolve(rows) }),
  });
  return byId(r, 'datadir.assetsPresent');
};

describe('★ T-136 datadir.assetsPresent —— 报出来的必须**就是**那几条，不多不少', () => {
  it('★ 三种历史路径形态都算"在"，缺的那条才报 —— 一条不多一条不少', async () => {
    /*
     * 这就是用户库的形状：`rel_path` 三种约定并存。
     * 旧实现只拿 `<dataDir>/media` 一个基准去拼，于是把**存在的 3 条报成"已不存在"**，
     * 而真正缺的那条一个字没提 —— 红灯指错了人。
     */
    const d = await seedDataDir({
      'media/N1/audio16k.wav': 'AAAA', // 相对 media 根
      'media/legacy/job-X-audio16k.wav': 'BBBB', // 相对 dataDir
      'jfk.wav': 'CCCC', // 裸文件名，文件在 dataDir 根上
    });
    const present = [
      { role: 'audio16k', relPath: 'N1/audio16k.wav' },
      { role: 'audio16k', relPath: 'media/legacy/job-X-audio16k.wav' },
      { role: 'original', relPath: 'jfk.wav' },
    ];
    const missing = [
      { role: 'original', relPath: 'really-gone.wav' },
      { role: 'original', relPath: 'also-gone.wav' },
    ];
    const c = await assetsPresent(d, [...present, ...missing]);

    assert.equal(c?.status, 'warn');
    assert.match(c?.detail ?? '', /^2\/5 /, `应当只报 2 条，实际：${c?.detail ?? ''}`);
    // 报出来的**就是**缺的那两条
    for (const m of missing) {
      assert.equal(
        (c?.detail ?? '').includes(m.relPath),
        true,
        `真缺的 ${m.relPath} 没被报出来：${c?.detail ?? ''}`,
      );
    }
    // 在盘上的一条都不许出现在告警里 —— 这正是 T-136 那盏假红灯
    for (const p of present) {
      assert.equal(
        (c?.detail ?? '').includes(p.relPath),
        false,
        `${p.relPath} 明明在盘上却被报成读不到：${c?.detail ?? ''}`,
      );
    }
  });

  it('★ 读不到时必须列出**找过哪些位置**，且不许断言"文件已被删除"', async () => {
    const d = await seedDataDir({});
    const c = await assetsPresent(d, [{ role: 'original', relPath: 'gone.wav' }]);
    assert.equal(c?.status, 'warn');
    for (const root of [join(d, 'media'), join(d, 'tmp'), d]) {
      assert.equal(
        (c?.detail ?? '').includes(join(root, 'gone.wav')),
        true,
        `没说试过 ${join(root, 'gone.wav')}：${c?.detail ?? ''}`,
      );
    }
    /*
     * 旧文案是「对应的媒体文件已被删除，相关笔记无法回放」——
     * 一句**说错了的红灯**：用户会去翻备份、会怀疑自己清理过什么。
     * 这里钉的是"不许再出现这种断言"。
     */
    assert.equal(/已被删除/.test(c?.remediation ?? ''), false, c?.remediation ?? '');
  });

  it('★ 全都读得到 → ok，且 detail 里带**真读到的首 4 字节**（可核对的证据）', async () => {
    const d = await seedDataDir({ 'media/a.wav': 'WXYZ' });
    const c = await assetsPresent(d, [{ role: 'original', relPath: 'a.wav' }]);
    assert.equal(c?.status, 'ok');
    assert.equal(
      (c?.detail ?? '').includes(Buffer.from('WXYZ').toString('hex')),
      true,
      `没有可核对的证据：${c?.detail ?? ''}`,
    );
  });

  it('★ 悬空符号链接要报 —— lstat 会说它存在，open 不会（T-128 同一条判据）', async () => {
    const d = await seedDataDir({});
    await fs.symlink(join(d, 'media', 'nope.wav'), join(d, 'media', 'dangling.wav'));
    const c = await assetsPresent(d, [{ role: 'original', relPath: 'dangling.wav' }]);
    assert.equal(c?.status, 'warn');
    assert.equal((c?.detail ?? '').includes('dangling.wav'), true);
  });

  it('★ 0 字节的资产要报：文件"在"但播不了，绿灯等于撒谎', async () => {
    const d = await seedDataDir({ 'media/empty.wav': '' });
    const c = await assetsPresent(d, [{ role: 'original', relPath: 'empty.wav' }]);
    assert.equal(c?.status, 'warn');
    assert.equal((c?.detail ?? '').includes('0 字节'), true, c?.detail ?? '');
  });

  it('越界的那条只记"越界"，不重复算成"读不到"', async () => {
    const d = await seedDataDir({ 'media/a.wav': 'AAAA' });
    const c = await assetsPresent(d, [
      { role: 'original', relPath: 'a.wav' },
      { role: 'audio16k', relPath: '/somewhere/else/x.wav' },
    ]);
    assert.equal(c?.status, 'ok', `越界应由 assetsContained 负责报：${c?.detail ?? ''}`);
  });

  it('没有资产 → ok', async () => {
    const d = await seedDataDir({});
    assert.equal((await assetsPresent(d, []))?.status, 'ok');
  });

  /**
   * ★ T-143 ①：**顺着符号链接出界的那条，必须算「越界」，不能算「读不到」。**
   *
   * 判错这一档的后果是本项目定义的最贵那种假红灯（⑤A-20）：
   * `assetsContained` 会一边报「N 条资产全部落在 dataDir 内」，一边指着一条
   * 指向 `/etc` 的软链 —— **结论对、理由假**，而理由假的告警最难被推翻。
   */
  it('★ 根内的软链指向根外 → assetsContained 必须报 fail，不许说"全部落在 dataDir 内"', async () => {
    const d = await seedDataDir({ 'media/a.wav': 'AAAA' });
    const outside = mkdtempSync(join(tmpdir(), 'om-sc-OUTSIDE-'));
    tmpRoots.push(outside);
    await fs.writeFile(join(outside, 'secret.txt'), 'SECRET-OUTSIDE');
    await fs.symlink(join(outside, 'secret.txt'), join(d, 'media', 'escape.wav'));

    const r = await runSelfCheck({
      ...BASE,
      dataDir: d,
      probes: minimalProbes({
        mediaAssets: () =>
          Promise.resolve([
            { role: 'original', relPath: 'a.wav' },
            { role: 'audio16k', relPath: 'escape.wav' },
          ]),
      }),
    });

    const contained = byId(r, 'datadir.assetsContained');
    assert.equal(contained?.status, 'fail', `软链出界必须算越界：${contained?.detail ?? ''}`);
    assert.equal(
      (contained?.detail ?? '').includes('escape.wav'),
      true,
      `必须点名是哪一条：${contained?.detail ?? ''}`,
    );
    // 越界的那条不许再被 assetsPresent 重复算成"读不到"以外的东西：
    // 它确实读不到（这是对的），但**证据不许包含根外文件的内容**
    const present = byId(r, 'datadir.assetsPresent');
    assert.equal(
      (present?.detail ?? '').includes('SECRET'),
      false,
      '根外内容不许出现在自检报告里',
    );
  });
});

/*
 * ★ T-147：这一组以前把 `/usr/bin/env` 当成"一个一定存在且可执行的文件"。
 *
 * 那是**宿主假设**，不是产品性质。`selfcheck.ts:398` 的判据是
 * `access(path, X_OK)` —— Windows 上 `D:\usr\bin\env` 不存在，于是两条都得到
 * `未找到 / fail`：`[CI 实测]` ci-crossplatform run 31017923588，win32/x64 上
 * `'fail' !== 'ok'` 与 `'fail' !== 'warn'` 就是这两条。
 *
 * 修法不是 skip，是**自己造那个文件**：判据要分的是「路径在不在 storeRoot 里」，
 * 文件从哪来根本不重要 —— 以前借宿主的，纯粹是图省事。
 * 造出来之后这两条在三个平台上测的是同一件事。
 */
describe('工具来源要分开：装在 dataDir 里 vs 借系统 PATH 的', () => {
  /**
   * 造一个真实存在、且**真的有可执行位**的假工具。
   *
   * `chmod(0o755)` 在 Windows 上读回来仍是 `666`（D-11 §3.1 实测），
   * 但那里 `access(X_OK)` 对任何可读文件都返回 true（同表），
   * 所以两边都能满足 `selfcheck.ts` 的 `exists(path, X_OK)` —— 判据成立的**理由**
   * 各平台不同，而这条用例要钉的性质（ok vs warn 取决于路径落在哪儿）是同一个。
   */
  async function fakeTool(dir: string): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    const p = join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    await fs.writeFile(p, '#!/bin/sh\nexit 0\n');
    await fs.chmod(p, 0o755);
    return p;
  }

  const withFfmpeg = (ffmpeg: string): Partial<SelfCheckProbes> => ({
    tools: () =>
      Promise.resolve({
        ffmpeg,
        ffprobe: null,
        whisperCli: null,
        whisperVad: null,
        vadModel: null,
        ytDlp: null,
      }),
  });

  it('从 storeRoot 里解析出来 = ok', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'om-sc-store-'));
    tmpRoots.push(storeRoot);
    const tool = await fakeTool(join(storeRoot, 'by-name', 'backend', 'media-tools'));

    const r = await runSelfCheck({ ...BASE, storeRoot, probes: minimalProbes(withFfmpeg(tool)) });
    const t = byId(r, 'tool.ffmpeg');
    assert.equal(t?.status, 'ok', `装在 storeRoot 里的工具必须算 ok：${t?.detail ?? ''}`);
    assert.equal(t?.required, true);
  });

  it('只在系统 PATH 上 = warn，且不再算必需项（能跑，但不可分发）', async () => {
    // 关键是这个文件**在 storeRoot 之外** —— 与它具体在哪个目录无关
    const outside = mkdtempSync(join(tmpdir(), 'om-sc-hostpath-'));
    tmpRoots.push(outside);
    const tool = await fakeTool(outside);
    const storeRoot = mkdtempSync(join(tmpdir(), 'om-sc-store-'));
    tmpRoots.push(storeRoot);
    // 先证明前置条件成立：文件真在、且真不在 storeRoot 底下
    assert.equal(tool.startsWith(storeRoot), false);

    const r = await runSelfCheck({ ...BASE, storeRoot, probes: minimalProbes(withFfmpeg(tool)) });
    const t = byId(r, 'tool.ffmpeg');
    assert.equal(t?.status, 'warn', `借宿主的工具必须算 warn：${t?.detail ?? ''}`);
    assert.equal(t?.required, false);
    assert.match(t?.detail ?? '', /系统 PATH/);
  });

  it('★ 路径为 null / 文件不存在 → fail（"没找到"和"借来的"必须分得开）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'om-sc-gone-'));
    tmpRoots.push(dir);
    const gone = join(dir, 'ffmpeg-that-was-never-installed');
    const r = await runSelfCheck({ ...BASE, probes: minimalProbes(withFfmpeg(gone)) });
    const t = byId(r, 'tool.ffmpeg');
    assert.equal(t?.status, 'fail');
    assert.equal(t?.detail, '未找到');
  });
});

/**
 * ★ T-128：后端 `.so` 符号链接。
 *
 * 用户那次 8 条链接全断、转写完全不可用，而**产品里没有任何地方会发现它** ——
 * 这组测试就是那个"任何地方"。判据必须是**顺着链真的读到内容**：
 * 悬空链接 `lstat()` 照样成功，用它做判据等于把这条检查写成永远绿。
 */
describe('★ T-128 后端 .so 符号链接可解析', () => {
  it('两级相对链完好 → 全部读得到内容', async () => {
    const links = await checkBackendSymlinks(await seedBackend({ broken: false }));
    assert.equal(links.length, 2, '两级链应各算一条');
    assert.ok(
      links.every((l) => l.readable),
      JSON.stringify(links),
    );
    // 读到的是真 ELF 魔数，不是"文件存在"这种间接证据
    assert.equal(links.find((l) => l.rel.endsWith('libwhisper.so'))?.note, '7f454c46');
  });

  it('★ 链接指向已消失的旧数据目录 → 必须报读不到（事故的精确形态）', async () => {
    const links = await checkBackendSymlinks(await seedBackend({ broken: true }));
    const broken = links.filter((l) => !l.readable);
    // 两级链断在第二跳，第一跳跟着一起用不了 —— 两条都要报出来
    assert.equal(broken.length, 2, JSON.stringify(links));
    assert.ok(broken.every((l) => l.note === 'ENOENT'), JSON.stringify(broken));
  });

  it('★ 悬空链接的 lstat 是成功的 —— 证明"组件存在"这个判据本身就是假绿灯', async () => {
    const storeRoot = await seedBackend({ broken: true });
    const p = join(storeRoot, 'by-name', 'backend', 'whisper-bin-ubuntu-x64', 'libwhisper.so.1');
    // 这一条不是在测我们的代码，是在钉住"为什么不能用 lstat"这个理由
    assert.equal((await fs.lstat(p)).isSymbolicLink(), true, 'lstat 对悬空链接照样成功');
    await assert.rejects(() => fs.readFile(p), '而真去读就会失败');
  });

  it('★ 断链 → runSelfCheck 报 fail，且 remediation 指出是搬家造成的', async () => {
    const r = await runSelfCheck({
      ...BASE,
      storeRoot: await seedBackend({ broken: true }),
      probes: minimalProbes({ installed: () => Promise.resolve(['whisper-bin-ubuntu-x64']) }),
    });
    const c = byId(r, 'backend.libLinks');
    assert.equal(c?.status, 'fail');
    assert.equal(c?.required, true);
    assert.match(c?.detail ?? '', /2\/2 条链接读不到目标/);
    assert.match(c?.remediation ?? '', /旧数据目录/);
    assert.equal(r.ok, false, 'required 的 fail 必须让整份报告变红');
  });

  it('链接完好 → ok', async () => {
    const r = await runSelfCheck({
      ...BASE,
      storeRoot: await seedBackend({ broken: false }),
      probes: minimalProbes({ installed: () => Promise.resolve(['whisper-bin-ubuntu-x64']) }),
    });
    const c = byId(r, 'backend.libLinks');
    assert.equal(c?.status, 'ok');
    assert.equal(c?.remediation, null);
  });

  it('★ 没装后端包 → warn 而不是 fail（"什么都没装"不是"装坏了"）', async () => {
    const r = await runSelfCheck({ ...BASE, probes: minimalProbes() });
    const c = byId(r, 'backend.libLinks');
    assert.equal(c?.status, 'warn');
    assert.match(c?.detail ?? '', /未安装后端包/);
  });

  it('★ required 恒为 true —— 它是纯逻辑，不许随 storeRoot 漂移（同源比对的前提）', async () => {
    // CLI 与 daemon 的 storeRoot 可以不同；required 若跟着环境变，
    // diffSelfCheckReports 会把它报成"判据被改分叉了"
    const states = await Promise.all([
      runSelfCheck({ ...BASE, probes: minimalProbes() }),
      runSelfCheck({
        ...BASE,
        storeRoot: await seedBackend({ broken: false }),
        probes: minimalProbes({ installed: () => Promise.resolve(['p']) }),
      }),
      runSelfCheck({
        ...BASE,
        storeRoot: await seedBackend({ broken: true }),
        probes: minimalProbes({ installed: () => Promise.resolve(['p']) }),
      }),
    ]);
    for (const r of states) assert.equal(byId(r, 'backend.libLinks')?.required, true);
    // 三种环境下 id 集合也必须完全一致
    assert.deepEqual(idsOf(states[0]!), idsOf(states[1]!));
    assert.deepEqual(idsOf(states[1]!), idsOf(states[2]!));
  });
});

describe('diffSelfCheckReports 真的抓得到漂移', () => {
  const mk = (results: { id: string; status: 'ok' | 'warn' | 'fail'; required?: boolean }[]): SelfCheckReport => ({
    ok: true,
    ranAt: '',
    dataDir: '',
    storeRoot: '',
    extensionsDir: '',
    counts: { ok: 0, warn: 0, fail: 0 },
    results: results.map((r) => ({
      layer: 'x',
      id: r.id,
      label: r.id,
      labelZh: r.id,
      status: r.status,
      detail: '',
      required: r.required ?? false,
      remediation: null,
    })),
  });

  it('完全一致 → 空', () => {
    const a = mk([{ id: 'a', status: 'ok' }, { id: 'b', status: 'warn' }]);
    assert.deepEqual(diffSelfCheckReports(a, mk([{ id: 'a', status: 'ok' }, { id: 'b', status: 'warn' }])), []);
  });

  it('端点少一项（就是 T-119 之前的形状）→ 报 missing-there', () => {
    const cli = mk([{ id: 'hw.os', status: 'ok' }, { id: 'ext.chineseSearch', status: 'ok' }]);
    const api = mk([{ id: 'ext.chineseSearch', status: 'ok' }]);
    const d = diffSelfCheckReports(cli, api);
    assert.equal(d.length, 1);
    assert.equal(d[0]?.id, 'hw.os');
    assert.equal(d[0]?.kind, 'missing-there');
  });

  it('结论不同 → 报 status（网页绿而 CLI 红，正是要抓的那种）', () => {
    const d = diffSelfCheckReports(
      mk([{ id: 'ext.chineseSearch', status: 'fail' }]),
      mk([{ id: 'ext.chineseSearch', status: 'ok' }]),
    );
    assert.deepEqual(d, [{ id: 'ext.chineseSearch', kind: 'status', here: 'fail', there: 'ok' }]);
  });

  it('必需性不同 → 也要报：那是纯逻辑，不该受环境影响', () => {
    const d = diffSelfCheckReports(
      mk([{ id: 'model.asr', status: 'ok', required: true }]),
      mk([{ id: 'model.asr', status: 'ok', required: false }]),
    );
    assert.equal(d.length, 1);
    assert.equal(d[0]?.kind, 'required');
  });

  it('detail 不参与比较 —— 路径/设备数天生不同，拿它做判据只会误报', () => {
    const a = mk([{ id: 'tool.ffmpeg', status: 'ok' }]);
    const b = mk([{ id: 'tool.ffmpeg', status: 'ok' }]);
    b.results[0]!.detail = '/完全不同的/路径/ffmpeg';
    assert.deepEqual(diffSelfCheckReports(a, b), []);
  });
});
