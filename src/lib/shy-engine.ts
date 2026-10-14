/** Transferable batch format. Positions and bounds share viewport coordinates. */
export const STRIDE = 16;
export const enum Field {
  ID = 0, PARENT = 1, HOME_X = 2, HOME_Y = 3, WIDTH = 4, HEIGHT = 5,
  X = 6, Y = 7, VX = 8, VY = 9, BOUND_X = 10, BOUND_Y = 11,
  BOUND_WIDTH = 12, BOUND_HEIGHT = 13, SECONDS = 14, ACTIVE = 15,
}
export type ShyEngineRequest = { generation: number; pointer: { x: number; y: number } | null; data: Float64Array };
export type ShyEngineResponse = { generation: number; data: Float64Array; backend: 'wasm' | 'js'; durationMs: number };

/** Allocation-free integration with reusable spatial buckets for the fallback. */
export class ShyJsEngine {
  private forces = new Float64Array(0);
  private seen = new Int32Array(0);
  private buckets = new Map<string, number[]>();
  step(data: Float64Array, pointer: ShyEngineRequest['pointer']): void {
    const count = data.length / STRIDE;
    if (this.forces.length < count * 2) { this.forces = new Float64Array(count * 2); this.seen = new Int32Array(count); }
    this.forces.fill(0); this.seen.fill(-1);
    for (const bucket of this.buckets.values()) bucket.length = 0;
    const ancestor = (a: number, b: number): boolean => {
      let p = data[a * STRIDE + Field.PARENT];
      for (let depth = 0; p >= 0 && p < count && depth < count; depth++, p = data[p * STRIDE + Field.PARENT]) if (p === b) return true;
      return false;
    };
    for (let i = 0; i < count; i++) {
      const a = i * STRIDE;
      if (!data[a + Field.ACTIVE]) continue;
      const x = data[a + 2] + data[a + 6], y = data[a + 3] + data[a + 7];
      const x0 = Math.floor((x - 3) / 64), x1 = Math.floor((x + data[a + 4] + 3) / 64);
      const y0 = Math.floor((y - 3) / 64), y1 = Math.floor((y + data[a + 5] + 3) / 64);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
        const key = `${cx},${cy}`;
        let bucket = this.buckets.get(key);
        if (!bucket) this.buckets.set(key, bucket = []);
        for (const j of bucket) {
          if (this.seen[j] === i) continue;
          this.seen[j] = i;
          if (ancestor(i, j) || ancestor(j, i)) continue;
          const b = j * STRIDE;
          if (!pointer && Math.hypot(data[a + 8], data[a + 9]) < .5 && Math.hypot(data[b + 8], data[b + 9]) < .5) continue;
          const bx = data[b + 2] + data[b + 6], by = data[b + 3] + data[b + 7];
          const gap = Math.hypot(Math.max(x - bx - data[b + 4], bx - x - data[a + 4], 0), Math.max(y - by - data[b + 5], by - y - data[a + 5], 0));
          if (gap >= 3) continue;
          const dx = x + data[a + 4] / 2 - bx - data[b + 4] / 2, dy = y + data[a + 5] / 2 - by - data[b + 5] / 2;
          const length = Math.hypot(dx, dy);
          if (!length) continue;
          const overlap = Math.max(0, Math.min(x + data[a + 4], bx + data[b + 4]) - Math.max(x, bx)) * Math.max(0, Math.min(y + data[a + 5], by + data[b + 5]) - Math.max(y, by));
          const area = Math.max(1, Math.min(data[a + 4] * data[a + 5], data[b + 4] * data[b + 5]));
          const strength = (60000 + 180000 * Math.min(1, overlap / area)) * (1 - gap / 3) ** 2 / length;
          const fx = dx * strength, fy = dy * strength;
          this.forces[i * 2] += fx; this.forces[i * 2 + 1] += fy;
          this.forces[j * 2] -= fx; this.forces[j * 2 + 1] -= fy;
        }
        bucket.push(i);
      }
    }
    // Keep the map bounded when the page geometry changes repeatedly.
    if (this.buckets.size > 32768) for (const [key, bucket] of this.buckets) if (!bucket.length) this.buckets.delete(key);
    for (let i = 0; i < count; i++) {
      const a = i * STRIDE;
      if (!data[a + 15]) continue;
      const x = data[a + 2] + data[a + 6], y = data[a + 3] + data[a + 7], w = data[a + 4], h = data[a + 5];
      const dt = Math.max(0, Math.min(data[a + 14], 1 / 30));
      let fx = this.forces[i * 2], fy = this.forces[i * 2 + 1];
      const scale = Math.min(1, 6000 / (Math.hypot(fx, fy) || 1)); fx *= scale; fy *= scale;
      if (pointer) {
        let dx = x + w / 2 - pointer.x, dy = y + h / 2 - pointer.y;
        if (!dx && !dy) { dx = data[a + 8] || 1; dy = data[a + 9]; }
        const gap = Math.hypot(Math.max(x - pointer.x, 0, pointer.x - x - w), Math.max(y - pointer.y, 0, pointer.y - y - h));
        const strength = 3200 / (1 + gap / 140) ** 2 / Math.hypot(dx, dy);
        fx += dx * strength; fy += dy * strength;
      }
      const left = data[a + 10], top = data[a + 11], right = Math.max(left, left + data[a + 12] - w), bottom = Math.max(top, top + data[a + 13] - h);
      if (x <= left + .01 && fx < 0 || x >= right - .01 && fx > 0) fx = 0;
      if (y <= top + .01 && fy < 0 || y >= bottom - .01 && fy > 0) fy = 0;
      const drag = Math.exp(-4.8 * dt);
      let vx = data[a + 8] * drag + fx / 4.8 * (1 - drag), vy = data[a + 9] * drag + fy / 4.8 * (1 - drag);
      const speed = Math.hypot(vx, vy);
      if (speed > 240) { vx *= 240 / speed; vy *= 240 / speed; }
      if (!fx && !fy && Math.hypot(vx, vy) < .5) { vx = 0; vy = 0; }
      const nx = Math.max(left, Math.min(x + vx * dt, right)), ny = Math.max(top, Math.min(y + vy * dt, bottom));
      if (Math.abs(nx - x - vx * dt) > .00001) vx = Math.abs(vx) < 40 ? 0 : -vx * .65;
      if (Math.abs(ny - y - vy * dt) > .00001) vy = Math.abs(vy) < 40 ? 0 : -vy * .65;
      data[a + 6] += nx - x; data[a + 7] += ny - y; data[a + 8] = vx; data[a + 9] = vy;
    }
  }
}
