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
function wordsPair(left: string[], right: string[], fits = (x: string, y: string) => x === y || ([...x].length >= 2 && [...y].length >= 2 && (x.startsWith(y) || y.startsWith(x)))): boolean {
  const owner: number[] = right.map(() => -1);
  const claim = (index: number, seen: Set<number>): boolean => right.some((word, at) => {
    if (seen.has(at) || !fits(left[index], word)) return false;
    seen.add(at);
    if (owner[at] < 0 || claim(owner[at], seen)) { owner[at] = index; return true; }
    return false;
  });
  return left.every((_, index) => claim(index, new Set()));
}

/** A small spelling error, including swapped adjacent letters, is a suggestion, never an automatic class match. */
function closeWord(left: string, right: string): boolean {
  if (left === right) return true;
  const a = [...left], b = [...right];
  const limit = Math.min(a.length, b.length) >= 8 ? 2 : 1;
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > limit) return false;
  const distance = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    distance[i][j] = Math.min(distance[i - 1][j] + 1, distance[i][j - 1] + 1, distance[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) distance[i][j] = Math.min(distance[i][j], distance[i - 2][j - 2] + 1);
  }
  return distance[a.length][b.length] <= limit;
}

/** Whole course names with a likely typo. Extra course words and different levels still mean different classes. */
export function similarClassName(left: string, right: string): boolean {
  const a = levelsAndWords(left), b = levelsAndWords(right);
  return a.levels === b.levels && a.words.length > 0 && a.words.length === b.words.length && wordsPair(a.words, b.words, closeWord);
}

/** Lower scores come first in autocomplete. Incomplete names may omit levels, but explicit levels must agree. */
export function classSearchScore(query: string, name: string): number | null {
  if (!query.trim()) return null;
  if (classKey(query) === classKey(name)) return 0;
  if (couldBeClass(query, name)) return 1;
  const a = levelsAndWords(query), b = levelsAndWords(name);
  if (a.levels && !a.levels.split(' ').every(level => b.levels.split(' ').includes(level))) return null;
  if (!a.words.length || a.words.length > b.words.length) return null;
  if (wordsPair(a.words, b.words, (x, y) => x === y || (x.length >= 2 && y.startsWith(x)))) return 2;
  return wordsPair(a.words, b.words, (x, y) => closeWord(x, y) || (x.length >= 2 && y.startsWith(x))) ? 3 : null;
}

export type DirectoryDetails = { name: string; teacher?: string; room?: string };
/** A directory entry may also list other spellings students confirmed as the same class. */
export type DirectoryEntryDetails = DirectoryDetails & { aliases?: DirectoryDetails[] };

/** The entry's own details first, then each alias, which inherits the teacher and room it leaves out. */
export function directoryForms(entry: DirectoryEntryDetails): DirectoryDetails[] {
  return [entry, ...(entry.aliases ?? []).map(alias => ({ name: alias.name, teacher: alias.teacher ?? entry.teacher, room: alias.room ?? entry.room }))];
}

/** Printed teacher/room conflicts keep separate sections from being automatically linked. Aliases match like names. */
export function directoryCandidates<T extends DirectoryEntryDetails>(printed: DirectoryDetails, entries: T[]): { matches: T[]; similar: T[] } {
  const compatible = (form: DirectoryDetails) => (['teacher', 'room'] as const).every(field => !printed[field]?.trim() || !form[field]?.trim() || classKey(printed[field]!) === classKey(form[field]!));
  const fits = (entry: T, test: (name: string) => boolean) => directoryForms(entry).some(form => compatible(form) && test(form.name));
  const matches = entries.filter(entry => fits(entry, name => couldBeClass(printed.name, name)));
  return { matches, similar: entries.filter(entry => !matches.includes(entry) && fits(entry, name => similarClassName(printed.name, name))) };
}

/**
 * The one directory entry a class belongs to: a single match, or, among several, the only one with the same words
 * (in its name or an alias). Typos and ambiguous sections resolve to nothing.
 */
export function resolveDirectoryEntry<T extends DirectoryEntryDetails>(printed: DirectoryDetails, entries: T[]): T | undefined {
  const { matches } = directoryCandidates(printed, entries);
  if (matches.length <= 1) return matches[0];
  const exact = matches.filter(entry => directoryForms(entry).some(form => classKey(form.name) === classKey(printed.name)));
  return exact.length === 1 ? exact[0] : undefined;
}

/**
 * Cells a timetable prints instead of a class when the student has none ("Unassigned", "Free", "Free period").
 * These are free periods, never classes for the timetable or the directory.
 */
const FREE_NAMES = new Set(['unassigned', 'unassigned period', 'unassigned block', 'free', 'free period', 'free block', 'open', 'open period', 'open block', 'no class', 'unscheduled']);
export const isFreePeriodName = (name: string) => FREE_NAMES.has(name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim());

const TITLES = new Set(['mr', 'mrs', 'ms', 'mx', 'miss', 'dr', 'prof', 'sr', 'sra', 'srta', 'mme', 'mlle']);

/**
 * Do two hand-typed teacher names mean one person? Titles are ignored, and every word of the shorter name pairs with
 * its own word of the longer one: the same word, a shortening ("Matt" / "Matthew", "R" / "Ray") or a small typo
 * ("Louissant" / "Louissaint"). So "Mr. Wise" is "Ray Wise", and "Ray Wise" is never "Polly Duke".
 */
export function sameTeacher(left: string, right: string): boolean {
  const words = (name: string) => name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u).filter(word => word && !TITLES.has(word));
  let a = words(left), b = words(right);
  if (!a.length || !b.length) return classKey(left) !== '' && classKey(left) === classKey(right);
  if (a.length > b.length) [a, b] = [b, a];
  return wordsPair(a, b, (x, y) => x.startsWith(y) || y.startsWith(x) || closeWord(x, y));
}

/**
 * Could these be one section? A teacher teaches one section at a time, so when both list a teacher, the teacher
 * decides and the room is ignored (one of them may have typed it wrong). Without two teachers, two different rooms
 * mean two sections. A blank field never conflicts.
 */
function sameSection(left: ClassLike, right: ClassLike): boolean {
  if (left.teacher?.trim() && right.teacher?.trim()) return sameTeacher(left.teacher, right.teacher);
  return !left.room?.trim() || !right.room?.trim() || classKey(left.room) === classKey(right.room);
}

export type ClassLike = { name: string; directoryId?: string | null; teacher?: string; room?: string };

/**
 * Two directory classes match by entry. Otherwise the names must match and the section must too: callers compare the
 * same period, so the same course name with another teacher (or, with no teachers, another room) is another section.
 */
export function sameClass(left: ClassLike, right: ClassLike): boolean {
  if (left.directoryId && right.directoryId) return left.directoryId === right.directoryId;
  const key = classKey(left.name);
  return key !== '' && key === classKey(right.name) && sameSection(left, right);
}

/**
 * Could two classes that sameClass keeps apart still be one class? Only when both list a teacher and a room, both
 * agree, and the names are close: one abbreviates, reorders or adds words to the other, or has a small typo, at
 * compatible levels ("Foundations in Literature" / "Foundations in Literature: Inquiry and Analysis E"). Two
 * directory entries with the same details count too, since the directory can hold a course twice. This is a
 * suggestion to show, never a match: "Spanish 2" and "Spanish 3" stay apart even in the same room.
 */
export function maybeSameClass(left: ClassLike, right: ClassLike): boolean {
  if (sameClass(left, right) || !left.teacher?.trim() || !right.teacher?.trim() || !left.room?.trim() || !right.room?.trim()) return false;
  return sameTeacher(left.teacher, right.teacher) && classKey(left.room) === classKey(right.room)
    && (classSearchScore(left.name, right.name) !== null || classSearchScore(right.name, left.name) !== null);
}
