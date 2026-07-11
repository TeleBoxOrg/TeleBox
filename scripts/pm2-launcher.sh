#!/usr/bin/env bash
# Portable PM2 launcher for TeleBox.
#
# This file intentionally contains no machine-specific paths and does not rely on
# preconfigured PM2 config files. PM2 should start this script directly:
#   pm2 start scripts/pm2-launcher.sh --name telebox --cwd "$PWD" --interpreter bash

set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd -P)"
cd "$ROOT_DIR"

# If PM2 was started from a non-interactive shell and node is not in PATH, try nvm.
if ! command -v node >/dev/null 2>&1; then
  NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  if [ -s "$NVM_SH" ]; then
    # shellcheck disable=SC1090
    . "$NVM_SH"
    nvm use --silent >/dev/null 2>&1 || true
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[pm2-launcher] node not found in PATH. Install Node.js or load nvm before starting PM2." >&2
  exit 127
fi

if [ ! -f "scripts/run-tsx.cjs" ]; then
  echo "[pm2-launcher] scripts/run-tsx.cjs not found under $ROOT_DIR" >&2
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[pm2-launcher] node_modules not found under $ROOT_DIR. Run: npm install" >&2
  exit 1
fi

ENTRY="${TELEBOX_ENTRY:-./src/index.ts}"
exec node scripts/run-tsx.cjs "$ENTRY" "$@"
