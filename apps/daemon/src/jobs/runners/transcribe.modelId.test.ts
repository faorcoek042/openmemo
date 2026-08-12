/**
 * `transcribe.started` 里那个 `modelId` —— **它一直在说假话。**
 *
 * ## 被钉住的缺陷
 *
 * 事件发的是 `deps.modelId`，也就是 **bundle 默认值**（`main.ts` 里
 * `getBundle().modelPath` 的 basename），**不是这次任务真正选中的那个**。
 * 而**同一个函数里 DB 行存的是对的** —— 库里是真话、事件里是假话，
 * 而用户只看得见事件。
 *
 * 它现在要紧：下一轮要做「换引擎 / 换模型重转」的选择器。
 * **事件说假话 ⇒ 用户没法验证自己真的换了模型。加了选择器却验不了，比不加更糟。**
 *
 * ## 为什么钉在纯函数这一层
 *
 * 三个真实坑里有两个**在本机和 CI 上都跑不出来**：
 *   · Windows 绝对路径没有 `/`，原来的 `.split('/').pop()` 原样返回整条路径；
 *   · sherpa / Paraformer 的 `modelPath` 是**目录**，可能带尾分隔符。
 * 起一个真 daemon 去复现"用户在 Windows 上选了 large-v3"既慢又做不到 ——
 * 而把取名判据抽成纯函数之后，这两种输入在 Linux 上就是两个字符串。
 * （同一课在 `isWithinImportRoots` 上付过账：宿主绑定的判断必须参数化才测得到。）
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runModelId } from './transcribe.js';

describe('#98 收尾：这次转写用的模型叫什么', () => {
  it('★★ 用户显式选的目录 id 优先 —— 那是他唯一能对上账的那串字', () => {
    assert.equal(
      runModelId('asr/whisper-large-v3-turbo-q5_0', '/models/by-name/asr/ggml-large-v3.bin', 'x'),
      'asr/whisper-large-v3-turbo-q5_0',
      '报权重文件名的话，用户在选择器里点的是 large-v3-turbo、看到的是另一串字，无从验证',
    );
  });

  it('★ 没有目录 id（自动选择）→ 报盘上那个真名，**不编**一个目录 id', () => {
    assert.equal(
      runModelId(undefined, '/models/by-name/asr/ggml-base.en.bin', 'fallback'),
      'ggml-base.en.bin',
      'active.json / OPENMEMO_ASR_MODEL / 手工拷进 by-name 的文件都没有目录条目',
    );
  });

  it('★★ Windows 绝对路径 —— 原来的 `.split("/")` 会原样吐回整条路径', () => {
    assert.equal(
      runModelId(undefined, 'C:\\Users\\runneradmin\\models\\ggml-base.en.bin', 'x'),
      'ggml-base.en.bin',
      '「模型名」变成一串本机绝对路径，还顺带把用户的目录结构广播了出去',
    );
  });

  it('★ sherpa / Paraformer 的 modelPath 是**目录**，目录名就是有意义的标识', () => {
    assert.equal(
      runModelId(undefined, '/models/by-name/asr/paraformer-zh-small', 'x'),
      'paraformer-zh-small',
    );
  });

  it('★★ 目录带尾分隔符也要给出同一个答案（两种写法都合法）', () => {
    for (const p of [
      '/models/by-name/asr/paraformer-zh-small/',
      'C:\\models\\paraformer-zh-small\\',
    ]) {
      assert.equal(runModelId(undefined, p, 'x'), 'paraformer-zh-small', `尾分隔符坑到了：${p}`);
    }
  });

  it('★ 什么都没有才回落到兜底值 —— 兜底不许伪装成"这次用的模型"', () => {
    assert.equal(runModelId(undefined, null, 'unknown'), 'unknown');
    assert.equal(runModelId(null, null, 'unknown'), 'unknown');
    // 空白的目录 id 不算数（`payload.modelId` 是外部传进来的字符串）
    assert.equal(runModelId('   ', '/m/ggml.bin', 'unknown'), 'ggml.bin');
  });
});
