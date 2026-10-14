// @ts-nocheck -- AssemblyScript source is typechecked by asc, not the app TypeScript compiler.
// Build with the pinned AssemblyScript compiler. ABI: sixteen f64 fields per record.
let data = new StaticArray<f64>(0);
let forces = new StaticArray<f64>(0);
let seen = new StaticArray<i32>(0);
let heads = new StaticArray<i32>(16384);
let next = new StaticArray<i32>(0);
let items = new StaticArray<i32>(0);
let cellX = new StaticArray<i32>(0);
let cellY = new StaticArray<i32>(0);
let capacity: i32 = 0;
let entries: i32 = 0;
export function allocate(count: i32, cells: i32): usize {
  if (count > capacity) {
    capacity = max(count, capacity * 2);
    data = new StaticArray<f64>(capacity * 16);
    forces = new StaticArray<f64>(capacity * 2);
    seen = new StaticArray<i32>(capacity);
  }
  if (cells > entries) {
    entries = max(cells, entries * 2);
    next = new StaticArray<i32>(entries); items = new StaticArray<i32>(entries);
    cellX = new StaticArray<i32>(entries); cellY = new StaticArray<i32>(entries);
  }
  return changetype<usize>(data);
}
function ancestor(a: i32, b: i32, count: i32): bool {
  let p = <i32>data[a * 16 + 1];
  for (let depth = 0; p >= 0 && p < count && depth < count; depth++) {
    if (p == b) return true;
    p = <i32>data[p * 16 + 1];
  }
  return false;
}
function length(x: f64, y: f64): f64 { return Math.sqrt(x * x + y * y); }
export function step(count: i32, hasPointer: bool, px: f64, py: f64): void {
  for (let i = 0; i < 16384; i++) heads[i] = -1;
  for (let i = 0; i < count; i++) { forces[i * 2] = 0; forces[i * 2 + 1] = 0; seen[i] = -1; }
  let entry = 0;
  for (let i = 0; i < count; i++) {
    const a = i * 16;
    if (data[a + 15] == 0) continue;
    const x = data[a + 2] + data[a + 6], y = data[a + 3] + data[a + 7];
    const x0 = <i32>Math.floor((x - 3) / 64), x1 = <i32>Math.floor((x + data[a + 4] + 3) / 64);
    const y0 = <i32>Math.floor((y - 3) / 64), y1 = <i32>Math.floor((y + data[a + 5] + 3) / 64);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const hash = ((cx * 73856093) ^ (cy * 19349663)) & 16383;
      for (let e = heads[hash]; e >= 0; e = next[e]) {
        if (cellX[e] != cx || cellY[e] != cy) continue;
        const j = items[e];
        if (seen[j] == i) continue;
        seen[j] = i;
        if (ancestor(i, j, count) || ancestor(j, i, count)) continue;
        const b = j * 16;
        if (!hasPointer && length(data[a + 8], data[a + 9]) < .5 && length(data[b + 8], data[b + 9]) < .5) continue;
        const bx = data[b + 2] + data[b + 6], by = data[b + 3] + data[b + 7];
        const gap = length(max(max(x - bx - data[b + 4], bx - x - data[a + 4]), 0), max(max(y - by - data[b + 5], by - y - data[a + 5]), 0));
        if (gap >= 3) continue;
        const dx = x + data[a + 4] / 2 - bx - data[b + 4] / 2, dy = y + data[a + 5] / 2 - by - data[b + 5] / 2;
        const len = length(dx, dy);
        if (len == 0) continue;
        const overlap = max(0, min(x + data[a + 4], bx + data[b + 4]) - max(x, bx)) * max(0, min(y + data[a + 5], by + data[b + 5]) - max(y, by));
        const area = max(1, min(data[a + 4] * data[a + 5], data[b + 4] * data[b + 5]));
        const falloff = 1 - gap / 3;
        const strength = (60000 + 180000 * min(1, overlap / area)) * falloff * falloff / len;
        const fx = dx * strength, fy = dy * strength;
        forces[i * 2] += fx; forces[i * 2 + 1] += fy;
        forces[j * 2] -= fx; forces[j * 2 + 1] -= fy;
      }
      assert(entry < entries);
      items[entry] = i; cellX[entry] = cx; cellY[entry] = cy;
      next[entry] = heads[hash]; heads[hash] = entry++;
    }
  }
  for (let i = 0; i < count; i++) {
    const a = i * 16;
    if (data[a + 15] == 0) continue;
    const x = data[a + 2] + data[a + 6], y = data[a + 3] + data[a + 7], w = data[a + 4], h = data[a + 5];
    const dt = max(0, min(data[a + 14], 1.0 / 30));
    let fx = forces[i * 2], fy = forces[i * 2 + 1];
    const magnitude = length(fx, fy);
    const scale = min(1, 6000 / (magnitude == 0 ? 1 : magnitude)); fx *= scale; fy *= scale;
    if (hasPointer) {
      let dx = x + w / 2 - px, dy = y + h / 2 - py;
      if (dx == 0 && dy == 0) { dx = data[a + 8] == 0 ? 1 : data[a + 8]; dy = data[a + 9]; }
      const gap = length(max(max(x - px, 0), px - x - w), max(max(y - py, 0), py - y - h));
      const falloff = 1 + gap / 140;
      const strength = 3200 / (falloff * falloff) / length(dx, dy);
      fx += dx * strength; fy += dy * strength;
    }
    const left = data[a + 10], top = data[a + 11], right = max(left, left + data[a + 12] - w), bottom = max(top, top + data[a + 13] - h);
    if (x <= left + .01 && fx < 0 || x >= right - .01 && fx > 0) fx = 0;
    if (y <= top + .01 && fy < 0 || y >= bottom - .01 && fy > 0) fy = 0;
    const drag = Math.exp(-4.8 * dt);
    let vx = data[a + 8] * drag + fx / 4.8 * (1 - drag), vy = data[a + 9] * drag + fy / 4.8 * (1 - drag);
    const speed = length(vx, vy);
    if (speed > 240) { vx *= 240 / speed; vy *= 240 / speed; }
    if (fx == 0 && fy == 0 && length(vx, vy) < .5) { vx = 0; vy = 0; }
    const nx = max(left, min(x + vx * dt, right)), ny = max(top, min(y + vy * dt, bottom));
    if (Math.abs(nx - x - vx * dt) > .00001) vx = Math.abs(vx) < 40 ? 0 : -vx * .65;
    if (Math.abs(ny - y - vy * dt) > .00001) vy = Math.abs(vy) < 40 ? 0 : -vy * .65;
    data[a + 6] += nx - x; data[a + 7] += ny - y; data[a + 8] = vx; data[a + 9] = vy;
  }
}
