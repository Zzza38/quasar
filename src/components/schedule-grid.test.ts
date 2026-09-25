import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { exampleSchedule, examplePersonalSchedule } from '@/domain/example';
import { REMOVED_PERIOD_LABEL, type Schedule } from '@/domain/schedule';
import { ScheduleGrid } from './schedule-grid';

const noop = () => {};

describe('ScheduleGrid', () => {
  it('labels a block whose period no longer exists as a removed period, never by its raw ID', () => {
    // A day override can keep a slot for a period the school has since removed.
    const value: Schedule = structuredClone(exampleSchedule);
    value.cycleDays[0].slots.push({ id: 'orphan', periodId: 'per-gone-7', start: '15:00', end: '15:45' });
    const personal = { ...examplePersonalSchedule, assignments: {} };
    const html = renderToStaticMarkup(createElement(ScheduleGrid, { value, personal, personalClassesOnly: true, onChange: noop, onEditDay: noop, onRemoveDay: noop }));
    expect(html).toContain(REMOVED_PERIOD_LABEL);
    expect(html).not.toContain('per-gone-7');
  });
});
