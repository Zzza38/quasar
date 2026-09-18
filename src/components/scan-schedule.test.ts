import { describe, expect, it } from 'vitest';
import { applyScan } from './scan-schedule';
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
});
