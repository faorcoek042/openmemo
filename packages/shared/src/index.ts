/**
 * @openmemo/shared — cross-package contracts.
 *
 * Owner: `model-mgmt` (T-013, BOARD file-ownership table).
 * Consumers: apps/daemon, apps/web, packages/downloader, packages/runtime.
 *
 * Everything exported here is either a pure type or a pure function — no I/O, no side
 * effects — so it is safe to import from both the daemon and the browser bundle.
 */

export * from './ulid.js';
export * from './hardware.js';
export * from './artifacts.js';
export * from './models.js';
export * from './bundled.js';
export * from './notes.js';
export * from './components.js';
export * from './backends.js';
export * from './breaker.js';
export * from './fitness.js';
export * from './jobs.js';
export * from './events.js';
export * from './api.js';
export * from './providers.js';
export * from './proxy.js';
export * from './schemas.js';
export * from './llm.js';
export * from './media-extensions.js';

export const PACKAGE_NAME = '@openmemo/shared' as const;

/**
 * Contract version. Bump on any breaking change to the shapes above; the daemon and web
 * app assert a match at startup so a stale frontend fails loudly instead of silently
 * mis-parsing responses.
 */
export const CONTRACT_VERSION = 1 as const;
