#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
backup_path="./data/backups/quasar-$(date -u +%Y%m%dT%H%M%S)-$$.sqlite"
exec "$HOME/.local/bin/node" --env-file=.env.local --import tsx scripts/backup.ts "$backup_path"
