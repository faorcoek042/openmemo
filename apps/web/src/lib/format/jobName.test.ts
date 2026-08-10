/**
 * `jobDisplayName()` —— job 名字的本地化与**三条兜底**。
 *
 * 起因：daemon 建 job 时写死 `displayName: model.displayNameZh`
 * （`apps/daemon/src/http/rest/models.ts:416`），名字在建 job 那一刻就冻住了，
 * `/api/jobs` 只是原样吐出去 ⇒ **任何英文界面都会看到中文名**。
 *
 * ⚠️ 夹具里中英两份名字**必须长得不一样**，而且**中文那份必须是真的中文**。
 * 这是本仓自己记过的教训（`components.test.tsx:4124`：
 * 「上一轮的教训：原来的桩全是 ASCII，`displayNameZh` 那条缺陷因此测不出来」）——
 * 两份写成一样，下面每一条都会变成恒真。
 *
 * ── 把名字遮住，这些断言什么时候会失败 ──────────────────────────────────────────
 * 任何人把渲染层改回直接用 `job.displayName`；或者反过来"为了本地化"把兜底删掉，
 * 让目录没加载时名字变空 / 变成原始 slug。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { jobDisplayName, type CatalogLookup } from './jobName';

const EN = 'Whisper Tiny (Q5_1)';
const ZH = '超小语音模型（Q5_1 量化）';
const SLUG = 'asr/whisper-tiny-q5_1';

/** 目录里认识这一个 id，别的一概不认识。 */
const lookup: CatalogLookup = (id) => (id === SLUG ? { displayName: EN, displayNameZh: ZH } : null);

/** daemon 实际会给的那个值：写死的中文。 */
const daemonGave = { type: 'download.model', targetId: SLUG, displayName: ZH };

describe('jobDisplayName：语言在读的那一刻决定，不在建 job 那一刻', () => {
  it('★ 英文界面 → 英文名（而 daemon 给的是中文）', () => {
    assert.equal(jobDisplayName('en', daemonGave, lookup), EN);
  });

  it('★ 中文界面 → 中文名（这一半不许被改坏）', () => {
    assert.equal(jobDisplayName('zh-CN', daemonGave, lookup), ZH);
  });

  it('`zh` / `zh-TW` 都算中文（只判前缀）', () => {
    assert.equal(jobDisplayName('zh', daemonGave, lookup), ZH);
    assert.equal(jobDisplayName('zh-TW', daemonGave, lookup), ZH);
  });

  /**
   * ★ 前提自检：如果 daemon 给的恰好就等于目标语言的名字，上面那两条会**恒真**。
   * 这一条钉住"英文名确实和 daemon 给的不是同一个字符串"，
   * 否则整个文件都在测一件不会失败的事。
   */
  it('前提自检：daemon 给的值 ≠ 英文名（否则上面全是恒真）', () => {
    assert.notEqual(daemonGave.displayName, EN);
    assert.match(ZH, /[一-龥]/, '中文夹具里没有汉字 —— 这条缺陷就测不出来');
  });
});

describe('jobDisplayName：三条兜底都不许把界面弄空、也不许摆原始 slug', () => {
  it('目录还没加载（lookup 一律不认识）→ 用 daemon 的名字', () => {
    const got = jobDisplayName('en', daemonGave, () => null);
    assert.equal(got, ZH, '目录没加载时把名字弄没了 —— 首帧必然处在这个状态');
  });

  it('压根没传 lookup → 用 daemon 的名字', () => {
    assert.equal(jobDisplayName('en', daemonGave), ZH);
  });

  it('★ 本地导入的模型：id 永远不在目录里，而 daemon 给的文件名正是该显示的', () => {
    const imported = {
      type: 'download.model',
      targetId: 'asr/imported-my-recording',
      displayName: 'my-recording.bin',
    };
    assert.equal(jobDisplayName('en', imported, lookup), 'my-recording.bin');
  });

  it('★ 后端包（download.backend）不查模型目录 —— 它在另一份目录里', () => {
    const pack = {
      type: 'download.backend',
      // 故意用一个**在模型目录里存在**的 id：证明拦住它的是 type，不是"查不到"
      targetId: SLUG,
      displayName: 'CPU 后端包',
    };
    assert.equal(
      jobDisplayName('en', pack, lookup),
      'CPU 后端包',
      '后端包被拿去查模型目录了 —— 判别应该是结构式的（按 type），不是碰运气',
    );
  });

  it('★ 流水线 job（transcribe）：displayName 是用户的笔记标题，绝不许被"本地化"', () => {
    const note = { type: 'transcribe', targetId: null, displayName: '我的会议录音' };
    assert.equal(jobDisplayName('en', note, lookup), '我的会议录音');
  });

  it('目录认识它、但两份名字都是空 → 退回 daemon 的名字，不返回空串', () => {
    const empty: CatalogLookup = () => ({ displayName: '', displayNameZh: '' });
    assert.equal(jobDisplayName('en', daemonGave, empty), ZH);
  });

  it('daemon 的名字也没有 → 最后才用 slug（比空白强），且绝不返回空串', () => {
    const nameless = { type: 'download.model', targetId: SLUG, displayName: '' };
    assert.equal(
      jobDisplayName('en', nameless, () => null),
      SLUG,
    );
  });

  it('★ 什么都没有时也不许抛异常（渲染层不该因为一个名字崩掉）', () => {
    assert.equal(jobDisplayName('en', { type: 'download.model' }), '');
  });
});
