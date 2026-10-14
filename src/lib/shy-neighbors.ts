import type { SpaceRect } from './shy-motion';

const CELL = 16;
const key = (x: number, y: number) => y * 65536 + x;

/** Fine cells for letters; broad rectangles are checked once per query. */
export class ShyNeighborhood<T> {
  private cells = new Map<number, T[]>();
  private broad: T[] = [];
  private seen = new Map<T, number>();
  private scratch: T[] = [];
  private query = 0;

  constructor(items: readonly T[], private rectOf: (item: T) => SpaceRect) {
    for (const item of items) {
      const rect = rectOf(item);
      const left = Math.floor(rect.x / CELL), right = Math.floor((rect.x + rect.width) / CELL);
      const top = Math.floor(rect.y / CELL), bottom = Math.floor((rect.y + rect.height) / CELL);
      if ((right - left + 1) * (bottom - top + 1) > 64) { this.broad.push(item); continue; }
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
        const index = key(x, y);
        const cell = this.cells.get(index);
        if (cell) cell.push(item);
        else this.cells.set(index, [item]);
      }
    }
  }

  /** The result buffer is reused, so consume it before the next query. */
  nearby(item: T, padding: number): readonly T[] {
    const rect = this.rectOf(item);
    this.scratch.length = 0;
    const query = ++this.query;
    const visit = (other: T) => {
      if (other === item || this.seen.get(other) === query) return;
      this.seen.set(other, query);
      const b = this.rectOf(other);
      if (rect.x > b.x + b.width + padding || rect.x + rect.width + padding < b.x ||
        rect.y > b.y + b.height + padding || rect.y + rect.height + padding < b.y) return;
      this.scratch.push(other);
    };
    const left = Math.floor((rect.x - padding) / CELL), right = Math.floor((rect.x + rect.width + padding) / CELL);
    const top = Math.floor((rect.y - padding) / CELL), bottom = Math.floor((rect.y + rect.height + padding) / CELL);
    // A broad query needn't walk thousands of empty grid cells.
    if ((right - left + 1) * (bottom - top + 1) > 64) {
      for (const cell of this.cells.values()) for (const other of cell) visit(other);
    } else {
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++)
        for (const other of this.cells.get(key(x, y)) ?? []) visit(other);
    }
    for (const other of this.broad) visit(other);
    return this.scratch;
  }
}
