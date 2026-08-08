/**
 * T-139 A3 —— `.ompk` 解码，以及**那个编波形的函数不许回来**。
 *
 * ## 为什么现在才有测试
 *
 * `decodeOmpk` 写好很久了，**一个调用方都没有**：详情页那段逻辑是反的 ——
 * 有真 peaks 资产时 `setPeaks(null)`（把真数据丢掉），没有时 `mockPeaks()`（造一份）。
 * 而 daemon 全仓零处产出 peaks 资产，所以**每一位用户看到的每一条波形都是编的**，
 * 界面上一个字都不说。修好之后 `decodeOmpk` 第一次上了产品路径，它得有测试。
 *
 * ## fixture 的来历
 *
 * 下面的字节是按 D-02 §3.4 的格式**在测试里现造**的，不是抄来的常量 ——
 * 同样的字节被写进临时 dataDir、经真 daemon 的 `/media/asset/<uid>` 发出、
 * 由真浏览器 fetch + 解码并画了出来（取证见 `coordination/inbox/notes-contract.md` §A3）。
 * 这里钉的是解码规则本身。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import * as peaksModule from './peaks';
import { decodeOmpk } from './peaks';

/** 按 D-02 §3.4 拼一个合法 `.ompk`。 */
function ompk(
  opts: { magic?: string; version?: number; channels?: number; values?: number[][] } = {},
) {
  const channels = opts.channels ?? 1;
  const values = opts.values ?? [[127, -127, 64, 0]];
  const perChannel = values[0]!.length;
  const buf = new ArrayBuffer(14 + perChannel * channels);
  const view = new DataView(buf);
  const magic = opts.magic ?? 'OMPK';
  for (let i = 0; i < 4; i += 1) view.setUint8(i, magic.charCodeAt(i));
  view.setUint8(4, opts.version ?? 1);
  view.setUint8(5, channels);
  view.setUint32(6, 256, true); // samplesPerPixel
  view.setUint32(10, 3000, true); // durationMs
  const body = new Int8Array(buf, 14);
  for (let c = 0; c < channels; c += 1) {
    for (let i = 0; i < perChannel; i += 1) body[c * perChannel + i] = values[c]![i]!;
  }
  return buf;
}

describe('decodeOmpk', () => {
  it('头部三个数按格式读出来（大端 magic + 小端 u32，写反了会安静地解出垃圾）', () => {
    const d = decodeOmpk(ompk());
    assert.equal(d.durationMs, 3000);
    assert.equal(d.samplesPerPixel, 256);
    assert.equal(d.channels.length, 1);
  });

  /*
   * ⚠️ 逐个比而不是 `deepEqual` 整个数组：解出来的是 **Float32Array**，
   * `64/127` 在 float32 里是 0.5039370059967041，在 float64 里是 0.5039370078740157 ——
   * 直接 deepEqual 会因为最后几位而红，那种红灯只会训练人去改断言。
   * 容差 1e-6 远小于"一个像素柱高"的量级，钉得住真正的错（比如除以 128 或忘了归一化）。
   */
  const near = (got: Float32Array, want: number[], msg?: string): void => {
    assert.equal(got.length, want.length, msg);
    for (let i = 0; i < want.length; i += 1) {
      assert.ok(
        Math.abs((got[i] ?? NaN) - want[i]!) < 1e-6,
        `${msg ?? ''} 第 ${i} 个值：期望 ≈${want[i]}，实际 ${got[i]}`,
      );
    }
  };

  it('★ 值归一化到 −1..1（wavesurfer 与我们的 canvas 都按这个值域画）', () => {
    const d = decodeOmpk(ompk({ values: [[127, -127, 64, 0]] }));
    near(d.channels[0]!, [1, -1, 64 / 127, 0]);
  });

  it('多声道各自成一个数组（交错存放，别把第二声道读成第一声道的尾巴）', () => {
    const d = decodeOmpk(
      ompk({
        channels: 2,
        values: [
          [127, 0],
          [-127, 64],
        ],
      }),
    );
    assert.equal(d.channels.length, 2);
    near(d.channels[0]!, [1, 0], '第一声道');
    near(d.channels[1]!, [-1, 64 / 127], '第二声道');
  });

  it('★ 坏数据必须抛，不能"尽力解出一点"—— 半份波形和编的波形一样是谎', () => {
    assert.throws(() => decodeOmpk(ompk({ magic: 'XXXX' })), /magic/);
    assert.throws(() => decodeOmpk(ompk({ version: 2 })), /版本/);
    assert.throws(() => decodeOmpk(new ArrayBuffer(8)), /过短/);
  });
});

describe('T-139 A3 —— mockPeaks 已删除', () => {
  it('★ 这个模块不许再导出 mockPeaks（回归护栏，与 MINDMAP_SAVE_SUPPORTED 同一手法）', () => {
    /*
     * 判据不是"调用方现在没用它"，是"它不存在"。
     * 留着一个 `mockPeaks` 在手边，下一个人看到空波形就会顺手拿它顶上 ——
     * 而那正是这次的 bug：一条编出来的波形不是占位符，它是在对用户断言
     * 这段音频长什么样。用户看到的每一个具体东西，要么来自后端，要么根本不提。
     */
    assert.equal(
      Object.prototype.hasOwnProperty.call(peaksModule, 'mockPeaks'),
      false,
      'mockPeaks 又回来了 —— 详情页没有真 .ompk 时必须如实不画波形（Waveform 会画基线 + 可点击游标）',
    );
    assert.deepEqual(Object.keys(peaksModule).sort(), ['decodeOmpk']);
  });
});

describe('T-153 —— wavesurfer.js 不许回到 apps/web 的依赖里', () => {
  /*
   * 为什么这条护栏只能钉 package.json：
   *
   * 一个**零 import** 的依赖不会被 tsc 发现（没人引它）、不会被 eslint 发现
   * （没有 import 语句可查）、不会被任何现有测试发现（它不产生行为）。
   * `wavesurfer.js` 就是这么从第一个脚手架提交（`4018e23`）一路活到 T-153 的：
   * 三年零调用，唯一的成本是**让读代码的人以为波形是它画的**。
   *
   * 判据不是"有没有人 import 它"（那恒为 false，钉住的是零），
   * 是"**它在不在依赖清单里**" —— 那才是它唯一的存在形式。
   * 裁决理由写在 `peaks.ts` 文件头，不在这里重复。
   */
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('读到的确实是 apps/web 的 package.json（cwd 变了就当场说，别静默通过）', () => {
    /*
     * 这条守卫只挡"读错文件 ⇒ 下一条恒绿"，**不碰被检查的那个量**
     * （`pack-publish` 记过两次的坑：把非空守卫加在要报告的量上，
     * 真出问题时先炸的是守卫，而它不告诉你为什么）。
     */
    assert.equal(pkg.name, '@openmemo/web');
  });

  it('★ dependencies / devDependencies 里都不许出现 wavesurfer', () => {
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const hits = all.filter((d) => d.toLowerCase().includes('wavesurfer'));
    assert.deepEqual(
      hits,
      [],
      `wavesurfer 又回到依赖清单里了：${hits.join(', ')} —— 见 peaks.ts 文件头的裁决`,
    );
  });
});
