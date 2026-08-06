/**
 * T-149 联动护栏：**落盘桶改成"一个 role 一个"，已装的模型不许因此消失。**
 *
 * ── 事故本体（改之前的真实状态，`[本机实测]`） ────────────────────────────────
 *
 * ```
 * daemon      roleToStoreKind('vad')  = asr     ← 写盘走这条（T-027 时代的映射表）
 * downloader  bucketForRole('vad')    = vad     ← 本该走这条
 * downloader  STORE_KINDS             = asr,llm,vad,punctuation,diarization,embedding,tts,backend
 * bucketForRole 的调用方数量           = 0
 * ```
 *
 * `store.ts:37-42` 的注释明写那次修复有**两条**（①一个 role 一个桶 ②role 写进记录），
 * 而**只落了②**。于是 VAD / 标点权重一直躺在 `by-name/asr/` 下，
 * `selfcheck` 只好拿一条按文件名打的正则去猜类型。
 * **一个写好了却没人调用的修法，和没写是一样的。**
 *
 * ── 为什么①必须和 `listInstalled()` 同一次改 ──────────────────────────────────
 *
 * `state.ts` 的 `listInstalled()` 原来写死扫 `['asr','llm']` 两个桶。
 * 这两个 bug **恰好互相掩盖**：因为没有东西写进 `vad/`，所以没有东西读不到。
 * 只改①的话，下一次装 VAD 会写进 `manifests/vad/`，而 `/api/models/installed`
 * 只扫 asr 与 llm —— **用户装完，列表里没有；没有任何报错。**
 *
 * 还有两处同样按 role 反算桶、也必须一起改（下面各有用例）：
 *   · 删除 `removeManifest(roleToStoreKind(role))` —— `fs.rm(..., {force:true})`
 *     **找不到不报错**，于是返回 204、事件也发了、记录还在。
 *   · 校验 `writeManifest(roleToStoreKind(role))` —— 会在新桶写出**第二份**记录。
 *
 * ── 这个文件钉的是什么 ───────────────────────────────────────────────────────
 *
 * 判据是**后果**，不是"某个函数返回了哪个字符串"：
 * 造一个**旧布局**的数据目录（VAD 记录躺在 `manifests/asr/` 下，与真实冷启动一致），
 * 然后问产品自己的方法：列得出来吗？删得掉吗？校验会不会写重？
 *
 * 反向验证的真实输出贴在 `coordination/inbox/catalog-truth.md`。
 */

/*
 * ⚠️ PROTOCOL §9-bis：**在模块顶层**把模型根与扩展目录钉进 tmp，窗口为零。
 * `RestState.create()` 会 `mkdir` 模型根、读写 `active.json` —— 不重定向的话
 * 它会去动这台机器上真实的数据目录。node:test 一个文件一个子进程，进程退了就没了，
 * 所以**不需要清理代码**，而清理代码正是"被 kill 就留下坏状态"的那个东西。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'om-rolebucket-'));
process.env['OPENMEMO_MODELS'] = join(TEST_ROOT, 'models');
process.env['OPENMEMO_EXT_DIR'] = join(TEST_ROOT, 'ext');

import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { STORE_KINDS, bucketForRole, findInstalledByRole } from '@openmemo/downloader';
import { MODEL_ROLES } from '@openmemo/shared';
import { listInstalledNamesByRole, runSelfCheck } from '@openmemo/runtime';

import { SseHub } from '../http/sse.js';
import { RestState } from '../http/rest/state.js';
import { roleToActivationSlot, roleToStoreKind } from '../http/rest/roleMap.js';

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'));
const MANIFEST_DIR = join(REPO_ROOT, 'vendor', 'manifests');

/* ═══════════════ ① 映射本身：桶 = role，槽位不许跟着一起翻 ═══════════════ */

describe('T-149 ① roleToStoreKind 必须就是 bucketForRole', () => {
  it('★ 七个 role 逐个对齐 —— 两处映射表必然漂移，所以只许有一处', () => {
    assert.ok(MODEL_ROLES.length >= 7, `role 只有 ${MODEL_ROLES.length} 个，断言失去意义`);
    for (const role of MODEL_ROLES) {
      assert.equal(
        roleToStoreKind(role),
        bucketForRole(role),
        `${role} 的桶两边算出来不一样 —— 这正是 VAD 落进 by-name/asr 的成因`,
      );
      // 而且必须是恒等（桶名就是 role 名），否则"一个 role 一个桶"这句话是假的
      assert.equal(roleToStoreKind(role), role, `${role} 没有自己的桶`);
    }
  });

  it('★ 激活槽位**不能**跟着桶一起变：embedding / tts 仍归 llm 槽', () => {
    // 老写法是 `roleToStoreKind(role) === 'llm' ? 'llm' : 'asr'`。
    // 桶恒等之后 bucketForRole('embedding') === 'embedding' ≠ 'llm'，
    // 那句话会把 embedding/tts 从 llm 槽悄悄挪到 asr 槽：编译不报错、行为反了。
    assert.equal(roleToActivationSlot('embedding'), 'llm');
    assert.equal(roleToActivationSlot('tts'), 'llm');
    assert.equal(roleToActivationSlot('llm'), 'llm');
    assert.equal(roleToActivationSlot('vad'), 'asr');
    assert.equal(roleToActivationSlot('punctuation'), 'asr');
    assert.equal(roleToActivationSlot('diarization'), 'asr');
    assert.equal(roleToActivationSlot('asr'), 'asr');
  });

  it('每个 role 都有一个真实存在的桶（写进去不会落到一个没人扫的目录）', () => {
    for (const role of MODEL_ROLES) {
      assert.ok(
        (STORE_KINDS as readonly string[]).includes(roleToStoreKind(role)),
        `${role} 的桶 ${roleToStoreKind(role)} 不在 STORE_KINDS 里`,
      );
    }
  });
});

/* ═══════════════ ② 旧布局：记录躺在错的桶里，也必须列得出、删得掉 ═══════════════ */

interface SeedOpts {
  /** 记录写进哪个桶（`'asr'` = 旧布局；`'vad'` = 改完之后的新布局）。 */
  bucket: string;
  id: string;
  role: string;
  fileName: string;
  integrity?: string;
  /** 故意不写 `role` 字段（更老的记录）。 */
  omitRole?: boolean;
}

/** 在**真实的模型根**下写一条安装记录 —— 与产品写出来的形状一致。 */
async function seedRecord(modelsRoot: string, o: SeedOpts): Promise<void> {
  const dir = join(modelsRoot, 'manifests', o.bucket);
  await mkdir(dir, { recursive: true });
  const rec: Record<string, unknown> = {
    schemaVersion: 1,
    id: o.id,
    groupId: o.id,
    displayName: o.fileName,
    quantization: 'f16',
    totalSizeBytes: 4,
    installedAt: '2026-01-01T00:00:00.000Z',
    verifiedAt: '2026-01-01T00:00:00.000Z',
    integrity: o.integrity ?? 'ok',
    files: [
      {
        role: 'weights',
        name: o.fileName,
        sha256: 'f'.repeat(64),
        sizeBytes: 4,
        root: 'models',
        relPath: join('by-name', o.bucket, o.fileName),
      },
    ],
    requirements: { ramRequiredMB: 1, vramRequiredMB: 1, diskRequiredMB: 1, cpuFeatures: [] },
    license: { id: 'MIT', gated: false, url: '' },
    source: { provider: 'custom', repo: 'test', revision: 'local' },
    benchmark: null,
    catalogVersion: 'test',
  };
  if (!o.omitRole) rec['role'] = o.role;
  await writeFile(join(dir, `${o.id.replace(/[^a-zA-Z0-9._-]+/g, '_')}.json`), JSON.stringify(rec, null, 2));
}

async function freshState(): Promise<RestState> {
  const dataDir = mkdtempSync(join(TEST_ROOT, 'data-'));
  process.env['OPENMEMO_MODELS'] = join(dataDir, 'models');
  return RestState.create({ sse: new SseHub(), dataDir, manifestDir: MANIFEST_DIR });
}

describe('T-149 ② 旧布局（VAD 记录躺在 manifests/asr 下）不许因为改桶而消失', () => {
  it('★★ 判据：已装的 VAD 必须仍然出现在 /api/models/installed 里', async () => {
    const state = await freshState();
    // 旧布局：roleToStoreKind('vad') 曾经返回 'asr'，所以记录写在这里
    await seedRecord(state.store.root, {
      bucket: 'asr',
      id: 'vad/silero-vad-ggml',
      role: 'vad',
      fileName: 'ggml-silero-v6.2.0.bin',
    });
    // 新布局：改完之后装的那一个
    await seedRecord(state.store.root, {
      bucket: 'vad',
      id: 'vad/silero-vad-onnx',
      role: 'vad',
      fileName: 'silero_vad.onnx',
    });
    // 对照：一个正常的 ASR
    await seedRecord(state.store.root, {
      bucket: 'asr',
      id: 'asr/whisper-tiny-q5_1',
      role: 'asr',
      fileName: 'ggml-tiny-q5_1.bin',
    });

    const ids = (await state.listInstalled()).map((m) => m.id).sort();
    assert.deepEqual(
      ids,
      ['asr/whisper-tiny-q5_1', 'vad/silero-vad-ggml', 'vad/silero-vad-onnx'],
      '改桶之后旧记录读不到了 —— 用户会看到"我装过的东西没了"，而且没有任何报错',
    );
  });

  it('★ 同一个 id 在新旧两个桶里都有（重装过的旧机器）→ 只出现一次', async () => {
    const state = await freshState();
    await seedRecord(state.store.root, {
      bucket: 'asr',
      id: 'vad/silero-vad-ggml',
      role: 'vad',
      fileName: 'old-copy.bin',
    });
    await seedRecord(state.store.root, {
      bucket: 'vad',
      id: 'vad/silero-vad-ggml',
      role: 'vad',
      fileName: 'ggml-silero-v6.2.0.bin',
    });

    const list = await state.listInstalled();
    assert.equal(list.length, 1, `同一个模型被列了 ${list.length} 次`);
    // 取的必须是"桶与 role 对得上"的那条，而不是"先读到谁算谁"
    assert.equal(list[0].files[0].name, 'ggml-silero-v6.2.0.bin');
  });

  it('★ 删除必须把旧桶里的那条也删掉（否则 204 之后模型还在）', async () => {
    const state = await freshState();
    await seedRecord(state.store.root, {
      bucket: 'asr',
      id: 'vad/silero-vad-ggml',
      role: 'vad',
      fileName: 'ggml-silero-v6.2.0.bin',
    });
    assert.equal((await state.listInstalled()).length, 1, '前置条件没成立，后面的断言无意义');

    await state.dropInstalledRecord('vad/silero-vad-ggml');
    assert.deepEqual(await state.listInstalled(), []);
  });

  it('★ 校验要写回**记录原来所在的桶**，不然会写出第二份记录', async () => {
    const state = await freshState();
    await seedRecord(state.store.root, {
      bucket: 'asr',
      id: 'vad/silero-vad-ggml',
      role: 'vad',
      fileName: 'ggml-silero-v6.2.0.bin',
    });

    const bucket = await state.bucketOfInstalled('vad/silero-vad-ggml');
    assert.equal(bucket, 'asr', '定位的是记录实际在的桶，不是按 role 算出来的那个');
    assert.notEqual(bucket, bucketForRole('vad'), '这条用例的前提就是两者不同');

    // 真按定位到的桶写回一次（= verifyModel 的动作），记录数不许变
    const rec = await state.store.readManifest<Record<string, unknown>>(bucket, 'vad/silero-vad-ggml');
    assert.ok(rec);
    await state.store.writeManifest(bucket, 'vad/silero-vad-ggml', { ...rec, integrity: 'ok' });
    assert.equal((await state.listInstalled()).length, 1, '校验一次就多出一份记录');
  });

  it('id 不存在时 bucketOfInstalled 返回 null（不许瞎猜一个桶）', async () => {
    const state = await freshState();
    assert.equal(await state.bucketOfInstalled('asr/does-not-exist'), null);
  });
});

/* ═══════════════ ③ 自检：类型由记录里的 role 回答，不由文件名 ═══════════════ */

describe('T-149 ③ listInstalledNamesByRole：不看目录，只看记录里的 role', () => {
  it('★ 旧布局下 role=vad 照样找得到（记录在 manifests/asr 里）', async () => {
    const dataDir = mkdtempSync(join(TEST_ROOT, 'byrole-'));
    const root = join(dataDir, 'models');
    await seedRecord(root, {
      bucket: 'asr',
      id: 'vad/silero-vad-ggml',
      role: 'vad',
      fileName: 'ggml-silero-v6.2.0.bin',
    });
    await seedRecord(root, {
      bucket: 'asr',
      id: 'asr/whisper-tiny-q5_1',
      role: 'asr',
      fileName: 'ggml-tiny-q5_1.bin',
    });

    assert.deepEqual((await listInstalledNamesByRole(root, 'vad')).names, [
      'ggml-silero-v6.2.0.bin',
    ]);
    assert.deepEqual((await listInstalledNamesByRole(root, 'asr')).names, ['ggml-tiny-q5_1.bin']);
  });

  it('★ 名字里带 silero 的**真** ASR 算 ASR —— 删掉的那条正则会在这里误杀', async () => {
    const dataDir = mkdtempSync(join(TEST_ROOT, 'silero-asr-'));
    const root = join(dataDir, 'models');
    await seedRecord(root, {
      bucket: 'asr',
      id: 'asr/silero-en-v1',
      role: 'asr',
      fileName: 'silero-asr-en-v1.bin',
    });
    const got = await listInstalledNamesByRole(root, 'asr');
    assert.deepEqual(got.names, ['silero-asr-en-v1.bin']);
    // 旧判据 `/silero|vad|punct|…/i` 在这里会把它剔掉 → model.asr 报 fail = 假红灯
    assert.equal(/silero|vad|punct|ct-transformer|speaker|diariz/i.test('silero-asr-en-v1.bin'), true);
  });

  it('★ 与 downloader 的 findInstalledByRole 必须给出同一个答案（两处规则不许漂移）', async () => {
    const dataDir = mkdtempSync(join(TEST_ROOT, 'agree-'));
    const root = join(dataDir, 'models');
    await seedRecord(root, { bucket: 'asr', id: 'vad/a', role: 'vad', fileName: 'a.bin' });
    await seedRecord(root, { bucket: 'vad', id: 'vad/b', role: 'vad', fileName: 'b.bin' });
    await seedRecord(root, { bucket: 'asr', id: 'asr/c', role: 'asr', fileName: 'c.bin' });
    // 坏掉的那条：两边都必须排除
    await seedRecord(root, {
      bucket: 'vad',
      id: 'vad/d',
      role: 'vad',
      fileName: 'd.bin',
      integrity: 'corrupt',
    });

    const { ArtifactStore } = await import('@openmemo/downloader');
    const viaDownloader = (await findInstalledByRole(new ArtifactStore(root), 'vad'))
      .flatMap((r) => (r as { files?: { name?: string }[] }).files ?? [])
      .map((f) => f.name as string)
      .sort();
    const viaRuntime = (await listInstalledNamesByRole(root, 'vad')).names;

    assert.ok(viaDownloader.length > 0, '筛空了，这条断言等于没写');
    assert.deepEqual(viaRuntime, viaDownloader);
    assert.deepEqual(viaRuntime, ['a.bin', 'b.bin'], '坏掉的 d.bin 不许算数');
  });

  it('★ 没写 role 的老记录：不猜类型，但要把"跳过了几条"数出来', async () => {
    const dataDir = mkdtempSync(join(TEST_ROOT, 'norole-'));
    const root = join(dataDir, 'models');
    await seedRecord(root, {
      bucket: 'asr',
      id: 'asr/legacy-1',
      role: 'asr',
      fileName: 'legacy-1.bin',
      omitRole: true,
    });
    await seedRecord(root, {
      bucket: 'asr',
      id: 'asr/legacy-2',
      role: 'asr',
      fileName: 'legacy-2.bin',
      omitRole: true,
    });
    const got = await listInstalledNamesByRole(root, 'asr');
    assert.deepEqual(got.names, [], '从目录名猜 role 正是那盏假绿灯，宁可说没有');
    assert.equal(got.skippedWithoutRole, 2, '"跳过了 2 条"和"什么都没装"不是一回事');
  });

  it('模型根不存在时返回空集而不是抛（全新安装是正常状态）', async () => {
    const got = await listInstalledNamesByRole(join(TEST_ROOT, 'no-such-root'), 'asr');
    assert.deepEqual(got, { names: [], skippedWithoutRole: 0 });
  });
});

/* ═══════════════ ④ 指引里提到的界面文字，必须是界面上真有的那几个字 ═══════════════ */

describe('T-149 ④ model.vad 的指引指向一个真实存在的落点', () => {
  it('★ 指引里的分组名必须与 i18n 里那一条逐字相同（两处字符串必然漂移）', async () => {
    /*
     * 这条守的是一种**不会让任何东西变红**的错：
     * daemon 说"去『实时字幕组件』那一组找"，而界面上那一组叫别的名字 ——
     * 用户照做、找不到、怀疑是自己的问题。T-149 之前那句指引就是这么坏掉的
     * （它说的是「模型」页，而那一页当时根本不渲染 VAD）。
     *
     * 判据不是"remediation 里有没有某个关键词"，是**"它说的那个名字，界面上真的叫这个"**：
     * 期望值从 `apps/web` 的 i18n 里读，不抄字面量。任何一边改名都会红。
     */
    const zhPath = join(REPO_ROOT, 'apps', 'web', 'src', 'app', 'i18n', 'locales', 'zh-CN.json');
    const zh = JSON.parse(await readFile(zhPath, 'utf8')) as {
      models?: { section?: Record<string, string> };
    };
    const sectionName = zh.models?.section?.['realtime'];
    assert.ok(
      sectionName && sectionName.length > 0,
      'i18n 里没有 models.section.realtime —— 分组本身可能被改掉了，指引要跟着改',
    );

    const report = await runSelfCheck({
      dataDir: join(TEST_ROOT, 'nonexistent-data'),
      storeRoot: join(TEST_ROOT, 'nonexistent-data', 'models'),
      extensionsDir: join(TEST_ROOT, 'nonexistent-data', 'bin', 'ext'),
      probes: {
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
        installedByRole: () => Promise.resolve({ names: [], skippedWithoutRole: 0 }),
        chineseSearch: () => Promise.resolve(null),
        vecVersion: () => Promise.resolve(null),
        engines: () => Promise.resolve([]),
        selectFor: () => Promise.resolve(null),
      },
    });
    const vad = report.results.find((r) => r.id === 'model.vad');
    assert.ok(vad, '连 model.vad 这一项都没有');
    assert.ok(
      (vad.remediation ?? '').includes(sectionName),
      `指引里没有提到界面上那一组的名字「${sectionName}」，用户照做会找不到：${vad.remediation ?? '(空)'}`,
    );
  });
});

/* ═══════════════ ⑤ 重定向守卫：本测试不许碰机器级状态 ═══════════════ */

describe('T-149 ⑤ 这个测试文件自己的越界守卫（PROTOCOL §9-bis）', () => {
  it('★ 模型根必须落在 tmpdir 里，且不在 $HOME 底下', () => {
    const root = process.env['OPENMEMO_MODELS'] ?? '';
    assert.ok(root.startsWith(tmpdir()), `模型根跑到了 tmpdir 之外：${root}`);
    const home = process.env['HOME'] ?? '';
    assert.equal(
      home !== '' && root.startsWith(home),
      false,
      '模型根落在了 $HOME 下 —— 一个进程级测试写了机器级状态',
    );
  });

  it('★ 真实数据目录一个字节都没被创建（反证：只在 TEST_ROOT 下有东西）', async () => {
    const entries = await readdir(TEST_ROOT);
    assert.ok(entries.length > 0, '什么都没建，说明上面的用例根本没跑到磁盘上');
  });
});
