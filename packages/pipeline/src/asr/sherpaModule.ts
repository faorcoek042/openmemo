/**
 * Loader for the optional `sherpa-onnx-node` native package.
 *
 * WHY THIS FILE EXISTS — a real interop bug, found the hard way (T-030):
 *
 * `sherpa-onnx-node` is CommonJS. When an ESM module does `await import('sherpa-onnx-node')`,
 * Node runs cjs-module-lexer over the source to guess which named exports to expose. The
 * guess is INCOMPLETE for this package:
 *
 *     namespace keys: [ 'OnlineRecognizer', 'default', 'module.exports' ]
 *     m.OfflineRecognizer   -> undefined
 *     m.default.OfflineRecognizer -> [Function]
 *
 * So `OnlineRecognizer` happens to be hoisted to the namespace and everything else is
 * only reachable through `.default`. That is why the F3 streaming engine worked on the
 * first try while Paraformer failed with `mod.OfflineRecognizer is not a constructor` —
 * the streaming path was passing by luck, not by correctness.
 *
 * Both engines now go through `loadSherpaModule()`, which resolves the real export
 * object regardless of how the lexer felt about it that day.
 */

/** The subset of sherpa-onnx-node this package uses. */
export interface SherpaExports {
  OnlineRecognizer?: new (config: unknown) => unknown;
  OfflineRecognizer?: new (config: unknown) => unknown;
  OfflinePunctuation?: new (config: unknown) => unknown;
  readWave?: (path: string) => { sampleRate: number; samples: Float32Array };
  [key: string]: unknown;
}

/**
 * Pick the object that actually carries the constructors.
 *
 * Checks `.default` first when it looks like the real export bag, because that is the
 * complete one; the namespace itself may hold only a partial hoist.
 */
export function normalizeSherpaModule(raw: unknown): SherpaExports {
  const ns = raw as { default?: unknown } & SherpaExports;

  const candidates: unknown[] = [ns.default, ns];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const c = candidate as SherpaExports;
    // A complete bag has the offline constructors; a partial hoist typically does not.
    if (typeof c.OfflineRecognizer === 'function' || typeof c.OnlineRecognizer === 'function') {
      // Prefer whichever candidate has MORE of what we need.
      const score = (x: SherpaExports): number =>
        Number(typeof x.OnlineRecognizer === 'function') +
        Number(typeof x.OfflineRecognizer === 'function') +
        Number(typeof x.OfflinePunctuation === 'function') +
        Number(typeof x.readWave === 'function');
      const other = candidate === ns.default ? ns : (ns.default as SherpaExports | undefined);
      if (
        other !== undefined &&
        other !== null &&
        typeof other === 'object' &&
        score(other) > score(c)
      ) {
        return other;
      }
      return c;
    }
  }

  throw new Error(
    'sherpa-onnx-node loaded but exposed no recognizer constructors ' +
      `(namespace keys: ${Object.keys(ns).join(', ')})`,
  );
}

/** Load and normalize. Throws when the optional package is absent. */
export async function loadSherpaModule(): Promise<SherpaExports> {
  // Indirection keeps bundlers from trying to resolve an optional native package.
  const spec = 'sherpa-onnx-node';
  return normalizeSherpaModule(await import(spec));
}
