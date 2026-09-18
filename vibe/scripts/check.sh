#!/usr/bin/env bash
# Pre-commit verifier: export the checkout to a temp dir and compare it with the
# tracked patches/ + overlay/ (contents and executable bits). Exit 0 iff they are
# equal; read-only with respect to both the checkout and the tracked directories.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
"$VIBE_SCRIPTS/export.sh" --out "$tmp" > /dev/null

executables() { (cd "$1" && find . -type f -perm -u+x | LC_ALL=C sort); }

rc=0
diff -rq "$tmp/patches" "$VIBE_PATCHES" || rc=1
diff -rq "$tmp/overlay" "$VIBE_OVERLAY" || rc=1
if [ "$rc" = 0 ] && [ "$(executables "$tmp/overlay")" != "$(executables "$VIBE_OVERLAY")" ]; then
	echo "executable bits differ under $VIBE_OVERLAY"
	rc=1
fi

if [ "$rc" = 0 ]; then
	echo "check: tracked state matches $VIBE_CHECKOUT"
else
	echo "check: tracked state differs from $VIBE_CHECKOUT (run export.sh)" >&2
fi
exit "$rc"
