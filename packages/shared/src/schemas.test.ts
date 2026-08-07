/**
 * 下载来源的**信任边界**：域名白名单 + https + sha256 钉死。
 *
 * ## 为什么先测这一条
 *
 * `closure-audit` 顺带查清了一件事：目录 Ed25519 验签**生产零调用方**，
 * 而且会联网取目录的那个分层加载器（`downloader/src/manifest.ts` 里的 `loadManifest` 一族）
 * 自己就是死代码 —— **该加载器已于 T-171 被用户裁决删除**，所以今天连"未来会验签"这个
 * 说法都不成立了。也就是说，**今天真正在承重的完整性控制只剩两条**：
 *
 *   ① 这里的域名白名单 + https（挡"从哪儿下"）
 *   ② 每个产物强制 sha256（挡"下到的是不是那个东西"）
 *
 * 这两条**全部住在 `packages/shared` 里，而这个包此前一个测试都没有**。
 * 把它们改松一格不会有任何东西变红：zod schema 放宽只是少抛一个异常，
 * 上层看到的是"校验通过"，和真的合法长得一模一样。
 *
 * 所以这一份的每条断言都对着一种**具体的放松方式**，而不是对着"功能正常"。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALLOWED_DOWNLOAD_HOSTS,
  ByteSizeSchema,
  DownloadUrlSchema,
  LOOPBACK_HOSTS,
  Sha256Schema,
} from './schemas.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

describe('DownloadUrlSchema —— 下载来源白名单', () => {
  it('白名单里的每个域名都必须真的放行（否则是把自己锁死了）', () => {
    for (const host of ALLOWED_DOWNLOAD_HOSTS) {
      assert.equal(
        ok(DownloadUrlSchema, `https://${host}/some/model.gguf`),
        true,
        `白名单里写着 ${host}，但 schema 不放行它 —— 白名单与实现不一致`,
      );
    }
  });

  it('★ 后缀相似的域名必须拒绝（把 includes/endsWith 写成子串匹配时会当场红）', () => {
    // 这一条是整份文件里最要紧的断言：
    // 只要有人把 hostname 的**精确相等**改成 endsWith / includes，
    // 下面这些就会全部变成"合法下载源"，而没有任何别的东西会察觉。
    const lookalikes = [
      'https://huggingface.co.evil.com/x.gguf',
      'https://evil-huggingface.co/x.gguf',
      'https://github.com.attacker.net/x.gguf',
      'https://notgithub.com/x.gguf',
      'https://raw.githubusercontent.com.evil.io/x.onnx',
    ];
    for (const u of lookalikes) {
      assert.equal(ok(DownloadUrlSchema, u), false, `${u} 必须被拒绝，但它通过了`);
    }
  });

  it('白名单之外的域名一律拒绝，哪怕是 https', () => {
    assert.equal(ok(DownloadUrlSchema, 'https://example.com/model.gguf'), false);
    assert.equal(ok(DownloadUrlSchema, 'https://cdn.jsdelivr.net/model.gguf'), false);
  });

  it('子域名不自动继承母域名的信任', () => {
    // huggingface.co 在白名单里，cdn.huggingface.co 不在 —— 必须逐个显式登记。
    assert.equal(ok(DownloadUrlSchema, 'https://cdn.huggingface.co/x.gguf'), false);
  });

  it('非 https 协议一律拒绝（回环除外）', () => {
    assert.equal(ok(DownloadUrlSchema, 'http://huggingface.co/x.gguf'), false);
    assert.equal(ok(DownloadUrlSchema, 'ftp://huggingface.co/x.gguf'), false);
    // `file://` 是刻意拒绝的（schemas.ts 里写了原因：Node fetch 读不了它，
    // 放进来就要在下载器里多开一条分支，而那条分支会绕过 Range/续传/校验/去重）。
    assert.equal(ok(DownloadUrlSchema, 'file:///etc/passwd'), false);
  });

  it('IPv4 回环与 localhost 允许明文 http（本机自建产物）', () => {
    for (const host of ['127.0.0.1', 'localhost']) {
      assert.equal(
        ok(DownloadUrlSchema, `http://${host}:17650/local-artifacts/whisper.tar.gz`),
        true,
        `回环 ${host} 上的 http 应当放行`,
      );
    }
    // 不是回环就不行 —— 这条挡的是"把回环豁免顺手放宽成任意内网地址"
    assert.equal(ok(DownloadUrlSchema, 'http://192.168.1.10/x.tar.gz'), false);
    assert.equal(ok(DownloadUrlSchema, 'http://10.0.0.5/x.tar.gz'), false);
  });

  it('IPv6 回环 `[::1]` 也放行 —— 曾经是一条永远命中不了的死条目（T-169 发现 / T-171 修）', () => {
    /*
     * 本用例在 T-171 之前钉的是**相反**的行为（`[::1]` 被拒），因为当时 `LOOPBACK_HOSTS`
     * 存的是裸 `'::1'`，而 `new URL('http://[::1]/x').hostname` 返回 `'[::1]'`（带方括号），
     * `includes()` 恒为 false。用户于 2026-08-07 裁定修它，判词是：
     *
     *   > 这条豁免的既有论证（回环流量不出机器、sha256 仍然钉死、复用同一条下载路径）
     *   > **对 IPv6 回环同样成立，一字不用改**。所以补上它**不是一个新决策，
     *   > 是把一个已经接受的决策表达完整** —— `::1` 按任何定义都是回环。
     *
     * 修法：`schemas.ts` 比对前用 `unbracketHost()` 剥掉首尾方括号（**两边都剥，不是两边都包**，
     * 抄 `apps/daemon/src/http/guard.ts:127-128` 的 T-142 修法）。
     *
     * ★ 这是同一个错误假设（"`URL.hostname` 不带方括号"）在本仓的**第二次**发作。
     *   第一次是 T-142 / commit `7ff7e73`：`guard.ts` 同源校验多包一层拼成 `[[::1]]`，
     *   导致用 `http://[::1]:port` 打开界面时**每个带 Origin 的请求都 403，整页全死**。
     *   两次方向不同（多包 vs 存裸的），后果都是 fail-closed 的静默失效。
     */
    assert.equal(
      ok(DownloadUrlSchema, 'http://[::1]:17650/local-artifacts/whisper.tar.gz'),
      true,
      'IPv6 回环 `[::1]` 上的 http 应当放行 —— 与 127.0.0.1 同一条豁免',
    );
    // 不带端口也一样。
    assert.equal(ok(DownloadUrlSchema, 'http://[::1]/local-artifacts/whisper.tar.gz'), true);
    // 展开写法也放行 —— **不是我们做的归一化**，是 `new URL` 自己把它压成 `[::1]` 的。
    // `[实测]` `new URL('http://[0:0:0:0:0:0:0:1]/x').hostname === '[::1]'`。
    // 钉住它是因为：这条一旦变红，说明 Node 的 URL 序列化行为变了，而我们有两处代码
    // （本文件 + guard.ts）建立在它之上。
    assert.equal(ok(DownloadUrlSchema, 'http://[0:0:0:0:0:0:0:1]/x.tar.gz'), true);
    // 名单里存的仍是**裸**形式 —— 归一化发生在比较侧。改成存 `'[::1]'` 是另一种修法，
    // 但那会让"两边都剥"退化成"依赖某一边的书写约定"，正是 T-142 踩过的坑。
    assert.equal(
      (LOOPBACK_HOSTS as readonly string[]).includes('::1'),
      true,
      'LOOPBACK_HOSTS 里的 ::1 被改写了 —— 修法是在比较侧剥括号，不是在名单里存带括号的形式',
    );
  });

  it('★ 剥方括号剥的是**包装**，不是判据 —— 非回环的 IPv6 仍然一律拒绝', () => {
    /*
     * 这条是 T-171 那次放宽的配对守卫，防的是把"剥括号"顺手做成"含冒号就算回环"。
     * 判据照抄 `guard.test.ts` 里 T-142 的同名反向断言：**剥壳不许放宽判据。**
     */
    for (const url of [
      'http://[2001:db8::1]/x.tar.gz', // 文档用地址段
      'http://[fe80::1]/x.tar.gz', // 链路本地
      'http://[fd00::1]/x.tar.gz', // 唯一本地（ULA）
      'http://[::ffff:127.0.0.1]/x.tar.gz', // IPv4 映射写法：**不是** LOOPBACK_HOSTS 里那三个之一
      'http://[::]/x.tar.gz', // 未指定地址
    ]) {
      assert.equal(ok(DownloadUrlSchema, url), false, `${url} 不是回环，必须仍被拒绝`);
    }
    // https 侧同理：IPv6 字面量不在域名白名单里，剥不剥括号都不该放行。
    assert.equal(ok(DownloadUrlSchema, 'https://[2001:db8::1]/x.tar.gz'), false);
    assert.equal(ok(DownloadUrlSchema, 'https://[::1]/x.tar.gz'), false);
  });

  it('不是 URL 的字符串要拒绝', () => {
    assert.equal(ok(DownloadUrlSchema, 'not a url'), false);
    assert.equal(ok(DownloadUrlSchema, ''), false);
  });
});

describe('Sha256Schema —— 产物校验和的形状', () => {
  it('64 位小写十六进制放行', () => {
    assert.equal(ok(Sha256Schema, 'a'.repeat(64)), true);
    assert.equal(ok(Sha256Schema, '0123456789abcdef'.repeat(4)), true);
  });

  it('大写、长度不对、含非十六进制字符一律拒绝', () => {
    assert.equal(ok(Sha256Schema, 'A'.repeat(64)), false, '大写必须拒绝：比对时大小写不一致会假阴');
    assert.equal(ok(Sha256Schema, 'a'.repeat(40)), false, '40 位是 sha1，不能当 sha256 收下');
    assert.equal(ok(Sha256Schema, 'a'.repeat(63)), false);
    assert.equal(ok(Sha256Schema, 'a'.repeat(65)), false);
    assert.equal(ok(Sha256Schema, 'g'.repeat(64)), false);
    assert.equal(ok(Sha256Schema, ''), false);
  });
});

describe('ByteSizeSchema —— 字节数必须是整数，不是给人看的字符串', () => {
  it('整数放行，小数/负数/字符串拒绝', () => {
    assert.equal(ok(ByteSizeSchema, 0), true);
    assert.equal(ok(ByteSizeSchema, 1_073_741_824), true);
    // schemas.ts 的文件头逐条列了同类产品在这里烂掉的样子：
    // memo.ac 的 `size` 是 "77.7 MB"、ComfyUI-Manager 的是 "4.71MB"。
    assert.equal(ok(ByteSizeSchema, '77.7 MB'), false);
    assert.equal(ok(ByteSizeSchema, '1073741824'), false);
    assert.equal(ok(ByteSizeSchema, 77.7), false);
    assert.equal(ok(ByteSizeSchema, -1), false);
  });
});
