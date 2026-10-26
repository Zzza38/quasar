import { describe, expect, it } from 'vitest';
import { classKey, couldBeClass, maybeSameClass, sameClass, sameTeacher, similarClassName, classSearchScore, directoryCandidates, isFreePeriodName, resolveDirectoryEntry } from './class-match';

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

describe('directory aliases', () => {
  const lit = { id: 'lit', name: 'Foundations in Literature', teacher: 'Polly Duke', room: '406', aliases: [{ name: 'Foundations of Literature: Inquiry and Analysis E' }, { name: 'English 9', room: '410' }] };
  const short = { id: 'short', name: 'Foundations of Literature', teacher: 'Amy Delaney', room: '307' };

  it('matches a confirmed spelling with the entry teacher and room, and the alias room when it has one', () => {
    expect(directoryCandidates({ name: 'Foundations of Literature: Inquiry and Analysis E', teacher: 'Polly Duke' }, [lit]).matches).toEqual([lit]);
    expect(directoryCandidates({ name: 'Foundations of Literature: Inquiry and Analysis E', teacher: 'Erin Nolan' }, [lit]).matches).toEqual([]);
    expect(directoryCandidates({ name: 'English 9', room: '410' }, [lit]).matches).toEqual([lit]);
    expect(directoryCandidates({ name: 'English 9', room: '406' }, [lit]).matches).toEqual([]);
  });

  it('resolves to one entry, preferring the same words when several could match', () => {
    expect(resolveDirectoryEntry({ name: 'Foundations of Literature' }, [lit, short])).toBe(short);
    expect(resolveDirectoryEntry({ name: 'Foundations of Literature' }, [short, { ...short, id: 'other', teacher: 'Erin Nolan' }])).toBeUndefined();
    expect(resolveDirectoryEntry({ name: 'Physics' }, [lit, short])).toBeUndefined();
  });

  it('knows free periods are not classes', () => {
    expect(['Free Period', 'free', 'Unassigned block'].every(isFreePeriodName)).toBe(true);
    expect(isFreePeriodName('Free Speech Seminar')).toBe(false);
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
  it('keeps two sections with the same name apart when their teacher differs', () => {
    const lit = 'Foundations in Literature: Inquiry and Analysis E';
    expect(sameClass({ name: lit, teacher: 'Ray Wise', room: '323' }, { name: lit, teacher: 'Polly Duke', room: '406' })).toBe(false);
    expect(sameClass({ name: lit, teacher: 'Ray Wise' }, { name: lit, teacher: 'Polly Duke' })).toBe(false);
    // With no teacher on one side, the rooms decide.
    expect(sameClass({ name: lit, room: '323' }, { name: lit, room: '406' })).toBe(false);
    expect(sameClass({ name: lit, teacher: 'Ray Wise', room: '323' }, { name: lit, room: '406' })).toBe(false);
    expect(sameClass({ name: lit, directoryId: 'd1', room: '323' }, { name: lit, room: '406' })).toBe(false);
    // Missing details still match, and a shared directory entry wins over typed details.
    expect(sameClass({ name: lit, teacher: 'Ray Wise', room: '323' }, { name: lit })).toBe(true);
    expect(sameClass({ name: lit, directoryId: 'd1', room: '323' }, { name: lit, directoryId: 'd1', room: '406' })).toBe(true);
  });
  it('lets the teacher decide over the room, and forgives how the teacher was typed', () => {
    const algebra = 'Algebra II and Trigonometry';
    expect(sameClass({ name: algebra, teacher: 'Matthew Walker', room: 'Lib Base Physics' }, { name: algebra, teacher: 'Matt Walker', room: '322' })).toBe(true);
    const history = 'Foundations of History: Inquiry and Analysis';
    expect(sameClass({ name: history, teacher: 'Allen Louissaint', room: '304' }, { name: history, teacher: 'Allen Louissant', room: '304' })).toBe(true);
    for (const [left, right] of [['Ray Wise', 'ray wise'], ['Mr. Wise', 'Ray Wise'], ['R. Wise', 'Ray Wise'], ['Dr Polly Duke', 'Polly Duke']]) expect(sameTeacher(left, right), `${left} / ${right}`).toBe(true);
    for (const [left, right] of [['Ray Wise', 'Polly Duke'], ['Ray Wise', 'Ray Duke'], ['Mr. Wise', 'Ms. Duke']]) expect(sameTeacher(left, right), `${left} / ${right}`).toBe(false);
  });
  it('suggests a close name with the same teacher and room as maybe the same class', () => {
    const section = { teacher: 'Ray Wise', room: '323' };
    for (const [left, right] of [['Foundations in Literature: Inquiry and Analysis E', 'Foundations in Literature'], ['AP Chem', 'AP Chemistry'], ['Algebar II', 'Algebra II'], ['Lit Inquiry', 'Literature Inquiry and Analysis']]) {
      expect(maybeSameClass({ name: left, ...section }, { name: right, ...section }), `${left} / ${right}`).toBe(true);
      expect(maybeSameClass({ name: right, ...section }, { name: left, ...section }), `${right} / ${left}`).toBe(true);
    }
    // A course the directory lists twice, and a teacher typed differently, still get the suggestion.
    expect(maybeSameClass({ name: 'Honors Spanish 2', directoryId: 'd1', ...section }, { name: 'Honors Spanish 2', directoryId: 'd2', ...section })).toBe(true);
    expect(maybeSameClass({ name: 'AP Chem', ...section }, { name: 'AP Chemistry', teacher: 'Mr. Wise', room: '323' })).toBe(true);
  });
  it('does not suggest when the class already matches, a detail is missing or differs, or the course differs', () => {
    const section = { teacher: 'Ray Wise', room: '323' };
    expect(maybeSameClass({ name: 'Algebra II', ...section }, { name: 'Algebra II', ...section })).toBe(false);
    expect(maybeSameClass({ name: 'AP Chem', teacher: 'Ray Wise' }, { name: 'AP Chemistry', teacher: 'Ray Wise' })).toBe(false);
    expect(maybeSameClass({ name: 'AP Chem', ...section }, { name: 'AP Chemistry', teacher: 'Ray Wise', room: '210' })).toBe(false);
    expect(maybeSameClass({ name: 'AP Chem', ...section }, { name: 'AP Chemistry', teacher: 'Polly Duke', room: '323' })).toBe(false);
    expect(maybeSameClass({ name: 'Spanish 2', ...section }, { name: 'Spanish 3', ...section })).toBe(false);
    expect(maybeSameClass({ name: 'Chemistry', ...section }, { name: 'Physics', ...section })).toBe(false);
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
