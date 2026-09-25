import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { Progress, clampProgress } from './progress';

afterEach(() => vi.restoreAllMocks());

it('clamps progress values into 0..max and treats missing or non-finite values as indeterminate', () => {
  expect(clampProgress(42)).toBe(42);
  expect(clampProgress(-5)).toBe(0);
  expect(clampProgress(130)).toBe(100);
  expect(clampProgress(7, 5)).toBe(5);
  expect(clampProgress(undefined)).toBeNull();
  expect(clampProgress(null)).toBeNull();
  expect(clampProgress(Number.NaN)).toBeNull();
});

it('forwards the value to Radix so the bar is announced as determinate', () => {
  const html = renderToStaticMarkup(createElement(Progress, { value: 40, 'aria-label': 'Period progress', 'aria-valuetext': '20 of 50 minutes' }));
  expect(html).toContain('role="progressbar"');
  expect(html).toContain('aria-valuenow="40"');
  expect(html).toContain('aria-valuetext="20 of 50 minutes"');
  expect(html).not.toContain('indeterminate');
  expect(html).toContain('data-state="loading"');
  expect(html).toContain('translateX(-60%)');
});

it('clamps out-of-range values without Radix logging a console error', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const over = renderToStaticMarkup(createElement(Progress, { value: 120 }));
  expect(over).toContain('aria-valuenow="100"');
  expect(over).toContain('data-state="complete"');
  const under = renderToStaticMarkup(createElement(Progress, { value: -10 }));
  expect(under).toContain('aria-valuenow="0"');
  expect(under).toContain('translateX(-100%)');
  expect(error).not.toHaveBeenCalled();
});

it('stays indeterminate when no value is given', () => {
  const html = renderToStaticMarkup(createElement(Progress));
  expect(html).not.toContain('aria-valuenow');
  expect(html).toContain('data-state="indeterminate"');
});
