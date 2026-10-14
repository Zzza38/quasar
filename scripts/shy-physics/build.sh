#!/usr/bin/env bash
set -euo pipefail
# Install a pinned compiler outside the app dependency tree.
compiler_dir="${SHY_COMPILER_DIR:-/tmp/quasar-shy-wasm}"
pnpm --dir "$compiler_dir" add assemblyscript@0.28.9
node "$compiler_dir/node_modules/assemblyscript/bin/asc.js" scripts/shy-physics/engine.ts \
  --outFile public/mods/shy-physics.wasm --optimizeLevel 3 --shrinkLevel 0 --converge --runtime incremental --noAssert --uncheckedBehavior always
