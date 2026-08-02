/**
 * 回归：**离线重跑不得覆盖用户的笔记标题**。
 *
 * 这是"用户数据被静默改写"类缺陷 —— 用户命名过的笔记，转写完自己变了名，
 * 不报错、不提示。比缺功能严重得多，所以单独锁一条测试。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mayRetitleNote } from './retitle.js';

describe('笔记标题覆盖规则', () => {
  it('导入时的占位标题（= 文件名）可以被更好的媒体标题替换', () => {
    assert.equal(
      mayRetitleNote({
        noteKind: 'media',
        currentTitle: 'garvey.wav',
        input: '/data/inbox/garvey.wav',
        mediaTitle: '1921 Marcus Garvey Speech',
      }),
      true,
    );
  });

  it('**用户自己命名过的笔记绝不覆盖**', () => {
    assert.equal(
      mayRetitleNote({
        noteKind: 'media',
        currentTitle: '我的会议纪要',
        input: '/data/inbox/garvey.wav',
        mediaTitle: '1921 Marcus Garvey Speech',
      }),
      false,
    );
  });

  it('**录音笔记一律不覆盖**（曾被改成 recordingUid）', () => {
    assert.equal(
      mayRetitleNote({
        noteKind: 'recording',
        currentTitle: '01KZ0T42GG97HC6C4WYT38EQQX.wav',
        input: '/data/media/recordings/01KZ0T42GG97HC6C4WYT38EQQX.wav',
        mediaTitle: '01KZ0T42GG97HC6C4WYT38EQQX',
      }),
      false,
    );
  });

  it('空标题可以被填上', () => {
    assert.equal(
      mayRetitleNote({ noteKind: 'media', currentTitle: '   ', input: '/x/a.wav', mediaTitle: 'A' }),
      true,
    );
  });

  it('媒体没有标题时不动', () => {
    assert.equal(
      mayRetitleNote({
        noteKind: 'media',
        currentTitle: 'a.wav',
        input: '/x/a.wav',
        mediaTitle: null,
      }),
      false,
    );
  });

  it('URL 导入：占位标题是 URL 的 basename（忽略 query/fragment）', () => {
    assert.equal(
      mayRetitleNote({
        noteKind: 'media',
        currentTitle: 'talk.mp3',
        input: 'https://example.com/files/talk.mp3?token=abc#t=10',
        mediaTitle: '一场演讲',
      }),
      true,
    );
  });
});
