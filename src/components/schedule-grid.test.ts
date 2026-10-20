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


describe('school-following timetable controls', () => {
  it('keeps bell-time editing and class placement available without rotation structure controls', () => {
    const html = renderToStaticMarkup(createElement(ScheduleGrid, { value: exampleSchedule, personal: examplePersonalSchedule, personalClassesOnly: true, allowStructure: false, onChange: noop, onEditDay: noop, onRemoveDay: noop }));
    expect(html).toContain('Edit times');
    expect(html).not.toMatch(/aria-label="Day \d+ name"/);
    expect(html).not.toMatch(/aria-label="Remove Day /);
  });

  it('retains structure management in a private schedule', () => {
    const html = renderToStaticMarkup(createElement(ScheduleGrid, { value: exampleSchedule, allowStructure: true, onChange: noop, onEditDay: noop, onRemoveDay: noop }));
    expect(html).toContain('aria-label="Day 1 name"');
    expect(html).toContain('aria-label="Remove Day ');
  });
});

describe('bell-time locking', () => {
  const personal = { ...examplePersonalSchedule, assignments: { A: 'algebra' } };
  const render = (timesLocked?: boolean, disabled?: boolean) => renderToStaticMarkup(createElement(ScheduleGrid, {
    value: exampleSchedule, personal, personalClassesOnly: true, timesLocked, disabled,
    onAssign: async () => {}, onChange: noop, onEditDay: noop, onRemoveDay: noop,
  }));
  const control = (html: string, label: string) => {
    const found = html.match(/<(?:button|input)\b[^>]*>/g)?.find(tag => tag.includes(`aria-label="${label}"`));
    expect(found, `Missing control ${label}`).toBeDefined();
    return found!;
  };
  const editTimes = (html: string) => html.match(/<button\b[^>]*>Edit times<span[^>]*> for Day 1<\/span><\/button>/)?.[0];

  it('locks every rendered time and structure control', () => {
    const html = render(true);
    expect(control(html, 'Day 1 name')).toContain('disabled=""');
    expect(control(html, 'Remove Day 1')).toContain('disabled=""');
    expect(editTimes(html)).toContain('disabled=""');
    expect(control(html, 'Resize Day 1 A start')).toContain('disabled=""');
    expect(control(html, 'Resize Day 1 A end')).toContain('disabled=""');
    expect(control(html, 'Remove time block from Day 1 9:10–10:10 AM')).toContain('disabled=""');
    expect(control(html, 'Place Lunch')).toContain('disabled=""');
    expect(control(html, 'Place in Day 1 at 1:00 PM')).toContain('disabled=""');
  });

  it('keeps class selection, existing block targets, and class removal available', () => {
    const html = render(true);
    expect(control(html, 'Place Algebra')).not.toContain('disabled=""');
    expect(control(html, 'Day 1, 8:00–9:00 AM: Algebra')).not.toContain('disabled=""');
    expect(control(html, 'Day 1, 9:10–10:10 AM: B')).not.toContain('disabled=""');
    expect(control(html, 'Remove class from Day 1 8:00–9:00 AM')).not.toContain('disabled=""');
  });

  it('preserves existing unlocked behavior when the prop is omitted', () => {
    const html = render();
    expect(control(html, 'Day 1 name')).not.toContain('disabled=""');
    expect(editTimes(html)).not.toContain('disabled=""');
    expect(control(html, 'Resize Day 1 A end')).not.toContain('disabled=""');
    expect(control(html, 'Remove time block from Day 1 9:10–10:10 AM')).not.toContain('disabled=""');
    expect(control(html, 'Place Lunch')).not.toContain('disabled=""');
  });

  it('still respects a full disabled state for class-only controls', () => {
    const html = render(true, true);
    expect(control(html, 'Place Algebra')).toContain('disabled=""');
    expect(control(html, 'Remove class from Day 1 8:00–9:00 AM')).toContain('disabled=""');
  });
});
