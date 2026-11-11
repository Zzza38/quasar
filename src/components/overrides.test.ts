import { exampleSchedule } from '@/domain/example';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BellTimeChoice, PERSONAL_BLOCK_CORRECTION, sharedBellTimeDraft } from './overrides';
import { describe, expect, it } from 'vitest';
import { committedShift, parseShift } from './overrides';

describe('shift field', () => {
  it('keeps the last valid shift while the text is not a number yet, instead of snapping to 0', () => {
    for (const text of ['', '-', ' ', '1.5', 'abc', '--5']) expect(parseShift(text), text).toBeNull();
  });

  it('commits whole minutes, negative ones included, clamped to ±720', () => {
    expect(parseShift('-15')).toBe(-15);
    expect(parseShift('45')).toBe(45);
    expect(parseShift('-0')).toBe(0);
    expect(Object.is(parseShift('-0'), 0)).toBe(true);
    expect(parseShift('900')).toBe(720);
    expect(parseShift('-900')).toBe(-720);
  });

  it('commits no shift for an emptied field, so clearing it and saving removes the shift', () => {
    expect(committedShift('', 30)).toBe(0);
    expect(committedShift('  ', -45)).toBe(0);
  });

  it('keeps the last shift while another partial entry is typed, and commits whole numbers', () => {
    expect(committedShift('1.5', 30)).toBe(30);
    expect(committedShift('abc', 30)).toBe(30);
    expect(committedShift('-15', 30)).toBe(-15);
    expect(committedShift('900', 0)).toBe(720);
  });
});


describe('recurring bell-time choice', () => {
  it('offers the shared correction and intentional personal paths with cancellation', () => {
    const noop = () => {};
    const html = renderToStaticMarkup(createElement(BellTimeChoice, { onSchool: noop, onPersonal: noop, onCancel: noop }));
    expect(html).toContain("The school&#x27;s time is wrong");
    expect(html).toContain('Only for me');
    expect(html).toContain('Cancel');
    expect(html).toContain('after review');
  });
});


describe('shared bell-time drafts', () => {
  it('blocks a new slot for a synthetic period already present in the personal editor catalog', () => {
    const before = structuredClone(exampleSchedule);
    before.periods.push({ id: 'class-private', label: 'Private class name', kind: 'class' });
    const after = structuredClone(before);
    after.cycleDays[0].slots.push({ id: 'private-slot', periodId: 'class-private', start: '13:00', end: '13:45' });
    expect(sharedBellTimeDraft(before, after, exampleSchedule)).toEqual({ schedule: null, schoolUnavailable: PERSONAL_BLOCK_CORRECTION });
  });

  it('blocks editing a personal slot that has no counterpart in the school timetable', () => {
    const before = structuredClone(exampleSchedule);
    before.periods.push({ id: 'class-private', label: 'Private class name', kind: 'class' });
    before.cycleDays[0].slots.push({ id: 'private-slot', periodId: 'class-private', start: '13:00', end: '13:45' });
    const after = structuredClone(before);
    after.cycleDays[0].slots.at(-1)!.end = '13:50';
    expect(sharedBellTimeDraft(before, after, exampleSchedule)).toEqual({ schedule: null, schoolUnavailable: PERSONAL_BLOCK_CORRECTION });
  });

  it('prefills a shared period edit for the selected grade without copying personal period labels', () => {
    const junior = structuredClone(exampleSchedule);
    junior.cycleDays[0].label = 'Junior day';
    junior.cycleDays[0].slots[0].end = '08:50';
    const school = { ...exampleSchedule, gradeSchedules: { '11': junior } };
    const before = structuredClone(junior);
    before.periods[0].label = 'Private class name';
    const after = structuredClone(before);
    after.cycleDays[0].slots[0].end = '08:45';
    const result = sharedBellTimeDraft(before, after, school, '11');
    expect(result.schoolUnavailable).toBeUndefined();
    expect(result.schedule?.cycleDays[0].label).toBe('Junior day');
    expect(result.schedule?.cycleDays[0].slots[0].end).toBe('08:45');
    expect(result.schedule?.periods).toEqual(junior.periods);
    expect(JSON.stringify(result.schedule)).not.toContain('Private class name');
  });

  it('disables the school action with an explanation while leaving the personal action available', () => {
    const noop = () => {};
    const html = renderToStaticMarkup(createElement(BellTimeChoice, { onSchool: noop, onPersonal: noop, onCancel: noop, schoolUnavailable: PERSONAL_BLOCK_CORRECTION }));
    expect(html.match(/<button[^>]*>The school&#x27;s time is wrong<\/button>/)?.[0]).toContain('disabled=""');
    expect(html.match(/<button[^>]*>Only for me<\/button>/)?.[0]).not.toContain('disabled=""');
    expect(html).toContain(PERSONAL_BLOCK_CORRECTION);
  });
});
