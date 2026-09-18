#!/usr/bin/env bash
# Regenerate the tracked fork state from the checkout: one patch per modified or
# deleted upstream file (patches/, named by path with "/" -> "__") and a mirrored copy
# of every new non-ignored file (overlay/). Outputs are rebuilt from scratch, so stale
# entries disappear and repeated runs are byte-identical. --out DIR writes DIR/patches
# and DIR/overlay instead of the tracked directories.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

usage() { echo "usage: export.sh [--out DIR]" >&2; exit 2; }

if [ $# -gt 0 ]; then
	[ $# -eq 2 ] && [ "$1" = "--out" ] || usage
	VIBE_PATCHES="$(_vibe_abs "$2")/patches"
	VIBE_OVERLAY="$(_vibe_abs "$2")/overlay"
fi

# A staged new file is neither a worktree diff nor untracked: it would silently vanish.
if ! git -C "$VIBE_CHECKOUT" diff --cached --quiet; then
	echo "error: $VIBE_CHECKOUT has staged changes; unstage them first (git reset -q)" >&2
	exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/patches" "$stage/overlay"
: > "$stage/patches/.gitkeep"
: > "$stage/overlay/.gitkeep"

# Every diff option that user git config could change is pinned here.
git -C "$VIBE_CHECKOUT" diff --name-only --no-renames -z |
while IFS= read -r -d '' path; do
	patch="$stage/patches/${path//\//__}.patch"
	if [ -e "$patch" ]; then
		echo "error: two paths map to $(basename "$patch")" >&2
		exit 1
	fi
	git -C "$VIBE_CHECKOUT" -c core.quotepath=false diff --no-color --no-ext-diff --no-textconv \
		--no-renames --binary --full-index --unified=3 --diff-algorithm=myers \
		--src-prefix=a/ --dst-prefix=b/ -- "$path" > "$patch"
	[ -s "$patch" ] || rm -f "$patch"
done

git -C "$VIBE_CHECKOUT" ls-files --others --exclude-standard -z |
while IFS= read -r -d '' path; do
	mkdir -p "$stage/overlay/$(dirname "$path")"
	cp -pPR "$VIBE_CHECKOUT/$path" "$stage/overlay/$path"
done

rm -rf "$VIBE_PATCHES" "$VIBE_OVERLAY"
mkdir -p "$(dirname "$VIBE_PATCHES")" "$(dirname "$VIBE_OVERLAY")"
mv "$stage/patches" "$VIBE_PATCHES"
mv "$stage/overlay" "$VIBE_OVERLAY"

patches=$(find "$VIBE_PATCHES" -type f -name '*.patch' | wc -l)
files=$(find "$VIBE_OVERLAY" \( -type f -o -type l \) ! -path "$VIBE_OVERLAY/.gitkeep" | wc -l)
echo "exported $((patches)) patches -> $VIBE_PATCHES, $((files)) overlay files -> $VIBE_OVERLAY"
