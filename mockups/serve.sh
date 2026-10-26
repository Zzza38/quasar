#!/usr/bin/env bash
# Serves the mockups on 127.0.0.1:3005 for local screenshots. Never expose them on the tailnet.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=3005
fuser -k "$PORT/tcp" 2>/dev/null || true
nohup python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIR" >/tmp/quasar-mockups.log 2>&1 &
echo "http://127.0.0.1:$PORT/"
