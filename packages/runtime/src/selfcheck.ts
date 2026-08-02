/**
 * Functional self-check, as a library.
 *
 * ADR-014 promotes this to the project-wide acceptance standard:
 *
 *   Verify that the FEATURE works, not that the COMPONENT loaded — because every layer
 *   degrades gracefully, and stacked graceful degradations are exactly how a product
 *   ends up running degraded with nobody aware.
 *
 * So: not "is libsimple loaded" but "does 用户 match in FTS5". Not "does whisper-cli
 * exist" but "is it executable at a path the daemon will actually resolve".
 *
 * Extracted from scripts/selfcheck.mjs so the daemon can serve the same checks over HTTP
 * (`GET /api/selfcheck`). The diagnostics page currently reports component-load status
 * and carries its own caveat that "a green light does not mean the feature works"; this
 * is the thing that closes that gap. One implementation, two surfaces — a CLI and an
 * endpoint that disagree would be worse than either alone.
 */

import { access, constants, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  /** Grouping for display: hardware / tools / models / ext / engines. */
  layer: string;
  /** Stable id so the UI can map to a remediation, and tests can assert. */
  id: string;
  label: string;
  labelZh: string;
  status: CheckStatus;
  detail: string;
  /** A failing required check means the product is broken, not merely degraded. */
  required: boolean;
  /** What the user should do. Null when nothing is wrong. */
  remediation: string | null;
}

export interface SelfCheckReport {
  ok: boolean;
  ranAt: string;
  dataDir: string;
  storeRoot: string;
  extensionsDir: string;
  counts: { ok: number; warn: number; fail: number };
  results: CheckResult[];
}

export interface SelfCheckInput {
  dataDir: string;
  storeRoot: string;
  extensionsDir: string;
  /**
   * Injected so this module stays dependency-free: `packages/runtime` must not import
   * `packages/pipeline` (that direction would be a cycle — pipeline already depends on
   * runtime). The caller supplies the probes it can perform.
   */
  probes: SelfCheckProbes;
}

export interface SelfCheckProbes {
  /** Resolved native tool paths, as the pipeline would resolve them. */
  tools: () => Promise<{
    ffmpeg: string | null;
    ffprobe: string | null;
    whisperCli: string | null;
    whisperVad: string | null;
    vadModel: string | null;
    ytDlp: string | null;
  }>;
  /** Installed artifact names by store kind. */
  installed: (kind: 'asr' | 'llm' | 'backend') => Promise<string[]>;
  /**
   * Run the four-word Chinese FTS5 test.
   * Returns hit counts, or null when the tokenizer could not even be loaded.
   */
  chineseSearch: () => Promise<Record<string, number> | null>;
  /** sqlite-vec version, or null when unavailable. */
  vecVersion: () => Promise<string | null>;
  /** ASR engine candidates with availability. */
  engines: () => Promise<{ id: string; available: boolean; reason?: string }[]>;
  /** Auto-selected engine per language; null when nothing is available. */
  selectFor: (language: string) => Promise<{ engineId: string; reason: string } | null>;
}

/** The words that were silently returning zero before libsimple shipped (T-035). */
export const CHINESE_PROBE_WORDS = ['用户', '推特', '中国', '服务'] as const;

async function exists(p: string | null | undefined, mode: number): Promise<boolean> {
  if (p === null || p === undefined || p.length === 0) return false;
  try {
    await access(p, mode);
    return true;
  } catch {
    return false;
  }
}

export async function runSelfCheck(input: SelfCheckInput): Promise<SelfCheckReport> {
  const results: CheckResult[] = [];
  const add = (r: CheckResult): void => {
    results.push(r);
  };

  // ---- tools ----------------------------------------------------------------------
  const tools = await input.probes.tools();
  const backendPacks = await input.probes.installed('backend');

  add({
    layer: 'tools',
    id: 'backend.packs',
    label: 'installed backend packs',
    labelZh: '已安装后端包',
    status: backendPacks.length > 0 ? 'ok' : 'warn',
    detail: backendPacks.length > 0 ? backendPacks.join(', ') : '无',
    required: false,
    remediation: backendPacks.length > 0 ? null : '在「运行时」页安装 CPU 基础包',
  });

  for (const [id, labelZh, path, required] of [
    ['tool.ffmpeg', 'ffmpeg', tools.ffmpeg, true],
    ['tool.ffprobe', 'ffprobe', tools.ffprobe, true],
    ['tool.whisperCli', 'whisper-cli', tools.whisperCli, true],
    ['tool.whisperVad', 'VAD 切分器', tools.whisperVad, false],
  ] as const) {
    const ok = await exists(path, constants.X_OK);
    add({
      layer: 'tools',
      id,
      label: labelZh,
      labelZh,
      status: ok ? 'ok' : required ? 'fail' : 'warn',
      detail: ok ? (path as string) : '未找到',
      required,
      remediation: ok ? null : '在「运行时」页安装对应组件',
    });
  }

  const vadOk = await exists(tools.vadModel, constants.R_OK);
  add({
    layer: 'tools',
    id: 'model.vad',
    label: 'VAD model',
    labelZh: 'VAD 模型',
    status: vadOk ? 'ok' : 'warn',
    detail: vadOk ? (tools.vadModel as string) : '未安装 → 切分降级为固定窗口',
    required: false,
    remediation: vadOk ? null : '在「模型」页安装 silero VAD（ggml 格式）',
  });

  // ---- models ---------------------------------------------------------------------
  const asr = await input.probes.installed('asr');
  add({
    layer: 'models',
    id: 'model.asr',
    label: 'ASR models',
    labelZh: 'ASR 模型',
    status: asr.length > 0 ? 'ok' : 'fail',
    detail: asr.length > 0 ? asr.join(', ') : '无',
    required: true,
    remediation: asr.length > 0 ? null : '在「模型」页下载一个语音识别模型',
  });

  const llm = await input.probes.installed('llm');
  add({
    layer: 'models',
    id: 'model.llm',
    label: 'LLM models',
    labelZh: 'LLM 模型',
    status: llm.length > 0 ? 'ok' : 'warn',
    detail: llm.length > 0 ? llm.join(', ') : '无（思维导图需要本地 LLM 或云 API Key）',
    required: false,
    remediation: llm.length > 0 ? null : '下载本地 LLM，或在设置里填云服务 API Key',
  });

  // ---- extensions: tested by FEATURE ------------------------------------------------
  const hits = await input.probes.chineseSearch();
  if (hits === null) {
    add({
      layer: 'ext',
      id: 'ext.chineseSearch',
      label: 'Chinese two-character search',
      labelZh: '中文双字词可搜索',
      status: 'fail',
      detail: '分词器不可用，未能测试',
      required: true,
      remediation: '安装中文分词扩展（libsimple）',
    });
  } else {
    const misses = Object.entries(hits).filter(([, n]) => n === 0).map(([w]) => w);
    add({
      layer: 'ext',
      id: 'ext.chineseSearch',
      label: 'Chinese two-character search',
      labelZh: '中文双字词可搜索',
      status: misses.length === 0 ? 'ok' : 'fail',
      detail: Object.entries(hits).map(([w, n]) => `${w}:${n}`).join(' '),
      required: true,
      remediation:
        misses.length === 0
          ? null
          : `这些词搜不到：${misses.join('、')}。多半是分词器退回 trigram（无法匹配 3 字以下）`,
    });
  }

  const vec = await input.probes.vecVersion();
  add({
    layer: 'ext',
    id: 'ext.sqliteVec',
    label: 'sqlite-vec',
    labelZh: '向量检索扩展',
    status: vec !== null ? 'ok' : 'warn',
    detail: vec ?? '不可用 → 语义检索关闭',
    required: false,
    remediation: vec !== null ? null : '安装向量检索扩展',
  });

  // ---- engines ----------------------------------------------------------------------
  for (const e of await input.probes.engines()) {
    add({
      layer: 'engines',
      id: `engine.${e.id}`,
      label: e.id,
      labelZh: e.id,
      status: e.available ? 'ok' : 'warn',
      detail: e.available ? '可用' : (e.reason ?? '不可用'),
      required: false,
      remediation: e.available ? null : '安装该引擎所需的后端包与模型',
    });
  }

  for (const [lang, labelZh] of [['zh', '中文自动选择'], ['en', '英文自动选择']] as const) {
    const sel = await input.probes.selectFor(lang);
    add({
      layer: 'engines',
      id: `engine.select.${lang}`,
      label: `auto engine (${lang})`,
      labelZh,
      status: sel !== null ? 'ok' : 'fail',
      detail: sel !== null ? `${sel.engineId}（${sel.reason}）` : '无可用引擎',
      required: true,
      remediation: sel !== null ? null : '安装 CPU 基础包与一个语音识别模型',
    });
  }

  const counts = {
    ok: results.filter((r) => r.status === 'ok').length,
    warn: results.filter((r) => r.status === 'warn').length,
    fail: results.filter((r) => r.status === 'fail').length,
  };

  return {
    // "ok" means no REQUIRED check failed. Warnings are degradations the user chose or
    // has not got to yet; failures mean something is actually broken.
    ok: results.every((r) => !(r.status === 'fail' && r.required)),
    ranAt: new Date().toISOString(),
    dataDir: input.dataDir,
    storeRoot: input.storeRoot,
    extensionsDir: input.extensionsDir,
    counts,
    results,
  };
}

/** List installed artifact names under `<storeRoot>/by-name/<kind>/`. */
export async function listByName(storeRoot: string, kind: string): Promise<string[]> {
  try {
    return (await readdir(join(storeRoot, 'by-name', kind))).sort();
  } catch {
    return [];
  }
}
