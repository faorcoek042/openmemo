/**
 * 「就绪」横幅：**鉴权关着的时候，token 一个字节都不许出现。**
 *
 * ## 这组用例来自用户 2026-08-08 的一句话
 *
 * > 「怎么还有 token？不是早都删除了这套安全验证流程吗」
 *
 * 鉴权**确实**是关的（`auth.ts` 的 `authMode()` 默认 `'none'`，
 * `http/server.ts` 的鉴权闸门整段跳过），但横幅照样把 `#t=<token>` 打出来。
 * 那串东西今天**不承担任何作用** —— 它只是让人以为还要过一道验证。
 *
 * 判据：**打印出来的东西必须对应一个真实存在的机制。**
 * 一个不起作用的凭据出现在最显眼的位置，与一句假注释是同一类东西。
 *
 * ## 为什么两个方向都要钉
 *
 * `OPENMEMO_AUTH=token` 是**恢复路径**：开着的时候 token 是用户唯一的入口，
 * 不打就等于把人锁在外面。所以这里不是"删掉 token"，是"**让它跟着开关走**"。
 * 只钉一个方向的用例会把开关做成单向门 —— `auth.ts` 的注释里记着本仓
 * 正因为这个吃过亏（`AUTH_MODE` 曾在模块加载时定死，于是 token 档从来没被测过）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readyBannerLines, readyUrl } from './ready-banner.js';

const TOKEN = 'khW7sas0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const base = { scheme: 'http', host: '127.0.0.1', port: 17650, token: TOKEN };

describe('① 鉴权关闭（默认）时，token 不许出现在任何一行里', () => {
  const input = { ...base, authRequired: false };

  it('URL 不带 #t=', () => {
    assert.equal(readyUrl(input), 'http://127.0.0.1:17650/');
  });

  it('★ 整个横幅的全文里搜不到 token 本身', () => {
    const all = readyBannerLines(input).join('\n');
    assert.equal(all.includes(TOKEN), false);
  });

  it('★ 整个横幅的全文里搜不到 "#t=" 这个片段', () => {
    const all = readyBannerLines(input).join('\n');
    assert.equal(all.includes('#t='), false);
  });

  it('也不该出现"令牌"这类会让人以为还要验证的字眼', () => {
    const all = readyBannerLines(input).join('\n');
    assert.equal(all.includes('令牌'), false);
  });
});

describe('② 恢复路径：OPENMEMO_AUTH=token 时照样要打，否则等于把人锁在外面', () => {
  const input = { ...base, authRequired: true };

  it('URL 带 #t=<token>', () => {
    assert.equal(readyUrl(input), `http://127.0.0.1:17650/#t=${TOKEN}`);
  });

  it('横幅里确实含 token', () => {
    assert.equal(readyBannerLines(input).join('\n').includes(TOKEN), true);
  });

  it('并且解释了这串东西是什么、别外传', () => {
    const all = readyBannerLines(input).join('\n');
    assert.equal(all.includes('登录令牌'), true);
    assert.equal(all.includes('请勿外传'), true);
  });
});

describe('③ 判据二：必须有一句人能照着做的话，不能只是一个裸 URL', () => {
  it('告诉用户去浏览器打开', () => {
    const all = readyBannerLines({ ...base, authRequired: false }).join('\n');
    assert.equal(all.includes('浏览器'), true);
  });

  it('★ 告诉用户怎么退出 —— 双击进来的人面对的是一个陌生窗口', () => {
    const all = readyBannerLines({ ...base, authRequired: false }).join('\n');
    assert.equal(all.includes('Ctrl+C'), true);
  });

  it('横幅不止一行（一个裸 URL 就是它要修的那个东西）', () => {
    assert.equal(readyBannerLines({ ...base, authRequired: false }).length >= 3, true);
  });
});

describe('④ 端口漂移：横幅必须报**实际**绑到的端口', () => {
  it('用的是传进来的 port，不是硬编码的 17650', () => {
    const drifted = readyUrl({ ...base, port: 17653, authRequired: false });
    assert.equal(drifted, 'http://127.0.0.1:17653/');
  });

  it('https 时 scheme 跟着变', () => {
    assert.equal(
      readyUrl({ ...base, scheme: 'https', authRequired: false }),
      'https://127.0.0.1:17650/',
    );
  });
});
