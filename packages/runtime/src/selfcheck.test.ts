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
    // T-149：按 role 问的那条同样是"必答"探针 —— 做成可选就等于留了一条
    // "没实现时退回按文件名猜"的暗道，而那条暗道正是这次要拆掉的东西。
    installedByRole: () => Promise.resolve({ names: [], skippedWithoutRole: 0 }),
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
  await fs.writeFile(
    join(pack, 'libwhisper.so.1.9.1'),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]),
  );
  await fs.symlink('libwhisper.so.1.9.1', join(pack, 'libwhisper.so.1'));
  await fs.symlink('libwhisper.so.1', join(pack, 'libwhisper.so'));
  if (opts.broken) {
    // 精确复现事故形态：链接被改写成指向一个**已经不存在的旧数据目录**
    await fs.unlink(join(pack, 'libwhisper.so.1'));
    await fs.symlink(
      '/tmp/om-gone/models/by-name/backend/x/libwhisper.so.1.9.1',
      join(pack, 'libwhisper.so.1'),
    );
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
          Promise.resolve({
            mode: 'system',
            activeUrl: null,
            ffmpegSupported: true,
            ffmpegReason: null,
          }),
      }),
    });
    assert.deepEqual(idsOf(bare), idsOf(full));
  });

  it('proxyTest 关闭时不产生 proxy.connectivity —— 自检必须能离线跑完', async () => {
    let called = 0;
    const probes = minimalProbes({
      proxy: () =>
        Promise.resolve({
          mode: 'system',
          activeUrl: null,
          ffmpegSupported: true,
          ffmpegReason: null,
        }),
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

  /*
   * ★ T-149：这一条原来喂的是 `installed('asr') → ['ggml-silero-v6.2.0.bin']`，
   * 也就是**按文件名**触发那条 `NON_ASR_NAME` 正则。正则删掉之后夹具也得跟着换 ——
   * 但**钉的后果一个字没变**：「目录里只躺着别的 role 的权重 ≠ ASR 就绪」。
   * 换的是提问方式（问记录里的 role，不问文件叫什么），不是判据。
   */
  it('by-name/asr 里只有别的 role 的权重 ≠ ASR 就绪', async () => {
    const r = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({
        // 目录里确实有文件……
        installed: (kind) => Promise.resolve(kind === 'asr' ? ['ggml-silero-v6.2.0.bin'] : []),
        // ……但没有一条安装记录说自己是 ASR
        installedByRole: (role) =>
          Promise.resolve(
            role === 'vad'
              ? { names: ['ggml-silero-v6.2.0.bin'], skippedWithoutRole: 0 }
              : { names: [], skippedWithoutRole: 0 },
          ),
      }),
    });
    const m = byId(r, 'model.asr');
    assert.equal(m?.status, 'fail', '把 VAD 当 ASR 报绿就是假绿灯');
    assert.match(m?.detail ?? '', /都不是 ASR 角色/);
    assert.match(m?.detail ?? '', /ggml-silero-v6\.2\.0\.bin/, '要说出目录里到底躺着什么');
  });

  /*
   * ★ T-149 —— 删掉的那条正则**具体会误伤什么**，用一条用例钉住。
   *
   * `NON_ASR_NAME = /silero|vad|punct|ct-transformer|speaker|diariz/i` 按文件名判类型，
   * 于是一个**真的** ASR 模型只要名字里带 `silero`（上游确实有 silero 系的 ASR 模型）
   * 就会被判成"不是 ASR" → `model.asr` fail → 一个装好了的产品被报成装不了。
   * 这是**假红灯**，与假绿灯同样要当 bug 修（HANDOFF ⑤B）。
   */
  it('★ 名字里带 silero 的**真** ASR 模型必须算 ASR（旧正则在这里会误杀）', async () => {
    const r = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({
        installed: (kind) => Promise.resolve(kind === 'asr' ? ['silero-asr-en-v1.bin'] : []),
        installedByRole: (role) =>
          Promise.resolve(
            role === 'asr'
              ? { names: ['silero-asr-en-v1.bin'], skippedWithoutRole: 0 }
              : { names: [], skippedWithoutRole: 0 },
          ),
      }),
    });
    const m = byId(r, 'model.asr');
    assert.equal(m?.status, 'ok', '记录里 role=asr，就该算 ASR —— 名字里有什么字与它无关');
    assert.match(m?.detail ?? '', /silero-asr-en-v1\.bin/);
  });

  /*
   * ★ T-149：「我跳过了 N 条」不许被吞成「你什么都没装」。
   * 没写 `role` 的老记录一律不猜（`store.ts` 的规矩），但那是**跳过**，不是**没有** ——
   * 不报出来的话，一个装满模型的旧库会被自检说成"无"，用户会去重装已经装好的东西。
   */
  it('★ 没写 role 的老记录：不猜，但必须把"跳过了几条"说出来', async () => {
    const r = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({
        installedByRole: () => Promise.resolve({ names: [], skippedWithoutRole: 3 }),
      }),
    });
    const m = byId(r, 'model.asr');
    assert.equal(m?.status, 'fail');
    assert.match(m?.detail ?? '', /3 条/, '跳过的范围要如实进返回值，不能静默吞掉');
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
    const seedVad = async (name: string, bytes: Buffer): Promise<string> => {
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
    /*
     * ★ T-149：第二个参数原来是「`by-name/asr` 里有哪些文件名」，靠 `VAD_WEIGHT_NAME`
     * 正则从里面挑出 VAD。正则删了，现在直接说「哪些**记录的 role 是 vad**」——
     * 与产品新的提问方式一致。用例钉的后果没变。
     */
    const vadCheck = async (vadModel: string | null, installedVad: string[] = []) =>
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
            installedByRole: (role) =>
              Promise.resolve(
                role === 'vad'
                  ? { names: installedVad, skippedWithoutRole: 0 }
                  : { names: [], skippedWithoutRole: 0 },
              ),
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
      const good = await seedVad(
        'ggml-silero-v6.2.0.bin',
        Buffer.concat([ggmlMagic, Buffer.alloc(32)]),
      );
      const c = await vadCheck(good);
      assert.equal(c?.status, 'ok');
      assert.equal(c?.detail, good);
    });

    it('★ 解析器已经拒绝交出坏文件时，仍要说清"你装的那个 whisper 用不了"', async () => {
      // 修复后的真实状态：tools.vadModel = null，而那份 sherpa 的 ONNX 记录还在
      const c = await vadCheck(null, ['silero_vad.onnx']);
      assert.equal(c?.status, 'warn');
      assert.match(c?.detail ?? '', /silero_vad\.onnx/);
      assert.match(c?.remediation ?? '', /silero-vad-ggml/);
      /*
       * ★ T-149：指引必须指向一个**今天真的到得了**的地方。
       * 原文是「在「模型」页安装 `vad/silero-vad-ggml`」，而当时 `/models` 的列表
       * 只渲染 `role === 'asr'` —— 用户照做会空手而归，然后怀疑是自己的问题。
       *
       * 现在两条路都要有，各守一半：
       *   ① 分组名 —— 必须与 `asrSections.ts` 真的会放它的那一组、以及用户看见的字一致
       *      （i18n `models.section.realtime` = 「实时字幕组件」）。
       *      写错分组名 = 又一条"照做找不到"的指引，而它不会让任何东西变红，所以在这里钉住。
       *   ② 直达地址 —— 不依赖列表分组的第二条路。
       */
      assert.match(
        c?.remediation ?? '',
        /实时字幕组件/,
        '要说清在哪一组，而且要与界面上那个分组名逐字一致',
      );
      assert.match(
        c?.remediation ?? '',
        /\/models\/vad%2Fsilero-vad-ggml/,
        '指引里必须有一个今天点得开的落点，而不是只有一句"去某某页"',
      );
      // 两个变体不能互换这件事必须说出来：选错的代价 T-148 已经付过一次
      assert.match(c?.remediation ?? '', /不能互换/);
    });

    it('一个 VAD 都没装 → warn，且**不能**说成"装了个用不了的"（那是假红灯）', async () => {
      /*
       * ★ T-149：这里原来传的是 `['ggml-tiny-q5_1.bin']` —— 一个 **ASR** 权重，
       * 因为当时第二个参数是「`by-name/asr` 目录里有什么」，靠正则从中挑 VAD，
       * ASR 那个名字挑不中，于是等价于"没有 VAD"。
       * 新签名问的是「哪些**记录的 role 是 vad**」，所以"一个都没装"就写成空集
       * —— 把 ASR 的文件名塞进来反而是在声称它是个 VAD，那是夹具在撒谎。
       */
      const c = await vadCheck(null, []);
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
    assert.equal((present?.detail ?? '').includes('SECRET'), false, '根外内容不许出现在自检报告里');
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
    const scan = await checkBackendSymlinks(await seedBackend({ broken: false }));
    const links = scan.links;
    assert.equal(links.length, 2, '两级链应各算一条');
    assert.deepEqual(scan.unscanned, [], '这棵树是好的，不该有扫不到的位置');
    assert.equal(scan.rootMissing, false);
    assert.ok(
      links.every((l) => l.readable),
      JSON.stringify(links),
    );
    // 读到的是真 ELF 魔数，不是"文件存在"这种间接证据
    assert.equal(links.find((l) => l.rel.endsWith('libwhisper.so'))?.note, '7f454c46');
  });

  it('★ 链接指向已消失的旧数据目录 → 必须报读不到（事故的精确形态）', async () => {
    const { links } = await checkBackendSymlinks(await seedBackend({ broken: true }));
    const broken = links.filter((l) => !l.readable);
    // 两级链断在第二跳，第一跳跟着一起用不了 —— 两条都要报出来
    assert.equal(broken.length, 2, JSON.stringify(links));
    assert.ok(
      broken.every((l) => l.note === 'ENOENT'),
      JSON.stringify(broken),
    );
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

  /*
   * ★ T-166：这里的 `ENOENT` 与 `move.ts` 的 `findStaleLinks` **判定相反**，
   * 两条都要有测试钉住，免得后来者看见"同一个 errno 两种处理"就去"统一"。
   */
  it('★ 后端目录不存在 = **合法的零**（rootMissing），不是"没检查"', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'om-sc-empty-'));
    tmpRoots.push(empty);
    const scan = await checkBackendSymlinks(empty);
    assert.equal(scan.rootMissing, true, '全新安装还没装后端包 —— 这个目录本来就不该存在');
    assert.deepEqual(scan.unscanned, [], 'ENOENT 在这一侧不算"扫不到"');
    assert.deepEqual(scan.links, []);
  });

  it('★ 后端目录读不动（不是 ENOENT）= 没检查 → 必须进 unscanned', async () => {
    const base = mkdtempSync(join(tmpdir(), 'om-sc-notdir-'));
    tmpRoots.push(base);
    // by-name/backend 是个**文件**而不是目录 → ENOTDIR。这不是"没装"，是"读不了"
    await fs.mkdir(join(base, 'by-name'), { recursive: true });
    await fs.writeFile(join(base, 'by-name', 'backend'), 'x');
    const scan = await checkBackendSymlinks(base);
    assert.equal(scan.rootMissing, false, 'ENOTDIR 不许被当成"没装后端包"');
    assert.equal(scan.unscanned.length, 1);
    assert.equal(scan.unscanned[0]?.code, 'ENOTDIR');
  });

  it('★★ 扫不全时 runSelfCheck **不许**说"该后端包不含符号链接"（那是假话）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'om-sc-partial-'));
    tmpRoots.push(base);
    await fs.mkdir(join(base, 'by-name'), { recursive: true });
    await fs.writeFile(join(base, 'by-name', 'backend'), 'x'); // ENOTDIR
    const r = await runSelfCheck({
      ...BASE,
      storeRoot: base,
      probes: minimalProbes({ installed: () => Promise.resolve(['whisper-bin-ubuntu-x64']) }),
    });
    const c = byId(r, 'backend.libLinks');
    assert.equal(c?.status, 'fail', '没检查过就不能算通过');
    assert.match(c?.detail ?? '', /没有检查完/);
    assert.ok(
      !(c?.detail ?? '').includes('不含符号链接'),
      `读不动却说"不含符号链接" —— 正是本轮要修的形状。实际: ${c?.detail ?? ''}`,
    );
    assert.equal(r.ok, false);
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
  const mk = (
    results: { id: string; status: 'ok' | 'warn' | 'fail'; required?: boolean }[],
  ): SelfCheckReport => ({
    ok: true,
    ranAt: '',
    dataDir: '',
    storeRoot: '',
    extensionsDir: '',
    counts: { ok: 0, warn: 0, fail: 0, unavailable: 0 },
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
    const a = mk([
      { id: 'a', status: 'ok' },
      { id: 'b', status: 'warn' },
    ]);
    assert.deepEqual(
      diffSelfCheckReports(
        a,
        mk([
          { id: 'a', status: 'ok' },
          { id: 'b', status: 'warn' },
        ]),
      ),
      [],
    );
  });

  it('端点少一项（就是 T-119 之前的形状）→ 报 missing-there', () => {
    const cli = mk([
      { id: 'hw.os', status: 'ok' },
      { id: 'ext.chineseSearch', status: 'ok' },
    ]);
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

/**
 * T-168 ④ —— `asr.coreml` 的三档，以及**哪一档该让整份报告变红**。
 *
 * ## 为什么这组测试到今天才有
 *
 * `checkCoreMl()` 第一行就 `if (platform !== 'darwin' || arch !== 'arm64') return;`，
 * 而 CI 与本机都跑在 Linux 上 —— **它的每一个分支都从来没有被任何测试执行过**。
 * 它却是决定「用户付了 1.17 GB 有没有白付」的那一条。
 * `SelfCheckInput.platform/arch` 这两个注入就是为了让它在 Linux 上跑起来
 * （与 `unpack.ts` 的 `lex(platform)` 同一招、同一个理由）。
 *
 * ## 判据
 *
 *   warn = 没装 encoder，功能健康（可选加速缺失）→ **不许**让报告变红
 *   fail = 装了、但目录里没有 coremldata.bin（结构性损坏，whisper 静默回退）
 *          → **必须**让报告变红
 *
 * 这两条一起才叫"裁决被执行了"。只验 fail 变红的话，
 * 一个把 warn 也标红的实现同样能过 —— 那正是原来 `required=false` 想避免的那种谎。
 */
describe('T-168 ④ asr.coreml：结构性损坏必须让审计变红，可选加速缺失不许', () => {
  const MAC = { platform: 'darwin' as NodeJS.Platform, arch: 'arm64' };
  const BIN = 'ggml-large-v3-turbo-q5_0.bin';
  const ENC = 'ggml-large-v3-turbo-encoder.mlmodelc';

  /** 造一个 storeRoot，by-name/asr 下按 `shape` 摆出 encoder 目录。 */
  async function macStore(shape: 'none' | 'shell' | 'good'): Promise<string> {
    const storeRoot = mkdtempSync(join(tmpdir(), 'om-sc-coreml-'));
    tmpRoots.push(storeRoot);
    const asr = join(storeRoot, 'by-name', 'asr');
    await fs.mkdir(asr, { recursive: true });
    const magic = Buffer.alloc(4);
    magic.writeUInt32LE(GGML_FILE_MAGIC, 0);
    await fs.writeFile(join(asr, BIN), magic);
    if (shape === 'shell') {
      // 事故形态：解包多留了一层同名目录（真 zip 里还有个 __MACOSX 把它挡住了）
      await fs.mkdir(join(asr, ENC, ENC), { recursive: true });
      await fs.writeFile(join(asr, ENC, ENC, 'coremldata.bin'), 'x');
    } else if (shape === 'good') {
      await fs.mkdir(join(asr, ENC), { recursive: true });
      await fs.writeFile(join(asr, ENC, 'coremldata.bin'), 'x');
    }
    return storeRoot;
  }

  const runMac = async (shape: 'none' | 'shell' | 'good'): Promise<SelfCheckReport> => {
    const storeRoot = await macStore(shape);
    return runSelfCheck({
      ...BASE,
      ...MAC,
      storeRoot,
      probes: minimalProbes({
        installedByRole: () => Promise.resolve({ names: [BIN], skippedWithoutRole: 0 }),
      }),
    });
  };

  /**
   * 让报告变红的那一组 id（`ok:` 那一行的判据逐字同一条）。
   *
   * ⚠️ **不能直接断言 `r.ok === true`。** 这个夹具的 dataDir 是 `/nonexistent`、
   * 探针一个工具都不给，于是本来就有 6 条不相干的 required 失败
   * （`tool.ffmpeg` / `tool.ffprobe` / `tool.whisperCli` / `ext.chineseSearch` /
   * `engine.select.zh` / `engine.select.en`）。`r.ok` 在三种形态下**恒为 false**，
   * 拿它当判据的话，这组测试写成什么样都会"过"。
   *
   * `[反向验证实测]` 第一版正是这么写的：把 `warn` 改成 `fail` 的变异**没有被抓住**。
   * 所以判据换成**差分** —— 只看 `asr.coreml` 有没有进这一组。
   */
  const redIds = (r: SelfCheckReport): string[] =>
    r.results.filter((c) => c.status === 'fail' && c.required).map((c) => c.id);

  it('★ fail（空壳）→ required=true，且它必须进"让报告变红"的那一组', async () => {
    const r = await runMac('shell');
    const c = byId(r, 'asr.coreml');
    assert.equal(c?.status, 'fail');
    assert.equal(c?.required, true);
    assert.equal(
      redIds(r).includes('asr.coreml'),
      true,
      '装了 encoder 却是空壳（whisper 静默回退到 Metal/CPU），而这一条不让报告变红',
    );
    assert.equal(r.ok, false);
  });

  it('★ warn（没装 encoder）→ **不许**进那一组：可选加速缺失不是"坏了"', async () => {
    const r = await runMac('none');
    const c = byId(r, 'asr.coreml');
    assert.equal(c?.status, 'warn');
    // required 是**无条件常量**（同源比对的前提），warn 不参与红绿
    assert.equal(c?.required, true);
    assert.equal(
      redIds(r).includes('asr.coreml'),
      false,
      '一台没装 encoder 的正常 Mac 被这一条判红了 —— required 只该让 fail 变红',
    );
  });

  it('★ ok（结构正确）→ 也不许进那一组', async () => {
    const r = await runMac('good');
    const c = byId(r, 'asr.coreml');
    assert.equal(c?.status, 'ok');
    assert.equal(c?.required, true);
    assert.equal(redIds(r).includes('asr.coreml'), false);
  });

  it('★ 差分：三种形态之间，红的那一组**只差** asr.coreml 一项', async () => {
    /*
     * 这条把"不相干的 6 条红"彻底排除掉：encoder 的形态是三次运行之间
     * **唯一**的变量，所以红集合的差也必须**恰好**是这一项。
     * 多出别的 id ⇒ 这条检查影响到了它不该影响的东西。
     */
    const shell = redIds(await runMac('shell'));
    const none = redIds(await runMac('none'));
    const good = redIds(await runMac('good'));
    assert.deepEqual(
      shell.filter((id) => !none.includes(id)),
      ['asr.coreml'],
    );
    assert.deepEqual(
      none.filter((id) => !shell.includes(id)),
      [],
    );
    assert.deepEqual(good, none, 'ok 与 warn 对红绿的贡献必须完全一样（都是零）');
  });

  it('非 darwin/arm64 上这一项根本不出现（不许变成永久噪音）', async () => {
    const storeRoot = await macStore('shell');
    for (const p of [
      { platform: 'linux' as NodeJS.Platform, arch: 'x64' },
      { platform: 'win32' as NodeJS.Platform, arch: 'x64' },
      { platform: 'darwin' as NodeJS.Platform, arch: 'x64' }, // Intel Mac 没有 ANE
    ]) {
      const r = await runSelfCheck({
        ...BASE,
        ...p,
        storeRoot,
        probes: minimalProbes({
          installedByRole: () => Promise.resolve({ names: [BIN], skippedWithoutRole: 0 }),
        }),
      });
      assert.equal(
        idsOf(r).includes('asr.coreml'),
        false,
        `${p.platform}/${p.arch} 上不该产出 asr.coreml`,
      );
    }
  });

  it('不传 platform/arch 时 = 宿主平台（生产侧行为逐字不变）', async () => {
    const storeRoot = await macStore('shell');
    const r = await runSelfCheck({
      ...BASE,
      storeRoot,
      probes: minimalProbes({
        installedByRole: () => Promise.resolve({ names: [BIN], skippedWithoutRole: 0 }),
      }),
    });
    assert.equal(
      idsOf(r).includes('asr.coreml'),
      process.platform === 'darwin' && process.arch === 'arm64',
    );
  });
});

/* ====================================================================================== */
/* T-173：断路器跳闸必须在自检里**说得出人话**，中英都要                                     */
/* ====================================================================================== */

/**
 * ## 为什么这一组比冷却期本身还重要
 *
 * 断路器跳闸此前是**零报错的静默降级**：探针不再被调用，GPU 加速"就是不工作"，
 * 而全仓没有任何一个出口说得出这件事发生过 —— `runtime.breaker` 确实随
 * `/api/runtime/hardware` 发出去，但前端把响应断言成窄契约 `GetHardwareResponse`，
 * 那个字段在**类型边界上**就被丢掉了。
 *
 * > 一个能自愈、但用户不知道发生过什么的系统，
 * > 和一个坏了不吭声的系统，在用户那里是一样的。
 *
 * 所以下面钉三件事：**这条检查项存在**、**它说得出"停用了什么/为什么/多久之后重试"**、
 * **中英两种语言都说得出**（英文用户拿到的不能是一句中文，也不能是一片空白）。
 */
function breakerProbe(over: Record<string, unknown> = {}) {
  return () =>
    Promise.resolve({
      verdict: 'open',
      blacklistedBackends: ['cuda', 'vulkan', 'rocm', 'metal', 'coreml'],
      consecutiveFailures: 3,
      threshold: 2,
      lastError: 'probe timed out after 10000ms (killed).',
      retryAt: new Date(Date.now() + 240_000).toISOString(),
      recovering: false,
      ...over,
    });
}

describe('T-173 断路器在自检里是可见的', () => {
  it('探针没给时检查项照常出现（两个出口 id 集合不许分叉）', async () => {
    const r = await runSelfCheck({ ...BASE, probes: minimalProbes() });
    assert.ok(idsOf(r).includes('hw.breaker'));
    assert.equal(byId(r, 'hw.breaker')?.status, 'warn');
    // "未探测" 这一支也得有英文，否则英文用户看到的是一句中文
    assert.match(byId(r, 'hw.breaker')?.detailEn ?? '', /not probed/);
  });

  it('没跳闸时是 ok，且不吓唬人', async () => {
    const r = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({
        breaker: breakerProbe({
          verdict: 'closed',
          blacklistedBackends: [],
          consecutiveFailures: 0,
          lastError: null,
          retryAt: null,
        }),
      }),
    });
    assert.equal(byId(r, 'hw.breaker')?.status, 'ok');
    assert.equal(byId(r, 'hw.breaker')?.remediation, null);
  });

  it('★ 跳闸时说得出「停用了什么 / 为什么 / 多久之后重试」—— 中英各一份', async () => {
    const r = await runSelfCheck({ ...BASE, probes: minimalProbes({ breaker: breakerProbe() }) });
    const c = byId(r, 'hw.breaker');

    // warn 而不是 fail：CPU 兜底还在，产品能用。fail 会让 CLI EXIT=1。
    assert.equal(c?.status, 'warn');
    assert.equal(c?.required, false);

    for (const [lang, text] of [
      ['中文', c?.detail ?? ''],
      ['English', c?.detailEn ?? ''],
    ] as const) {
      assert.notEqual(text, '', `${lang}: detail 是空的`);
      assert.equal(text.includes('metal'), true, `${lang}: 没说停用了哪个后端`);
      assert.equal(text.includes('10000ms'), true, `${lang}: 没说原因`);
      assert.equal(/\d/.test(text), true, `${lang}: 没有任何数字 —— "多久之后"就没说出来`);
    }
    // 「将在 Y 之后重试」必须是**具体的 Y**，不是"稍后重试"
    assert.match(c?.detail ?? '', /将在约 4 分钟后自动重试/);
    assert.match(c?.detailEn ?? '', /Automatic retry in about 4 min/);

    // 中文里不许混英文提示语，英文里不许混中文 —— 混了就等于没做双语
    assert.equal(/[一-龥]/.test(c?.detailEn ?? ''), false, 'detailEn 里混进了中文');
    assert.equal(/[一-龥]/.test(c?.remediationEn ?? ''), false, 'remediationEn 里混进了中文');
    assert.equal(/[一-龥]/.test(c?.detail ?? ''), true);

    // 用户该知道"不用你动手"，否则他会去找一个并不存在的按钮
    assert.match(c?.remediation ?? '', /自动重试/);
    assert.match(c?.remediationEn ?? '', /automatically/);
  });

  it('正在重试时说的是"正在重试"，不是一个假的倒计时', async () => {
    const r = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({ breaker: breakerProbe({ recovering: true }) }),
    });
    assert.match(byId(r, 'hw.breaker')?.detail ?? '', /正在重试/);
    assert.match(byId(r, 'hw.breaker')?.detailEn ?? '', /Retrying now/);
  });

  it('拿不到断路器状态时如实说拿不到（CLI 没连 daemon 的那一支），不是假装没跳闸', async () => {
    const r = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({ breaker: () => Promise.resolve(null) }),
    });
    assert.equal(byId(r, 'hw.breaker')?.status, 'warn');
    assert.match(byId(r, 'hw.breaker')?.detail ?? '', /取不到/);
    assert.match(byId(r, 'hw.breaker')?.detailEn ?? '', /unavailable/);
  });

  it('★ retryAt 缺失/坏掉时如实说"没记录"，绝不编一个时间出来', async () => {
    for (const bad of [null, 'not-a-date']) {
      const r = await runSelfCheck({
        ...BASE,
        probes: minimalProbes({ breaker: breakerProbe({ retryAt: bad }) }),
      });
      assert.match(byId(r, 'hw.breaker')?.detail ?? '', /重试时刻未记录/);
      assert.match(byId(r, 'hw.breaker')?.detailEn ?? '', /No retry time recorded/);
    }
  });
});

/**
 * ★ T-174：英文字段里不许出现中文。
 *
 * ## 为什么这条守卫存在（成因比那 5 处改动重要）
 *
 * `tool.ffmpeg` 等 5 条检查项此前写的是 `label: labelZh` —— **英文界面上显示中文标签**。
 * 它能长期存在而没人发现，原因不是"没人看"，是**多数条目上它没有可观测后果**：
 * 前三条的 `labelZh` 恰好是 `ffmpeg` / `ffprobe` / `whisper-cli` 这类工具名，中英同形，
 * 于是"把中文塞进英文字段"这个错误**在 3/5 的样本上是隐形的**，只有 `VAD 切分器` 与
 * `yt-dlp（可选，GPL）` 会露馅，而没人用英文界面翻自检页。
 *
 * ## 判据为什么不是"中英字段不相等"
 *
 * 那条看起来更自然的判据（`label !== labelZh`）**是错的**：`ffmpeg` 本来就该两边相等，
 * 它会把 3 条正确的条目判红，于是必然被加豁免名单，而豁免名单会慢慢长大直到守卫失效。
 *
 * 真正要钉的性质是「**英文字段里不许有 CJK**」—— 它对 `ffmpeg` 天然放行，
 * 对 `VAD 切分器` 当场变红，不需要任何豁免。范围含全角标点（`（`、`，`），
 * 因为 `yt-dlp（可选，GPL）` 的括号逗号也是全角，那同样是"英文界面上的中文"。
 *
 * `detail` **不在检查范围内**：它按设计就是中文原文（见 `CheckResult` 的注释），
 * 英文版走可选的 `detailEn`。`labelZh` 同理不检查（它可以是拉丁字母的工具名）。
 */
describe('★ T-174 英文字段里不许出现中文', () => {
  /**
   * CJK 统一表意文字 + CJK 标点（、。）+ 全角形式（（），）。
   *
   * 写成 `\u` 转义而不是字面量：这个范围的**第一个字符就是 U+3000 全角空格**，
   * 字面量写法会被 eslint `no-irregular-whitespace` 拦下 —— 而且在 diff 里根本看不见。
   */
  const CJK = /[\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF]/;

  /** 造一个真实存在、且真的有可执行位的假工具（同上面那组用例的理由）。 */
  async function fakeTool(dir: string): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    const p = join(dir, process.platform === 'win32' ? 'tool.exe' : 'tool');
    await fs.writeFile(p, '#!/bin/sh\nexit 0\n');
    await fs.chmod(p, 0o755);
    return p;
  }

  const allTools = (p: string | null): Partial<SelfCheckProbes> => ({
    tools: () =>
      Promise.resolve({
        ffmpeg: p,
        ffprobe: p,
        whisperCli: p,
        whisperVad: p,
        vadModel: p,
        ytDlp: p,
      }),
  });

  /**
   * 三种 tools 分支各跑一遍。
   *
   * ★ 必须三条都跑：出问题的 `label: labelZh` 在 `selfcheck.ts` 里是**三个独立的
   * `add()`**（未找到 / 装在 storeRoot / 只在 PATH 上），改对两个漏掉一个，
   * 只跑一种分支的守卫会照样报绿 —— 那正是这条守卫要防的形状。
   */
  async function reportsCoveringAllToolBranches(): Promise<SelfCheckReport[]> {
    const storeRoot = mkdtempSync(join(tmpdir(), 'om-sc-i18n-store-'));
    tmpRoots.push(storeRoot);
    const outside = mkdtempSync(join(tmpdir(), 'om-sc-i18n-host-'));
    tmpRoots.push(outside);

    const inStore = await fakeTool(join(storeRoot, 'by-name', 'backend', 'media-tools'));
    const onPath = await fakeTool(outside);
    assert.equal(inStore.startsWith(storeRoot), true);
    assert.equal(onPath.startsWith(storeRoot), false);

    const probes = { breaker: breakerProbe() };
    return [
      // ① 未找到（路径为 null）
      await runSelfCheck({ ...BASE, storeRoot, probes: minimalProbes({ ...probes }) }),
      // ② 装在 storeRoot 里 → ok
      await runSelfCheck({
        ...BASE,
        storeRoot,
        probes: minimalProbes({ ...probes, ...allTools(inStore) }),
      }),
      // ③ 只在系统 PATH 上 → warn
      await runSelfCheck({
        ...BASE,
        storeRoot,
        probes: minimalProbes({ ...probes, ...allTools(onPath) }),
      }),
    ];
  }

  it('前提自检：三种 tools 分支真的都被覆盖到了', async () => {
    const [notFound, inStore, onPath] = await reportsCoveringAllToolBranches();
    // 守卫本身要先证明自己跑在有内容的样本上，否则它就是一条永远绿的空断言
    assert.equal(byId(notFound, 'tool.ffmpeg')?.status, 'fail');
    assert.equal(byId(inStore, 'tool.ffmpeg')?.status, 'ok');
    assert.equal(byId(onPath, 'tool.ffmpeg')?.status, 'warn');
  });

  it('★ 每一条 CheckResult 的 label / detailEn / remediationEn 都不许含中文', async () => {
    const reports = await reportsCoveringAllToolBranches();
    let checked = 0;
    for (const r of reports) {
      for (const c of r.results) {
        for (const [field, text] of [
          ['label', c.label],
          ['detailEn', c.detailEn],
          ['remediationEn', c.remediationEn],
        ] as const) {
          if (text === undefined || text === null) continue;
          checked += 1;
          assert.equal(
            CJK.test(text),
            false,
            `${c.id}.${field} 是英文字段，却含中文：${JSON.stringify(text)}`,
          );
        }
      }
    }
    // 空集返回绿是本仓最贵的那类假绿（HANDOFF ⑤A-2）—— 先证明真的检查了东西
    assert.equal(
      checked > 60,
      true,
      `只检查了 ${String(checked)} 个字段，样本太少，守卫可能是空的`,
    );
  });

  it('那 5 条工具检查各自给出了英文标签（不是把中文抄过去）', async () => {
    const [r] = await reportsCoveringAllToolBranches();
    assert.equal(byId(r, 'tool.whisperVad')?.label, 'VAD splitter');
    assert.equal(byId(r, 'tool.whisperVad')?.labelZh, 'VAD 切分器');
    assert.equal(byId(r, 'tool.ytDlp')?.label, 'yt-dlp (optional, GPL)');
    assert.equal(byId(r, 'tool.ytDlp')?.labelZh, 'yt-dlp（可选，GPL）');
    // 中英同形的那三条**不该**被强行拆开 —— 守卫允许相等，见本组头注
    assert.equal(byId(r, 'tool.ffmpeg')?.label, 'ffmpeg');
    assert.equal(byId(r, 'tool.ffmpeg')?.labelZh, 'ffmpeg');
  });
});

/* ═════════ ★ 第四态 `unavailable` —— 「没有答案，也没有下一步」 ═════════ */

describe('★ CheckStatus 第四态：hw.cpu 不再对一台没测过的 CPU 下预言', () => {
  /*
   * 事故形状：`detectCpu()` 的空 `features` 有三个真实生产者（win32 的 PowerShell
   * 被执行策略挡住 / 命令跑通却没解析出东西 / 非三大平台的 default 分支无条件返回 []），
   * 而自检把空集合读成「测过了，没有」，于是一台**装着 AVX2 的正常机器**
   * 被告知「未检出指令集 → 推理会明显更慢」——**一句关于硬件的预言。**
   *
   * ⚠️ 判据钉的是**后果**，不是措辞里的某个词：
   *   ① 状态不能是 ok / fail（它既不是"好的"也不是"坏了"）；
   *   ② **`remediation` 必须为 null** —— 原来那句不是动作，是结论，用户找不到终点；
   *   ③ detail 里必须**明说"不代表这台机器没有"**，否则读的人还是会读成"测过了没有"。
   */
  it('本机真实跑一次：features 为空时必须是 unavailable + remediation 为 null', async () => {
    const r = await runSelfCheck({ ...BASE, probes: minimalProbes() });
    const cpu = byId(r, 'hw.cpu');
    assert.ok(cpu, 'hw.cpu 这条必须始终存在（T-119：id 集合不变）');

    if (cpu.detail.includes('本次未能测出')) {
      // 这台机器没测出指令集 —— 那就必须是第四态，且没有"补救"
      assert.equal(cpu.status, 'unavailable');
      assert.equal(cpu.remediation, null, '"没有下一步"的态不许给补救 —— 那是走不出去的路');
      assert.equal(
        cpu.detail.includes('不代表这台机器没有'),
        true,
        `措辞必须挡住"测过了没有"这种读法：${cpu.detail}`,
      );
    } else {
      // 测出来了 —— 那就是 ok，且同样没有补救
      assert.equal(cpu.status, 'ok');
      assert.equal(cpu.remediation, null);
    }
  });

  it('★ 任何 unavailable 的检查项都不许带 remediation（这一态的定义就是"没有下一步"）', async () => {
    const r = await runSelfCheck({ ...BASE, probes: minimalProbes() });
    const un = r.results.filter((c) => c.status === 'unavailable');
    for (const c of un) {
      assert.equal(
        c.remediation,
        null,
        `${c.id} 是 unavailable 却给了补救：${String(c.remediation)}`,
      );
      assert.equal(c.remediationEn ?? null, null, `${c.id} 的英文补救也必须为空`);
    }
    // 前提自检：这一轮真的产生过这一态才谈得上"守住了"（空集返回绿，⑤A-2）
    assert.equal(
      un.length + r.results.filter((c) => c.id === 'hw.cpu' && c.status === 'ok').length > 0,
      true,
      'hw.cpu 既不是 unavailable 也不是 ok —— 这条守卫钉的是零',
    );
  });

  it('★ unavailable 不进 ok 的判据，但**单独计数**（不许并进 warn）', async () => {
    const r = await runSelfCheck({ ...BASE, probes: minimalProbes() });
    assert.equal(typeof r.counts.unavailable, 'number', 'counts 必须有独立的第四档');
    // 三态并成两态，第三态就消失了 —— 计数必须逐条对得上
    const sum = r.counts.ok + r.counts.warn + r.counts.fail + r.counts.unavailable;
    assert.equal(
      sum,
      r.results.length,
      `四档相加 ${String(sum)} ≠ 总数 ${String(r.results.length)}`,
    );
    // `ok` 只看 fail && required：unavailable 不许让整份报告变红
    const requiredFails = r.results.filter((c) => c.status === 'fail' && c.required);
    assert.equal(r.ok, requiredFails.length === 0);
  });
});

/* ═════ ★ ② tool.* —— 「找不到」不等于「去装」，中间那步得先问 ═════ */

describe('★ tool.* 装不到时报 unavailable，而不是让整份报告永久红', () => {
  /*
   * 实测的平台事实（`vendor/manifests/backends.json` 14 条）：
   * **darwin/x64 有 0 条包、win32/arm64 有 0 条、linux/arm64 只有 1 条**（`ytdlp-linux-arm64`）。
   * ffmpeg 只由 `media-tools-{linux-x64, win-x64, macos-arm64}` 提供。
   * ⇒ Intel Mac 上三个必需工具全 null，自检**永久红**，而那句"去「本机组件」页装"
   *   指向的页面会把这些包如实渲染成「其它平台」——**一个说去装，一个说装不了。**
   *
   * ⚠️ 判据钉后果：`ok` 不再被它拖红、且不给一条走不出去的补救。
   */
  it('★ 目录里没有能给出该二进制的包 ⇒ unavailable + 无补救 + 不拖红整份报告', async () => {
    const r = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({ canInstallBinary: () => Promise.resolve(false) }),
    });
    for (const id of ['tool.ffmpeg', 'tool.ffprobe', 'tool.whisperCli']) {
      const c = byId(r, id);
      assert.ok(c, `${id} 必须仍然出现（T-119：id 集合不变）`);
      assert.equal(c.status, 'unavailable', `${id} 应为 unavailable，实得 ${c.status}`);
      assert.equal(c.remediation, null, `${id} 装不到却给了补救 —— 那是走不出去的路`);
      assert.equal(c.required, true, 'required 是纯逻辑，不许随环境漂移');
    }
    /*
     * ⚠️ 判据钉的是**因果**，不是 `r.ok === true`：
     * 这个最小探针场景里本来就还有别的 required 失败（例如 `model.asr` 真的没装），
     * 拿全局 `ok` 当判据会把"别人的红"算到这条修复头上 —— 那样它既可能假绿也可能假红。
     * 要证明的是：**这三条不再出现在"required 的 fail"集合里**。
     */
    const requiredFails = r.results
      .filter((c) => c.status === 'fail' && c.required)
      .map((c) => c.id);
    for (const id of ['tool.ffmpeg', 'tool.ffprobe', 'tool.whisperCli']) {
      assert.equal(
        requiredFails.includes(id),
        false,
        `${id} 仍在把整份报告拖红：${requiredFails.join(', ')}`,
      );
    }
  });

  it('★ 反向：目录里有包时，仍然是原来的「去装」（这条修复不许把能装的也说成装不到）', async () => {
    const r = await runSelfCheck({
      ...BASE,
      probes: minimalProbes({ canInstallBinary: () => Promise.resolve(true) }),
    });
    const c = byId(r, 'tool.ffmpeg');
    assert.equal(c?.status, 'fail');
    assert.equal(c?.detail, '未找到');
    assert.match(c?.remediation ?? '', /本机组件/);
    const requiredFails = r.results
      .filter((x) => x.status === 'fail' && x.required)
      .map((x) => x.id);
    assert.equal(
      requiredFails.includes('tool.ffmpeg'),
      true,
      '能装却没装 = 真的缺东西，这条必须仍然是 required 的 fail',
    );
  });

  it('探针没给 ⇒ 退回原行为（不是所有调用方都拿得到目录）', async () => {
    const r = await runSelfCheck({ ...BASE, probes: minimalProbes() });
    assert.equal(byId(r, 'tool.ffmpeg')?.status, 'fail');
    assert.match(byId(r, 'tool.ffmpeg')?.remediation ?? '', /本机组件/);
  });
});
