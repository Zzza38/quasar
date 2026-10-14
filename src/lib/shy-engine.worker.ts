import { ShyJsEngine, STRIDE, type ShyEngineRequest, type ShyEngineResponse } from './shy-engine';

type WasmEngine = {
  memory: WebAssembly.Memory;
  allocate: (count: number, cells: number) => number;
  step: (count: number, hasPointer: number, x: number, y: number) => void;
};
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ShyEngineRequest>) => void) | null;
  postMessage: (message: ShyEngineResponse | { ready: true; backend: 'wasm' | 'js' }, transfer?: Transferable[]) => void;
};
let wasm: WasmEngine | null = null;
const fallback = new ShyJsEngine();

async function initialize() {
  try {
    const response = await fetch('/mods/shy-physics.wasm');
    if (!response.ok) throw new Error(`Physics WASM returned ${response.status}`);
    const imports = { env: { abort: () => { throw new Error('Physics WASM aborted'); } } };
    const instance = await WebAssembly.instantiate(await response.arrayBuffer(), imports);
    wasm = instance.instance.exports as unknown as WasmEngine;
  } catch {
    wasm = null;
  }
  scope.onmessage = ({ data: request }) => {
    const started = performance.now();
    if (wasm) {
      try {
        const count = request.data.length / STRIDE;
        let cells = 0;
        for (let i = 0; i < request.data.length; i += STRIDE) {
          if (!request.data[i + 15]) continue;
          const x = request.data[i + 2] + request.data[i + 6], y = request.data[i + 3] + request.data[i + 7];
          cells += (Math.floor((x + request.data[i + 4] + 3) / 64) - Math.floor((x - 3) / 64) + 1) *
            (Math.floor((y + request.data[i + 5] + 3) / 64) - Math.floor((y - 3) / 64) + 1);
        }
        const address = wasm.allocate(count, cells);
        const view = new Float64Array(wasm.memory.buffer, address, request.data.length);
        view.set(request.data);
        wasm.step(count, request.pointer ? 1 : 0, request.pointer?.x ?? 0, request.pointer?.y ?? 0);
        request.data.set(view);
      } catch {
        // Preserve motion if fetching or executing WASM fails on this browser.
        wasm = null;
        fallback.step(request.data, request.pointer);
      }
    } else fallback.step(request.data, request.pointer);
    scope.postMessage({ generation: request.generation, data: request.data, backend: wasm ? 'wasm' : 'js', durationMs: performance.now() - started }, [request.data.buffer as ArrayBuffer]);
  };
  scope.postMessage({ ready: true, backend: wasm ? 'wasm' : 'js' });
}
void initialize();
