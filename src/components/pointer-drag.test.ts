import { describe, expect, it } from 'vitest';
import { edgeSpeed } from './pointer-drag';

describe('edge scrolling speed', () => {
  it('is zero away from the edges and grows towards each edge', () => {
    expect(edgeSpeed(400, 0, 800)).toBe(0);
    expect(edgeSpeed(96, 0, 800)).toBe(0);
    expect(edgeSpeed(704, 0, 800)).toBe(0);
    expect(edgeSpeed(48, 0, 800)).toBeLessThan(0);
    expect(edgeSpeed(752, 0, 800)).toBeGreaterThan(0);
    expect(edgeSpeed(780, 0, 800)).toBeGreaterThan(edgeSpeed(752, 0, 800));
    expect(edgeSpeed(20, 0, 800)).toBe(-edgeSpeed(780, 0, 800));
  });
  it('is full speed at and beyond an edge, such as over a bar that covers it', () => {
    expect(edgeSpeed(800, 0, 800)).toBe(1100);
    expect(edgeSpeed(900, 0, 800)).toBe(1100);
    expect(edgeSpeed(-50, 56, 800)).toBe(-1100);
  });
  it('measures from the given bounds, and narrows its zones in a short area', () => {
    expect(edgeSpeed(100, 56, 800)).toBeLessThan(0);
    expect(edgeSpeed(100, 0, 800)).toBe(0);
    // 150px tall: each zone is a third, so the middle third is still.
    expect(edgeSpeed(75, 0, 150)).toBe(0);
    expect(edgeSpeed(40, 0, 150)).toBeLessThan(0);
    expect(edgeSpeed(10, 0, 0)).toBe(0);
  });
  it('takes a smaller zone and speed for sideways scrolling', () => {
    expect(edgeSpeed(60, 0, 400, { zone: 48, speed: 600 })).toBe(0);
    expect(edgeSpeed(400, 0, 400, { zone: 48, speed: 600 })).toBe(600);
  });
});
