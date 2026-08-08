/**
 * 删除必须**可逆** —— 「软删除」这个词的另一半。
 *
 * ## 守的是什么
 *
 * `[实测 2026-08-08]` 在 `POST /api/notes/:uid/restore` 之前，
 * 全 daemon **零 restore 路径**（全仓 grep `deleted_at = NULL` / `restore`，
 * 唯一命中是组件回滚，与笔记无关）。于是三件事同时成立：
 *
 * - 数据**永远留在盘上**（`softDeleteNote` 只写 `deleted_at`）；
 * - 用户**永远拿不回来**；
 * - 而且**看不出它还在**（所有读路径都过滤 `deleted_at IS NULL`）。
 *
 * 对用户是「删除实际不可逆，而 UI 用的是一个听起来可逆的词」；
 * 对隐私是「他以为删掉了，其实那行还在库里」。
 *
 * Manager 2026-08-08 裁定：**软删除之所以叫"软"，就是因为它可逆。**
 *
 * ## 为什么这里要连 404 一起钉
 *
 * 恢复的入口有一个**结构性陷阱**：按 uid 取笔记的那段用 `repos.noteByUid()`，
 * 而它**按设计查不到已删的**。restore 分支若排在它后面，就会变成一个
 * **永远够不到的实现** —— 装了、测了单函数、用户点了永远 404。
 * 所以下面第 2 条专门断言「删掉之后还能恢复」，那条一红就说明顺序又错了。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { CSRF_HEADER, SESSION_COOKIE } from './auth.js';
import { startDaemon } from '../main.js';

const ROOT = mkdtempSync(join(tmpdir(), 'omrestore-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

let portCursor = 19660;
const nextPort = (): number => portCursor++;

interface Session {
  base: string;
  sid: string;
  csrf: string;
}

async function handshake(port: number, token: string): Promise<Session> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const sid = /om_sid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  const { csrf } = (await res.json()) as { csrf: string };
  assert.ok(sid && csrf, '握手失败，后面的断言就没意义了');
  return { base: `http://127.0.0.1:${port}`, sid, csrf };
}

function tinyWav(): Buffer {
  const data = Buffer.alloc(64);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + data.length, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(16000, 24);
  hdr.writeUInt32LE(32000, 28);
  hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(data.length, 40);
  return Buffer.concat([hdr, data]);
}

async function upload(s: Session): Promise<string> {
  const boundary = '----RestoreBoundary';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="restore.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`,
  );
  const res = await fetch(`${s.base}/api/notes/upload`, {
    method: 'POST',
    headers: {
      Cookie: `${SESSION_COOKIE}=${s.sid}`,
      [CSRF_HEADER]: s.csrf,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat([head, tinyWav(), Buffer.from(`\r\n--${boundary}--\r\n`)]),
  });
  const body = await res.text();
  assert.equal(res.status, 202, body);
  return (JSON.parse(body) as { noteUid: string }).noteUid;
}

const auth = (s: Session): Record<string, string> => ({
  Cookie: `${SESSION_COOKIE}=${s.sid}`,
  [CSRF_HEADER]: s.csrf,
});

async function boot(): Promise<Session> {
  const port = nextPort();
  const dataDir = mkdtempSync(join(ROOT, 'data-'));
  const d = await startDaemon({ port, dataDir });
  after(() => void d.stop());
  return await handshake(port, d.token);
}

describe('删除必须可逆（POST /api/notes/:uid/restore）', () => {
  it('★ 删掉之后，笔记确实从列表里消失（前提自检）', async () => {
    const s = await boot();
    const uid = await upload(s);
    await fetch(`${s.base}/api/notes/${uid}`, { method: 'DELETE', headers: auth(s) });
    const list = (await (await fetch(`${s.base}/api/notes`, { headers: auth(s) })).json()) as {
      notes: { uid: string }[];
    };
    assert.equal(
      list.notes.some((n) => n.uid === uid),
      false,
      '没消失的话，下面"恢复"就没有被恢复的东西',
    );
  });

  it('★★ 删掉之后必须能恢复，而且恢复后重新出现在列表里', async () => {
    const s = await boot();
    const uid = await upload(s);
    await fetch(`${s.base}/api/notes/${uid}`, { method: 'DELETE', headers: auth(s) });

    const res = await fetch(`${s.base}/api/notes/${uid}/restore`, {
      method: 'POST',
      headers: auth(s),
    });
    assert.equal(
      res.status,
      200,
      '404 多半意味着 restore 分支排到了 noteByUid() 后面 —— 那条按设计查不到已删的，' +
        '于是这个端点会变成一个永远够不到的实现',
    );

    const list = (await (await fetch(`${s.base}/api/notes`, { headers: auth(s) })).json()) as {
      notes: { uid: string }[];
    };
    assert.equal(
      list.notes.some((n) => n.uid === uid),
      true,
      '恢复只改了 deleted_at 却没回到列表 = 读路径与写路径对不上',
    );
  });

  it('★ 没删过的笔记去恢复 → 404，**不许编一个成功**', async () => {
    const s = await boot();
    const uid = await upload(s);
    const res = await fetch(`${s.base}/api/notes/${uid}/restore`, {
      method: 'POST',
      headers: auth(s),
    });
    assert.equal(res.status, 404);
  });

  it('★ 不存在的 uid 去恢复 → 404', async () => {
    const s = await boot();
    const res = await fetch(`${s.base}/api/notes/01ARZ3NDEKTSV4RRFFQ69G5FAV/restore`, {
      method: 'POST',
      headers: auth(s),
    });
    assert.equal(res.status, 404);
  });
});
