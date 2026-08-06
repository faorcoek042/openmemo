/**
 * T-160 ①：**F3 与 ADR-013 的中文引擎被一个没人设置的环境变量永久闸死。**
 *
 * ## 事故形状
 *
 * `SherpaOnnxEngine` / `ParaformerEngine` 都是真实现，但 `setup.ts` 里长这样：
 *
 * ```
 * const streamDir = env['OPENMEMO_SHERPA_STREAM_DIR'];   // 剥注释后全仓 1 读 0 写
 * if (streamDir) { … 才构造引擎 … }
 * ```
 *
 * `[本机实测]` 这两个变量**只有那一处读、全仓 0 处写** —— 没有任何产品路径、脚本、
 * workflow 设置它们。于是：
 *   · F3 录音转文字三平台一样死（live `streamAvailable:false`，点录音回 `ASR_STREAM_UNAVAILABLE`）；
 *   · ADR-013「中文默认引擎 = Paraformer / 84x 实时」**从落笔到今天一次都没生效过**。
 * 最要命的是它**不报错、也不显示"未启用"**：把模型装好也一样死，因为这段代码
 * 根本不看安装记录。与 `decodeOmpk` 零调用方 / `RemediationButton` 零 importer 同族。
 *
 * ## 这些用例钉的是什么
 *
 * 不是"某个函数返回了某个字符串"，是**产品判据本身**：
 *   ① 没装 → 明说"未安装 + 去哪装"，而不是静默不可用；
 *   ② 装上 → `streamAvailable` / `paraformerAvailable` 翻成 true，
 *      **且全程一个环境变量都没设**（用例开头显式断言它们是 undefined ——
 *      否则这条用例可能只是证明了"环境变量还能用"）。
 *
 * ③ 还钉了一条**顺手查出来的、此前没人提过的**事故：sherpa 流式模型与 Paraformer
 *    **都带一个叫 `tokens.txt` 的文件**，两条都是 `role: asr`，于是都硬链到
 *    `by-name/asr/tokens.txt`，后装的把先装的顶掉，而两条安装记录仍然都指着它。
 *    后果不是"装不上"，是**装上了、跑起来了、词表是别人的**。
 *    用例里先复现这次覆盖（断言 `by-name` 上的那份确实被顶了），再断言两个引擎
 *    各自拿到的仍是自己那一份。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { AppPaths } from '../config/paths.js';
import { buildPipeline } from './setup.js';

/*
 * 环境在**模块顶层**清干净，不用 after() 还原（PROTOCOL §9-bis：
 * node:test 一个测试文件一个子进程，进程一退就没了；"写完记得擦"靠不住）。
 *
 * 这四个变量必须清掉，否则这些用例可能在跑机器上"碰巧绿"：
 * 前两个正是本次要拆掉的那道闸，后两个会让 whisper 的解析走别的分支。
 */
delete process.env['OPENMEMO_SHERPA_STREAM_DIR'];
delete process.env['OPENMEMO_PARAFORMER_DIR'];
delete process.env['OPENMEMO_PUNCT_DIR'];
delete process.env['OPENMEMO_MODELS'];
delete process.env['OPENMEMO_ASR_MODEL'];
delete process.env['OPENMEMO_VAD_MODEL'];

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

interface FakeFile {
  readonly name: string;
  readonly bytes: Buffer;
}

/**
 * 造一条**和产品安装器写出来的形状一致**的安装记录。
 *
 * 刻意走 blob + by-name 硬链两步（而不是直接写文件）：`tokens.txt` 那次覆盖
 * 只有在这个真实布局下才会发生，直接写文件就复现不出来了。
 */
async function fakeInstall(
  modelsDir: string,
  spec: { id: string; role: string; family?: string; files: FakeFile[] },
): Promise<void> {
  const bucket = spec.role;
  const blobDir = join(modelsDir, 'blobs');
  const byName = join(modelsDir, 'by-name', bucket);
  const manifestDir = join(modelsDir, 'manifests', bucket);
  await mkdir(blobDir, { recursive: true });
  await mkdir(byName, { recursive: true });
  await mkdir(manifestDir, { recursive: true });

  const files = [];
  for (const f of spec.files) {
    const digest = sha256(f.bytes);
    const blob = join(blobDir, `sha256-${digest}`);
    await writeFile(blob, f.bytes);
    const linked = join(byName, f.name);
    // 与 ArtifactStore.linkByName 一字不差：先 rm 再 link —— 同名文件就是这么被顶掉的
    await rm(linked, { force: true });
    await link(blob, linked);
    files.push({
      role: 'weights',
      name: f.name,
      sha256: digest,
      sizeBytes: f.bytes.length,
      root: 'models',
      relPath: `by-name/${bucket}/${f.name}`,
      path: linked,
    });
  }

  const record = {
    schemaVersion: 1,
    id: spec.id,
    role: spec.role,
    ...(spec.family ? { family: spec.family } : {}),
    integrity: 'ok',
    files,
  };
  const safe = spec.id.replace(/[^a-zA-Z0-9._-]+/g, '_');
  await writeFile(join(manifestDir, `${safe}.json`), JSON.stringify(record, null, 2));
}

const onnx = (tag: string): Buffer => Buffer.from(`fake-onnx:${tag}`);

/** sherpa 流式 transducer 的四件套，文件名照抄上游发布包。 */
const STREAM_FILES: FakeFile[] = [
  { name: 'encoder-epoch-99-avg-1.int8.onnx', bytes: onnx('encoder') },
  { name: 'decoder-epoch-99-avg-1.int8.onnx', bytes: onnx('decoder') },
  { name: 'joiner-epoch-99-avg-1.int8.onnx', bytes: onnx('joiner') },
  { name: 'tokens.txt', bytes: Buffer.from('STREAM-TOKENS\n<blk> 0\n') },
];

/** Paraformer 的三件套。**注意它也叫 tokens.txt** —— 这就是撞车的那一对。 */
const PARAFORMER_FILES: FakeFile[] = [
  { name: 'model.int8.onnx', bytes: onnx('paraformer') },
  { name: 'tokens.txt', bytes: Buffer.from('PARAFORMER-TOKENS\n<blk> 0\n') },
  { name: 'am.mvn', bytes: Buffer.from('mvn') },
];

async function freshPaths(tag: string): Promise<AppPaths> {
  const dataDir = await mkdtemp(join(tmpdir(), `om-cn-${tag}-`));
  const modelsDir = join(dataDir, 'models');
  await mkdir(modelsDir, { recursive: true });
  await mkdir(join(dataDir, 'tmp'), { recursive: true });
  return {
    dataDir,
    dbFile: join(dataDir, 'openmemo.db'),
    runtimeDir: join(dataDir, 'runtime'),
    runtimeJson: join(dataDir, 'runtime', 'runtime.json'),
    backupsDir: join(dataDir, 'backups'),
    logsDir: join(dataDir, 'logs'),
    tmpDir: join(dataDir, 'tmp'),
    mediaDir: join(dataDir, 'media'),
    modelsDir,
    extensionsDir: join(dataDir, 'bin', 'ext'),
  };
}

describe('中文/流式引擎：判据是"模型装没装"，不是"环境变量设没设"', () => {
  it('闸门不在因果链上了 —— 这三个环境变量在本文件里全程 undefined', () => {
    // 这条不是形式主义：没有它，下面所有"翻成 true"的断言都可能只是证明了
    // "环境变量那条老路还能走"，而那正是本次要拆掉的东西。
    assert.equal(process.env['OPENMEMO_SHERPA_STREAM_DIR'], undefined);
    assert.equal(process.env['OPENMEMO_PARAFORMER_DIR'], undefined);
    assert.equal(process.env['OPENMEMO_PUNCT_DIR'], undefined);
  });

  it('没装模型时**明说未安装**，而不是静默不可用', async () => {
    const paths = await freshPaths('empty');
    const bundle = await buildPipeline(paths);

    assert.equal(bundle.streamAvailable, false);
    assert.equal(bundle.streamModelId, 'none');
    assert.equal(bundle.paraformerAvailable, false);

    const ids = bundle.unavailableEngines.map((e) => e.id).sort();
    assert.deepEqual(ids, ['paraformer', 'sherpa-onnx']);

    // 原因必须**可操作** —— "不可用"三个字等于没说。UI 直接渲染这句话。
    for (const e of bundle.unavailableEngines) {
      assert.ok(e.reasonZh.length > 0, `${e.id} 缺原因`);
      assert.match(e.reasonZh, /未安装/, `${e.id} 的原因没说清是"没装"：${e.reasonZh}`);
      assert.match(e.reasonZh, /模型/, `${e.id} 的原因没告诉用户去哪装：${e.reasonZh}`);
    }
  });

  it('装上流式中文模型 → streamAvailable 翻成 true（零环境变量）', async () => {
    const paths = await freshPaths('stream');
    await fakeInstall(paths.modelsDir, {
      id: 'asr/sherpa-streaming-zh-14m',
      role: 'asr',
      family: 'sherpa-zipformer',
      files: STREAM_FILES,
    });

    const bundle = await buildPipeline(paths);

    assert.equal(bundle.streamModelId, 'streaming-zipformer-zh-14M');
    assert.equal(
      bundle.unavailableEngines.find((e) => e.id === 'sherpa-onnx'),
      undefined,
      '模型已装，引擎就必须被构造出来',
    );
    assert.equal(
      bundle.streamAvailable,
      true,
      '装上模型后 F3 必须真的可用。若这里红了而上面两条绿，说明卡在 sherpa-onnx-node ' +
        '原生模块加载上（那是另一条独立缺陷，不是这道闸）',
    );
    // 引擎候选里真的多了一条，`selectEngine` 才可能选到它
    assert.ok(bundle.candidates.some((c) => c.engine.id === 'sherpa-onnx'));
  });

  it('装上 Paraformer → ADR-013 的中文默认引擎第一次真的可用', async () => {
    const paths = await freshPaths('para');
    await fakeInstall(paths.modelsDir, {
      id: 'asr/paraformer-zh-small',
      role: 'asr',
      family: 'paraformer',
      files: PARAFORMER_FILES,
    });

    const bundle = await buildPipeline(paths);

    assert.equal(
      bundle.unavailableEngines.find((e) => e.id === 'paraformer'),
      undefined,
      '模型已装，引擎就必须被构造出来',
    );
    assert.equal(bundle.paraformerAvailable, true);
    // 按语言挑引擎：中文必须落到 Paraformer 而不是 whisper（ADR-013 决策 1）
    assert.equal(bundle.pipelineFor('zh').engineId, 'paraformer');
  });

  it('两个中文模型同时装：`by-name/asr/tokens.txt` 会被顶掉，但引擎各自拿到自己的那份', async () => {
    const paths = await freshPaths('both');
    await fakeInstall(paths.modelsDir, {
      id: 'asr/sherpa-streaming-zh-14m',
      role: 'asr',
      family: 'sherpa-zipformer',
      files: STREAM_FILES,
    });
    // 后装的这个会把 by-name/asr/tokens.txt 顶掉 —— 先证明这次覆盖**真的发生了**，
    // 否则下面那两条断言可能只是在验证一个不存在的危险。
    await fakeInstall(paths.modelsDir, {
      id: 'asr/paraformer-zh-small',
      role: 'asr',
      family: 'paraformer',
      files: PARAFORMER_FILES,
    });

    const clobbered = await readFile(join(paths.modelsDir, 'by-name', 'asr', 'tokens.txt'), 'utf8');
    assert.match(
      clobbered,
      /PARAFORMER-TOKENS/,
      'by-name 上那份 tokens.txt 应当已被后装的 Paraformer 顶掉 —— 覆盖没发生的话这条用例就失去意义了',
    );

    const bundle = await buildPipeline(paths);
    assert.equal(bundle.streamAvailable, true, '两个都装了，流式仍必须可用');
    assert.equal(bundle.paraformerAvailable, true, '两个都装了，离线中文仍必须可用');

    // 每个模型独占一个目录，各自的 tokens 不串
    const streamTokens = await readFile(
      join(paths.modelsDir, 'by-model', 'asr_sherpa-streaming-zh-14m', 'tokens.txt'),
      'utf8',
    );
    const paraTokens = await readFile(
      join(paths.modelsDir, 'by-model', 'asr_paraformer-zh-small', 'tokens.txt'),
      'utf8',
    );
    assert.match(streamTokens, /STREAM-TOKENS/, '流式引擎拿到了 Paraformer 的词表');
    assert.match(paraTokens, /PARAFORMER-TOKENS/, 'Paraformer 拿到了流式模型的词表');
  });
});
