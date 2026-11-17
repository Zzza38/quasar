import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { exampleSchedule, examplePersonalSchedule } from '@/domain/example';
import { REMOVED_PERIOD_LABEL, type Schedule } from '@/domain/schedule';
import { dayRangeLabel, ScheduleGrid, scheduleBands } from './schedule-grid';

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

describe('disabled timetable', () => {
  const personal = { ...examplePersonalSchedule, assignments: { A: 'algebra' } };
  const render = (disabled?: boolean) => renderToStaticMarkup(createElement(ScheduleGrid, {
    value: exampleSchedule, personal, personalClassesOnly: true, disabled,
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

  it('also disables class selection, existing block targets, and class removal', () => {
    const html = render(true);
    expect(control(html, 'Place Algebra')).toContain('disabled=""');
    expect(control(html, 'Day 1, 8:00–9:00 AM: Algebra')).toContain('disabled=""');
    expect(control(html, 'Day 1, 9:10–10:10 AM: B')).toContain('disabled=""');
    expect(control(html, 'Remove class from Day 1 8:00–9:00 AM')).toContain('disabled=""');
  });

  it('preserves existing unlocked behavior when the prop is omitted', () => {
    const html = render();
    expect(control(html, 'Day 1 name')).not.toContain('disabled=""');
    expect(editTimes(html)).not.toContain('disabled=""');
    expect(control(html, 'Resize Day 1 A end')).not.toContain('disabled=""');
    expect(control(html, 'Remove time block from Day 1 9:10–10:10 AM')).not.toContain('disabled=""');
    expect(control(html, 'Place Lunch')).not.toContain('disabled=""');
  });

});

describe('scheduleBands', () => {
  const slot = (id: string, periodId: string, start: string, end: string) => ({ id, periodId, start, end });
  const lunchOnly = (entry: { periodId: string }) => entry.periodId === 'lunch';

  it('joins neighbouring days that have the period at the same time, and leaves a day with another time on its own', () => {
    const days = [
      { id: 'd1', slots: [slot('a1', 'A', '08:00', '09:00'), slot('l1', 'lunch', '12:00', '12:40')] },
      { id: 'd2', slots: [slot('a2', 'A', '08:00', '09:00'), slot('l2', 'lunch', '12:00', '12:40')] },
      { id: 'd3', slots: [slot('l3', 'lunch', '12:30', '13:10')] },
      { id: 'd4', slots: [slot('l4', 'lunch', '12:00', '12:40')] },
      { id: 'd5', slots: [slot('l5', 'lunch', '12:00', '12:40')] },
    ];
    const { runs, members } = scheduleBands(days, lunchOnly);
    expect(runs.map(run => [run.dayId, run.slot.id, run.span])).toEqual([['d1', 'l1', 2], ['d4', 'l4', 2]]);
    expect([...members].sort()).toEqual(['d1:l1', 'd2:l2', 'd4:l4', 'd5:l5']);
  });

  it('never joins the slots the caller leaves out, even at matching times', () => {
    const days = [{ id: 'd1', slots: [slot('a1', 'A', '08:00', '09:00')] }, { id: 'd2', slots: [slot('a2', 'A', '08:00', '09:00')] }];
    expect(scheduleBands(days, lunchOnly)).toEqual({ members: new Set(), runs: [] });
  });

  it('keeps a lone day and a slot without times as ordinary blocks', () => {
    const days = [{ id: 'd1', slots: [slot('l1', 'lunch', '12:00', '12:40'), slot('l0', 'lunch', '', '')] }, { id: 'd2', slots: [slot('l9', 'lunch', '', '')] }];
    expect(scheduleBands(days, lunchOnly).runs).toEqual([]);
  });
});

describe('dayRangeLabel', () => {
  it('shortens numbered days and keeps other names whole', () => {
    expect(dayRangeLabel('Day 1', 'Day 5')).toBe('Days 1–5');
    expect(dayRangeLabel('Day 6', 'Day 10')).toBe('Days 6–10');
    expect(dayRangeLabel('Mon', 'Fri')).toBe('Mon – Fri');
    expect(dayRangeLabel('A1', 'B2')).toBe('A1 – B2');
    expect(dayRangeLabel('Day 3', 'Day 3')).toBe('Day 3');
    expect(dayRangeLabel('1', '5')).toBe('1 – 5');
  });
});

describe('ScheduleGrid board', () => {
  const render = (disabled: boolean) => renderToStaticMarkup(createElement(ScheduleGrid, { value: exampleSchedule, personal: examplePersonalSchedule, personalClassesOnly: true, allowStructure: false, disabled, onChange: noop, onEditDay: noop, onRemoveDay: noop,
    board: { palette: entries => createElement('ul', { 'data-list': '' }, entries.map(entry => createElement('li', { key: entry.period.id }, entry.label))), highlight: 'algebra' } }));

  it('draws the caller\'s class list, one week behind week maps, a lunch band and the lit class', () => {
    const html = render(true);
    expect(html).toContain('<ul data-list="">');
    expect(html).toContain('aria-label="Rotation week 1"');
    expect(html).not.toContain('aria-label="Rotation week 2"');
    expect(html.match(/class="board-week"/g)).toHaveLength(2);
    expect(html.match(/class="time-band-fill"/g)).toHaveLength(1);
    expect(html).toContain('time-block-lit');
    expect(html).toContain('board-map-lit');
    // Locked: no chips to place and no day editing.
    expect(html).not.toContain('Available periods');
    expect(html).not.toContain('Edit times');
  });

  it('brings the chips and the day editing back when the timetable can change', () => {
    const html = render(false);
    expect(html).toContain('Available periods');
    expect(html).toContain('aria-label="Edit times for Day 1"');
  });
});
