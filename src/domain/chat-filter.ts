/**
 * Chat slur filter, shared by the composer (a notice under the draft) and the server (censors the stored text).
 *
 * Ordinary swearing passes. Slurs are replaced with asterisks: the list below is matched as whole words after
 * the text is normalized, so "n1gger", "f*ggot", "r e t a r d", "fag\u200bgot" and "faggggot" are all caught,
 * while "spicy", "raccoon" and "Japan" are not. Every notice is a fixed string; the message text is never echoed.
 */

/** Shown under the composer while the draft has a slur in it. The message still sends; the slur leaves as asterisks. */
export const SLUR_NOTICE = 'Slurs get censored before your message is sent. Swearing is fine.';

/**
 * Slur stems. Letters match with repeats ("gg" or "ggg"), a space in a stem matches any separator, and
 * a censored letter ("*", "#") matches any single letter. Each stem may carry a plural or slang ending (s, z, a, ah).
 */
const SLURS = [
  // Anti-Black
  'nigger', 'nigga', 'niggah', 'negress', 'coon', 'jigaboo', 'porch monkey', 'jungle bunny', 'darkie', 'darky', 'golliwog', 'kaffir',
  // Anti-Latino
  'spic', 'spick', 'spik', 'wetback', 'wet back', 'beaner',
  // Anti-Asian
  'chink', 'gook', 'jap', 'zipperhead', 'slanteye', 'slant eye', 'chinaman', 'chinamen', 'chingchong', 'ching chong',
  // Anti-Arab, South Asian, Middle Eastern
  'raghead', 'rag head', 'towelhead', 'towel head', 'sandnigger', 'sand nigger', 'camel jockey', 'cameljockey', 'curry muncher', 'currymuncher', 'paki',
  // Antisemitic
  'kike', 'kyke', 'hymie', 'heeb', 'yid',
  // Anti-Indigenous
  'redskin', 'injun', 'squaw', 'prairie nigger',
  // Anti-European ethnic
  'wop', 'dago', 'polack', 'kraut',
  // Anti-gay and anti-trans
  'fag', 'faggot', 'fagot', 'faggy', 'dyke', 'tranny', 'trannie', 'shemale', 'she male', 'ladyboy',
  // Ableist
  'retard', 'retarded', 'spaz', 'spazz',
];

const SUFFIX = '(?:s|z|az|a|ah)?';
const NOT_LETTER_BEFORE = '(?<![a-z*])';
const NOT_LETTER_AFTER = '(?![a-z*])';

function stemPattern(stem: string): string {
  return [...stem].map(char => (char === ' ' ? '[^a-z*]*' : `(?:${char}+|\\*)`)).join('');
}
const SLUR_PATTERN = new RegExp(`${NOT_LETTER_BEFORE}(?:${SLURS.map(stemPattern).join('|')})${SUFFIX}${NOT_LETTER_AFTER}`);

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '$': 's', '@': 'a', '!': 'i', '|': 'l', '€': 'e', '£': 'l', '¡': 'i', '#': '*', '•': '*', '·': '*' };

/** Cyrillic and Greek letters that look like Latin ones, so "fаggot" with a Cyrillic а is still caught. */
const LOOKALIKES: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ԛ': 'q', 'һ': 'h', 'ԝ': 'w', 'к': 'k', 'т': 't', 'в': 'b', 'м': 'm', 'н': 'h', 'г': 'r', 'ո': 'n', 'ɡ': 'g', 'ı': 'i', 'ɩ': 'i', 'ǀ': 'l',
  'α': 'a', 'ε': 'e', 'ο': 'o', 'ρ': 'p', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'τ': 't', 'υ': 'u', 'χ': 'x', 'β': 'b', 'γ': 'y', 'η': 'n', 'ζ': 'z',
};
const LOOKALIKE_PATTERN = new RegExp(`[${Object.keys(LOOKALIKES).join('')}]`, 'gu');

const INVISIBLE = /[\p{Cf}\p{Cc}\p{Mn}\p{Me}\u200b-\u200f\u2060-\u206f\ufeff\u00ad]/gu;
const SEPARATOR = /[\s._\-,]/;
const SLUR_PATTERN_ALL = new RegExp(SLUR_PATTERN.source, 'g');

/**
 * The normalized text plus, for each of its characters, the index of the original code point it came from.
 * Normalization: NFKD, invisible characters removed (zero-width spaces and joiners, soft hyphens, every Unicode
 * format and control character, combining marks), lowercase, lookalike and leet letters mapped, censor marks
 * kept as "*", and runs of three or more spaced-out single letters joined ("n i g g e r"). No slur is two
 * letters long, so pairs are left alone.
 */
function normalizeWithOrigins(text: string): { normalized: string; origins: number[] } {
  const chars: string[] = [];
  const origins: number[] = [];
  Array.from(text).forEach((point, index) => {
    const mapped = point.normalize('NFKD').replace(INVISIBLE, '').toLowerCase()
      .replace(LOOKALIKE_PATTERN, char => LOOKALIKES[char] ?? char)
      .replace(/[0134578$@!|€£¡#•·]/g, char => LEET[char] ?? char);
    // UTF-16 code units, so indexes line up with the regex matches below (an emoji is two units).
    for (let unit = 0; unit < mapped.length; unit += 1) { chars.push(mapped[unit]!); origins.push(index); }
  });
  // Join spaced-out letters: inside a run of single letters separated by one separator each, drop the separators.
  const joined = chars.join('');
  const drop = new Set<number>();
  for (const match of joined.matchAll(/(?<![a-z*])(?:[a-z*][\s._\-,]+){2,}[a-z*](?![a-z*])/g)) {
    const from = match.index ?? 0;
    for (let at = from; at < from + match[0].length; at += 1) if (SEPARATOR.test(joined[at]!)) drop.add(at);
  }
  const normalized: string[] = [];
  const kept: number[] = [];
  chars.forEach((char, at) => { if (!drop.has(at)) { normalized.push(char); kept.push(origins[at]!); } });
  return { normalized: normalized.join(''), origins: kept };
}

/** The normalized form alone (what the slur list is matched against). */
export function normalizeForFilter(text: string): string {
  return normalizeWithOrigins(text).normalized;
}

/** True when the text contains a slur from the list (after normalization). */
export function hasSlur(text: string): boolean {
  return SLUR_PATTERN.test(normalizeForFilter(text));
}

/**
 * The text with every slur replaced by asterisks, one per matched letter, covering the original characters
 * (including any invisible ones or separators used to disguise it). Everything else is returned untouched.
 */
export function censorSlurs(text: string): string {
  const { normalized, origins } = normalizeWithOrigins(text);
  const matches = [...normalized.matchAll(SLUR_PATTERN_ALL)];
  if (!matches.length) return text;
  const points = Array.from(text);
  const replaced: { from: number; to: number; stars: number }[] = [];
  for (const match of matches) {
    const start = match.index ?? 0;
    const end = start + match[0].length - 1;
    replaced.push({ from: origins[start]!, to: origins[end]!, stars: match[0].replace(/[^a-z*]/g, '').length });
  }
  const out: string[] = [];
  let cursor = 0;
  for (const range of replaced) {
    if (range.from < cursor) continue;
    out.push(...points.slice(cursor, range.from), '*'.repeat(range.stars));
    cursor = range.to + 1;
  }
  out.push(...points.slice(cursor));
  return out.join('');
}

/** The composer's notice for a draft with a slur in it, or null. Nothing is refused; the server censors. */
export function slurNotice(text: string): string | null {
  return hasSlur(text) ? SLUR_NOTICE : null;
}

/* ---------- The ICE prank ---------- */

const IMMIGRANTS = /(?<![a-z])immigrants?(?![a-z])/i;

/** True when the message mentions "immigrant" or "immigrants". Nothing is reported anywhere; it only shows the joke line. */
export function mentionsImmigrants(text: string): boolean {
  return IMMIGRANTS.test(text);
}

/** The joke line shown under a message that mentions immigrants: a cartoon klaxon, the owner's exact wording. Nothing is stored, sent or reported anywhere. */
export function icePrankNotice(): string {
  return 'ALERT! ALERT! WORD "IMMIGRANT" DETECTED. Reporting to ICE...';
}
