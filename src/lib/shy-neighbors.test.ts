import { describe, expect, it } from 'vitest';
import { ShyNeighborhood } from './shy-neighbors';

describe('shy neighbor search', () => {
  it('finds edges of large rectangles once, across cells and negative scroll coordinates', () => {
    const letter = { x: 98, y: -50, width: 8, height: 20 };
    const nearby = { x: 108, y: -50, width: 8, height: 20 };
    const broad = { x: 100, y: -500, width: 800, height: 900 };
    const distant = { x: 500, y: 700, width: 10, height: 20 };
    const grid = new ShyNeighborhood([letter, nearby, broad, distant], item => item);
    expect([...grid.nearby(letter, 3)]).toEqual(expect.arrayContaining([nearby, broad]));
    expect(grid.nearby(letter, 3)).toHaveLength(2);
    expect(grid.nearby(broad, 3)).toContain(letter);
    expect(grid.nearby(distant, 3)).toHaveLength(0);
  });
  it('keeps dense letter searches local instead of checking entire rows', () => {
    const letters = Array.from({ length: 2000 }, (_, i) => ({ x: i % 100 * 10, y: Math.floor(i / 100) * 24, width: 7, height: 20 }));
    const grid = new ShyNeighborhood(letters, item => item);
    const neighbors = [...grid.nearby(letters[1050], 3)];
    expect(neighbors.length).toBeLessThanOrEqual(2);
    expect(neighbors).toContain(letters[1049]);
    expect(neighbors).toContain(letters[1051]);
  });
});
