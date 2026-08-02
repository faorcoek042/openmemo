/**
 * Post-processing for Paraformer output. ADR-013 decision 1 item 3.
 *
 * Paraformer's acoustic model writes numbers as Chinese words and drops English casing.
 * Both are cosmetic for a human reader but NOT cosmetic downstream: the mind-map
 * generator asks an LLM to extract dates and entities, and "两千零八年" is materially
 * harder to pin to 2008 than "2008年" is.
 *
 * ⚠️ STATUS (T-030): `zhNumeralsToArabic` is NOT enabled by default. Measured regression:
 * 两千零六年 -> 两千06年. The rules fire on partial matches in mixed positional/digit-run
 * numerals. Kept, with failing cases documented in the tests, until fixed.
 * `restoreEnglishCasing` IS enabled: a fixed allowlist cannot make text worse.
 *
 * SCOPE — deliberately conservative. These are the two transforms that are safe to do
 * with rules. Anything requiring real semantic understanding is NOT attempted here; see
 * the "not attempted" notes on each function. A wrong "fix" in a transcript is worse
 * than a raw one, because the user cannot tell it was us.
 */

// =========================================================================================
// Chinese numerals -> Arabic
// =========================================================================================

const DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 幺: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

const UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const BIG_UNITS: Record<string, number> = { 万: 10_000, 亿: 100_000_000 };

/** Characters that can appear inside one Chinese number. */
const NUM_CHARS = new RegExp(`[${Object.keys(DIGITS).join('')}${Object.keys(UNITS).join('')}${Object.keys(BIG_UNITS).join('')}]`);

/**
 * Parse a positional Chinese numeral (三千七百多万 -> 37000000-ish, 一百四十 -> 140).
 * Returns null when the string is not a well-formed number.
 */
export function parseChineseNumber(s: string): number | null {
  if (s.length === 0) return null;

  let total = 0;
  let section = 0;
  let current = 0;
  let sawAny = false;

  for (const ch of s) {
    if (ch in DIGITS) {
      current = DIGITS[ch]!;
      sawAny = true;
      continue;
    }
    if (ch in UNITS) {
      const unit = UNITS[ch]!;
      // 十 with no preceding digit means one ten (十五 = 15).
      section += (current === 0 ? 1 : current) * unit;
      current = 0;
      sawAny = true;
      continue;
    }
    if (ch in BIG_UNITS) {
      const big = BIG_UNITS[ch]!;
      section = (section + current) * big;
      total += section;
      section = 0;
      current = 0;
      sawAny = true;
      continue;
    }
    return null;
  }

  if (!sawAny) return null;
  return total + section + current;
}

/**
 * A run of digit characters read out one by one, e.g. a year: 二零零八 -> 2008.
 *
 * Distinguished from the positional form because 二零零八 is NOT 2008 positionally — it
 * is a digit sequence. Years are overwhelmingly spoken this way, so we check for a pure
 * digit run before trying positional parsing.
 */
function parseDigitRun(s: string): string | null {
  if (s.length < 2) return null;
  let out = '';
  for (const ch of s) {
    if (!(ch in DIGITS)) return null;
    // 两 never appears in a read-out digit sequence; its presence means positional.
    if (ch === '两') return null;
    out += String(DIGITS[ch]);
  }
  return out;
}

/**
 * Convert Chinese numerals to Arabic digits.
 *
 * NOT ATTEMPTED (each would need context we do not have):
 *   - 一 used as "a/one" rather than a count ("一个问题" stays as-is unless followed by
 *     a unit we recognise) — converting it would produce "1个问题", which reads worse.
 *   - Ordinals and section headers ("一、历史") — left alone, since "1、历史" is not an
 *     improvement and the pattern collides with list markers.
 *   - 多 / 几 / 余 approximations ("三千七百多万") — the number is converted, the
 *     approximation word is preserved, so meaning is not lost.
 */
export function zhNumeralsToArabic(text: string): string {
  if (text.length === 0) return text;

  // Longest-first so 年月日 patterns win over bare runs.
  let out = text;

  // 1. Years: a 2-or-more digit run immediately before 年.
  out = out.replace(/([零〇一二三四五六七八九]{2,})年/g, (m, run: string) => {
    const digits = parseDigitRun(run);
    return digits === null ? m : `${digits}年`;
  });

  // 2. Percentages: 百分之七百五十二 -> 752%
  out = out.replace(/百分之([零〇一二三四五六七八九两十百千万亿]+)/g, (m, num: string) => {
    const n = parseChineseNumber(num);
    return n === null ? m : `${String(n)}%`;
  });

  // 3. Quantities followed by a unit/measure word we are confident about.
  //    Restricting to these units is what keeps "一个" and "一种" from being mangled.
  const UNIT_WORDS = '年|月|日|号|时|点|分|秒|岁|位|名|人|个月|周|天|字|万|亿|元|美元|公里|米|页|集|章|条|次|届|世纪';
  out = out.replace(
    new RegExp(`([零〇一二三四五六七八九两十百千万亿]{2,})(?=(${UNIT_WORDS}))`, 'g'),
    (m: string) => {
      const digits = parseDigitRun(m);
      if (digits !== null) return digits;
      const n = parseChineseNumber(m);
      return n === null ? m : String(n);
    },
  );

  return out;
}

// =========================================================================================
// English casing
// =========================================================================================

/**
 * Terms Paraformer reliably lowercases. Ordered longest-first at match time so
 * "ruby on rails" wins over "ruby".
 *
 * DELIBERATELY A FIXED LIST, not a heuristic. "Capitalise any word after a full stop"
 * is wrong for Chinese text (there are no sentence-initial English words to speak of)
 * and "capitalise unknown latin runs" would turn "sms" into "Sms". A curated list is
 * small, predictable, and never makes the text worse — an unlisted term simply stays as
 * the model produced it.
 */
const KNOWN_TERMS: string[] = [
  'Twitter', 'Facebook', 'Google', 'YouTube', 'GitHub', 'Microsoft', 'Windows Live',
  'Windows', 'Apple', 'iPhone', 'iPad', 'macOS', 'Android', 'Linux', 'Ubuntu',
  'OpenAI', 'ChatGPT', 'Claude', 'Gemini', 'DeepSeek', 'NVIDIA', 'AMD', 'Intel',
  'Ruby on Rails', 'Ruby', 'Python', 'JavaScript', 'TypeScript', 'Node.js', 'Scala',
  'Java', 'Rails', 'React', 'Vue', 'Docker', 'Kubernetes',
  'RSS', 'SMS', 'API', 'URL', 'HTTP', 'HTTPS', 'HTML', 'CSS', 'JSON', 'XML', 'PDF',
  'CPU', 'GPU', 'RAM', 'SSD', 'USB', 'WiFi', 'IP', 'DNS', 'VPN', 'CEO', 'CTO', 'NBA',
  'AI', 'ML', 'LLM', 'ASR', 'TTS', 'OCR', 'SDK', 'IDE', 'CLI', 'UI', 'UX',
  'Alexa', 'Bing', 'Flickr', 'LinkedIn', 'Instagram', 'TikTok', 'WeChat', 'Weibo',
];

const TERM_PATTERNS: { re: RegExp; replacement: string }[] = KNOWN_TERMS
  .slice()
  .sort((a, b) => b.length - a.length)
  .map((term) => ({
    // \b does not behave usefully next to CJK, so we assert "not a latin letter/digit"
    // on both sides instead.
    re: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9])`, 'gi'),
    replacement: term,
  }));

/**
 * Restore casing for known terms.
 *
 * NOT ATTEMPTED: general proper-noun casing. Deciding that "audio 公司" should be
 * "Obvious 公司" requires knowing the entity — that is a model's job, not a regex's, and
 * guessing would corrupt text while looking authoritative.
 */
export function restoreEnglishCasing(text: string): string {
  if (text.length === 0) return text;
  let out = text;
  for (const { re, replacement } of TERM_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Both transforms, in the order ParaformerEngine applies them. */
export function postprocessChinese(
  text: string,
  opts: { numerals?: boolean; casing?: boolean } = {},
): string {
  let out = text;
  if (opts.numerals !== false) out = zhNumeralsToArabic(out);
  if (opts.casing !== false) out = restoreEnglishCasing(out);
  return out;
}

/** True when the text contains any Chinese numeral character — used by tests and the UI. */
export function hasChineseNumerals(text: string): boolean {
  return NUM_CHARS.test(text);
}
