#!/usr/bin/env bash
# Launch the development build: the checkout's scripts/code.sh with the pinned Node
# toolchain on PATH. All arguments are passed through.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

exec "$VIBE_CHECKOUT/scripts/code.sh" "$@"
