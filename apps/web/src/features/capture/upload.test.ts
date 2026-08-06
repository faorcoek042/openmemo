/**
 * T-152 —— 拖拽预检 `looksLikeMedia()` 与服务端上传白名单**必须是同一份**。
 *
 * ## 这条用例钉的是什么（先读断言，别读名字）
 *
 * 收敛之前，这个函数里写死了一条 18 项的正则，而 `apps/daemon/src/http/upload.ts`
 * 的 `ALLOWED_UPLOAD_EXTENSIONS` 是另一份手抄的 17 项。`[实测]` 差集与用户看得见的后果：
 *
 * - `web ∖ daemon = {flv, wmv}` —— 用户拖一个 `.flv` 进来：**这条正则放行、界面上出现
 *   上传行、然后服务端回 415**。用户看到的是"传了一半失败"，不是"这个格式不支持"。
 * - `daemon ∖ web = {ts}` —— 服务端收得下，这条正则却不认，文件被前端默默滤掉。
 *
 * 两侧现在都 import `@openmemo/shared` 的 `UPLOAD_MEDIA_EXTENSIONS`，**相等由构造保证**。
 * 但"由构造相等"只在没人重新写死一份的前提下成立 —— 而重新写死一份，
 * `tsc` 一个字都不会说（`[实测]`：把函数体改回旧正则，`npx tsc -b` 退出码 0）。
 * 所以这里必须有一条**在测试层**变红的钉子。
 *
 * ⚠️ 本文件必须登记在 `apps/web/tsconfig.test.json` 的 `include` 白名单里 ——
 * 那是显式白名单，不登记就永远不会被编译、也永远不会被跑，一个字都不报。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PLAYLIST_EXTENSIONS, UPLOAD_MEDIA_EXTENSIONS } from '@openmemo/shared';

import { looksLikeMedia } from './upload';

/** 只有名字重要；`type` 留空是为了强制走扩展名那条判据而不是 MIME 快路径。 */
function named(name: string, type = ''): File {
  return new File([new Uint8Array([0])], name, { type });
}

describe('looksLikeMedia —— 前端预检必须与服务端上传白名单逐字一致（T-152）', () => {
  it('★ 服务端收得下的每一个扩展名，前端都必须放行（否则文件被默默滤掉）', () => {
    // 守卫只挡"集合被筛空 → 下面那条永远绿"（⑤A-2）。
    // ⚠️ 它只能加在被遍历的**输入集合**上，绝不能加在 rejected（要报告的量）上。
    assert.equal(
      UPLOAD_MEDIA_EXTENSIONS.size >= 19,
      true,
      `共享白名单只剩 ${UPLOAD_MEDIA_EXTENSIONS.size} 项，集合被筛空了`,
    );

    const rejected = [...UPLOAD_MEDIA_EXTENSIONS].filter((ext) => !looksLikeMedia(named(`a${ext}`)));
    assert.deepEqual(
      rejected,
      [],
      '这些扩展名服务端收得下，前端预检却把它们滤掉了 —— ' +
        'looksLikeMedia 又变回写死的正则了。它必须查 @openmemo/shared 的 ' +
        `UPLOAD_MEDIA_EXTENSIONS：\n  ${rejected.join('\n  ')}`,
    );
  });

  it('★ 反过来也不许放行服务端会拒的东西（放行 = 用户看到上传行然后吃 415）', () => {
    const NOT_ACCEPTED = [
      '.exe',
      '.sh',
      '.dll',
      '.bat',
      '.ps1',
      '.py',
      '.zip',
      '.pdf',
      '.txt',
      '.json',
      '.srt', // 字幕：pipeline 认，上传端点刻意不收
      '.vtt',
      '.m3u8', // ★ 播放列表：安全边界，见下一条
      '.m3u',
      '.pls',
    ];
    assert.equal(NOT_ACCEPTED.length >= 15, true, `样本只剩 ${NOT_ACCEPTED.length} 个，被筛空了`);

    const accepted = NOT_ACCEPTED.filter((ext) => looksLikeMedia(named(`a${ext}`)));
    assert.deepEqual(
      accepted,
      [],
      `这些扩展名服务端会拒（415），前端却放行了：\n  ${accepted.join('\n  ')}`,
    );
  });

  it('★ 播放列表一个都不许通过拖拽预检（T-026 实测攻击）', () => {
    // 本地 `.m3u8` 的 segment URI 写 `file:///tmp/secret.ts` 就能让 ffmpeg 读任意本地文件。
    // 它不是媒体文件，是间接寻址原语 —— 不许从浏览器拖进来。
    assert.equal(
      PLAYLIST_EXTENSIONS.size >= 6,
      true,
      `播放列表集合只剩 ${PLAYLIST_EXTENSIONS.size} 项，被筛空了`,
    );
    const leaked = [...PLAYLIST_EXTENSIONS].filter((ext) => looksLikeMedia(named(`list${ext}`)));
    assert.deepEqual(leaked, [], `播放列表通过了拖拽预检：${leaked.join(', ')}`);
  });

  it('收敛决策的具体取值：flv / wmv（web 早就放行）与 ts（daemon 早就收）都在', () => {
    assert.equal(looksLikeMedia(named('clip.flv')), true, 'flv：收敛前 daemon 漏了它');
    assert.equal(looksLikeMedia(named('clip.wmv')), true, 'wmv：收敛前 daemon 漏了它');
    // ⚠️ `.ts` 与 TypeScript 源文件同扩展名：拖一个 .ts 源码进来会过这道预检，
    // 由**服务端 ffprobe 当场认出不是媒体并拒掉**（D-01 §8.5）。预检从来不是判定。
    assert.equal(looksLikeMedia(named('segment.ts')), true, 'ts：收敛前 web 这侧漏了它');
  });

  it('MIME 快路径保留：浏览器已经认出 audio/ video/ 时不看扩展名', () => {
    // 很多相机 / 录音 App 导出的文件没有扩展名，只有 MIME —— 砍掉这条会让它们传不上去。
    assert.equal(looksLikeMedia(named('recording', 'audio/mpeg')), true);
    assert.equal(looksLikeMedia(named('clip', 'video/mp4')), true);
    assert.equal(looksLikeMedia(named('readme', 'text/plain')), false);
    assert.equal(looksLikeMedia(named('noextension')), false);
  });
});
