import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ScheduleTimeInput } from './schedule-time-input';

function render(value: string) {
  const html = renderToStaticMarkup(createElement(ScheduleTimeInput, { label: 'Slot 1 start', value, onChange: () => {} }));
  const describedBy = (tag: string) => new RegExp(`<${tag}[^>]*aria-describedby="([^"]+)"`).exec(html)?.[1];
  const described = (id: string | undefined) => id ? new RegExp(`id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([^<]*)<`).exec(html)?.[1] : undefined;
  return { html, input: described(describedBy('input')), button: described(describedBy('button')) };
}

it('exposes the half of the day to assistive technology on both the field and the toggle', () => {
  const morning = render('08:05');
  expect(morning.html).toContain('value="8:05"');
  expect(morning.input).toBe('AM');
  expect(morning.button).toBe('AM');
  const evening = render('20:05');
  expect(evening.html).toContain('value="8:05"');
  expect(evening.input).toBe('PM');
  expect(evening.button).toBe('PM');
});
it('keeps the toggle name stable and describes nothing while the time is empty', () => {
  const empty = render('');
  expect(empty.html).toContain('aria-label="Slot 1 start AM/PM"');
  expect(empty.input).toBeUndefined();
  expect(empty.button).toBeUndefined();
});
