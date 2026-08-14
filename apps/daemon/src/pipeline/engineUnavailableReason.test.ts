/**
 * #112：**`EngineUnavailableReason` 这一格里不许出现中文。**
 *
 * ## 这条护栏守的是什么
 *
 * `/api/health` 的 `pipeline.engines[].reason` 会被 `apps/web` 插进**英文**句子里
 * （`asr.engineUnavailable.*` 那四条词条），三个渲染点：录音页的引擎状态条、
 * 模型页的 `EngineFitChip`、重转弹窗那一行。所以这一格里出现的任何汉字，
 * 都会在英文界面上变成半句中文 —— 那正是这次修复要消灭的东西。
 *
 * 上一版这两个解析器交出来的是**整句中文**：
 *
 * ```
 * 未安装流式中文模型 —— 去「模型」页装 “sherpa 流式中文 zh-14M” 即可启用录音转文字
 * 已安装 asr/paraformer-zh-small，但文件不完整（缺 *.onnx 或 tokens.txt）
 * OPENMEMO_SHERPA_STREAM_DIR 指向 /tmp/x，但那里没有 encoder/decoder/joiner/tokens.txt
 * ```
 *
 * 现在它们交出的是**档位 + 数据**，措辞归 web 的两份 locale。
 * 这个文件钉的就是那条边界：**daemon 这一侧一个汉字都不许有。**
 *
 * ## ⚠️ 判据是「整个结构序列化之后不含 CJK」，不是「某个字段不含」
 *
 * 将来给某一档加一个中文参数（比如把模型的中文显示名塞进 `installedIds` 旁边），
 * 这条会红。形状照 `packages/downloader/src/rateLimitReason.test.ts` 的第 ④ 组
 * （#106 钉 `UpstreamFailure` 的那一条），**包括它的前提检查** ——
 * 没有那一条，整组可能只是因为正则抓不到汉字而全绿。
 *
 * ## 措辞那一层没有丢，只是搬了家
 *
 * 「这句话读起来到底说没说清下一步」钉在
 * `apps/web/src/features/models/engineReasonText.test.ts`（断的是**渲染出来的英文**，
 * 比在这里读一句中文更接近用户）。两层缺一不可：
 *   · 只留这里 ⇒ 结构对了、界面上却可能是一段空白；
 *   · 只留那里 ⇒ daemon 哪天又往结构里塞一句中文，没有任何东西会红。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { EngineUnavailableReason } from '@openmemo/shared';

import { resolveOfflineChineseModel, resolveStreamingModel } from './setup.js';

/*
 * ⚠️ 这里**不需要**清 `OPENMEMO_SHERPA_STREAM_DIR` / `OPENMEMO_PARAFORMER_DIR`
 * （`chineseEngineResolve.test.ts` 那边要清，是因为它走 `buildPipeline(paths)`，
 * 那条路读的是真的 `process.env`）。这两个解析器把 env **作为参数**收下，
 * 下面每一次调用都显式传了对象字面量 —— 夹具本身就是密闭的。
 * 顺手加两行 `delete` 看起来更稳，实则是一条会被后人当成"必需"的假纪律。
 */

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** 造一条与产品安装器同形的安装记录（blob + by-name 硬链两步）。 */
async function fakeInstall(
  modelsDir: string,
  spec: { id: string; files: { name: string; bytes: Buffer }[] },
): Promise<void> {
  const blobDir = join(modelsDir, 'blobs');
  const byName = join(modelsDir, 'by-name', 'asr');
  const manifestDir = join(modelsDir, 'manifests', 'asr');
  await mkdir(blobDir, { recursive: true });
  await mkdir(byName, { recursive: true });
  await mkdir(manifestDir, { recursive: true });

  const files = [];
  for (const f of spec.files) {
    const digest = sha256(f.bytes);
    await writeFile(join(blobDir, `sha256-${digest}`), f.bytes);
    const linked = join(byName, f.name);
    await rm(linked, { force: true });
    await link(join(blobDir, `sha256-${digest}`), linked);
    files.push({
      role: 'weights',
      name: f.name,
      sha256: digest,
      sizeBytes: f.bytes.length,
      root: 'models',
      relPath: `by-name/asr/${f.name}`,
      path: linked,
    });
  }
  await writeFile(
    join(manifestDir, `${spec.id.replace(/[^a-zA-Z0-9._-]+/g, '_')}.json`),
    JSON.stringify({ schemaVersion: 1, id: spec.id, role: 'asr', integrity: 'ok', files }, null, 2),
  );
}

async function freshModelsDir(tag: string): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), `om-eur-${tag}-`)), 'models');
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 把两个解析器**真跑一遍**，收齐它们能产出的每一种 `EngineUnavailableReason`。
 *
 * ⚠️ 刻意不手写字面量样本。手写的话，这一组测的是"我记得 daemon 会返回什么"，
 * 而不是 daemon 真的返回了什么 —— 有人往解析器里塞回一句中文时，
 * 手写样本一个字都不会变。夹具全部走真安装记录 + 真目录。
 */
async function collectReasons(): Promise<EngineUnavailableReason[]> {
  const out: EngineUnavailableReason[] = [];

  // ① 什么都没装 —— 两个引擎各一条 `model_not_installed`
  const empty = await freshModelsDir('empty');
  const s1 = await resolveStreamingModel(empty, {});
  const p1 = await resolveOfflineChineseModel(empty, {});
  if (s1.reason) out.push(s1.reason);
  if (p1.reason) out.push(p1.reason);

  /*
   * ② 装了、但盘上缺文件 —— `installed_but_files_incomplete`。
   *
   * 记录原封不动写着 tokens.txt，只把它的 blob 与 by-name 链删掉：
   * `looksLike*()` 按**记录**判 ⇒ 进候选；`materializeModelDir()` 找不到源
   * 就跳过它（不报错）⇒ 摊出来的目录里缺一件 ⇒ 解析失败。
   * 这正是真实世界里这一档的来源：**记录说文件在，文件不在了。**
   */
  const partial = await freshModelsDir('partial');
  const tokens = Buffer.from('TOKENS\n<blk> 0\n');
  await fakeInstall(partial, {
    id: 'asr/sherpa-streaming-zh-14m',
    files: [
      { name: 'encoder-epoch-99-avg-1.int8.onnx', bytes: Buffer.from('fake-onnx:encoder') },
      { name: 'decoder-epoch-99-avg-1.int8.onnx', bytes: Buffer.from('fake-onnx:decoder') },
      { name: 'joiner-epoch-99-avg-1.int8.onnx', bytes: Buffer.from('fake-onnx:joiner') },
      { name: 'tokens.txt', bytes: tokens },
    ],
  });
  await fakeInstall(partial, {
    id: 'asr/paraformer-zh-small',
    files: [
      { name: 'model.int8.onnx', bytes: Buffer.from('fake-onnx:paraformer') },
      { name: 'tokens.txt', bytes: tokens },
    ],
  });
  await rm(join(partial, 'blobs', `sha256-${sha256(tokens)}`), { force: true });
  await rm(join(partial, 'by-name', 'asr', 'tokens.txt'), { force: true });
  const s2 = await resolveStreamingModel(partial, {});
  const p2 = await resolveOfflineChineseModel(partial, {});
  if (s2.reason) out.push(s2.reason);
  if (p2.reason) out.push(p2.reason);

  // ③ 环境变量指向一个空目录 —— 两个变量各一条 `override_dir_incomplete`
  const bogus = await freshModelsDir('override');
  const s3 = await resolveStreamingModel(bogus, { OPENMEMO_SHERPA_STREAM_DIR: bogus });
  const p3 = await resolveOfflineChineseModel(bogus, { OPENMEMO_PARAFORMER_DIR: bogus });
  if (s3.reason) out.push(s3.reason);
  if (p3.reason) out.push(p3.reason);

  return out;
}

describe('#112 ④：`EngineUnavailableReason` 这一格里不许出现中文', () => {
  /**
   * CJK 表意文字 + CJK 标点（、。「」）+ 全角形式（（），；）。
   *
   * ⚠️ **写 `\u` 转义，不写字面量**：范围首字符是 U+3000 全角空格，
   * 直接写进正则会被 eslint 的 `no-irregular-whitespace` 判红，
   * 而且在 diff 里根本看不出来。（同一条也记在
   * `packages/downloader/src/rateLimitReason.test.ts` 与 `components.test.tsx` 里。）
   */
  const CJK = /[\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF]/;

  it('前提检查：这条正则真的抓得到汉字与全角标点（否则本组全是空转）', () => {
    // 这三句正是被删掉的那三句原文的片段 —— 它们必须被抓到。
    assert.equal(CJK.test('未安装流式中文模型'), true);
    assert.equal(CJK.test('，但文件不完整（缺 *.onnx 或 tokens.txt）'), true);
    assert.equal(CJK.test('去「模型」页装'), true);
    // 反向：纯英文 + 半角标点不许误报，否则下面每条都会"红得毫无意义"
    assert.equal(CJK.test('no model is installed (install one on the Models page)'), false);
  });

  it('★★ 两个解析器能产出的每一种原因，序列化之后都不含 CJK', async () => {
    const reasons = await collectReasons();
    /*
     * ⚠️ 样本数是**断言**，不是注释：夹具哪天造不出某一档（比如安装记录格式变了、
     * 或者有人给解析器加了一条提前返回），`reasons` 会静默变短，
     * 而"对着 0 条样本断言不含中文"是永远绿的。
     */
    assert.equal(reasons.length, 6, `样本数不对，夹具没造出全部分档：${JSON.stringify(reasons)}`);
    for (const r of reasons) {
      const json = JSON.stringify(r);
      assert.equal(CJK.test(json), false, `引擎不可用原因里混进了中文：${json}`);
    }
  });

  it('★ 三档一个都不许少（少一档 = 上面那条在更小的集合上空转）', async () => {
    const kinds = [...new Set((await collectReasons()).map((r) => r.kind))].sort();
    /*
     * `engine_probe_text` 不在这里：它不由这两个解析器产出，而是
     * `packages/pipeline` 的 `buildCandidates()` 交上来的英文原话，
     * 由 `main.ts` / `http/rest/selfcheck.ts` 现场包上信封。
     * 那一档的"不许翻译、如实标注是原文"钉在 web 那一侧的用例里。
     */
    assert.deepEqual(kinds, [
      'installed_but_files_incomplete',
      'model_not_installed',
      'override_dir_incomplete',
    ]);
  });

  it('★ 结构化字段里装的是**数据**：id 列表与变量名照实交出，没有被拼进句子', async () => {
    const reasons = await collectReasons();

    const incomplete = reasons.filter((r) => r.kind === 'installed_but_files_incomplete');
    assert.equal(incomplete.length, 2, 'sherpa 与 Paraformer 各应有一条');
    assert.deepEqual(
      incomplete.flatMap((r) =>
        r.kind === 'installed_but_files_incomplete' ? [...r.installedIds] : [],
      ),
      ['asr/sherpa-streaming-zh-14m', 'asr/paraformer-zh-small'],
      '已装 id 必须照实列出来 —— 说不出是哪一个装坏了，用户就不知道该重装哪一个',
    );

    const overrides = reasons.filter((r) => r.kind === 'override_dir_incomplete');
    assert.deepEqual(
      overrides.map((r) => (r.kind === 'override_dir_incomplete' ? r.envVar : '')),
      ['OPENMEMO_SHERPA_STREAM_DIR', 'OPENMEMO_PARAFORMER_DIR'],
      '排障时必须知道是**哪个**变量指错了，只说"用不了"等于没说',
    );
    for (const o of overrides) {
      assert.ok(
        o.kind === 'override_dir_incomplete' && o.dir.length > 0,
        '变量指向的那个目录也必须交出去，否则他不知道该去看哪里',
      );
    }
  });
});
