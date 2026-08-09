/**
 * `buildCatalog()` 的组代表文案（`descriptionZh/En`/`tags`/`displayName`/`license`）
 * 必须来自"该组里最值得信任的那个变体"，不能只是"清单数组里排第一个"。
 *
 * ## 这条守的是什么（Manager 2026-08-10 点名的两个真实事故）
 *
 * - `asr/whisper-tiny`：质量警示曾经只写在 `whisper-tiny-f16`（既不随包也不是默认档），
 *   随包默认档 `whisper-tiny-q5_1` 排数组第一位、原文无警示 —— 真实用户永远看不到
 *   这句话。已把警示文案挪到 `whisper-tiny-q5_1` 自己的 `descriptionZh/En`
 *   （见 `vendor/manifests/models-whisper.json`），这里断言它真的会被 `buildCatalog()`
 *   选中、送到 API 响应里。
 * - `vad/silero-vad`：清单里 `silero-vad-onnx` 排第一位，旧逻辑会让组描述讲
 *   "sherpa-onnx 专用格式，whisper.cpp 用不了这个文件"；而**随包内置、真正落进
 *   用户机器的是 `silero-vad-ggml`**（{@link BUNDLED_MODEL_IDS}）——描述文字与用户
 *   实际拿到的文件正好说反。
 *
 * ## 判据是结构式的，不是关键词匹配
 *
 * 断言的是**对象相等**（`group.descriptionZh === 某个具名变体.descriptionZh`），
 * 不是"整段文字里是否出现某个词"——后一种判据既会被同义改写绕过，也会被页面别处
 * 恰好出现同一个词误报为通过（今天已经在 B11 那条判据上吃过这个亏）。
 * 拿到这个结构式结果之后，剩下"它是否会逐字渲染进卡片"这一段，由
 * `apps/web/src/test/components.test.tsx`（"目录描述里的 Markdown 强调不许把裸星号
 * 吐给用户"那条）验证 —— 两段拼起来才是"真实用户会看到这句话"的完整证据链，
 * 单独一段都不够。
 *
 * ## 为什么两个用例都要有：一个证明"实际生产数据是对的"，一个证明"机制本身对"
 *
 * 第一个用例直接用真清单（`vad/silero-vad`、`asr/whisper-tiny`）——证明的是
 * **当下**这份数据经过 `buildCatalog()` 之后确实讲对了话。
 *
 * 第二个用例把 `asr/whisper-large-v3-turbo` 组的两个真实变体**颠倒顺序**塞进
 * 临时清单（`recommended-default` 标签在原清单里恰好也排第一位，直接用原顺序测
 * 不出"顺序被打乱还对不对"）——证明的是**优先级机制本身**不依赖数组顺序，而不是
 * 恰好当下的排列凑对了。这正是"清单被重排"或"新变体插进中间"这类以后一定会发生
 * 的改动最终会不会静默讲错话的分界线。
 */
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-catalog-rank-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import { SseHub } from '../sse.js';
import { RestState } from './state.js';

const MANIFEST_DIR = fileURLToPath(new URL('../../../../../vendor/manifests', import.meta.url));

function realModels(file: string): Record<string, unknown>[] {
  const raw = JSON.parse(readFileSync(join(MANIFEST_DIR, file), 'utf8')) as {
    models?: Record<string, unknown>[];
  };
  return raw.models ?? [];
}

async function seedCatalog(models: Record<string, unknown>[]): Promise<RestState> {
  const dataDir = mkdtempSync(join(TEST_ROOT, 'data-'));
  process.env['OPENMEMO_MODELS'] = join(dataDir, 'models');
  const manifestDir = mkdtempSync(join(TEST_ROOT, 'manifests-'));
  await writeFile(
    join(manifestDir, 'models-test.json'),
    JSON.stringify({
      schemaVersion: 1,
      catalogVersion: '2026.08.10',
      generatedAt: '2026-08-10T00:00:00.000Z',
      models,
    }),
    'utf8',
  );
  return RestState.create({ sse: new SseHub(), dataDir, manifestDir });
}

describe('buildCatalog(): 组代表文案不能只看"清单数组第一个"', () => {
  it('★★ 真清单：vad/silero-vad 组描述必须来自随包内置的 ggml，不是排第一的 onnx', async () => {
    const support = realModels('models-asr-support.json');
    const vad = support.filter((m) => m['groupId'] === 'vad/silero-vad');
    assert.equal(vad.length, 2, '真清单里 vad/silero-vad 应该正好两个变体（onnx + ggml）');
    const onnx = vad.find((m) => m['id'] === 'vad/silero-vad-onnx');
    const ggml = vad.find((m) => m['id'] === 'vad/silero-vad-ggml');
    assert.ok(onnx && ggml, '真清单里缺了 onnx 或 ggml 变体 —— 这个测试的前提没了，先查清单');
    // 清单里的真实顺序就是 onnx 排第一 —— 这正是旧 bug 复现的顺序，不用特意颠倒。
    assert.equal(support.indexOf(onnx!) < support.indexOf(ggml!), true, '前提：onnx 在 ggml 前面');

    const state = await seedCatalog(vad);
    const catalog = await state.buildCatalog('all', null);
    const group = catalog.groups.find((g) => g.groupId === 'vad/silero-vad');
    assert.ok(group, '组没有出现在 buildCatalog() 的结果里');

    assert.equal(
      group!.descriptionZh,
      ggml!['descriptionZh'],
      '组描述应该等于随包内置的 ggml 变体的文案（结构相等），不是排第一的 onnx',
    );
    assert.notEqual(
      group!.descriptionZh,
      onnx!['descriptionZh'],
      '组描述不该讲成 onnx 那份——那份文件根本没有随包，用户装到的是 ggml',
    );
  });

  it('★★ 真清单：asr/whisper-tiny 组描述必须来自随包默认档 q5_1，且带上质量警示', async () => {
    const whisper = realModels('models-whisper.json');
    const tiny = whisper.filter((m) => m['groupId'] === 'asr/whisper-tiny');
    assert.ok(tiny.length >= 2, '真清单里 asr/whisper-tiny 变体太少 —— 前提没了');
    const q5_1 = tiny.find((m) => m['id'] === 'asr/whisper-tiny-q5_1');
    const f16 = tiny.find((m) => m['id'] === 'asr/whisper-tiny-f16');
    assert.ok(q5_1 && f16, '真清单里缺了 q5_1 或 f16 变体');

    const state = await seedCatalog(tiny);
    const catalog = await state.buildCatalog('all', null);
    const group = catalog.groups.find((g) => g.groupId === 'asr/whisper-tiny');
    assert.ok(group, '组没有出现在 buildCatalog() 的结果里');

    assert.equal(
      group!.descriptionZh,
      q5_1!['descriptionZh'],
      '组描述应该等于随包默认档 q5_1 的文案（结构相等）',
    );
    assert.notEqual(
      group!.descriptionZh,
      f16!['descriptionZh'],
      '组描述不该讲成 f16 那份——那份既不随包也不是默认档，真实用户装到的是 q5_1',
    );
    // 不做关键词匹配；只确认代表文案确实换成了带警示的那一版（对象相等已经证明这点），
    // 这里再补一条粗粒度的健全性检查：新文案不能是旧的、不带任何警示的短版本。
    assert.equal(
      (group!.descriptionZh as string).length > 20,
      true,
      '拿到的描述短得不像带了警示文案的那一版，回去检查 manifest 是否真的改了',
    );
  });

  it('★ 机制本身：即使把带 recommended-default 标签的变体排到数组第二位，组描述仍然选它', async () => {
    const whisper = realModels('models-whisper.json');
    const turbo = whisper.filter((m) => m['groupId'] === 'asr/whisper-large-v3-turbo');
    assert.ok(turbo.length >= 2, '真清单里 asr/whisper-large-v3-turbo 变体太少 —— 前提没了');
    const tagged = turbo.find(
      (m) => Array.isArray(m['tags']) && (m['tags'] as string[]).includes('recommended-default'),
    );
    const untagged = turbo.find((m) => m !== tagged);
    assert.ok(tagged && untagged, '真清单里缺了带标签或不带标签的变体');
    assert.notEqual(
      tagged!['descriptionZh'],
      untagged!['descriptionZh'],
      '前提：两个变体的文案必须不同，否则这条测不出选中了谁',
    );

    // ★ 关键：故意把带标签的那个放在数组第二位 —— 真清单里它现在恰好排第一，
    // 直接用原顺序测不出"顺序被打乱还对不对"，必须颠倒过来才是在测机制本身。
    const reordered = [untagged!, tagged!];
    assert.notEqual(
      reordered[0],
      tagged,
      '前提：颠倒后带标签的变体不再是数组第一个',
    );

    const state = await seedCatalog(reordered);
    const catalog = await state.buildCatalog('all', null);
    const group = catalog.groups.find((g) => g.groupId === 'asr/whisper-large-v3-turbo');
    assert.ok(group, '组没有出现在 buildCatalog() 的结果里');

    assert.equal(
      group!.descriptionZh,
      tagged!['descriptionZh'],
      '带 recommended-default 标签的变体即使排第二，也该赢过排第一但没有标签的那个',
    );
  });
});
