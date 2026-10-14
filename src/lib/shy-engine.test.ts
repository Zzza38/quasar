import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ShyJsEngine, STRIDE, Field } from './shy-engine';
import { particleRepulsion, stepShyPhysics, type SpaceRect } from './shy-motion';

type Exports = { memory: WebAssembly.Memory; allocate(count: number, cells: number): number; step(count: number, pointer: number, x: number, y: number): void };
async function wasmEngine() {
  const module = await WebAssembly.instantiate(readFileSync('public/mods/shy-physics.wasm'), { env: { abort: () => { throw Error('abort'); } } });
  return module.instance.exports as unknown as Exports;
}
function scene(count: number) {
  const data = new Float64Array(count * STRIDE);
  for (let i = 0; i < count; i++) {
    const a = i * STRIDE;
    data.set([i, -1, (i % 80) * 12, Math.floor(i / 80) * 22, 10, 20, 0, 0, 0, 0, 0, -200, 1600, 4000, 1 / 30, 1], a);
  }
  return data;
}
function runWasm(engine: Exports, data: Float64Array, pointer: { x: number; y: number } | null) {
  const address = engine.allocate(data.length / STRIDE, data.length * 8);
  const view = new Float64Array(engine.memory.buffer, address, data.length);
  view.set(data); engine.step(data.length / STRIDE, pointer ? 1 : 0, pointer?.x ?? 0, pointer?.y ?? 0); data.set(view);
}
function reference(data: Float64Array, pointer: { x: number; y: number }) {
  const count = data.length / STRIDE;
  const rects: SpaceRect[] = Array.from({ length: count }, (_, i) => ({ x: data[i * STRIDE + 2] + data[i * STRIDE + 6], y: data[i * STRIDE + 3] + data[i * STRIDE + 7], width: data[i * STRIDE + 4], height: data[i * STRIDE + 5] }));
  const forces = Array.from({ length: count }, () => ({ x: 0, y: 0 }));
  for (let i = 0; i < count; i++) for (let j = 0; j < i; j++) {
    const force = particleRepulsion(rects[i], rects[j]);
    forces[i].x += force.x; forces[i].y += force.y; forces[j].x -= force.x; forces[j].y -= force.y;
  }
  for (let i = 0; i < count; i++) {
    const a = i * STRIDE;
    const result = stepShyPhysics(rects[i], { x: data[a + 8], y: data[a + 9] }, pointer, { x: data[a + 10], y: data[a + 11], width: data[a + 12], height: data[a + 13] }, data[a + 14], [], forces[i]);
    data[a + 6] += result.move.x; data[a + 7] += result.move.y; data[a + 8] = result.velocity.x; data[a + 9] = result.velocity.y;
  }
}
describe('batched shy engine', () => {
  it('matches the independent reference for cursor, nearby repulsion, friction, and bounds', async () => {
    const wasm = await wasmEngine(), js = new ShyJsEngine();
    const expected = scene(100), actual = expected.slice(), fallback = expected.slice();
    expected[Field.HOME_X] = actual[Field.HOME_X] = fallback[Field.HOME_X] = -5;
    const pointer = { x: 12, y: 20 };
    reference(expected, pointer); runWasm(wasm, actual, pointer); js.step(fallback, pointer);
    for (let i = 0; i < expected.length; i++) {
      expect(actual[i]).toBeCloseTo(expected[i], 8);
      expect(fallback[i]).toBeCloseTo(expected[i], 8);
    }
  });
  it('excludes owner chains, retains inactive state, and leaves resting pages asleep', async () => {
    const wasm = await wasmEngine(), js = new ShyJsEngine();
    for (const run of [(data: Float64Array) => runWasm(wasm, data, null), (data: Float64Array) => js.step(data, null)]) {
      const resting = scene(2); const before = resting.slice(); run(resting); expect(resting).toEqual(before);
      const inactive = scene(2); inactive[Field.ACTIVE] = 0; inactive[Field.VX] = 100; const copy = inactive.slice(0, STRIDE); run(inactive); expect(inactive.slice(0, STRIDE)).toEqual(copy);
      const owned = scene(2); owned[STRIDE + Field.PARENT] = 0; owned[Field.VX] = 20; owned[STRIDE + Field.VX] = 20;
      run(owned); expect(owned[Field.VX]).toBeCloseTo(owned[STRIDE + Field.VX], 10);
    }
  });
  it('keeps long batches finite and parity with the JS fallback', async () => {
    const wasm = await wasmEngine(), js = new ShyJsEngine(), actual = scene(2000), expected = actual.slice();
    for (let frame = 0; frame < 10; frame++) {
      expected.set(actual);
      const pointer = { x: 50 + frame * 10, y: 200 }; runWasm(wasm, actual, pointer); js.step(expected, pointer);
      let maxError = 0;
      for (let i = 0; i < actual.length; i++) maxError = Math.max(maxError, Math.abs(actual[i] - expected[i]));
      expect(Number.isFinite(maxError)).toBe(true); expect(maxError).toBeLessThan(1e-7);
    }
  });
  it('reports a warmed large-batch benchmark against the old object physics', async () => {
    const wasm = await wasmEngine(), data = scene(2000), pointer = { x: 500, y: 100 };
    for (let i = 0; i < 5; i++) runWasm(wasm, data, pointer);
    const start = performance.now(); for (let i = 0; i < 20; i++) runWasm(wasm, data, pointer); const wasmMs = (performance.now() - start) / 20;
    const fallback = new ShyJsEngine(), jsData = scene(2000);
    for (let i = 0; i < 5; i++) fallback.step(jsData, pointer);
    const jsStart = performance.now(); for (let i = 0; i < 20; i++) fallback.step(jsData, pointer); const jsMs = (performance.now() - jsStart) / 20;
    const old = scene(2000), oldStart = performance.now(); reference(old, pointer); const objectMs = performance.now() - oldStart;
    console.info(`2000 particles: batched WASM ${wasmMs.toFixed(2)}ms/step including copies; batched JS ${jsMs.toFixed(2)}ms/step; pairwise object reference ${objectMs.toFixed(2)}ms/step`);
    expect(data[Field.VX]).toBeLessThanOrEqual(240);
  });
});
