import { describe, expect, it } from 'vitest';
import { classKey, couldBeClass, sameClass, similarClassName, classSearchScore, directoryCandidates } from './class-match';

describe('directory name suggestions', () => {
  it('suggests small typos and incomplete names without making them automatic matches', () => {
    expect(similarClassName('Algebar II', 'Algebra II')).toBe(true);
    expect(similarClassName('Algera II', 'Algebra II')).toBe(true);
    expect(classSearchScore('Algebar', 'Algebra II')).not.toBeNull();
    expect(classSearchScore('Alg', 'Algebra II')).not.toBeNull();
    expect(classSearchScore('Honors Spanish', 'Spanish 2 Honors')).not.toBeNull();
    expect(couldBeClass('Algebar II', 'Algebra II')).toBe(false);
    expect(sameClass({ name: 'Algebar II' }, { name: 'Algebra II' })).toBe(false);
  });
  it('keeps different course words and explicit levels apart', () => {
    for (const [query, name] of [['Algebar II', 'Algebra I'], ['Spanish 2', 'Spanish 3'], ['AP Chemistry', 'Chemistry'], ['Art', 'Art History']]) {
      expect(similarClassName(query, name), `${query} / ${name}`).toBe(false);
    }
    expect(classSearchScore('Algebar II', 'Algebra III')).toBeNull();
    expect(classSearchScore('Physics', 'Algebra II')).toBeNull();
    expect(classSearchScore('', 'Algebra II')).toBeNull();
  });
  it('requires compatible teachers and rooms before suggesting the same section', () => {
    const entries = [{ name: 'Algebra II', teacher: 'Ms. Ortiz', room: '204' }];
    expect(directoryCandidates({ name: 'Algebar II' }, entries)).toEqual({ matches: [], similar: entries });
    expect(directoryCandidates({ name: 'Algebra II', teacher: 'Mr. Lee' }, entries)).toEqual({ matches: [], similar: [] });
    expect(directoryCandidates({ name: 'Algebra II', room: '301' }, entries)).toEqual({ matches: [], similar: [] });
  });
});

describe('class matching', () => {
  it('treats word order, case, punctuation and honors spellings as the same class', () => {
    for (const name of ['Honors Spanish 2', 'Spanish 2 Honors', 'Spanish 2H', 'spanish  2 – honours', 'SPANISH 2 HON.']) expect(classKey(name)).toBe('2 honors spanish');
    expect(classKey('Pre-AP Computer Science')).toBe('ap computer pre science');
    expect(sameClass({ name: 'Honors Spanish 2' }, { name: 'Spanish 2 Honors' })).toBe(true);
  });
  it('keeps genuinely different classes apart', () => {
    expect(sameClass({ name: 'Spanish 2 Honors' }, { name: 'Spanish 3 Honors' })).toBe(false);
    expect(sameClass({ name: 'Spanish 2 Honors' }, { name: 'Spanish 2' })).toBe(false);
    expect(sameClass({ name: 'Algebra II' }, { name: 'Algebra II and Trigonometry' })).toBe(false);
  });
  it('gives class names in any script their own key, and never matches an empty key', () => {
    expect(classKey('数学')).toBe('数学');
    expect(classKey('Русский язык')).toBe(classKey('язык РУССКИЙ'));
    expect(classKey('Русский язык')).not.toBe('');
    expect(classKey('Алгебра 2')).toBe('2 алгебра');
    expect(classKey('🎨')).toBe('🎨');
    expect(classKey('   ')).toBe('');
    expect(sameClass({ name: '数学' }, { name: '物理' })).toBe(false);
    expect(sameClass({ name: 'Алгебра 2' }, { name: 'Геометрия 2' })).toBe(false);
    expect(sameClass({ name: '🎨' }, { name: '🎵' })).toBe(false);
    expect(sameClass({ name: 'Русский язык' }, { name: 'язык русский' })).toBe(true);
    expect(sameClass({ name: '数学' }, { name: ' 数学 ' })).toBe(true);
    expect(sameClass({ name: ' ' }, { name: '' })).toBe(false);
    // Latin names keep their old keys, accents included.
    expect(classKey('Español 2')).toBe('2 espanol');
  });
  it('trusts the school directory over the typed name', () => {
    expect(sameClass({ name: 'Spanish 2 Honors', directoryId: 'd1' }, { name: 'Español 2', directoryId: 'd1' })).toBe(true);
    expect(sameClass({ name: 'Spanish 2 Honors', directoryId: 'd1' }, { name: 'Spanish 2 Honors', directoryId: 'd2' })).toBe(false);
    // A directory class and a hand-typed class still match by name.
    expect(sameClass({ name: 'Spanish 2 Honors', directoryId: 'd1' }, { name: 'Honors Spanish 2' })).toBe(true);
  });
  it('keeps names in scripts with vowel signs apart', () => {
    expect(classKey('किला')).not.toBe(classKey('कोला'));
    expect(couldBeClass('किला', 'कोला')).toBe(false);
  });
  it('lets a printed timetable name abbreviate or reorder a directory class at the same level', () => {
    expect(couldBeClass('Honors Spanish 2', 'Spanish 2 Honors')).toBe(true);
    expect(couldBeClass('AP Chem', 'AP Chemistry')).toBe(true);
    expect(couldBeClass('AP Chemistry', 'AP Chem')).toBe(true);
    expect(couldBeClass('Alg II', 'Algebra II')).toBe(true);
    expect(couldBeClass('Alg II H', 'Algebra 2 Honors')).toBe(true);
    expect(couldBeClass('Phys Ed', 'Physical Education')).toBe(true);
    expect(couldBeClass('Alg 2 & Trig', 'Algebra II and Trigonometry')).toBe(true);
    expect(couldBeClass('History of Art', 'Art History')).toBe(true);
  });
  it('refuses a directory class that is a different course or level', () => {
    expect(couldBeClass('Chemistry', 'Algebra II')).toBe(false);
    expect(couldBeClass('Chemistry', 'AP Chemistry')).toBe(false);
    expect(couldBeClass('Spanish 2', 'Spanish 3')).toBe(false);
    expect(couldBeClass('Alg II', 'Algebra II Honors')).toBe(false);
    expect(couldBeClass('US History', 'World History')).toBe(false);
    expect(couldBeClass('Phys Ed', 'Physics')).toBe(false);
    expect(couldBeClass('C', 'Chemistry')).toBe(false);
    expect(couldBeClass('AP', 'AP Chemistry')).toBe(false);
    expect(couldBeClass('数学', '物理')).toBe(false);
    expect(couldBeClass('Constructor Theory', 'Algebra II')).toBe(false);
  });
  it('refuses a name with a word the other name lacks, since that is a different course', () => {
    for (const [printed, listed] of [
      ['Algebra II', 'Algebra II and Trigonometry'], ['Art History', 'Art'], ['Biology', 'Marine Biology'],
      ['English', 'English Language Learners'], ['Math', 'Math Support'], ['Chemistry and Physics', 'Chemistry'], ['Hist', 'Art History'],
      // A dropped word is refused even in a familiar short form; the student links those by hand.
      ['AP Lang', 'AP English Language'],
    ]) {
      expect(couldBeClass(printed, listed), `${printed} / ${listed}`).toBe(false);
      expect(couldBeClass(listed, printed), `${listed} / ${printed}`).toBe(false);
    }
  });
});
