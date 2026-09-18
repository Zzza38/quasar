#!/usr/bin/env bash
# Serves the landing-page mockups on 127.0.0.1:3005 and exposes them on the tailnet.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=3005
pkill -f "http.server $PORT" 2>/dev/null || true
nohup python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIR" >/tmp/quasar-mockups.log 2>&1 &
sleep 1
tailscale serve --bg --https="$PORT" "http://127.0.0.1:$PORT"
echo "https://$(tailscale status --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'):$PORT/"
