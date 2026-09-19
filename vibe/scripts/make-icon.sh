#!/usr/bin/env bash
# Render the app icon from the SVGs in branding/ into the files upstream ships, at their
# checkout paths: icon.svg (48 px and up) and icon-small.svg (32 px and down) become the
# .icns, the .ico files and the .png files; icon-small.svg becomes the in-workbench app
# icon and mark.svg the four editor watermarks. Everything is rendered into a temp dir
# first and the same inputs give the same bytes, so --check re-renders and compares
# without writing (exit 1 and one "stale:" line per file that differs). --out DIR
# targets DIR instead of the checkout; $VIBE_BRANDING overrides the source directory.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

VIBE_BRANDING="$(_vibe_abs "${VIBE_BRANDING:-$VIBE_ROOT/branding}")"
MEDIA="src/vs/workbench/browser"
TARGETS=(
	resources/darwin/code.icns
	resources/linux/code.png
	resources/server/code-192.png
	resources/server/code-512.png
	resources/server/favicon.ico
	resources/win32/code.ico
	resources/win32/code_150x150.png
	resources/win32/code_70x70.png
	"$MEDIA/media/code-icon.svg"
	"$MEDIA/parts/editor/media/letterpress-dark.svg"
	"$MEDIA/parts/editor/media/letterpress-hcDark.svg"
	"$MEDIA/parts/editor/media/letterpress-hcLight.svg"
	"$MEDIA/parts/editor/media/letterpress-light.svg"
)

usage() { echo "usage: make-icon.sh [--check] [--out DIR]" >&2; exit 2; }

check=0
dest="$VIBE_CHECKOUT"
while [ $# -gt 0 ]; do
	case "$1" in
		--check) check=1; shift ;;
		--out) [ $# -ge 2 ] || usage; dest="$(_vibe_abs "$2")"; shift 2 ;;
		*) usage ;;
	esac
done

for tool in rsvg-convert magick iconutil; do
	if ! command -v "$tool" > /dev/null; then
		echo "error: $tool not found (needs rsvg-convert, ImageMagick 7 and macOS iconutil)" >&2
		exit 1
	fi
done
for svg in icon.svg icon-small.svg mark.svg; do
	if [ ! -f "$VIBE_BRANDING/$svg" ]; then
		echo "error: $VIBE_BRANDING/$svg is missing" >&2
		exit 1
	fi
done
if [ "$dest" = "$VIBE_CHECKOUT" ] && [ ! -d "$VIBE_CHECKOUT/resources" ]; then
	echo "error: no checkout at $VIBE_CHECKOUT (run bootstrap.sh, or pass --out DIR)" >&2
	exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
out="$tmp/render"

# The master sits on the macOS grid: an 824 px tile with 100 px of air on a 1024 px
# canvas. Everywhere else the tile gets the 87.5 % of the canvas the small variant has.
MAC_BOX='viewBox="0 0 1024 1024"'
WIDE_BOX='viewBox="41 41 942 942"'
if ! grep -q "$MAC_BOX" "$VIBE_BRANDING/icon.svg"; then
	echo "error: $VIBE_BRANDING/icon.svg must carry $MAC_BOX" >&2
	exit 1
fi
sed "s/$MAC_BOX/$WIDE_BOX/" "$VIBE_BRANDING/icon.svg" > "$tmp/icon-wide.svg"

# png <mac|wide> <size> <file>: one square PNG holding pixels only (rsvg-convert adds a
# bKGD chunk, ImageMagick would add dates). 32 px and down come from the small variant.
png() {
	local src="$VIBE_BRANDING/icon-small.svg"
	if [ "$2" -gt 32 ]; then
		src="$VIBE_BRANDING/icon.svg"
		[ "$1" = mac ] || src="$tmp/icon-wide.svg"
	fi
	mkdir -p "$(dirname "$3")"
	rsvg-convert -w "$2" -h "$2" "$src" |
		magick png:- -strip -define png:exclude-chunks=all -define png:color-type=6 \
			-define png:bit-depth=8 -define png:compression-level=9 "png:$3"
}

# ico <file> <size>...
ico() {
	local file="$1" size parts=()
	shift
	for size in "$@"; do
		png wide "$size" "$tmp/ico/$size.png"
		parts+=("$tmp/ico/$size.png")
	done
	mkdir -p "$(dirname "$file")"
	magick "${parts[@]}" "ico:$file"
}

# letterpress <theme> <colour> [opacity]: the watermark is a CSS background, which has
# no text colour to inherit, so currentColor is replaced the way upstream paints it.
letterpress() {
	local file="$out/$MEDIA/parts/editor/media/letterpress-$1.svg" attr=""
	[ -z "${3:-}" ] || attr=" opacity=\"$3\""
	mkdir -p "$(dirname "$file")"
	sed -e "s/currentColor/$2/g" -e "s/<svg /<svg$attr /" "$VIBE_BRANDING/mark.svg" > "$file"
}

iconset="$tmp/code.iconset"
for pt in 16 32 128 256 512; do
	png mac "$pt" "$iconset/icon_${pt}x${pt}.png"
	png mac "$((pt * 2))" "$iconset/icon_${pt}x${pt}@2x.png"
done
mkdir -p "$out/resources/darwin"
iconutil -c icns -o "$out/resources/darwin/code.icns" "$iconset"

png wide 1024 "$out/resources/linux/code.png"
png wide 192 "$out/resources/server/code-192.png"
png wide 512 "$out/resources/server/code-512.png"
png wide 150 "$out/resources/win32/code_150x150.png"
png wide 70 "$out/resources/win32/code_70x70.png"
ico "$out/resources/server/favicon.ico" 16 24 32 48 64
ico "$out/resources/win32/code.ico" 16 24 32 48 64 128 256

mkdir -p "$out/$MEDIA/media"
cp "$VIBE_BRANDING/icon-small.svg" "$out/$MEDIA/media/code-icon.svg"
letterpress dark '#000000' 0.3
letterpress light '#000000' 0.1
letterpress hcDark '#3C3C3C'
letterpress hcLight '#D9D9D9'

if [ "$check" = 1 ]; then
	rc=0
	for target in "${TARGETS[@]}"; do
		if ! cmp -s "$out/$target" "$dest/$target"; then
			echo "stale: $dest/$target" >&2
			rc=1
		fi
	done
	if [ "$rc" = 0 ]; then
		echo "check: ${#TARGETS[@]} icon files in $dest match $VIBE_BRANDING"
	else
		echo "check: $dest is not what $VIBE_BRANDING renders to (run make-icon.sh)" >&2
	fi
	exit "$rc"
fi

for target in "${TARGETS[@]}"; do
	mkdir -p "$(dirname "$dest/$target")"
	cp "$out/$target" "$dest/$target"
done
echo "rendered ${#TARGETS[@]} icon files -> $dest"
