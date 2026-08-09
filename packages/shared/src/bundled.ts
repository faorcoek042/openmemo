/**
 * Model ids bundled into the pre-built package (D-20 §9/§10, Manager ruling 2026-08-09).
 *
 * Single source of truth for BOTH sides of "packaging vs. discovery" — a split that has
 * already caused the exact same bug twice before this one (see `roleToStoreKind`'s file
 * header, `apps/daemon/src/http/rest/roleMap.ts`, for the canonical write-up of "a mapping
 * duplicated in two places drifts"):
 *   - `scripts/build-bundle.mjs`                    what gets COPIED into the package
 *   - `apps/daemon/src/http/rest/modelReconcile.ts` what gets LANDED into the ArtifactStore
 *     on first run
 * If either side reads a different list than this one, "bundled" stops being a single
 * true statement — exactly the failure D-20 §11.1 found (`grep -rn
 * "BUNDLED_MODELS|bundledModels|resolveBundledModel" apps/daemon packages` → 0 hits: bytes
 * were shippable in principle, but nothing in the product ever looked for them).
 *
 * ## Selection — not "smallest available", each entry has an independent reason
 *
 *   `vad/silero-vad-ggml`          0.9 MB  MIT          default VAD; every recording path
 *                                                        needs one.
 *   `asr/whisper-tiny-q5_1`       32.2 MB  MIT          the ONLY model CI has proven,
 *                                                        end-to-end, to transcribe
 *                                                        non-empty text from real audio —
 *                                                        chosen for that reason, not merely
 *                                                        because it is the smallest.
 *   `asr/sherpa-streaming-zh-14m` 25.4 MB  Apache-2.0   F3 (live/streaming transcription)
 *                                                        hardcodes `engineId: 'sherpa-onnx'`
 *                                                        (`apps/daemon/src/ws/recorder.ts`)
 *                                                        with NO whisper fallback path.
 *                                                        Without this bundled, F3 cannot
 *                                                        open a session at all on a fresh
 *                                                        install: `setup.ts`'s
 *                                                        `resolveStreamingModel()` finds
 *                                                        nothing, and `recorder.ts` refuses
 *                                                        to open a half-working session —
 *                                                        `流式识别引擎不可用`.
 *
 * Total ~58.4 MB raw / platform (D-20 §9's bundle-worthy line is 100 MB/item; nothing here
 * is close to it). ffmpeg / yt-dlp / whisper CUDA / paraformer / punctuation etc. stay
 * download-only — GPL (ffmpeg), pending a binary-embedded-dependency license audit
 * (yt-dlp), or simply over the line (everything else). Full per-item ruling table: D-20 §9.2.
 *
 * ## Why this lives in `shared`, not `downloader` or the daemon
 *
 * `build-bundle.mjs` is a standalone script (not part of the daemon process) and only
 * already depends on `@openmemo/downloader` and `@openmemo/pipeline` dist output for other
 * steps — `shared` is the one package with zero Node-only I/O that both the build script
 * and the daemon can import identically.
 */
export const BUNDLED_MODEL_IDS = [
  'vad/silero-vad-ggml',
  'asr/whisper-tiny-q5_1',
  'asr/sherpa-streaming-zh-14m',
] as const;

export type BundledModelId = (typeof BUNDLED_MODEL_IDS)[number];
