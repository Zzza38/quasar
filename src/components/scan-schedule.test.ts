import { describe, expect, it } from 'vitest';
import { applyScan, clearedClasses, describeCloseUp, draftRow, freedPeriods, keptDetails, periodClashes, photoError, renameRow, replacedClasses, scanSteps, visibleRegion } from './scan-schedule';
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

describe('free periods from a scan', () => {
  it('leaves unassigned periods empty, except one an included class also picks', () => {
    const personal = { ...emptyPersonalSchedule(), classes: [{ id: 'art', name: 'Art' }, { id: 'gym', name: 'Gym' }], assignments: { P3: 'art', P4: 'gym', P6: 'art' } };
    const rows = [row('Chemistry', { periodIds: ['P4'] }), row('Band', { include: false, periodIds: ['P6'] })];
    expect(freedPeriods(rows, ['P3', 'P4', 'P6'])).toEqual(['P3', 'P6']);
    expect(clearedClasses(personal, rows, ['P3', 'P4', 'P6'])).toEqual([{ periodId: 'P3', name: 'Art' }, { periodId: 'P6', name: 'Art' }]);
    const next = applyScan(personal, rows, ['P3', 'P4', 'P6']);
    expect(next.assignments).toEqual({ P4: 'Chemistry' });
    // The class itself stays saved; only its periods are freed.
    expect(next.classes.map(cls => cls.id)).toEqual(['art', 'gym', 'Chemistry']);
    expect(applyScan(personal, rows).assignments).toEqual({ P3: 'art', P4: 'Chemistry', P6: 'art' });
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

describe('scan progress', () => {
  const states = (steps: ReturnType<typeof scanSteps>) => steps.map(step => `${step.state} ${step.label}`);
  it('walks through sending, reading, close-ups and matching', () => {
    expect(states(scanSteps(null, 2))).toEqual(['active Sending 2 pictures', 'todo Reading the timetable', "todo Matching classes to your school's periods"]);
    expect(states(scanSteps({ stage: 'reading', round: 0, closeUps: [] }, 1))).toEqual(['done Sending your picture', 'active Reading the timetable', "todo Matching classes to your school's periods"]);
    const zooming = scanSteps({ stage: 'zooming', round: 0, closeUps: [] }, 1);
    expect(states(zooming)).toEqual(['done Sending your picture', 'done Reading the timetable', 'active Looking closer at hard-to-read parts', "todo Matching classes to your school's periods"]);
    expect(zooming[2].detail).toBe('Cropping close-ups');
    const closeUp = { photo: 1, left: 0, top: 0, width: 0.5, height: 0.5 };
    expect(scanSteps({ stage: 'reading', round: 1, closeUps: [closeUp, closeUp] }, 1)[2].detail).toBe('2 close-ups so far');
    // A scan that zoomed keeps the close-up step, done, while it matches.
    expect(states(scanSteps({ stage: 'checking', round: 0, closeUps: [closeUp] }, 1))).toEqual(['done Sending your picture', 'done Reading the timetable', 'done Looking closer at hard-to-read parts', "active Matching classes to your school's periods"]);
  });

  it('says where each close-up is', () => {
    expect(describeCloseUp({ photo: 2, left: 0, top: 0, width: 0.3, height: 0.3, enhance: true }, 2)).toBe('Picture 2, top left, sharpened');
    expect(describeCloseUp({ photo: 1, left: 0.4, top: 0.4, width: 0.2, height: 0.2 }, 1)).toBe('Close-up, center');
    expect(describeCloseUp({ photo: 1, left: 0, top: 0.7, width: 1, height: 0.3, rotate: 90 }, 1)).toBe('Close-up, bottom, turned');
    expect(describeCloseUp({ photo: 1, left: 0, top: 0, width: 1, height: 1 }, 1)).toBe('Close-up, most of it');
  });

  it('places a close-up box on a cropped thumbnail', () => {
    const region = { left: 0.5, top: 0, width: 0.5, height: 1 };
    // A whole-picture thumbnail shows the region as it is.
    expect(visibleRegion(region)).toEqual(region);
    // A wide 1600 × 600 picture in a 3:4 box shows its middle 28%, so the right half starts past the centre and runs off the edge.
    const wide = visibleRegion(region, { width: 1600, height: 600 }, 3 / 4)!;
    expect(wide.left).toBeCloseTo(0.5);
    expect(wide.width).toBeCloseTo(0.5);
    expect(wide.top).toBe(0);
    expect(wide.height).toBe(1);
    expect(visibleRegion({ left: 0, top: 0, width: 0.1, height: 1 }, { width: 1600, height: 600 }, 3 / 4)).toBeNull();
    // A tall 600 × 1600 picture shows its middle half, trimmed top and bottom instead.
    const tall = visibleRegion({ left: 0, top: 0.3, width: 1, height: 0.2 }, { width: 600, height: 1600 }, 3 / 4)!;
    expect(tall.left).toBe(0);
    expect(tall.top).toBeCloseTo(0.1);
    expect(tall.height).toBeCloseTo(0.4);
    expect(visibleRegion(region, undefined, 3 / 4)).toBeNull();
  });
});
