#!/usr/bin/env bash
# Compile the checkout (`npm run compile`) with the pinned Node toolchain.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

cd "$VIBE_CHECKOUT"
exec npm run compile
