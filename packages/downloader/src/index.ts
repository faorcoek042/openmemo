/**
 * @openmemo/downloader — unified downloader for model weights AND GPU backend packs.
 *
 * Owner: `model-mgmt` (T-013). Reviewer: `gpu-runtime` (ADR-003 decision 6).
 *
 * Consumes `vendor/manifests/*.json` (ADR-001 class C artifacts).
 *
 * Core guarantees:
 *   - resumable chunked transfer over HTTP Range (lineage: Ollama server/download.go)
 *   - mandatory SHA-256 verification before anything is installed — the gap in Ollama,
 *     closed here per ADR-004 decision 5; "verified == installed" is GPT4All's model
 *   - dedup strictly by SHA-256, never by size (ggml-tiny.bin vs ggml-tiny.en.bin differ
 *     by only 13,002 bytes)
 *   - mirror probing and automatic failover, so "is hf-mirror reachable from China?"
 *     never has to be answered (ADR-004 decision 1)
 */

export * from './http.js';
export * from './sidecar.js';
export * from './verify.js';
export * from './download.js';
export * from './probe.js';
export * from './store.js';
export * from './queue.js';
export * from './installer.js';
export * from './manifest.js';
export * from './upstream.js';
export * from './components.js';
export * from './unpack.js';
export * from './signature.js';

export const PACKAGE_NAME = '@openmemo/downloader' as const;
