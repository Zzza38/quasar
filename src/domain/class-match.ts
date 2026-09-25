/**
 * When do two students' classes count as the same class?
 *
 * Students type class names by hand, so the same course shows up as "Spanish 2 Honors",
 * "Honors Spanish 2" or "Spanish 2H". Two entries are the same class when they point at the
 * same school-directory entry, or when they contain the same words in any order after light
 * normalization. The period rule (same period as well) is applied by the callers.
 */
const HONORS = new Set(['h', 'hon', 'hnrs', 'honor', 'honors', 'honours']);

/**
 * A comparable key: lower-cased words in sorted order, with honors spellings unified. Words are runs of letters and
 * digits in any script ("数学", "Алгебра 2"), so a class name that is not in Latin letters still has a key. A name
 * with no letters or digits at all ("🎨") falls back to its trimmed, lower-cased text. Only a blank name has the
 * empty key, and the empty key never matches anything.
 */
export function classKey(name: string): string {
  const tokens = classTokens(name);
  return tokens.length ? tokens.sort().join(' ') : name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** classKey's words in their printed order. */
function classTokens(name: string): string[] {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean)
    .flatMap((token) => {
      const level = /^(\d+)h$/.exec(token);
      if (level) return [level[1], 'honors'];
      return [HONORS.has(token) ? 'honors' : token];
    });
}

const ROMAN = new Map(['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'].map((numeral, index) => [numeral, String(index + 1)]));
const LEVEL_WORDS = new Set(['honors', 'ap', 'ib']);
const FILLER = new Set(['and', 'of', 'the', 'for', 'in']);

/**
 * Could a name printed on a timetable be this directory class? Timetables shorten and reorder names, so beyond the
 * same classKey this accepts an abbreviation: every word of each name pairs with its own word of the other, either
 * the same word or one a prefix of the other (two letters or more), as in "AP Chem" for "AP Chemistry", "Alg II H" for
 * "Algebra 2 Honors" or "Alg 2 & Trig" for "Algebra II and Trigonometry". A word left over on either side means a
 * different course, so "Art" is never "Art History" and "Hist" is never "Art History"; filler words ("and", "of") do
 * not count. The level must agree exactly (numbers, roman numerals, honors, AP, IB), so "Spanish 2" is never
 * "Spanish 3", "Chemistry" is never "AP Chemistry", and "Chemistry" is never "Algebra II".
 */
export function couldBeClass(printed: string, listed: string): boolean {
  const key = classKey(printed);
  if (key !== '' && key === classKey(listed)) return true;
  const a = levelsAndWords(printed), b = levelsAndWords(listed);
  if (a.levels !== b.levels || !a.words.length || a.words.length !== b.words.length) return false;
  return wordsPair(a.words, b.words);
}

function levelsAndWords(name: string): { levels: string; words: string[] } {
  const levels = new Set<string>(), words: string[] = [];
  for (const token of classTokens(name)) {
    const level = ROMAN.get(token) ?? (/^\d+$/.test(token) ? String(Number(token)) : LEVEL_WORDS.has(token) ? token : undefined);
    if (level) levels.add(level); else if (!FILLER.has(token)) words.push(token);
  }
  return { levels: [...levels].sort().join(' '), words };
}

/** Pairs every word of `left` with a distinct word of `right` (bipartite matching, so word order never matters). */
function wordsPair(left: string[], right: string[]): boolean {
  const fits = (x: string, y: string) => x === y || ([...x].length >= 2 && [...y].length >= 2 && (x.startsWith(y) || y.startsWith(x)));
  const owner: number[] = right.map(() => -1);
  const claim = (index: number, seen: Set<number>): boolean => right.some((word, at) => {
    if (seen.has(at) || !fits(left[index], word)) return false;
    seen.add(at);
    if (owner[at] < 0 || claim(owner[at], seen)) { owner[at] = index; return true; }
    return false;
  });
  return left.every((_, index) => claim(index, new Set()));
}

export type ClassLike = { name: string; directoryId?: string | null };

export function sameClass(left: ClassLike, right: ClassLike): boolean {
  if (left.directoryId && right.directoryId) return left.directoryId === right.directoryId;
  const key = classKey(left.name);
  return key !== '' && key === classKey(right.name);
}
