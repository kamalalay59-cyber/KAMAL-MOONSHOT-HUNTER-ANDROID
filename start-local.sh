#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required." >&2
  exit 1
fi
node -e "if (Number(process.versions.node.split('.')[0]) < 20) process.exit(1)" || {
  echo "Node.js 20 or newer is required." >&2
  exit 1
}
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from the example. Add Telegram credentials there if you want alerts."
fi
echo "Starting local PAPER-only scanner. Keep this terminal open while it runs."
echo "Dashboard: http://127.0.0.1:8787"
node server.mjs
