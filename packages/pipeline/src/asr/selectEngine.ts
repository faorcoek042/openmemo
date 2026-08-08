/**
 * Engine selection. D-01 §6.1, ADR-013 decision 1.
 *
 * Policy: `user override > explicit setting > automatic by language`.
 *
 * The automatic rule exists because the right default genuinely differs by language —
 * measured on identical audio and hardware (T-026):
 *
 *   Chinese, offline:  paraformer 84x realtime, 12/13 proper nouns
 *                      whisper large-v3-turbo 2.7x realtime, 13/13
 *                      whisper base 18x realtime, ~2/13   ← fast but unusable
 *   English, offline:  whisper is the only engine we ship that handles it well.
 *
 * ADR-013 is explicit that the Chinese default is a TRADE, not a free win: Paraformer
 * costs word-level timestamps. So `selectEngine` returns the reasons and costs alongside
 * the choice, and the UI is expected to show them. Choosing for the user is fine;
 * choosing for the user and not saying so is not.
 */

import type { AsrCapabilities, AsrEngine } from './types.js';

export type EngineId = 'whisper.cpp' | 'paraformer' | 'sherpa-onnx';

export type TranscriptionMode = 'batch' | 'stream';

export interface EngineCandidate {
  engine: AsrEngine;
  capabilities: AsrCapabilities;
  available: boolean;
  unavailableReason?: string;
}

export interface SelectEngineInput {
  candidates: EngineCandidate[];
  /** BCP-47-ish language tag, or 'auto'/undefined when unknown. */
  language?: string;
  mode: TranscriptionMode;
  /** Explicit engine id from settings. Beats the automatic rule. */
  preferredEngineId?: EngineId;
  /** One-off override for this job (the "switch engine and re-run" button). */
  forceEngineId?: EngineId;
  /**
   * The user needs word-level timing (F5 word highlighting, karaoke export).
   * Engines without it are demoted rather than excluded — a transcript with coarse
   * timing beats no transcript.
   */
  requireWordTimestamps?: boolean;
}

/** Costs the UI must surface when this engine is chosen. */
export interface EngineTradeoff {
  code: 'no_word_timestamps' | 'no_punctuation' | 'slow_on_cpu' | 'poor_for_language';
  /** Plain-language explanation, already localised for the primary audience. */
  message: string;
}

export interface EngineSelection {
  engine: AsrEngine;
  engineId: string;
  /** Why this one, in order of precedence applied. */
  reason: string;
  tradeoffs: EngineTradeoff[];
  /** Other engines the user could switch to, best first. */
  alternatives: { engineId: string; benefit: string }[];
}

export function isChinese(language: string | undefined): boolean {
  if (language === undefined) return false;
  const l = language.toLowerCase();
  return l.startsWith('zh') || l.startsWith('cmn') || l.startsWith('yue');
}

/**
 * Score a candidate for (language, mode). Higher wins. 0 means "cannot serve this".
 *
 * Scores are ordinal, not physical quantities — they encode the measured ranking, and
 * the comment above each block records the measurement that justifies it.
 */
function score(c: EngineCandidate, input: SelectEngineInput): number {
  if (!c.available) return 0;
  if (!c.capabilities.modes.includes(input.mode)) return 0;

  const zh = isChinese(input.language);
  let s = 10;

  if (input.mode === 'stream') {
    // Only sherpa-onnx streams at all; whisper.cpp cannot produce partials.
    return c.engine.id === 'sherpa-onnx' ? 100 : 0;
  }

  if (zh) {
    // 84x vs 2.7x realtime with 12/13 vs 13/13 proper nouns (T-026).
    if (c.engine.id === 'paraformer') s = 90;
    else if (c.engine.id === 'whisper.cpp') s = 60;
  } else {
    // Paraformer is Chinese-only; running it on English produces garbage.
    if (c.engine.id === 'paraformer') {
      const claimsLang = c.capabilities.languages;
      const supports =
        claimsLang === 'auto' ||
        (Array.isArray(claimsLang) &&
          claimsLang.some(
            (l) => input.language !== undefined && input.language.toLowerCase().startsWith(l),
          ));
      if (!supports) return 0;
      s = 40;
    } else if (c.engine.id === 'whisper.cpp') {
      s = 90;
    }
  }

  // Demote, never exclude: coarse timing beats no transcript.
  if (input.requireWordTimestamps === true && !c.capabilities.wordTimestamps) {
    s -= 50;
  }

  return Math.max(1, s);
}

export function selectEngine(input: SelectEngineInput): EngineSelection | null {
  const byId = (id: string): EngineCandidate | undefined =>
    input.candidates.find((c) => c.engine.id === id);

  // 1. Per-job override (the "re-run with a different engine" path).
  if (input.forceEngineId !== undefined) {
    const forced = byId(input.forceEngineId);
    if (forced !== undefined && forced.available) {
      return describe(forced, input, `forced for this job (${input.forceEngineId})`);
    }
  }

  // 2. Settings preference.
  if (input.preferredEngineId !== undefined) {
    const preferred = byId(input.preferredEngineId);
    if (preferred !== undefined && preferred.available) {
      return describe(preferred, input, `preferred in settings (${input.preferredEngineId})`);
    }
  }

  // 3. Automatic.
  const ranked = input.candidates
    .map((c) => ({ c, s: score(c, input) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  const best = ranked[0];
  if (best === undefined) return null;

  const why = isChinese(input.language)
    ? input.mode === 'stream'
      ? 'automatic: only this engine supports live transcription'
      : 'automatic: fastest engine with acceptable Chinese accuracy'
    : 'automatic: best fit for this language';

  return describe(best.c, input, why);
}

function describe(c: EngineCandidate, input: SelectEngineInput, reason: string): EngineSelection {
  const tradeoffs: EngineTradeoff[] = [];

  if (!c.capabilities.wordTimestamps) {
    tradeoffs.push({
      code: 'no_word_timestamps',
      message:
        '此引擎不提供逐字时间戳，转写稿与音频的联动将按段落高亮，而不是逐字高亮。' +
        '需要逐字精度可切换到 Whisper 并重新转写。',
    });
  }

  if (c.engine.id === 'paraformer') {
    tradeoffs.push({
      code: 'no_punctuation',
      message: '标点由独立模型补全；数字与英文大小写为规则还原，可能与原文有出入。',
    });
  }

  if (c.engine.id === 'whisper.cpp' && isChinese(input.language)) {
    tradeoffs.push({
      code: 'slow_on_cpu',
      message:
        '中文使用 Whisper large 系列时，在没有显卡的机器上约为 2.7 倍速' +
        '（1 小时录音约需 22 分钟）。',
    });
  }

  const alternatives = input.candidates
    .filter((x) => x.engine.id !== c.engine.id && x.available)
    .map((x) => ({
      engineId: x.engine.id,
      benefit:
        x.capabilities.wordTimestamps && !c.capabilities.wordTimestamps
          ? '提供逐字时间戳'
          : x.capabilities.modes.includes('stream') && !c.capabilities.modes.includes('stream')
            ? '支持实时字幕'
            : '备选引擎',
    }));

  return { engine: c.engine, engineId: c.engine.id, reason, tradeoffs, alternatives };
}

/** Build candidates by probing availability. Failures become unavailable, not throws. */
export async function buildCandidates(engines: AsrEngine[]): Promise<EngineCandidate[]> {
  return Promise.all(
    engines.map(async (engine) => {
      try {
        const [capabilities, availability] = await Promise.all([
          engine.capabilities(),
          engine.isAvailable(),
        ]);
        return {
          engine,
          capabilities,
          available: availability.ok,
          ...(availability.ok ? {} : { unavailableReason: availability.reason }),
        };
      } catch (err) {
        return {
          engine,
          capabilities: {
            modes: [],
            backends: [],
            languages: [],
            wordTimestamps: false,
            diarization: false,
          },
          available: false,
          unavailableReason: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}
