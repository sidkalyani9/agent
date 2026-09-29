#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export PYTHONPATH="$PWD/backend${PYTHONPATH:+:$PYTHONPATH}"
# The built-in App Service Python container routes traffic to port 8000.
export PORT="${PORT:-8000}"
exec python -m pantry
