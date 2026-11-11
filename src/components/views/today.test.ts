import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { NextClass, StudentClass } from '@/domain/schedule';
import { contrastWithWhite } from '@/lib/color';
import { classColor } from '@/lib/format';
import { FollowingBlock, nowCardBase } from './today';

describe('Now card colour', () => {
  it('gives an unassigned period a concrete base that keeps white text at 4.5:1', () => {
    const dot = classColor(undefined, 'other').dot;
    expect(dot.startsWith('var(')).toBe(true);
    const base = nowCardBase(dot);
    expect(base).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrastWithWhite(base)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps class and lunch colours, darkened only as far as white text needs', () => {
    for (const dot of [classColor('algebra').dot, classColor(undefined, 'lunch').dot, '#facc15'])
      expect(contrastWithWhite(nowCardBase(dot)), dot).toBeGreaterThanOrEqual(4.5);
    expect(nowCardBase('#1e3a8a')).toBe('#1e3a8a');
  });
});

describe('Now card following block', () => {
  const period = (extra: Partial<NextClass> = {}): NextClass => ({
    slotId: 's2', periodId: 'p2', label: 'Period 2', kind: 'class', start: '10:00', end: '10:50',
    startAt: '2026-09-22T14:00:00Z', endAt: '2026-09-22T14:50:00Z', date: '2026-09-22', cycleDayId: 'a', cycleDayLabel: 'Day A', status: 'upcoming',
    class: { id: 'chem', name: 'Chemistry', room: '112', teacher: 'Ms. Park', color: '#4f46e5' } as StudentClass, ...extra,
  });
  const render = (props: Parameters<typeof FollowingBlock>[0]) => renderToStaticMarkup(createElement(FollowingBlock, props));

  it('names the next class with its start time, room and teacher in its own colour', () => {
    const html = render({ period: period(), label: 'Next', sameDay: true, today: '2026-09-22' });
    expect(html).toContain('aria-label="Next: Chemistry"');
    for (const text of ['Chemistry', '10:00', 'Ms. Park', '112']) expect(html).toContain(text);
    expect(html).toContain('#4f46e5');
  });

  it('says which day a period on another day starts and leaves out empty room and teacher', () => {
    const html = render({ period: period({ date: '2026-09-23', kind: 'lunch', label: 'Lunch', class: undefined }), label: 'Then', sameDay: false, today: '2026-09-22' });
    expect(html).toContain('aria-label="Then: Lunch"');
    expect(html).toMatch(/Tomorrow/i);
    expect(html).not.toContain('<p');
  });
});
