/**
 * T-148 的护栏：**「装了 VAD」不等于「whisper.cpp 能用它」，而且失败必须说得出原因。**
 *
 * ## 这些用例守的是一次真实事故，不是假想风险
 *
 * `[CI 实测]` cold-start-audit run 31039460495：linux-x64 与 win32-x64 上，
 * 一次干净机器的真实转写死在同一句话上 ——
 *
 * ```
 * whisper-vad-speech-segments exited with code 2
 * read_audio_data: trying to decode with miniaudio
 * error: failed to initialize whisper context
 * ```
 *
 * `[本机实测]`（仓库自带的 `for-tests-silero-v6.2.0-ggml.bin`，sha256 与清单
 * `vad/silero-vad-ggml` 逐字符一致；二进制用的是 CI 装的那一个上游包）复现出三条：
 *
 * 1. 传空路径、传不存在的路径、传 sherpa 的 `silero_vad.onnx` —— **输出逐字节相同**，
 *    因为 `-np` 把 whisper 自己那句 `invalid model data (bad magic)` 关掉了；
 * 2. 去掉 `-np` 之后，同一次失败会多出那两行，一眼定位；
 * 3. `-vspd`（例子自己的 `--help` 里写着的 flag，parser 里**没有**）
 *    → `error: unknown argument` → **`exit(0)` + 空 stdout** → 读起来像"没有语音"
 *    → 零 chunk → **空转写 + 绿灯**。
 *
 * ## 读断言前先读这句
 *
 * 每一条钉的都是**后果**：argv 里有没有那个会吞诊断的开关、拿不到结果时是不是当场出声、
 * VAD 跑挂了整单转写还活不活得下来。不钉注释里的关键词 —— 注释改了不该变红。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GGML_FILE_MAGIC, isGgmlModelFile } from '@openmemo/downloader';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildVadFlags,
  detectSpeechSegments,
  interpretVadRun,
  parseVadOutput,
  planAudioChunks,
  type SpeechSegment,
} from '../vad.js';
import type { ToolPaths } from '../../tools.js';

const TOOLS = (
  vadModel: string | null,
  whisperVad: string | null = '/fake/whisper-vad',
): ToolPaths => ({
  ffmpeg: '/fake/ffmpeg',
  ffprobe: '/fake/ffprobe',
  whisperCli: '/fake/whisper-cli',
  whisperVad,
  vadModel,
  ytDlp: null,
});

/** ggml 权重落盘的头四字节（小端）。用常量算出来，不手抄字面量。 */
const MAGIC_LE = ((): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(GGML_FILE_MAGIC, 0);
  return b;
})();

/** VAD 跑成功时返回的东西，用来证明成功路径没被这些改动动过。 */
const OK_SEGMENTS: SpeechSegment[] = [
  { startMs: 320, endMs: 2270 },
  { startMs: 3270, endMs: 4410 },
];

describe('ggml 魔数判定（whisper.cpp 加载得了吗）', () => {
  it('★ 常量与上游头文件一致；注意落盘顺序是 "lmgg" 不是 "ggml"', () => {
    // vendor/whisper.cpp/ggml/include/ggml.h:216 —— #define GGML_FILE_MAGIC 0x67676d6c
    assert.equal(GGML_FILE_MAGIC, 0x67676d6c);
    /*
     * 这个常量按**大端**看才拼成 "ggml"，而 ggml 是按小端写盘的 ——
     * `[本机实测]` 真权重头四字节是 6c 6d 67 67，`xxd` 出来是 "lmgg"。
     * 谁按直觉写 `Buffer.from('ggml')` 造夹具，谁就会得到一个永远不通过的判定
     * （本条第一版就是这么红的，留在这里免得下一个人再来一遍）。
     */
    assert.equal(Buffer.from('ggml', 'latin1').readUInt32BE(0), GGML_FILE_MAGIC);
    assert.equal(MAGIC_LE.toString('latin1'), 'lmgg');
  });

  it('★ 判据是内容不是文件名：名字叫 .bin 的 ONNX 一样要被否掉', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vadfix-magic-'));
    const ggml = join(dir, 'looks-wrong.onnx');
    const onnx = join(dir, 'ggml-silero-v6.2.0.bin'); // ← 名字完全"对"，内容不对
    await writeFile(ggml, Buffer.concat([MAGIC_LE, Buffer.alloc(64)]));
    // ONNX 是 protobuf，头一个字节是字段 tag 0x08，绝不会是 "ggml"
    await writeFile(onnx, Buffer.from([0x08, 0x07, 0x12, 0x0c, 0x00, 0x00, 0x00, 0x00]));

    assert.equal(await isGgmlModelFile(ggml), true, '内容是 ggml 就该通过，哪怕后缀是 .onnx');
    assert.equal(await isGgmlModelFile(onnx), false, '内容不是 ggml 就该被否，哪怕名字一模一样');
  });

  it('不存在 / 是目录 / 不足四字节 —— 一律 false，绝不抛', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vadfix-magic2-'));
    const tooShort = join(dir, 'short.bin');
    await writeFile(tooShort, Buffer.from('gg', 'latin1'));
    assert.equal(await isGgmlModelFile(join(dir, 'nope.bin')), false);
    // 目录：access(R_OK) 对它返回成功，而 std::ifstream 打开目录在 glibc 上也"成功" ——
    // 这正是旧自检给出假绿灯的形状之一。
    assert.equal(await isGgmlModelFile(dir), false);
    assert.equal(await isGgmlModelFile(tooShort), false);
    assert.equal(await isGgmlModelFile(''), false);
    assert.equal(await isGgmlModelFile(null), false);
  });
});

describe('buildVadFlags —— 失败原因不许被开关吞掉', () => {
  /** 只保留成对的 `-x value`，用来做"结构"断言而不是"某个字符串在不在"。 */
  const pairs = (flags: string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let i = 0; i < flags.length; i += 1) {
      const f = flags[i] as string;
      if (
        f.startsWith('-') &&
        flags[i + 1] !== undefined &&
        !(flags[i + 1] as string).startsWith('-')
      ) {
        out[f] = flags[i + 1] as string;
        i += 1;
      }
    }
    return out;
  };

  it('★ 绝不能出现 `-np`：它会把 whisper 五种加载失败压成同一句话', () => {
    /*
     * 这一条钉的是**后果**：带上 `-np` 时，"模型路径为空 / 文件不存在 / 格式不对"
     * 三种失败在 stderr 上逐字节相同（本机用 CI 那个上游二进制实测过），
     * 于是 CI 拿到的错误信息里没有任何能定位的东西。
     * 它是一个 argv 元素，不是注释里的关键词 —— 改注释不会让这条变红。
     */
    const flags = buildVadFlags('/models/ggml-silero-v6.2.0.bin', '/tmp/audio16k.wav', {
      threshold: 0.5,
      minSpeechDurationMs: 250,
      maxSpeechDurationSec: 30,
      speechPadMs: 30,
      threads: 2,
    });
    assert.equal(flags.includes('-np'), false);
    assert.equal(flags.includes('--no-prints'), false);
  });

  it('★ 模型路径必须是紧跟 `-vm` 的**独立**一个 argv 元素', () => {
    const flags = buildVadFlags('/models/a b/ggml-silero.bin', '/tmp/audio16k.wav');
    assert.deepEqual(pairs(flags)['-vm'], '/models/a b/ggml-silero.bin');
    assert.deepEqual(pairs(flags)['-f'], '/tmp/audio16k.wav');
  });

  it('★ min-speech-duration 走长写法：`-vspd` 不存在，`-vsd` 含义会翻', () => {
    /*
     * 两个坑，一个比一个安静：
     * ① `-vspd` 出现在例子自己的 --help 里（speech.cpp:37），parser 里**没有这个分支**。
     *    `[本机实测]`：`-vspd 250` → `error: unknown argument` → **exit 0 + 空 stdout**，
     *    读起来正好等于"这段音频没有语音" —— 零 chunk、空转写、job 成功。
     * ② `-vsd` 今天是 min-**speech**（parser:67 先命中），而 usage:38 说它是 min-**silence**。
     *    上游无论往哪边对齐，这个短写法都可能**改变含义而不改变形状**（两边都收整数、都 exit 0）。
     * 长写法在现状与任何一种修法下都只有一个意思，所以它是唯一不会在我们脚下翻的拼法。
     */
    const flags = buildVadFlags('/m.bin', '/a.wav', { minSpeechDurationMs: 250 });
    assert.equal(flags.includes('-vspd'), false, 'parser 里没有它 → exit(0) + 空 stdout');
    assert.equal(flags.includes('-vsd'), false, '含义与它自己的 --help 相反，会在升级时静默翻转');
    assert.equal(pairs(flags)['--vad-min-speech-duration-ms'], '250');
  });

  it('只发 parser 真的认识、且**只有一个意思**的开关', () => {
    /*
     * 允许集 = speech.cpp:62-72 里**长写法唯一绑定**的那些，加上三个无歧义的短写法。
     * 刻意**不**放 `-vsd` / `-vspd`：前者一名两义，后者根本不存在。
     * `--vad-min-silence-duration-ms` 也不在里面 —— 它被绑到了 min-speech 那个变量上。
     */
    const SUPPORTED = new Set([
      '-f',
      '-t',
      '-vm',
      '--vad-threshold',
      '--vad-min-speech-duration-ms',
      '--vad-max-speech-duration-s',
      '--vad-speech-pad-ms',
    ]);
    const flags = buildVadFlags('/m.bin', '/a.wav', {
      threshold: 0.4,
      minSpeechDurationMs: 100,
      maxSpeechDurationSec: 20,
      speechPadMs: 10,
      threads: 8,
    });
    const unknown = flags.filter((f) => f.startsWith('-') && !SUPPORTED.has(f));
    assert.deepEqual(
      unknown,
      [],
      `这些 flag 要么例子不认识（exit 0 + 空 stdout），要么一名两义：${unknown.join(' ')}`,
    );
    // 前提自检：真的发出了那四个可调项，否则上面那条对空集恒真
    assert.equal(flags.filter((f) => f.startsWith('--')).length, 4);
  });
});

describe('interpretVadRun —— "exit 0" 不等于"跑过了"', () => {
  const run = (stdout: string, code = 0) => ({ stdout, stderr: '', code });

  it('★ exit 0 + 空 stdout 必须抛，不能当成"这段音频没有语音"', () => {
    /*
     * 这正是 `-vspd` 那次的真实输出：`error: unknown argument` 打到 stderr，
     * 然后 `exit(0)`、stdout 一个字节都没有。
     * 解析器本身分不出这两种情况 —— 所以这道闸必须和"拿到段落"绑在同一个函数里。
     */
    assert.equal(parseVadOutput('').length, 0, '前提：解析器对空输入返回空数组，看起来完全正常');
    assert.throws(() => interpretVadRun(run('')), /no result header/);
  });

  it('★ 0 段但带结果头，是**真答案**，不许被当成失败', () => {
    assert.deepEqual(interpretVadRun(run('\nDetected 0 speech segments:\n\n')), []);
  });

  it('有段落时按厘秒换算成毫秒', () => {
    assert.deepEqual(
      interpretVadRun(
        run('\nDetected 1 speech segments:\nSpeech segment 0: start = 32.00, end = 227.00\n'),
      ),
      [{ startMs: 320, endMs: 2270 }],
    );
  });

  it('usage 文本（例子把 --help 打到 stderr、stdout 全空）不算答案', () => {
    assert.throws(
      () =>
        interpretVadRun({
          stdout: '',
          stderr: 'usage: whisper-vad-speech-segments [options] file',
          code: 0,
        }),
      /no result header/,
    );
  });

  it('抛出来的话里要带上退出码与实际输出，否则又是一条查不动的错误', () => {
    try {
      interpretVadRun({
        stdout: 'nothing useful',
        stderr: 'error: unknown argument: -vspd',
        code: 0,
      });
      assert.fail('应该抛');
    } catch (e) {
      const m = (e as Error).message;
      assert.equal(m.includes('unknown argument: -vspd'), true);
      assert.equal(m.includes('nothing useful'), true);
    }
  });
});

describe('detectSpeechSegments 的入参防线', () => {
  it('★ 空字符串的模型路径必须被当成"没装"，不能当成一个路径传下去', async () => {
    /*
     * `??` 只拦 null/undefined。上游任何一处把默认值写成 `''`，旧的 `=== null` 判断
     * 就会放行，于是 argv 里出现 `-vm ""` —— whisper 报的还是那句一模一样的
     * `failed to initialize whisper context`，谁也看不出问题在哪。
     */
    await assert.rejects(
      () => detectSpeechSegments(TOOLS(''), '/tmp/a.wav', { cwd: '/tmp' }),
      /not installed/,
    );
  });

  it('组件没装时同样拒绝', async () => {
    await assert.rejects(
      () => detectSpeechSegments(TOOLS('/tmp/m.bin', null), '/tmp/a.wav', { cwd: '/tmp' }),
      /not installed/,
    );
  });
});

describe('planAudioChunks —— VAD 跑挂了，转写要活下来并且要出声', () => {
  const base = {
    wavPath: '/tmp/audio16k.wav',
    cwd: '/tmp',
    durationMs: 95_000,
  };

  it('★ VAD 抛错 → 退回固定窗口，而不是把整单转写打死', async () => {
    const ac = new AbortController();
    const plan = await planAudioChunks({
      ...base,
      tools: TOOLS('/tmp/silero_vad.onnx'),
      signal: ac.signal,
      detect: () => {
        // 与 CI 上拿到的那条一字不差（现在还多了 whisper 自己那两行）
        throw new Error(
          'whisper-vad-speech-segments exited with code 2\n' +
            'whisper_vad_init_with_params: invalid model data (bad magic)\n' +
            'error: failed to initialize whisper context\n',
        );
      },
    });

    assert.equal(plan.chunking, 'fixed');
    assert.equal(plan.chunks.length > 0, true, '固定窗口必须真的排出 chunk，否则等于没降级');
    // 95 s / 30 s 窗口 + 0.5 s 重叠 —— 钉的是"覆盖到了音频结尾"这个后果
    assert.equal(plan.chunks[0]?.startMs, 0);
    assert.equal(plan.chunks[plan.chunks.length - 1]?.endMs, 95_000);
  });

  it('★ 退回时必须留下一条给人看的话，而且带得上原始失败原因', async () => {
    const ac = new AbortController();
    const plan = await planAudioChunks({
      ...base,
      tools: TOOLS('/tmp/silero_vad.onnx'),
      signal: ac.signal,
      detect: () => {
        throw new Error('invalid model data (bad magic)\n第二行不该出现在提示里');
      },
    });
    /*
     * 判据是「这条降级说得出原因」，不是「文案长什么样」：
     * 只断言 warnings 非空，等于允许一句 "出错了" 蒙混过关。
     */
    assert.equal(plan.warningsZh.length, 1);
    assert.equal(plan.warningsZh[0]?.includes('bad magic'), true, '必须带上真正的失败原因');
    assert.equal(
      plan.warningsZh[0]?.includes('第二行'),
      false,
      '只取首行，别把 2 KB stderr 灌进 UI',
    );
  });

  it('★ 用户点了取消时**不许**降级 —— 取消必须一路传出去', async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () =>
        planAudioChunks({
          ...base,
          tools: TOOLS('/tmp/m.bin'),
          signal: ac.signal,
          detect: () => {
            throw new Error('cancelled');
          },
        }),
      /cancelled/,
      '把「停止」悄悄变成「换个更差的切分继续跑」是另一种谎',
    );
  });

  it('VAD 没装 → 固定窗口，但**不**产生告警（那是正常状态，报了就是假红灯）', async () => {
    const ac = new AbortController();
    const plan = await planAudioChunks({
      ...base,
      tools: TOOLS(null, null),
      signal: ac.signal,
      detect: () => {
        throw new Error('不该被调用');
      },
    });
    assert.equal(plan.chunking, 'fixed');
    assert.equal(plan.warningsZh.length, 0);
  });

  it('成功路径没有被这些改动动过：按静音切分、零告警', async () => {
    const ac = new AbortController();
    const plan = await planAudioChunks({
      ...base,
      tools: TOOLS('/tmp/ggml-silero.bin'),
      signal: ac.signal,
      detect: () => Promise.resolve(OK_SEGMENTS),
    });
    assert.equal(plan.chunking, 'vad');
    assert.equal(plan.warningsZh.length, 0);
    assert.equal(plan.speechMs, 1950 + 1140);
    assert.equal(plan.chunks.length, 1);
  });

  it('VAD 跑通但确实没有语音 → 零 chunk，且**不**当成失败', async () => {
    const ac = new AbortController();
    const plan = await planAudioChunks({
      ...base,
      tools: TOOLS('/tmp/ggml-silero.bin'),
      signal: ac.signal,
      detect: () => Promise.resolve([]),
    });
    assert.equal(plan.chunking, 'vad');
    assert.equal(plan.chunks.length, 0);
    assert.equal(plan.warningsZh.length, 0);
  });
});
