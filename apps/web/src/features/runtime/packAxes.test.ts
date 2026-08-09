/**
 * T-192 —— **`pack.backend` 这个轴被当成三个用了**，三个问题各自该由什么回答。
 *
 * ## 缺陷原状（`[实测 2026-08-10]`，目录 25 个包里命中 18 个）
 *
 * 18 = 全部非 `whisper.cpp` 的包（sqlite-ext 11 + yt-dlp 4 + ffmpeg 3），
 * **它们的 `backend` 全是 `'cpu'`** —— 而那个字段的含义是「用哪块算力跑推理」。
 *
 *   ① 「设为当前后端」→ `select(pack.backend)`：在 libsimple / yt-dlp / ffmpeg 卡上
 *      点一下 = **一键把 whisper 从 GPU 静默降级到 CPU**，`/models` 显存预算归零。
 *   ② `isActive = selectedBackend === pack.backend && installed` →
 *      一个 SQLite 分词扩展的卡片上写着「CPU ⚡使用中」。
 *   ③ `isLoadBearing = tier==='builtin' || backend==='cpu'` → 这 18 个包**永远删不掉**
 *      （清单里没有任何 `builtin`），而 daemon 照删不误 ——
 *      用户想回收磁盘空间，产品里没有任何路径。
 *
 * ## 把名字遮住，这些断言什么时候会失败
 *
 * 任何人把这三个判据里的 `engine` 那一问去掉、退回只看 `pack.backend`；
 * 或者反过来为了让 yt-dlp 能删，**把 whisper CPU 包的保护一起拆了**
 * （下面有专门的阴性对照钉住它）；
 * 或者新加一种 engine 时在穷尽表里顺手填一个"先能用"的值。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BACKEND_IS_COMPUTE_AXIS, isActivePack, isLoadBearingPack } from './packStatus';

/** `[实测]` 目录里真实存在的四类包（engine → 一条代表）。 */
const WHISPER_CPU = {
  engine: 'whisper.cpp',
  backend: 'cpu',
  tier: 'downloadable',
  installed: true,
} as const;
const WHISPER_VULKAN = {
  engine: 'whisper.cpp',
  backend: 'vulkan',
  tier: 'downloadable',
  installed: true,
} as const;
const FFMPEG = { engine: 'ffmpeg', backend: 'cpu', tier: 'downloadable', installed: true } as const;
const YTDLP = { engine: 'yt-dlp', backend: 'cpu', tier: 'downloadable', installed: true } as const;
const LIBSIMPLE = {
  engine: 'sqlite-ext',
  backend: 'cpu',
  tier: 'downloadable',
  installed: true,
} as const;

const NON_INFERENCE = [FFMPEG, YTDLP, LIBSIMPLE];

describe('T-192 ①：「设为当前后端」只对算力轴上的包有意义', () => {
  it('★ 非推理包不在算力轴上 —— 那个按钮不该出现在它们的卡片上', () => {
    for (const p of NON_INFERENCE) {
      assert.equal(
        BACKEND_IS_COMPUTE_AXIS[p.engine],
        false,
        `${p.engine} 被当成算力轴 ⇒ 用户在它的卡上点一下会把 whisper 静默降级到 CPU`,
      );
    }
  });

  it('★ whisper.cpp 在算力轴上（阴性对照：不许把闸门焊死在 false 上）', () => {
    assert.equal(BACKEND_IS_COMPUTE_AXIS['whisper.cpp'], true);
  });

  it('★ 穷尽表必须覆盖 schema 允许的全部 engine —— 少一个就是默默继承隐含假设', () => {
    // 与 `SELF_TEST_APPLIES` 同一条理由：新加 engine 要在编译期表态。
    const keys = Object.keys(BACKEND_IS_COMPUTE_AXIS).sort();
    assert.deepEqual(keys, [
      'ffmpeg',
      'llama.cpp',
      'sherpa-onnx',
      'sqlite-ext',
      'whisper.cpp',
      'yt-dlp',
    ]);
  });
});

describe('T-192 ②：「⚡使用中」不许出现在非推理包上', () => {
  it('★ 默认 selectedBackend=cpu 时，18 个非推理包一个都不许亮「使用中」', () => {
    for (const p of NON_INFERENCE) {
      assert.equal(
        isActivePack(p, 'cpu'),
        false,
        `${p.engine} 的卡片上写着「CPU ⚡使用中」—— 它根本不是"正在使用的后端"`,
      );
    }
  });

  it('★ 阴性对照：whisper CPU 包在 selectedBackend=cpu 时**必须**亮（否则只是焊死成 false）', () => {
    assert.equal(isActivePack(WHISPER_CPU, 'cpu'), true);
  });

  it('★ 选的是别的后端时不亮', () => {
    assert.equal(isActivePack(WHISPER_CPU, 'vulkan'), false);
    assert.equal(isActivePack(WHISPER_VULKAN, 'vulkan'), true);
  });

  it('★ 没装的包不算"使用中"', () => {
    assert.equal(isActivePack({ ...WHISPER_CPU, installed: false }, 'cpu'), false);
  });

  it('★ selectedBackend 还没拿到时不下结论', () => {
    assert.equal(isActivePack(WHISPER_CPU, undefined), false);
    assert.equal(isActivePack(WHISPER_CPU, null), false);
  });
});

describe('T-192 ③：能不能卸载，判据对准 ggml SIGABRT 那条真实约束', () => {
  it('★ 非推理包必须可卸载 —— 用户要能回收磁盘空间', () => {
    for (const p of NON_INFERENCE) {
      assert.equal(
        isLoadBearingPack(p),
        false,
        `${p.engine} 被锁成"承重墙"⇒ 永远删不掉，而 daemon 照删不误 —— ` +
          `UI 挡下的是一个服务端支持的合法动作`,
      );
    }
  });

  it('★ 阴性对照：whisper 的 CPU 兜底**仍然**锁着（删了它 ggml 会 SIGABRT）', () => {
    assert.equal(
      isLoadBearingPack(WHISPER_CPU),
      true,
      '为了让 yt-dlp 能删就把 whisper CPU 的保护一起拆了 —— 那是放宽，不是对准判据',
    );
  });

  it('★ whisper 的加速包可以卸载（它不是兜底）', () => {
    assert.equal(isLoadBearingPack(WHISPER_VULKAN), false);
  });

  it('★ `tier: builtin` 的推理包也锁着（随安装器出厂的那一档）', () => {
    assert.equal(isLoadBearingPack({ ...WHISPER_VULKAN, tier: 'builtin' }), true);
    // 但 builtin 的非推理包不该被这条锁住 —— 理由是 ASR 专属的
    assert.equal(isLoadBearingPack({ ...YTDLP, tier: 'builtin' }), false);
  });
});
