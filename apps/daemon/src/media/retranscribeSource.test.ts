/**
 * 重跑判据（#95）。
 *
 * ## 这些用例守的是一句**曾经真的在对用户撒的谎**
 *
 * 旧判据是 `media_sources.input_url != null` —— 只判非空。而那一列存的是绝对路径，
 * 全仓没有任何一处在数据目录搬家时更新它。于是搬完家：音频照播（`rel_path` 迁过了）、
 * 按钮照亮、`POST` 回 202、job 事后死在 `no media source can handle this input`，
 * 而笔记详情页对此一个字都不显示。
 *
 * `[实测]` demo 库（`/root/data-memo`，4 条笔记）里 note 1/2 的 `input_url` 分别是
 * `/tmp/dd55/media/long.wav` 与 `/tmp/omdemo/jfk.wav` —— 都在当前数据目录之外，
 * 而它们的音频好好地躺在 `<dataDir>/media/` 里。**下面 `searchGuide` 那条用例
 * 复刻的就是这个形状**，它必须判"能重跑"（走归档原件那一档），
 * 否则这次修复就把一批本来能用的笔记变成了永久灰。
 *
 * ⚠️ 判据不能退化成 `existsSync`：空文件（0 字节）转不了，悬空软链 `access` 也可能
 * 说"能"。所以下面每一条"能重跑"的断言，前提都是**真的写了字节进去**。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { looksLikeUrl, resolveRetranscribeSource } from './retranscribeSource.js';

const ROOT = mkdtempSync(join(tmpdir(), 'om-retranscribe-'));
after(async () => {
  await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

interface FakeAsset {
  readonly role: string;
  readonly rel_path: string;
}

/**
 * 只喂 `resolveRetranscribeSource` 真正用到的两个方法。
 *
 * 用结构化假实现而不是开真库：这个函数的全部逻辑都在**文件系统**那一侧，
 * 用真 SQLite 只会让用例变慢，并且把"路径判断"的失败伪装成"建库失败"。
 */
function deps(
  dataDir: string,
  source: { kind: string; input_url: string | null } | undefined,
  assets: FakeAsset[] = [],
) {
  return {
    dataDir,
    repos: {
      primarySourceOf: () => (source === undefined ? undefined : { id: 1, ...source }),
      assetsOfNote: () => assets,
    },
  } as unknown as Parameters<typeof resolveRetranscribeSource>[0];
}

/** 造一份数据目录：`<root>/<name>/media` 一并建好，返回 dataDir。 */
async function makeDataDir(name: string): Promise<string> {
  const dataDir = join(ROOT, name);
  await fs.mkdir(join(dataDir, 'media'), { recursive: true });
  return dataDir;
}

async function writeFileWithBytes(abs: string, body = 'RIFFxxxxWAVE'): Promise<string> {
  await fs.mkdir(join(abs, '..'), { recursive: true });
  await fs.writeFile(abs, body);
  return abs;
}

describe('looksLikeUrl —— 与导入分支同一个判据', () => {
  it('认得出链接，也认得出本地绝对路径', () => {
    assert.equal(looksLikeUrl('https://example.com/a.mp3'), true);
    assert.equal(looksLikeUrl('HTTP://EXAMPLE.COM/a.mp3'), true, '大小写不敏感');
    assert.equal(looksLikeUrl('file:///tmp/a.wav'), true);
    assert.equal(looksLikeUrl('/home/me/a.wav'), false);
    // Windows 盘符**不是** scheme：`c:` 后面没有 `//`
    assert.equal(looksLikeUrl('C:\\Users\\me\\a.wav'), false);
  });
});

describe('resolveRetranscribeSource', () => {
  it('没有记录原始输入 → NO_SOURCE_INPUT（与改动前同一个 code）', async () => {
    const dataDir = await makeDataDir('no-input');
    const r = await resolveRetranscribeSource(deps(dataDir, { kind: 'local', input_url: null }), 1);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'NO_SOURCE_INPUT');
    assert.deepEqual(r.tried, []);
  });

  it('连 media_sources 都没有 → 同样是 NO_SOURCE_INPUT，不许抛', async () => {
    const dataDir = await makeDataDir('no-source-row');
    const r = await resolveRetranscribeSource(deps(dataDir, undefined), 1);
    assert.equal(r.ok, false);
  });

  it('★ 链接来源一律放行，且**不做任何网络 IO**（这一档是"未知"不是"已验证"）', async () => {
    const dataDir = await makeDataDir('url');
    const r = await resolveRetranscribeSource(
      deps(dataDir, { kind: 'url', input_url: 'https://example.com/talk.mp3' }),
      1,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.from, 'url');
    assert.equal(r.input, 'https://example.com/talk.mp3', '链接必须原样传给 runner');
    assert.equal(r.sourceKind, 'url');
  });

  it('input_url 还打得开 → 用它，且行为与改动前一致（零回归）', async () => {
    const dataDir = await makeDataDir('happy');
    const wav = await writeFileWithBytes(join(dataDir, 'media', 'REC.wav'));
    const r = await resolveRetranscribeSource(
      deps(dataDir, { kind: 'recording', input_url: wav }),
      1,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.from, 'sourceInput');
    assert.equal(r.input, wav);
    assert.equal(r.sourceKind, 'recording');
  });

  it('★ 搬过家的形状：input_url 指向旧数据目录，但归档原件还在 → 退回原件，**不许变灰**', async () => {
    const dataDir = await makeDataDir('searchGuide');
    // 归档原件：`rel_path` 是相对 media 根的规范形态（migrateAssets 会把它迁对）
    const archived = await writeFileWithBytes(join(dataDir, 'media', 'jfk.wav'));

    const r = await resolveRetranscribeSource(
      deps(
        dataDir,
        // 老数据目录里的绝对路径 —— demo 库里 note 2 就是这个值
        { kind: 'local', input_url: '/tmp/omdemo/jfk.wav' },
        [{ role: 'original', rel_path: 'jfk.wav' }],
      ),
      1,
    );

    assert.equal(r.ok, true, '库里明明有这份原件，判成不能重跑就是把功能白白关掉');
    if (!r.ok) return;
    assert.equal(r.from, 'originalAsset');
    assert.equal(r.input, archived, '喂给 runner 的必须是归档原件的绝对路径');
    assert.equal(r.sourceKind, 'local', 'kind 照旧带出来，不因为换了输入就改');
  });

  it('★ input_url 失效 + 归档原件也读不到 → 变灰，并说出找过哪些位置', async () => {
    const dataDir = await makeDataDir('both-gone');
    const r = await resolveRetranscribeSource(
      deps(dataDir, { kind: 'local', input_url: '/tmp/gone/x.wav' }, [
        { role: 'original', rel_path: 'nowhere.wav' },
      ]),
      1,
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'SOURCE_UNREADABLE');
    assert.notEqual(r.code, 'NO_SOURCE_INPUT', '记录了原始输入，说"没记录"是另一句谎');
    assert.ok(r.tried.length > 0, '必须报出找过的位置，否则用户分不清"文件没了"和"我们找错了"');
    assert.ok(
      r.tried.some((p) => p.includes('nowhere.wav')),
      '归档原件那一档也要出现在 tried 里',
    );
    assert.ok(r.messageZh.includes('/tmp/gone/x.wav'), '原始输入原文要在理由里，供用户核对');
    assert.ok(r.message.length > 0 && r.messageZh.length > 0, '双语都要有');
  });

  it('★ 空文件（0 字节）算读不到 —— 它转不了，判成"能重跑"就是把失败推到 job 里', async () => {
    const dataDir = await makeDataDir('empty');
    const empty = join(dataDir, 'media', 'empty.wav');
    await fs.writeFile(empty, '');
    const r = await resolveRetranscribeSource(
      deps(dataDir, { kind: 'local', input_url: empty }, []),
      1,
    );
    assert.equal(r.ok, false, 'existsSync 会说"在"，而它是个 0 字节文件');
  });

  it('归档原件是空文件时同样落空（两档用同一条"真读到字节"的判据）', async () => {
    const dataDir = await makeDataDir('empty-archive');
    await fs.writeFile(join(dataDir, 'media', 'a.wav'), '');
    const r = await resolveRetranscribeSource(
      deps(dataDir, { kind: 'local', input_url: '/tmp/gone/x.wav' }, [
        { role: 'original', rel_path: 'a.wav' },
      ]),
      1,
    );
    assert.equal(r.ok, false);
  });

  it('★ 数据目录之外的绝对路径判不通过 —— 与 runner 的 allowedRoot 是同一个范围', async () => {
    const dataDir = await makeDataDir('outside');
    // 文件**真的存在**，只是不在数据目录内：runner 的 LocalFileSource 也会拒它，
    // 所以这里必须一致地判"不能重跑"，否则又是一句"事前说行、事后失败"。
    const outside = await writeFileWithBytes(join(ROOT, 'outside-of-datadir.wav'));
    const r = await resolveRetranscribeSource(
      deps(dataDir, { kind: 'local', input_url: outside }, []),
      1,
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.tried, [], '一个候选都不该落在根内');
    assert.ok(r.messageZh.includes('没有任何候选路径落在数据目录内'));
  });

  it('只认 role=original 作回退，别的角色不许顶替', async () => {
    const dataDir = await makeDataDir('wrong-role');
    // audio16k 是**归一化产物**（16k 单声道），拿它当"原件"重跑等于永久降质
    await writeFileWithBytes(join(dataDir, 'media', 'N', 'audio16k.wav'));
    const r = await resolveRetranscribeSource(
      deps(dataDir, { kind: 'local', input_url: '/tmp/gone/x.wav' }, [
        { role: 'audio16k', rel_path: join('N', 'audio16k.wav') },
        { role: 'peaks', rel_path: join('N', 'peaks.ompk') },
      ]),
      1,
    );
    assert.equal(r.ok, false, 'audio16k 不是原件，不许拿它冒充');
  });

  it('没有任何资产时，理由要说出"连归档原件都没有"（处置不同：只能重新导入）', async () => {
    const dataDir = await makeDataDir('no-assets');
    const r = await resolveRetranscribeSource(
      deps(dataDir, { kind: 'local', input_url: '/tmp/gone/x.wav' }, []),
      1,
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.messageZh.includes('没有可回退的归档原件'));
  });
});
