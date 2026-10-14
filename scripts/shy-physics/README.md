# Shy physics WASM

Run from the repository root:

```sh
bash scripts/shy-physics/build.sh
```

The script installs AssemblyScript 0.28.9 into `/tmp/quasar-shy-wasm`, then rebuilds `public/mods/shy-physics.wasm`. Override `SHY_COMPILER_DIR` to reuse another compiler directory. The app serves the checked-in binary and does not require the compiler at runtime.

The worker sends a complete transferable Float64Array batch into WASM. Numeric hash buckets find nearby rectangles, exclude owner chains, and accumulate equal and opposite forces. Integration updates world offsets and velocity in place. Hash storage and particle arrays grow only when capacity is exceeded. All index ranges come from the allocated batch and precomputed cell count; the production compiler removes redundant array bounds checks.

A JavaScript implementation with the same transferable format takes over if WASM cannot load. Both implementations run in the worker. DOM measurement and painting remain on the main thread.

Verify with:

```sh
node node_modules/vitest/vitest.mjs run --configLoader runner src/lib/shy-engine.test.ts
```

The benchmark compares batched WASM with batched JavaScript, including memory copies. The separate pairwise reference exists for correctness validation and is not the app's previous spatial-grid implementation. Timing varies by machine and concurrent load.
