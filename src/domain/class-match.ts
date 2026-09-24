/**
 * When do two students' classes count as the same class?
 *
 * Students type class names by hand, so the same course shows up as "Spanish 2 Honors",
 * "Honors Spanish 2" or "Spanish 2H". Two entries are the same class when they point at the
 * same school-directory entry, or when they contain the same words in any order after light
 * normalization. The period rule (same period as well) is applied by the callers.
 */
const HONORS = new Set(['h', 'hon', 'hnrs', 'honor', 'honors', 'honours']);

/** A comparable key: lower-cased words in sorted order, with honors spellings unified. */
export function classKey(name: string): string {
  const tokens = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/).filter(Boolean)
    .flatMap((token) => {
      const level = /^(\d+)h$/.exec(token);
      if (level) return [level[1], 'honors'];
      return [HONORS.has(token) ? 'honors' : token];
    });
  return tokens.sort().join(' ');
}

export type ClassLike = { name: string; directoryId?: string | null };

export function sameClass(left: ClassLike, right: ClassLike): boolean {
  if (left.directoryId && right.directoryId) return left.directoryId === right.directoryId;
  return classKey(left.name) === classKey(right.name);
}
