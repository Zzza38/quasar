import { expect, it } from 'vitest';
import { buildTimeAxis } from './time-axis';
it('keeps short blocks readable and adjacent blocks aligned without overlap', () => {
  const axis = buildTimeAxis(480, 960, [485, 490, 495, 570]);
  expect(axis.y(485) - axis.y(480)).toBeGreaterThanOrEqual(24);
  expect(axis.y(490) - axis.y(485)).toBeGreaterThanOrEqual(24);
  for (const minute of [480, 482, 485, 488, 490, 555, 960]) expect(axis.time(axis.y(minute))).toBeCloseTo(minute);
  expect(axis.y(960)).toBe(axis.height);
});
