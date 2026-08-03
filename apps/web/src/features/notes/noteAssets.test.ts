/**
 * T-139 A1 / A3 —— 「这条笔记有没有可用的音频 / 波形」。
 *
 * ## 这些用例钉的是什么（先读断言，别读名字 —— ⑤A-18 规矩 1）
 *
 * 唯一真正重要的一条是 `REAL_NOTE_RESPONSE`：它**不是手写的想象形状**，而是从
 * 一个真 daemon 上 `curl` 下来的响应逐字粘贴（见常量上方的取证信息）。
 * 这个 bug 之所以能活到今天，正是因为前端那份手抄 DTO 与 daemon 的实际输出
 * **从来没有被同一段代码同时看过一眼**：web 声明了 daemon 不发的 `state`、
 * 漏了 daemon 在发的 `url`，而 `tsc` 一个字都不会说（两边根本没有类型连接）。
 *
 * 所以判据是：**把真实响应喂进去，播放器必须拿得到音源。**
 * 只要 daemon 那侧再把 `state` 丢掉一次，`apps/daemon` 的契约用例会红；
 * 只要前端再改成筛一个不存在的字段，这里会红。两边各有一道，缺一道都补不上这个洞。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NoteDetail } from '../../lib/api/types';
import { isUsableAsset, pickAudioAsset, pickPeaksAsset } from './noteAssets';

/**
 * ★ 取证：`curl -s http://127.0.0.1:17971/api/notes/01KZ47VXT0G82CP80S0MD7DHW1`
 * （T-139 自建的临时 daemon，真 SQLite、真 `media_assets` 行、真 `/media/asset` URL）。
 * 除了删去与本用例无关的顶层键，**字段名与取值一字未改**。
 */
const REAL_NOTE_RESPONSE = {
  uid: '01KZ47VXT0G82CP80S0MD7DHW1',
  title: '契约验证用笔记',
  assets: [
    {
      uid: '01KZ47VXTAH8PSATQ8MG069NMB',
      role: 'audio16k',
      mime: 'audio/wav',
      bytes: 96044,
      durationMs: 3000,
      state: 'ready',
      url: '/media/asset/01KZ47VXTAH8PSATQ8MG069NMB',
    },
    {
      uid: '01KZ47VXTBA889PTTM6F86VF4D',
      role: 'peaks',
      mime: 'application/octet-stream',
      bytes: 526,
      durationMs: 3000,
      state: 'ready',
      url: '/media/asset/01KZ47VXTBA889PTTM6F86VF4D',
    },
  ],
} as unknown as NoteDetail;

/** 出事那天的响应：同一条笔记，**只是没有 `state` 这个键**。 */
const RESPONSE_WITHOUT_STATE = {
  ...REAL_NOTE_RESPONSE,
  assets: REAL_NOTE_RESPONSE.assets.map(({ state: _drop, ...rest }) => rest),
} as unknown as NoteDetail;

describe('T-139 A1 —— 播放器音源的选取', () => {
  it('★ 真 daemon 响应喂进去，必须选出 audio16k 那条（这是 <audio> 会不会渲染的全部依据）', () => {
    const a = pickAudioAsset(REAL_NOTE_RESPONSE);
    assert.equal(a?.uid, '01KZ47VXTAH8PSATQ8MG069NMB');
    assert.equal(a?.role, 'audio16k');
    // daemon 给的是现成 URL，前端不该再拼一次路径
    assert.equal(a?.url, '/media/asset/01KZ47VXTAH8PSATQ8MG069NMB');
  });

  it('★ 响应里没有 state 这个键时，仍然要选得出来 —— "字段缺失"不等于"不可用"', () => {
    /*
     * 这一条就是事故本身的形状：daemon 不发 `state`，前端筛 `state === 'ready'`，
     * 于是恒 false、`<audio>` 不进 DOM、点播放毫无反应且零报错。
     * 判据抄自同一份 DTO 里 `canRetranscribe` 已经立过的规矩：
     * 把"缺字段"读成"不可用"，会对所有旧响应静默藏掉一个本来能用的功能。
     */
    assert.equal(pickAudioAsset(RESPONSE_WITHOUT_STATE)?.role, 'audio16k');
  });

  it('daemon 明确说不可用的三种状态一律排除（这才是这个字段存在的意义）', () => {
    for (const bad of ['pending', 'missing', 'failed'] as const) {
      const note = {
        ...REAL_NOTE_RESPONSE,
        assets: [{ ...REAL_NOTE_RESPONSE.assets[0], state: bad }],
      } as unknown as NoteDetail;
      assert.equal(
        pickAudioAsset(note),
        undefined,
        `state='${bad}' 的资产被当成可播 —— 用户会点到一个必然失败的播放键`,
      );
    }
    assert.equal(isUsableAsset({ state: 'ready' }), true);
    assert.equal(isUsableAsset({}), true);
    assert.equal(isUsableAsset({ state: 'missing' }), false);
  });

  it('assets 不是数组时不许抛 —— 详情页整页崩过一次（tags 那次）', () => {
    assert.equal(pickAudioAsset(undefined), undefined);
    assert.equal(pickAudioAsset({} as NoteDetail), undefined);
    assert.equal(pickAudioAsset({ assets: null } as unknown as NoteDetail), undefined);
  });
});

describe('T-139 A3 —— 波形只能来自真资产', () => {
  it('有 peaks 资产就选出来（此前这一支反而把它丢掉，改去造一份假的）', () => {
    const p = pickPeaksAsset(REAL_NOTE_RESPONSE);
    assert.equal(p?.role, 'peaks');
    assert.equal(p?.url, '/media/asset/01KZ47VXTBA889PTTM6F86VF4D');
  });

  it('★ 没有 peaks 资产就是 undefined —— 调用方必须如实不画，不许回落成编出来的波形', () => {
    const onlyAudio = {
      ...REAL_NOTE_RESPONSE,
      assets: [REAL_NOTE_RESPONSE.assets[0]],
    } as unknown as NoteDetail;
    assert.equal(pickPeaksAsset(onlyAudio), undefined);
  });
});
