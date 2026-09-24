/**
 * Global chat filter, shared by the composer (disable Send) and the server (refuse the send).
 *
 * Ordinary swearing passes. Slurs don't: the list below is matched as whole words after the text is
 * normalized, so "n1gger", "f*ggot", "r e t a r d" and "faggggot" are all caught, while "spicy",
 * "raccoon" and "Japan" are not. Every error is a fixed string; the message text is never echoed.
 */

export const SLUR_ERROR = 'That message has a slur in it, so it wasn’t sent. Swearing is fine here; slurs aren’t.';

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

/**
 * Lowercase ASCII with invisible characters removed (zero-width spaces and joiners, soft hyphens, every Unicode
 * format and control character, combining marks), lookalike letters and leet letters mapped, censor marks kept
 * as "*", and spaced-out letters joined.
 */
export function normalizeForFilter(text: string): string {
  const value = text.normalize('NFKD')
    .replace(/[\p{Cf}\p{Cc}\p{Mn}\p{Me}\u200b-\u200f\u2060-\u206f\ufeff\u00ad]/gu, '')
    .toLowerCase()
    .replace(LOOKALIKE_PATTERN, char => LOOKALIKES[char] ?? char)
    .replace(/[0134578$@!|€£¡#•·]/g, char => LEET[char] ?? char);
  // "n i g g e r" and "n.i.g.g.e.r": a run of three or more single letters separated by spaces or punctuation
  // becomes one word. No slur is two letters long, so pairs are left alone.
  return value.replace(/(?<![a-z*])(?:[a-z*][\s._\-,]+){2,}[a-z*](?![a-z*])/g, run => run.replace(/[\s._\-,]+/g, ''));
}

/** True when the text contains a slur from the list (after normalization). */
export function hasSlur(text: string): boolean {
  return SLUR_PATTERN.test(normalizeForFilter(text));
}

/** The fixed error for a body that must not be posted in the global chat, or null. */
export function slurError(text: string): string | null {
  return hasSlur(text) ? SLUR_ERROR : null;
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
