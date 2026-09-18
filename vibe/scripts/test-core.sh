#!/usr/bin/env bash
# Run core unit tests through the checkout's scripts/test.sh (Electron + mocha, against
# compiled out/): any number of test files (--run), or exactly one glob (--runGlob).
# Upstream accepts a single glob and silently ignores it when --run is present, so
# other mixes are refused. Source-style globs (src/...*.test.ts) are translated to the
# out/-relative .js form upstream expects.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

usage() { echo "usage: test-core.sh <test-file>... | <glob>" >&2; exit 2; }

[ $# -gt 0 ] || usage
args=()
for arg in "$@"; do
	case "$arg" in
		*[*?[]*)
			[ $# -eq 1 ] || usage
			arg="${arg#src/}"
			case "$arg" in *.ts) arg="${arg%.ts}.js" ;; esac
			args+=(--runGlob "$arg")
			;;
		*) args+=(--run "$arg") ;;
	esac
done

exec "$VIBE_CHECKOUT/scripts/test.sh" "${args[@]}"
