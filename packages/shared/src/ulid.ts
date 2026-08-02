/**
 * ULID generation — the external identifier format (ADR-006 decision 5, D-02 §双 ID 约定).
 *
 * Dual-ID convention: SQLite rows carry `id INTEGER PRIMARY KEY` internally (FTS5's
 * `content_rowid` and sqlite-vec's rowid association both REQUIRE an integer), while the
 * API only ever exposes `uid TEXT` — a ULID. The integer PK never leaves the daemon.
 *
 * ULID over UUIDv4 because the first 48 bits are a timestamp, so ids sort
 * lexicographically in creation order. That means a job list sorts correctly by id
 * alone, with no separate ordering column.
 *
 * Implemented here rather than pulled from npm: it is ~40 lines, and this is the one
 * identifier format every package depends on.
 */

/**
 * Randomness comes from Web Crypto (`globalThis.crypto`), NOT `node:crypto`.
 *
 * `@openmemo/shared` is imported by apps/web's browser bundle, so any `node:` import here
 * makes Vite externalise the module and the code breaks at runtime in the browser. Web
 * Crypto is available in both Node 18+ and every target browser, so it is the only
 * correct choice for an isomorphic package.
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

export type Ulid = string;

/** 26-character ULID: 10 chars of millisecond timestamp + 16 chars of randomness. */
export function ulid(seedTime: number = Date.now()): Ulid {
  return encodeTime(seedTime) + encodeRandom();
}

function encodeTime(now: number): string {
  let out = '';
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LEN);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) out += ENCODING[bytes[i] % 32];
  return out;
}

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isUlid(v: string): boolean {
  return ULID_RE.test(v);
}

/** Extract the embedded creation time. Useful for sorting and debugging. */
export function ulidTime(id: Ulid): number {
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const idx = ENCODING.indexOf(id[i]);
    if (idx < 0) throw new Error(`Invalid ULID character at ${i}: ${id[i]}`);
    t = t * 32 + idx;
  }
  return t;
}
