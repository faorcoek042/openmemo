import { useTranslation } from 'react-i18next';
import { Type } from 'lucide-react';

import type { TranscriptSegmentDto } from '../../lib/events/types';

/**
 * 逐字高亮可用性徽标（ADR-013 §0）。
 *
 * 中文默认引擎 Paraformer **没有词级时间戳**，所以 F5 只能整句高亮。
 * 不显式说明的话，用户会把它当成 bug（"为什么高亮不跟着字走"），
 * 而真相是引擎取舍 —— 且换 large-v3-turbo 就能拿到，只是慢 32 倍。
 *
 * 这条属于**功能正确性**而不是文案润色：不能让 UI 暗示存在一个它并不具备的能力。
 */
export function WordLevelBadge({ segments }: { segments: readonly TranscriptSegmentDto[] }) {
  const { t } = useTranslation();
  if (segments.length === 0) return null;

  const hasWordLevel = segments.some((s) => s.words && s.words.length > 0);
  if (hasWordLevel) return null;

  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-normal text-ink-muted"
      title={t('recorder.paraformerTradeoff')}
    >
      <Type className="size-3" aria-hidden />
      {t('recorder.wordLevelUnavailable')}
    </span>
  );
}
