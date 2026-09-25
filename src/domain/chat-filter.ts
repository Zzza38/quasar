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
 * Slur stems. Letters match with repeats ("gg" or "ggg"), except that a stem of three letters or fewer repeats only
 * its last letter, so "wop" does not match "woop". A space in a stem matches a run of spaces and joining symbols
 * (WORD_GAP: "-", "_", "/", "\", "+", "~", "&", "=", "^", "<", ">") or nothing, or one ".", "," or ":"; it never
 * spans a sentence or clause break such as ", ", ". ", "...", an em dash or an emoji. A hyphen in a stem matches
 * only a hyphen, an underscore or nothing: "wet-back" catches "wetback" and "wet-back" but not the ordinary "got wet
 * back there". A censored letter ("*", "#") inside a word matches any single letter, but only in a match with at
 * least two real letters (MIN_REAL_LETTERS), so a self-censored swear such as "s***" or "h***" is never read as a
 * four-letter stem. A censor mark at the start or end of a word is only ever a boundary, never a letter, so
 * emphasis such as "*app*" or "**on**" passes (the cost: "*aggot" with its first letter starred passes too).
 * A "#" that starts a word is a hashtag, not a censored letter ("#pics" passes).
 * Each stem may carry a plural or slang ending (s, z, a, ah).
 */
const SLURS = [
  // Anti-Black
  'nigger', 'nigga', 'niggah', 'negress', 'coon', 'jigaboo', 'porch monkey', 'jungle bunny', 'darkie', 'darky', 'golliwog', 'kaffir',
  // Anti-Latino
  'spic', 'spick', 'spik', 'wet-back', 'beaner',
  // Anti-Asian
  'chink', 'gook', 'jap', 'zipperhead', 'slanteye', 'slant eye', 'chinaman', 'chinamen', 'chingchong', 'ching chong',
  // Anti-Arab, South Asian, Middle Eastern
  'rag head', 'towel head', 'sandnigger', 'sand nigger', 'camel jockey', 'cameljockey', 'curry muncher', 'currymuncher', 'paki',
  // Antisemitic
  'kike', 'kyke', 'hymie', 'heeb', 'yid',
  // Anti-Indigenous
  'redskin', 'injun', 'squaw', 'prairie nigger',
  // Anti-European ethnic
  'wop', 'dago', 'polack', 'kraut',
  // Anti-gay and anti-trans
  'fag', 'faggot', 'fagot', 'faggy', 'dyke', 'tranny', 'trannie', 'she-male', 'ladyboy',
  // Ableist
  'retard', 'retarded', 'spaz', 'spazz',
];

/**
 * A leet digit or symbol at the edge of a word ("faggot!", "1retard") may be a letter or may be punctuation. The
 * internal normalized text marks such edge characters as uppercase so the pattern can read them either way: as a
 * letter inside a slur, or as a word boundary after one. A censor mark at the edge of a word ("*retard*") is
 * marked as EDGE_STAR, which is only a boundary: reading it as a letter too would turn emphasis such as "*app*",
 * "*id*" or "**on**" into "jap", "yid" or "coon". Leet characters and censor marks between letters ("n1gger",
 * "f*g", or the "*" in a spaced-out "f * g") are always plain letters or wildcards.
 */
const EDGE_STAR = '\u0001';
const letter = (char: string): string => `[${char}${char.toUpperCase()}]`;
const SUFFIX = `(?:${['s', 'z', 'az', 'a', 'ah'].map(ending => [...ending].map(letter).join('')).join('|')})?`;
const NOT_LETTER_BEFORE = '(?<![a-z*])';
const NOT_LETTER_AFTER = '(?![a-z*])';

/**
 * What may sit between the words of a two-word stem: a run of whitespace and joining symbols, or one ".", ",",
 * ":", "&" or "+" with nothing around it ("towel.head", "ching:chong", "rag+head"). Clause punctuation followed by
 * a space (", ", ". "), a spaced "&" or "+" (both read as "and"), ellipses, dashes other than "-", brackets, quotes
 * and emoji are left out, because ordinary sentences break there ("grab a towel. head to the pool", "grab your
 * towel & head out", "my towel 😭 head over").
 */
const WORD_GAP = '(?:[\\s_\\-/\\\\~=^<>]*|[.,:&+])';
const JOINED_GAP = '[_-]?';
/** The last letter of a short stem is the only one that may repeat ("fagg" but not "faag"). */
const SHORT_STEM = 3;

function stemPattern(stem: string): string {
  const letters = stem.replace(/[ -]/g, '').length;
  let seen = 0;
  return [...stem].map((char) => {
    if (char === ' ') return WORD_GAP;
    if (char === '-') return JOINED_GAP;
    seen += 1;
    const repeat = letters > SHORT_STEM || seen === letters ? '+' : '';
    return `(?:${letter(char)}${repeat}|\\*)`;
  }).join('');
}
const STEMS = `(?:${SLURS.map(stemPattern).join('|')})${SUFFIX}${NOT_LETTER_AFTER}`;
const SLUR_PATTERN_ALL = new RegExp(`${NOT_LETTER_BEFORE}${STEMS}`, 'g');
/** The same pattern anchored at a given index with no boundary before it: a slur at the end of a joined run of letters. */
const SLUR_AT = new RegExp(STEMS, 'y');
/** A match that uses censored letters needs this many real ones, so "f*g" is caught but "f***" is ordinary swearing. */
const MIN_REAL_LETTERS = 2;
/**
 * One-letter words that may lead a run of spaced-out letters ("u r a f a g", "you're a r e t a r d"). The join
 * step glues them onto the slur, so the slur is also looked for right after them, as long as it ends the run.
 * Only these letters are skipped, and a slur found that way may not start with a doubled letter, so a spaced-out
 * "r a c c o o n" still reads as "raccoon", not "ra" plus "ccoon". The cost is that a spaced-out word made of such
 * letters plus a stem ("a s p i c") is censored too; nobody spells ordinary words out letter by letter.
 */
const ONE_LETTER_WORDS = new Set(['a', 'i', 'u', 'r', 'o', 'y']);

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '$': 's', '@': 'a', '!': 'i', '|': 'l', '€': 'e', '£': 'l', '¡': 'i', '#': '*', '•': '*', '·': '*' };

/** Cyrillic and Greek letters that look like Latin ones, so "fаggot" with a Cyrillic а is still caught. */
const LOOKALIKES: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ԛ': 'q', 'һ': 'h', 'ԝ': 'w', 'к': 'k', 'т': 't', 'в': 'b', 'м': 'm', 'н': 'h', 'г': 'r', 'ո': 'n', 'ɡ': 'g', 'ı': 'i', 'ɩ': 'i', 'ǀ': 'l',
  'α': 'a', 'ε': 'e', 'ο': 'o', 'ρ': 'p', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'τ': 't', 'υ': 'u', 'χ': 'x', 'β': 'b', 'γ': 'y', 'η': 'n', 'ζ': 'z',
};
const LOOKALIKE_PATTERN = new RegExp(`[${Object.keys(LOOKALIKES).join('')}]`, 'gu');

const INVISIBLE = /[\p{Cf}\p{Cc}\p{Mn}\p{Me}\u200b-\u200f\u2060-\u206f\ufeff\u00ad]/gu;
/**
 * Tabs and line breaks are control characters too, but they separate words: the filter reads them as a space
 * instead of deleting them, so "hi\nfaggot" is not glued into one word that the whole-word match skips.
 */
const WHITESPACE_CONTROL = /^[\t-\r\u0085]$/u;
const SEPARATOR = /[\s._\-,]/;

/**
 * The normalized text plus, for each of its characters, the index of the original code point it came from.
 * Normalization: NFKD, tabs and line breaks read as spaces, invisible characters removed (zero-width spaces and
 * joiners, soft hyphens, every other Unicode format and control character, combining marks), lowercase, lookalike and leet letters mapped, censor marks
 * kept as "*", and runs of three or more spaced-out single letters joined ("n i g g e r"). No slur is two
 * letters long, so pairs are left alone. Leet characters and censor marks at the edge of a word are marked
 * (uppercase, EDGE_STAR) so they can count as either a letter or a boundary; see EDGE_STAR. A "#" that starts a
 * word stays "#", a plain boundary, because it is a hashtag. `runs` lists each joined run as [start, end) in the
 * normalized text.
 */
function normalizeWithOrigins(text: string): { normalized: string; origins: number[]; runs: [number, number][] } {
  const chars: string[] = [];
  const origins: number[] = [];
  const leet: boolean[] = [];
  const hash: boolean[] = [];
  Array.from(text).forEach((point, index) => {
    const mapped = WHITESPACE_CONTROL.test(point) ? ' ' : point.normalize('NFKD').replace(INVISIBLE, '').toLowerCase()
      .replace(LOOKALIKE_PATTERN, char => LOOKALIKES[char] ?? char);
    // UTF-16 code units, so indexes line up with the regex matches below (an emoji is two units).
    for (let unit = 0; unit < mapped.length; unit += 1) {
      const char = mapped[unit]!;
      const fromLeet = LEET[char];
      chars.push(fromLeet ?? char);
      origins.push(index);
      leet.push(fromLeet !== undefined || char === '*');
      hash.push(char === '#');
    }
  });
  // Mark the leet characters at either end of each word (a run of letters and censor marks).
  for (const word of chars.join('').matchAll(/[a-z*]+/g)) {
    const from = word.index ?? 0;
    const to = from + word[0].length;
    const mark = (at: number) => { chars[at] = chars[at] === '*' ? EDGE_STAR : chars[at]!.toUpperCase(); };
    let head = from;
    for (; head < to && hash[head]; head += 1) chars[head] = '#';
    for (; head < to && leet[head]; head += 1) mark(head);
    for (let tail = to - 1; tail >= head && leet[tail]; tail -= 1) mark(tail);
  }
  // Join spaced-out letters: inside a run of single letters separated by one separator each, drop the separators.
  const joined = chars.join('');
  const drop = new Set<number>();
  const joinedRuns: [number, number][] = [];
  for (const match of joined.matchAll(new RegExp(`(?<![a-z*])(?:[a-zA-Z*${EDGE_STAR}][\\s._\\-,]+){2,}[a-zA-Z*${EDGE_STAR}](?![a-z*])`, 'g'))) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    joinedRuns.push([from, to]);
    for (let at = from; at < to; at += 1) {
      if (SEPARATOR.test(joined[at]!)) drop.add(at);
      // Once joined, a lone censor mark between letters ("f * g") is inside the word, so it is a wildcard again.
      else if (at > from && at < to - 1 && chars[at] === EDGE_STAR) chars[at] = '*';
    }
  }
  const normalized: string[] = [];
  const kept: number[] = [];
  const position: number[] = [];
  chars.forEach((char, at) => { position.push(normalized.length); if (!drop.has(at)) { normalized.push(char); kept.push(origins[at]!); } });
  const runs = joinedRuns.map(([from, to]): [number, number] => [position[from]!, position[to - 1]! + 1]);
  return { normalized: normalized.join(''), origins: kept, runs };
}

const realLetters = (match: string) => match.replace(/[^a-zA-Z]/g, '').length;
const acceptable = (match: string) => !/[*\u0001]/.test(match) || realLetters(match) >= MIN_REAL_LETTERS;

/**
 * Every slur in the normalized text, as [index, matched text]. Whole words first; then, for a joined run of
 * spaced-out letters with no slur in it, a slur that ends the run after one or more leading one-letter words.
 */
function slurMatches({ normalized, runs }: { normalized: string; runs: [number, number][] }): { index: number; text: string }[] {
  const found: { index: number; text: string }[] = [];
  SLUR_PATTERN_ALL.lastIndex = 0;
  for (let match = SLUR_PATTERN_ALL.exec(normalized); match; match = SLUR_PATTERN_ALL.exec(normalized)) {
    // A match rejected for too few real letters may hide another stem one character later, so step by one.
    if (acceptable(match[0])) found.push({ index: match.index, text: match[0] });
    else SLUR_PATTERN_ALL.lastIndex = match.index + 1;
  }
  for (const [start, end] of runs) {
    if (found.some(match => match.index < end && match.index + match.text.length > start)) continue;
    for (let at = start; at < end - 1 && ONE_LETTER_WORDS.has(normalized[at]!); ) {
      at += 1;
      SLUR_AT.lastIndex = at;
      const match = SLUR_AT.exec(normalized);
      if (match && at + match[0].length === end && normalized[at] !== normalized[at + 1] && acceptable(match[0])) { found.push({ index: at, text: match[0] }); break; }
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** The normalized form alone (what the slur list is matched against), without the internal edge marks. */
export function normalizeForFilter(text: string): string {
  return normalizeWithOrigins(text).normalized.toLowerCase().replaceAll(EDGE_STAR, '*');
}

/**
 * Folds text for lookalike-proof comparisons such as the reserved display-name check: NFKD, invisible characters
 * and combining marks removed, lowercased, and Cyrillic or Greek lookalikes mapped to Latin ("Ѕuррort" becomes
 * "support"). With `leet`, digits and symbols that stand in for letters are mapped too ("Supp0rt").
 */
export function foldConfusables(text: string, options: { leet?: boolean } = {}): string {
  return Array.from(text.normalize('NFKD').replace(INVISIBLE, '').toLowerCase())
    .map(char => LOOKALIKES[char] ?? (options.leet ? LEET[char] ?? char : char)).join('');
}

/** True when the text contains a slur from the list (after normalization). */
export function hasSlur(text: string): boolean {
  return slurMatches(normalizeWithOrigins(text)).length > 0;
}

/**
 * The text with every slur replaced by asterisks, one per matched letter, covering the original characters
 * (including any invisible ones or separators used to disguise it). Everything else is returned untouched.
 */
export function censorSlurs(text: string): string {
  const normalization = normalizeWithOrigins(text);
  const { origins } = normalization;
  const matches = slurMatches(normalization);
  if (!matches.length) return text;
  const points = Array.from(text);
  const replaced: { from: number; to: number; stars: number }[] = [];
  for (const match of matches) {
    const start = match.index;
    const end = start + match.text.length - 1;
    replaced.push({ from: origins[start]!, to: origins[end]!, stars: match.text.replace(/[^a-zA-Z*\u0001]/g, '').length });
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
