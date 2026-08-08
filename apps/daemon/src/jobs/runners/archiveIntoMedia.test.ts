/**
 * `archiveIntoMedia` 的**归档判断**：同一个文件用不同写法的根传进来，结论必须一样。
 *
 * ## 这条用例钉的是一次真实事故（CI run 31247843782 抓到的）
 *
 * F3 录音停止后，WAV 就躺在 `<mediaRoot>/recordings/<ULID>.wav`，本该命中
 * 「已经在 media/ 里就别动它」。但那句判断是 `relative()` —— **纯字符串运算**，
 * 而 `mediaRoot` 与文件路径在真实系统上经常是**同一个目录的两种写法**：
 *   · macOS：`os.tmpdir()` = `/var/folders/…`，而 `/var` 是指向 `/private/var` 的符号链接
 *   · Windows：`%TEMP%` 常是 8.3 短名 `C:\Users\RUNNER~1\…`，长名是 `…\runneradmin\…`
 *
 * 判断落空 → 录音被 `rename()` 搬走 → 两条用户可见的后果：
 *   ① 原来那条 `role='original'` 资产的 `rel_path` 指空，`/media/asset/<uid>` **404**，
 *      播放器当场废掉（实测同一条笔记上出现两条 `original`，先来的那条 404）；
 *   ② `media_sources.input_url` 也指空，于是**之后每一次「重新转写」都失败**
 *      （`no media source can handle this input`）。
 *
 * **这个 bug 在 Linux 上不可见** —— `/tmp` 既没有符号链接也没有短名。
 * 所以这条用例用一个**符号链接**在 Linux 上把 macOS 的那种写法差异造出来，
 * 否则它在开发机上永远是绿的，而那正是这个缺陷能活到用户手里的原因。
 */
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { archiveIntoMedia } from './transcribe.js';

const made: string[] = [];
after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

async function fixture(): Promise<{ root: string; media: string; wav: string }> {
  const root = await mkdtemp(join(tmpdir(), 'om-archive-'));
  made.push(root);
  const media = join(root, 'media');
  await mkdir(join(media, 'recordings'), { recursive: true });
  const wav = join(media, 'recordings', 'REC01.wav');
  await writeFile(wav, Buffer.from('RIFFxxxxWAVE-payload'));
  return { root, media, wav };
}

describe('archiveIntoMedia —— 已经在 media/ 里的文件不许被搬走', () => {
  it('直路：mediaRoot 与文件路径写法一致时，原样返回相对路径且不动文件', async () => {
    const { media, wav } = await fixture();
    const rel = await archiveIntoMedia(media, 'NOTEUID', wav, 'REC01.wav');
    assert.equal(rel, join('recordings', 'REC01.wav'));
    assert.equal(existsSync(wav), true, '文件被搬走了');
  });

  it('★ mediaRoot 经由符号链接传进来时，结论必须不变（macOS /var → /private/var 的形状）', async () => {
    const { root, media, wav } = await fixture();
    // <root>/alias -> <root>/media：同一个目录的第二种合法写法
    const alias = join(root, 'alias');
    await symlink(media, alias, 'dir');

    const rel = await archiveIntoMedia(alias, 'NOTEUID', wav, 'REC01.wav');

    /*
     * 判据有两条，缺一不可：
     *   · 返回的仍是 `recordings/REC01.wav`（不是 `NOTEUID/REC01.wav`）
     *   · **文件还在原地** —— 这一条才是用户看得见的那个后果
     *     （搬走了的话，录音自己的 rel_path 与 input_url 一起指空）
     */
    assert.equal(rel, join('recordings', 'REC01.wav'));
    assert.equal(
      existsSync(wav),
      true,
      '录音被搬走了 —— 它的 rel_path 与 input_url 会一起指空：播放 404、重新转写永久失败',
    );
    assert.equal((await readFile(wav)).toString('utf8'), 'RIFFxxxxWAVE-payload');
  });

  it('反向：真的在 media/ 外面的文件**必须**被搬进来（别把判断修成"永远不搬"）', async () => {
    const { root, media } = await fixture();
    // 前提自检：把上面那条修成 `return rel` 恒真的话，这一条会红
    const outside = join(root, 'tmp-job', 'audio16k.wav');
    await mkdir(join(root, 'tmp-job'), { recursive: true });
    await writeFile(outside, Buffer.from('normalized'));

    const rel = await archiveIntoMedia(media, 'NOTEUID', outside, 'audio16k.wav');

    assert.equal(rel, join('NOTEUID', 'audio16k.wav'));
    assert.equal(existsSync(outside), false, '外面那份该被搬走（tmp/ 要保持"可随时删"）');
    assert.equal(existsSync(join(media, 'NOTEUID', 'audio16k.wav')), true);
  });
});
