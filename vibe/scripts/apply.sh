#!/usr/bin/env bash
# Rebuild the fork inside the checkout: verify the upstream pin, require a pristine
# checkout, then apply patches/*.patch and copy overlay/ in. --force first discards
# local changes (tracked edits and non-ignored untracked files); ignored content such
# as node_modules/ and out/ always survives. All patches are validated before any is
# applied, so a conflict leaves the checkout untouched.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
LC_ALL=C
export LC_ALL

usage() { echo "usage: apply.sh [--force]" >&2; exit 2; }

force=0
if [ $# -gt 0 ]; then
	[ $# -eq 1 ] && [ "$1" = "--force" ] || usage
	force=1
fi

vibe_check_pin

changes="$(vibe_checkout_changes)"
if [ -n "$changes" ]; then
	if [ "$force" = 0 ]; then
		{
			echo "error: $VIBE_CHECKOUT has local changes:"
			printf '%s\n' "$changes" | sed -n '1,20p'
			echo "Save them with export.sh, or discard them with: apply.sh --force"
		} >&2
		exit 1
	fi
	git -C "$VIBE_CHECKOUT" reset -q --hard HEAD
	git -C "$VIBE_CHECKOUT" clean -fdq
fi

patches=0
failed=""
for patch in "$VIBE_PATCHES"/*.patch; do
	[ -e "$patch" ] || continue
	patches=$((patches + 1))
	git -C "$VIBE_CHECKOUT" apply --check --whitespace=nowarn "$patch" || failed="$failed $(basename "$patch")"
done
if [ -n "$failed" ]; then
	echo "error: patches do not apply to $VIBE_CHECKOUT (nothing was changed):$failed" >&2
	exit 1
fi
for patch in "$VIBE_PATCHES"/*.patch; do
	[ -e "$patch" ] || continue
	git -C "$VIBE_CHECKOUT" apply --whitespace=nowarn "$patch"
done

files=0
if [ -d "$VIBE_OVERLAY" ]; then
	while IFS= read -r -d '' path; do
		mkdir -p "$VIBE_CHECKOUT/$(dirname "$path")"
		cp -pPR "$VIBE_OVERLAY/$path" "$VIBE_CHECKOUT/$path"
		files=$((files + 1))
	done < <(cd "$VIBE_OVERLAY" && find . \( -type f -o -type l \) ! -path ./.gitkeep -print0)
fi

echo "applied $patches patches, copied $files overlay files -> $VIBE_CHECKOUT"
