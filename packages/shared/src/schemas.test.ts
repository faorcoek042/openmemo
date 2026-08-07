/**
 * 下载来源的**信任边界**：域名白名单 + https + sha256 钉死。
 *
 * ## 为什么先测这一条
 *
 * `closure-audit` 顺带查清了一件事：目录 Ed25519 验签**生产零调用方**，
 * 而且会联网取目录的那个分层加载器（`downloader/manifest.ts:75 loadManifest`）
 * 自己就是死代码 —— 也就是说，**今天真正在承重的完整性控制只剩两条**：
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

  it('⚠️ 已知缺陷（T-169 发现）：`LOOPBACK_HOSTS` 里的 `::1` 是一条**永远命中不了**的死条目', () => {
    /*
     * 这条断言钉的是**当前真实行为**，不是期望行为 —— 写在这里是为了让这个不一致有人守。
     *
     * 成因：`LOOPBACK_HOSTS` 里写的是 `'::1'`，而 `new URL('http://[::1]/x').hostname`
     * 返回的是 **`'[::1]'`（带方括号）**，于是 `LOOPBACK_HOSTS.includes(hostname)` 恒为 false。
     * IPv4 的 `127.0.0.1` 与 `localhost` 不带括号，所以只有 IPv6 这一条是死的。
     *
     * 为什么这轮**不顺手修**：改它是把一个安全校验**放宽**（让 `[::1]` 从拒绝变放行）。
     * 本仓库对"放宽安全校验"一律要求用户/Manager 本人拍板（见 closure-audit 🚧-14），
     * 而且当前方向是 **fail-closed**（拒绝），不是漏放 —— 不修不会造成安全后果，
     * 只会让"本机自建产物用 IPv6 回环分发"这条路走不通。
     *
     * 要修的时候：`schemas.ts` 里比对前把 hostname 的首尾方括号剥掉，
     * 然后把这条用例改成"应当放行"。**别只改这条用例。**
     */
    assert.equal(
      ok(DownloadUrlSchema, 'http://[::1]:17650/local-artifacts/whisper.tar.gz'),
      false,
      '`[::1]` 现在被放行了 —— 如果这是有意修的，请一并更新本用例与上面那段说明',
    );
    // 名单里确实写着它，所以"名单与实现不一致"这件事本身也钉一下。
    assert.equal(
      (LOOPBACK_HOSTS as readonly string[]).includes('::1'),
      true,
      'LOOPBACK_HOSTS 里的 ::1 被删掉了 —— 那也是一种修法，但上面那条用例要跟着改',
    );
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
