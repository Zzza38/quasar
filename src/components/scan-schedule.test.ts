import { describe, expect, it } from 'vitest';
import { applyScan, draftRow, keptDetails, periodClashes, photoError, renameRow, replacedClasses } from './scan-schedule';
import { emptyPersonalSchedule } from '@/domain/schedule';

const DIR = '3f6e4a2b-1c5d-4e8f-9a0b-2c3d4e5f6a7b';
const row = (name: string, extra: Partial<Parameters<typeof applyScan>[1][number]> = {}) => ({ name, days: [], periodIds: [], include: true, ...extra });

describe('applying a confirmed scan', () => {
  it('creates classes with stable IDs and places them on periods', () => {
    const next = applyScan(emptyPersonalSchedule(), [
      row('Algebra II', { periodIds: ['P1', 'P5'], teacher: 'Ms. Ortiz', room: '204' }),
      row('Chemistry', { periodIds: ['P2'], directoryId: DIR }),
      row('Unplaced elective'),
      row('Skipped', { include: false, periodIds: ['P3'] }),
      row('   ', { periodIds: ['P4'] }),
    ]);
    expect(next.classes).toEqual([
      { id: 'Algebra-II', name: 'Algebra II', teacher: 'Ms. Ortiz', room: '204' },
      { id: DIR, directoryId: DIR, name: 'Chemistry' },
      { id: 'Unplaced-elective', name: 'Unplaced elective' },
    ]);
    expect(next.assignments).toEqual({ P1: 'Algebra-II', P5: 'Algebra-II', P2: DIR });
  });

  it('reuses classes the student already has instead of duplicating them', () => {
    const personal = { ...emptyPersonalSchedule(), classes: [{ id: 'alg', name: 'algebra ii' }, { id: 'chem', directoryId: DIR, name: 'Chem' }], assignments: { P9: 'alg' } };
    const next = applyScan(personal, [row('Algebra II', { periodIds: ['P1'] }), row('Chemistry', { periodIds: ['P2'], directoryId: DIR }), row('Algebra II', { periodIds: ['P3'] })]);
    expect(next.classes.map(cls => cls.id)).toEqual(['alg', 'chem']);
    expect(next.assignments).toEqual({ P9: 'alg', P1: 'alg', P2: 'chem', P3: 'alg' });
  });

  it('fills a reused class’s blank teacher and room but keeps what the student saved', () => {
    const personal = { ...emptyPersonalSchedule(), classes: [{ id: 'alg', name: 'Algebra II', teacher: 'Ms. Ortiz' }, { id: 'chem', directoryId: DIR, name: 'Chem', room: '110' }] };
    const rows = [
      row('algebra ii', { periodIds: ['P1'], teacher: 'Mr. Lee', room: ' 204 ' }),
      row('Chemistry', { periodIds: ['P2'], directoryId: DIR, teacher: 'Dr. Kim', room: '112' }),
    ];
    const next = applyScan(personal, rows);
    expect(next.classes).toEqual([
      { id: 'alg', name: 'Algebra II', teacher: 'Ms. Ortiz', room: '204' },
      { id: 'chem', directoryId: DIR, name: 'Chem', room: '110', teacher: 'Dr. Kim' },
    ]);
    expect(personal.classes[0]).toEqual({ id: 'alg', name: 'Algebra II', teacher: 'Ms. Ortiz' });

    // The review sheet tells the student which typed values the saved class keeps instead.
    expect(keptDetails(personal.classes, rows[0]!)).toEqual({ name: 'Algebra II', kept: ['teacher Ms. Ortiz'] });
    expect(keptDetails(personal.classes, rows[1]!)).toEqual({ name: 'Chem', kept: ['room 110'] });
    expect(keptDetails(personal.classes, row('Algebra II', { teacher: 'Ms. Ortiz' }))).toBeNull();
    expect(keptDetails(personal.classes, row('Geometry', { teacher: 'Mr. Lee' }))).toBeNull();
  });
});

describe('reviewing scanned rows', () => {
  const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

  it('drops the scanner’s directory link when the student renames a row, and restores it if the name is set back', () => {
    const draft = draftRow({ name: 'Algebra II', periodIds: ['P1'], directoryId: DIR, days: [] });
    const renamed = renameRow(draft, 'Geometry');
    expect(renamed.directoryId).toBeUndefined();
    expect(renameRow(renamed, ' algebra ii ').directoryId).toBe(DIR);
    expect(renameRow(draftRow({ name: 'Art', periodIds: [], days: [] }), 'Art I').directoryId).toBeUndefined();

    // The student already has the class the scanner wrongly matched: the corrected row must not land on it.
    const personal = { ...emptyPersonalSchedule(), classes: [{ id: 'alg', directoryId: DIR, name: 'Algebra II' }] };
    const next = applyScan(personal, [renamed]);
    expect(next.classes).toEqual([{ id: 'alg', directoryId: DIR, name: 'Algebra II' }, { id: 'Geometry', name: 'Geometry' }]);
    expect(next.assignments).toEqual({ P1: 'Geometry' });

    // Without an existing class, the new class is not saved under the wrong directory entry.
    const fresh = applyScan(emptyPersonalSchedule(), [renamed]);
    expect(fresh.classes).toEqual([{ id: 'Geometry', name: 'Geometry' }]);
  });

  it('keeps a renamed directory copy the student already has linked when the row is left as scanned', () => {
    const personal = { ...emptyPersonalSchedule(), classes: [{ id: 'chem', directoryId: OTHER, name: 'Chem' }] };
    const next = applyScan(personal, [draftRow({ name: 'Chemistry', periodIds: ['P2'], directoryId: OTHER, days: [] })]);
    expect(next.classes.map(cls => cls.id)).toEqual(['chem']);
    expect(next.assignments).toEqual({ P2: 'chem' });
  });

  it('flags periods that two included rows both claim', () => {
    const rows = [
      row('Biology', { periodIds: ['P1', 'P2'] }),
      row('Chemistry', { periodIds: ['P1'] }),
      row('History', { periodIds: ['P2'], include: false }),
      row('  ', { periodIds: ['P2'] }),
      row('Art', { periodIds: ['P3'] }),
    ];
    expect(periodClashes(emptyPersonalSchedule(), rows)).toEqual([
      [{ periodId: 'P1', name: 'Chemistry' }],
      [{ periodId: 'P1', name: 'Biology' }],
      [],
      [],
      [],
    ]);
  });

  it('does not flag rows that end up as the same class', () => {
    const rows = [
      row('Biology', { periodIds: ['P1'] }),
      row(' biology ', { periodIds: ['P1'] }),
      row('Chem', { periodIds: ['P2'], directoryId: DIR }),
      row('Chemistry', { periodIds: ['P2'], directoryId: DIR }),
      row('Art', { periodIds: ['P2'] }),
    ];
    expect(periodClashes(emptyPersonalSchedule(), rows)).toEqual([
      [],
      [],
      [{ periodId: 'P2', name: 'Art' }],
      [{ periodId: 'P2', name: 'Art' }],
      [{ periodId: 'P2', name: 'Chem' }, { periodId: 'P2', name: 'Chemistry' }],
    ]);
  });

  it('compares rows by the saved class they land on, not only by each other', () => {
    // One row matches the saved class by name and the other by its directory link: saving puts both on 'chem'.
    const personal = { ...emptyPersonalSchedule(), classes: [{ id: 'chem', directoryId: DIR, name: 'Chem' }, { id: 'lab', directoryId: OTHER, name: 'Chem Lab' }] };
    const folded = [row('Chem', { periodIds: ['P2'] }), row('Chemistry', { periodIds: ['P2'], directoryId: DIR })];
    expect(applyScan(personal, folded).assignments).toEqual({ P2: 'chem' });
    expect(periodClashes(personal, folded)).toEqual([[], []]);

    // Same name, but the directory link sends one row to a different saved class, so the period really clashes.
    const split = [row('Chem Lab', { periodIds: ['P3'], directoryId: DIR }), row('chem lab', { periodIds: ['P3'] })];
    expect(applyScan(personal, split).assignments).toEqual({ P3: 'lab' });
    expect(periodClashes(personal, split)).toEqual([[{ periodId: 'P3', name: 'chem lab' }], [{ periodId: 'P3', name: 'Chem Lab' }]]);
  });

  it('warns about a replaced class only when the row lands on a different class than the period holds', () => {
    const personal = {
      ...emptyPersonalSchedule(),
      classes: [{ id: 'chem', directoryId: DIR, name: 'Chem' }, { id: 'lab', directoryId: OTHER, name: 'Lab' }, { id: 'art', name: 'Art' }],
      assignments: { P2: 'chem', P3: 'art', P4: 'art', P5: 'art' },
    };
    expect(replacedClasses(personal, [
      // A renamed directory copy: the scanner reads the directory name, but saving keeps P2 on the student's 'chem'.
      row('Chemistry', { periodIds: ['P2'], directoryId: DIR }),
      row('Biology', { periodIds: ['P3'] }),
      // The name matches the period's class, but the directory link finds 'lab' first, so Art loses P4.
      row('Art', { periodIds: ['P4'], directoryId: OTHER }),
      row('Music', { periodIds: ['P5'], include: false }),
      row('  ', { periodIds: ['P5'] }),
    ])).toEqual([[], [{ periodId: 'P3', name: 'Art' }], [{ periodId: 'P4', name: 'Art' }], [], []]);
  });
});

describe('photo errors', () => {
  it('keeps prepareImage’s own message for a single pick and names each failed file otherwise', () => {
    const canvas = 'Could not process the photo on this device.';
    const unreadable = 'That file is not an image the browser can read.';
    expect(photoError(1, [{ name: 'a.jpg', message: canvas }], 0)).toBe(canvas);
    expect(photoError(3, [{ name: 'bad.heic', message: unreadable }], 2)).toBe(`bad.heic: ${unreadable} The other photos were added.`);
    expect(photoError(2, [{ name: 'bad.heic', message: unreadable }], 1)).toBe(`bad.heic: ${unreadable} The other photo was added.`);
    expect(photoError(3, [{ name: 'a.heic', message: unreadable }, { name: 'b.heic', message: unreadable }], 1)).toBe(`a.heic: ${unreadable} b.heic: ${unreadable} The other photo was added.`);
    expect(photoError(2, [{ name: '', message: canvas }, { name: 'b.png', message: unreadable }], 0)).toBe(`A file: ${canvas} b.png: ${unreadable}`);
  });
});
