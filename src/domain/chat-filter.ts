import { CONFUSABLE_LETTERS } from './confusable-letters';

/**
 * Chat slur filter, shared by the composer (a notice under the draft) and the server (censors the stored text).
 *
 * Ordinary swearing passes. Slurs are replaced with asterisks: the list below is matched as whole words after
 * the text is normalized, so "n1gger", "f*ggot", "r e t a r d", "fag\u200bgot" and "faggggot" are all caught,
 * while "spicy", "raccoon" and "Japan" are not. The worst stems are also caught inside longer words, and a word
 * made only of glued slurs is caught whole (see EMBEDDED_SLURS). Every notice is a fixed string; the message
 * text is never echoed.
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
 * Each stem may carry a plural or slang ending (s, z, a, ah). An "i" in a stem also matches "y" ("nygga", "chynk").
 */
const SLURS = [
  // Anti-Black
  'nigger', 'nigga', 'niggah', 'nigguh', 'niggur', 'niggor', 'niggr', 'niga', 'nigah', 'nlgger', 'nlgga', 'negress', 'coon', 'jigaboo', 'porch monkey', 'jungle bunny', 'darkie', 'darky', 'golliwog', 'kaffir',
  // Anti-Latino
  'spic', 'spick', 'spik', 'wet-back', 'wet-bak', 'beaner',
  // Anti-Asian
  'chink', 'chinky', 'chinkie', 'gook', 'jap', 'zipperhead', 'slanteye', 'slant eye', 'chinaman', 'chinamen', 'chingchong', 'ching chong',
  // Anti-Arab, South Asian, Middle Eastern
  'rag head', 'towel head', 'sandnigger', 'sand nigger', 'camel jockey', 'cameljockey', 'curry muncher', 'currymuncher', 'paki',
  // Antisemitic
  'kike', 'kyke', 'hymie', 'heeb', 'yid',
  // Anti-Indigenous
  'redskin', 'injun', 'squaw', 'prairie nigger',
  // Anti-European ethnic
  'wop', 'dago', 'polack', 'kraut',
  // Anti-gay and anti-trans
  'fag', 'fahg', 'faggot', 'fagot', 'faggy', 'faggie', 'faggit', 'fagget', 'faggut', 'faggat', 'phag', 'phaggot', 'feggot', 'dyke', 'tranny', 'trannie', 'tranni', 'trany', 'she-male', 'ladyboy',
  // Ableist
  'retard', 'retarded', 'retarted', 'rehtard', 'rehtarded', 'ritarded', 'retart', 'spaz', 'spazz',
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
const letter = (char: string): string => (char === 'i' ? '[iIyY]' : `[${char}${char.toUpperCase()}]`);
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
    // A "q" reads as a "g" in a longer stem ("niqqa", "faqqot"), but not in a short one, where "faq" is a word.
    const shape = char === 'g' && letters > SHORT_STEM ? '[gGqQ]' : letter(char);
    // A silent "h" may follow any letter of a longer stem ("niggha", "fagghot", "retharded").
    const silentH = letters > SHORT_STEM && char !== 'h' ? '[hH]?' : '';
    return `(?:${shape}${repeat}${silentH}|\\*)`;
  }).join('');
}
const STEMS = `(?:${SLURS.map(stemPattern).join('|')})${SUFFIX}${NOT_LETTER_AFTER}`;
const SLUR_PATTERN_ALL = new RegExp(`${NOT_LETTER_BEFORE}${STEMS}`, 'g');
/** The same pattern anchored at a given index with no boundary before it: a slur at the end of a joined run of letters. */
const SLUR_AT = new RegExp(STEMS, 'y');
/** A match that uses censored letters needs this many real ones, so "f*g" is caught but "f***" is ordinary swearing. */
const MIN_REAL_LETTERS = 2;

/**
 * Stems caught even inside a longer word ("bigniggers", "ilovefaggots", "xretardx"). No ordinary word contains one,
 * apart from the words in EMBEDDED_SAFE, which are masked out of the word before it is searched, so "snigger" and
 * "fire retardant" pass while "sniggernigger" does not. Short stems stay whole-word only ("raccoon", "Japan",
 * "spicy", "squawk"); a word made only of glued slurs ("fagfag") is caught by STEM_AT instead.
 */
const EMBEDDED_SLURS = ['nigger', 'nigga', 'niggah', 'nigguh', 'niggur', 'niggor', 'nlgger', 'nlgga', 'negress', 'jigaboo', 'faggot', 'faggit', 'faggut', 'phaggot', 'tranny', 'trannie', 'retard', 'retarded', 'retarted', 'rehtard', 'ritarded', 'beaner', 'wet-back', 'wet-bak', 'zipperhead'];
const EMBEDDED_SAFE = /snigger|niggard|retarda(?:nt|nce|tion)|retarder|beaner(?:y|ies)/gi;
const SLUR_INSIDE = new RegExp([...EMBEDDED_SLURS].sort((a, b) => b.length - a.length).map(stemPattern).join('|'), 'g');
/** A slur found inside a word needs more real letters than a whole-word one, so self-censored swears stay out. */
const EMBEDDED_MIN_REAL_LETTERS = 4;
/** One stem at a given index, longest stems first so "spickspick" reads as two "spick" and not "spic" plus "kspick". */
const STEM_AT = new RegExp(`(?:${[...SLURS].sort((a, b) => b.length - a.length).map(stemPattern).join('|')})`, 'y');
const ONLY_SUFFIX = new RegExp(`^${SUFFIX}$`);
/**
 * A short stem glued to a word that commonly leads or trails an insult ("fagboy", "coonboy", "dumbfag", "ufag").
 * Only these words are allowed around it, so "raccoon", "Japan", "spicy" and "coonhound" still pass.
 */
const INSULT_HEADS = ['big', 'dumb', 'stupid', 'fat', 'lil', 'little', 'ugly', 'dirty', 'fuckin', 'fucking', 'you', 'ur', 'u', 'ya', 'yo', 'gay', 'shit', 'ass', 'mega', 'super', 'ultra', 'hey', 'the', 'stinky', 'smelly', 'nasty', 'lazy', 'poor', 'broke'];
const INSULT_TAILS = [
  'boy', 'girl', 'kid', 'child', 'baby', 'face', 'head', 'brain', 'lover', 'lord', 'master', 'king', 'queen', 'prince', 'man', 'men', 'guy', 'dude', 'bro',
  'mom', 'dad', 'mother', 'father', 'son', 'sister', 'brother', 'family', 'friend', 'gang', 'squad', 'people', 'folk', 'lady', 'trash', 'scum', 'junk',
  'ass', 'bag', 'hole', 'dick', 'cock', 'slut', 'whore', 'bitch', 'shit', 'fuck', 'stain', 'wad', 'tard', 'monkey', 'dog', 'pig', 'rat', 'ape', 'nerd',
  'ball', 'balls', 'nut', 'nuts', 'bucket', 'zilla', 'licker', 'sucker', 'fucker', 'eater', 'muncher',
  'land', 'town', 'house', 'school', 'teacher', 'food', 'life', 'energy', 'vibes', 'behavior', 'breath', 'loving',
];
const spelled = (words: string[]) => `(?:${words.map(word => [...word].map(letter).join('')).join('|')})`;
const ANY_STEM = `(?:${SLURS.map(stemPattern).join('|')})${SUFFIX}`;
const INSULT_COMPOUND = new RegExp(`^(?:${spelled(INSULT_HEADS)}+${ANY_STEM}${spelled(INSULT_TAILS)}*|${ANY_STEM}${spelled(INSULT_TAILS)}+)${SUFFIX}$`);
/**
 * One-letter words that may lead a run of spaced-out letters ("u r a f a g", "you're a r e t a r d"). The join
 * step glues them onto the slur, so the slur is also looked for right after them, as long as it ends the run.
 * Only these letters are skipped, and a slur found that way may not start with a doubled letter, so a spaced-out
 * "r a c c o o n" still reads as "raccoon", not "ra" plus "ccoon". The cost is that a spaced-out word made of such
 * letters plus a stem ("a s p i c") is censored too; nobody spells ordinary words out letter by letter.
 */
const ONE_LETTER_WORDS = new Set(['a', 'i', 'u', 'r', 'o', 'y']);

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '$': 's', '@': 'a', '!': 'i', '|': 'l', '€': 'e', '£': 'l', '¡': 'i', '#': '*', '•': '*', '·': '*', '❗': 'i', '❕': 'i', 'ǃ': 'i', '9': 'g', '6': 'g', '†': 't', '✝': 't', '✞': 't', '✟': 't' };

/** Each character of `shapes` paired with the letter at the same position in `latin`. */
const pairs = (shapes: string, latin: string): [string, string][] => Array.from(shapes, (shape, at) => [shape, latin[at]!]);

/**
 * Characters that look like a plain Latin letter, so "fаggot" with a Cyrillic а, "ɴɪɢɢᴇʀ", "fɑggot", "FꓮGGOT" and
 * "nᎥgger" are all caught. Most come from Unicode's own confusables list (CONFUSABLE_LETTERS, generated); the
 * pairs below add shapes it leaves out and settle the few where it picks a different letter than a reader would
 * ("ν" reads as v, "η" as n). Scripts with case are listed in capitals; the lowercase forms are added too, since
 * the text is lowercased first, but never over a character listed in its own right ("Ɪ" must not turn "ɪ" into l).
 */
const LISTED_LOOKALIKES: [string, string][] = [
  ...Object.entries(CONFUSABLE_LETTERS).flatMap(([latin, shapes]) => Array.from(shapes, (shape): [string, string] => [shape, latin])),
  ...pairs('νηꓲɛɘǝəŋẏᴉᵹ𐌉𐌀𐌏ΛΔæ', 'vnieeeenyigiaoaae'),
  // Canadian syllabics, Cherokee, Armenian, Coptic and Tai Le.
  ...pairs('ᗩᑕᗴᘜᑎᔕᗯᘔᏆրՈԼⲀⲈⲄᥱ', 'acegnswzinnlaere'),
];
const LOOKALIKES: Record<string, string> = Object.fromEntries([
  ...LISTED_LOOKALIKES.map(([shape, latin]) => [shape.toLowerCase(), latin]),
  ...LISTED_LOOKALIKES,
]);
const LOOKALIKE_PATTERN = new RegExp(`[${Object.keys(LOOKALIKES).join('')}]`, 'gu');

/**
 * Letters in boxes, circles and brackets with no compatibility decomposition to a plain letter, or one that adds
 * punctuation: 🅰-🆉 (negative squared), 🅐-🅩 (negative circled), ⒜-⒵ and 🄐-🄩 (parenthesized, which NFKD turns
 * into "(a)"), and the regional indicators 🇦-🇿. Read as the plain letter before normalizing.
 */
const ENCLOSED_RANGES = [0x1f170, 0x1f150, 0x249c, 0x1f110, 0x1f1e6];
function enclosedLetter(point: string): string | null {
  const code = point.codePointAt(0)!;
  for (const start of ENCLOSED_RANGES) if (code >= start && code < start + 26) return String.fromCharCode(97 + code - start);
  return null;
}

const INVISIBLE = /[\p{Cf}\p{Cc}\p{Mn}\p{Me}\u200b-\u200f\u2060-\u206f\ufeff\u00ad]/gu;
/**
 * Spaces too narrow to read as a word break (six-per-em, punctuation, thin, hair, narrow no-break and medium
 * mathematical spaces) are removed like invisible characters, so "ni\u200agga" with a hair space is caught. They are
 * tested before NFKD, which would turn them into plain spaces.
 */
const NARROW_SPACE = /^[\u2006\u2008\u2009\u200a\u202f\u205f]$/u;
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
    const mapped = WHITESPACE_CONTROL.test(point) ? ' ' : NARROW_SPACE.test(point) ? '' : (enclosedLetter(point) ?? point).normalize('NFKD').replace(INVISIBLE, '').toLowerCase()
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

/** A slur at `index` in the normalized text. `letters` counts the stars it becomes when symbols inside it are not letters. */
type SlurMatch = { index: number; text: string; letters?: number };

const realLetters = (match: string) => match.replace(/[^a-zA-Z]/g, '').length;
const acceptable = (match: string) => !/[*\u0001]/.test(match) || realLetters(match) >= MIN_REAL_LETTERS;

/**
 * Slurs glued into a longer word: a word made only of two or more slurs ("niggerniggernigger", "fagfag") or of a
 * slur and INSULT_HEADS or INSULT_TAILS ("fagboy") is censored whole, and otherwise each EMBEDDED_SLURS stem inside
 * it is ("bigniggers", "ilovefaggots").
 */
function onlySlurs(text: string): boolean {
  let at = 0;
  let stems = 0;
  for (STEM_AT.lastIndex = 0; ; STEM_AT.lastIndex = at) {
    const match = STEM_AT.exec(text);
    if (!match || !match[0].length) break;
    at += match[0].length;
    stems += 1;
  }
  return stems >= 2 && ONLY_SUFFIX.test(text.slice(at)) && acceptable(text);
}

function gluedSlurs(normalized: string, found: SlurMatch[]): void {
  for (const word of normalized.matchAll(/[a-zA-Z*]+/g)) {
    const from = word.index ?? 0;
    const text = word[0];
    if (found.some(match => match.index < from + text.length && match.index + match.text.length > from)) continue;
    // Leet characters at the edges (uppercase here) may be punctuation, as in "fagfag!", so try without them too.
    const lead = /^[A-Z]*/.exec(text)![0].length;
    const core = text.slice(lead).replace(/[A-Z]+$/, '');
    if (onlySlurs(text)) { found.push({ index: from, text }); continue; }
    if (core && onlySlurs(core)) { found.push({ index: from + lead, text: core }); continue; }
    if (INSULT_COMPOUND.test(text)) { found.push({ index: from, text }); continue; }
    if (core && INSULT_COMPOUND.test(core)) { found.push({ index: from + lead, text: core }); continue; }
    const masked = text.replace(EMBEDDED_SAFE, safe => '.'.repeat(safe.length));
    for (const match of masked.matchAll(SLUR_INSIDE))
      if (realLetters(match[0]) >= EMBEDDED_MIN_REAL_LETTERS) found.push({ index: from + (match.index ?? 0), text: match[0] });
  }
}

/**
 * Chunks of letters joined by up to three punctuation marks, symbols or modifier letters with no spaces ("nigg.er",
 * "n.igger", "n/i/g/g/e/r", "nig'ger", "nig·ger", "ni‧gga", "nigʻger"). A censor mark counts as a symbol here, so
 * "nig*ger" reads as "nigger" rather than as a wildcard.
 */
const SPLIT_WORD = /[a-zA-Z]+(?:[\p{P}\p{S}\p{Lm}\u0001]{1,3}[a-zA-Z]+)+/gu;
/** Dashes, hyphenation points and middle dots ("*" once normalized), read like the hyphen in a hyphenated stem. */
const HYPHEN_LIKE = /^[\p{Pd}\u2027\u2219\u22c5*\u0001]+$/u;
/** A two-word or hyphenated stem on its own; WORD_GAP and JOINED_GAP already decide what may split those. */
const TWO_PART_STEM = new RegExp(`^(?:${SLURS.filter(stem => /[ -]/.test(stem)).map(stemPattern).join('|')})${SUFFIX}$`);

/**
 * Slurs split by symbols inside a word: the chunks are read as one word, and a match covers the symbols too.
 * A match that is just a two-part stem is skipped unless a dash, hyphenation point or middle dot splits it, so
 * "wet.back" and "she/male" pass as they do without this step, while "wet‧back" does not.
 */
function splitSlurs(normalized: string, found: SlurMatch[]): void {
  for (const split of normalized.matchAll(SPLIT_WORD)) {
    const from = split.index ?? 0;
    const letters: number[] = [];
    // UTF-16 indexes, since a symbol between the chunks may be an emoji (two units).
    for (let at = 0; at < split[0].length; at += 1) if (/[a-zA-Z]/.test(split[0][at]!)) letters.push(from + at);
    const joined = letters.map(at => normalized[at]).join('');
    for (const match of slurMatches({ normalized: joined, runs: [] })) {
      const start = letters[match.index]!;
      const end = letters[match.index + match.text.length - 1]! + 1;
      if (TWO_PART_STEM.test(match.text) && !HYPHEN_LIKE.test(normalized.slice(start, end).replace(/[a-zA-Z]/g, ''))) continue;
      if (!found.some(other => other.index < end && other.index + other.text.length > start)) found.push({ index: start, text: normalized.slice(start, end), letters: match.letters ?? match.text.replace(/[^a-zA-Z*\u0001]/g, '').length });
    }
  }
}

/**
 * Every slur in the normalized text, as [index, matched text]. Whole words first; then slurs glued into a longer
 * word (gluedSlurs) or split by symbols inside one (splitSlurs); then, for a joined run of spaced-out letters with
 * no slur in it, a slur that ends the run after one or more leading one-letter words.
 */
function slurMatches({ normalized, runs }: { normalized: string; runs: [number, number][] }): SlurMatch[] {
  const found: SlurMatch[] = [];
  SLUR_PATTERN_ALL.lastIndex = 0;
  for (let match = SLUR_PATTERN_ALL.exec(normalized); match; match = SLUR_PATTERN_ALL.exec(normalized)) {
    // A match rejected for too few real letters may hide another stem one character later, so step by one.
    if (acceptable(match[0])) found.push({ index: match.index, text: match[0] });
    else SLUR_PATTERN_ALL.lastIndex = match.index + 1;
  }
  gluedSlurs(normalized, found);
  splitSlurs(normalized, found);
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
  return Array.from(Array.from(text, point => enclosedLetter(point) ?? point).join('').normalize('NFKD').replace(INVISIBLE, '').toLowerCase())
    .map(char => LOOKALIKES[char] ?? (options.leet ? LEET[char] ?? char : char)).join('');
}

/** EMBEDDED_SLURS without the two-word stems, whose own gap rules decide what may split them ("wet\\nback"). */
const JOINABLE_INSIDE = new RegExp(EMBEDDED_SLURS.filter(stem => !/[ -]/.test(stem)).sort((a, b) => b.length - a.length).map(stemPattern).join('|'), 'g');
const embeddedCount = (text: string) => [...normalizeForFilter(text).replace(EMBEDDED_SAFE, safe => '.'.repeat(safe.length)).matchAll(JOINABLE_INSIDE)]
  .filter(match => realLetters(match[0]) >= EMBEDDED_MIN_REAL_LETTERS).length;

/**
 * True when two words read as one make an EMBEDDED_SLURS stem that neither has alone: a word broken across a line
 * ("ni" at the end of one line, "gga" at the start of the next). Short and two-word stems are left out, so
 * "got wet\nback home" and "do re mi fa\ngot it" pass.
 */
export function joinsIntoSlur(before: string, after: string): boolean {
  return embeddedCount(before + after) > embeddedCount(before) + embeddedCount(after);
}

/** True when the text contains a slur from the list (after normalization). */
export function hasSlur(text: string): boolean {
  return slurMatches(normalizeWithOrigins(text)).length > 0;
}

/**
 * The text with every slur replaced by asterisks, one per matched letter, covering the original characters
 * (including any invisible ones or separators used to disguise it). Everything else is returned untouched.
 * With `ignore`, characters it matches are left out before matching, as if invisible, and are covered too when
 * they sit inside a slur: censorBody passes the markdown markers, so "n**igg**er" (shown as one word) is caught.
 */
export function censorSlurs(text: string, options: { ignore?: RegExp } = {}): string {
  const points = Array.from(text);
  const kept = options.ignore ? points.flatMap((point, index) => (options.ignore!.test(point) ? [] : [index])) : points.map((_, index) => index);
  const normalization = normalizeWithOrigins(options.ignore ? kept.map(index => points[index]).join('') : text);
  const { origins } = normalization;
  const matches = slurMatches(normalization);
  if (!matches.length) return text;
  const replaced: { from: number; to: number; stars: number }[] = [];
  for (const match of matches) {
    const start = match.index;
    const end = start + match.text.length - 1;
    replaced.push({ from: kept[origins[start]!]!, to: kept[origins[end]!]!, stars: match.letters ?? match.text.replace(/[^a-zA-Z*\u0001]/g, '').length });
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
