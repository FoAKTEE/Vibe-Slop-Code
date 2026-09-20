#!/usr/bin/env bash
# Checks on a linux tarball from package-linux.sh (VibeSlopCode-linux-<arch>-<version>.tar.gz).
# Read-only, on an unpacked scratch copy: one top-level directory, the rebranded product.json
# and its pinned commit, the launcher and the Electron binary, every native binary (ELF for
# <arch>, nothing built for another platform, none needing a glibc newer than the ceiling),
# and the three built-in extensions with the code and media their build produces.
# One `ok:` line per check (`note:` for what is worth knowing but no failure); the first
# failure says what was expected and exits non-zero.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

NAME_LONG="Vibe Slop Code"
GALLERY_SERVICE="https://open-vsx.org/vscode/gallery"
GALLERY_ITEM="https://open-vsx.org/vscode/item"
# The newest glibc that the app's own binaries may need. 2.28 (RHEL 8, Debian 10, Ubuntu
# 18.10) is what upstream builds its linux client against and enforces on its native modules
# (build/azure-pipelines/linux/steps/product-build-linux-compile.yml: EXPECTED_GLIBC_VERSION
# 2.28), and it is the floor of the Electron runtime that ships in the package, so nothing
# here may ask for more. Prebuilt helpers that upstream ships and that cannot be rebuilt here
# are named in a `note:` line instead: the app runs without them, their feature does not.
MAX_GLIBC="${VIBE_LINUX_MAX_GLIBC:-2.28}"
EXTENSIONS="vibe-chandra vibe-agents vibe-remote-ssh"

usage() { echo "usage: verify-linux.sh <tarball>" >&2; exit 2; }
die() { echo "verify-linux.sh: $*" >&2; exit 1; }

# json_str <file> <dotted.key>: a string out of a JSON file, empty when absent.
json_str() {
	python3 -c 'import functools, json, sys; print(functools.reduce(lambda d, k: d.get(k) if isinstance(d, dict) else None, sys.argv[2].split("."), json.load(open(sys.argv[1]))) or "")' "$1" "$2"
}

# check_product <dotted.key> <expected>
check_product() {
	local have
	have="$(json_str "$PRODUCT" "$1")"
	[ "$have" = "$2" ] || die "product.json $1 is '${have:-<unset>}', expected '$2'"
	echo "ok: product.json $1 = $have"
}

# version_le <a> <b>: dotted numbers, a <= b.
version_le() {
	local IFS=. i
	local a=($1) b=($2)
	for i in 0 1 2; do
		[ "${a[$i]:-0}" -lt "${b[$i]:-0}" ] && return 0
		[ "${a[$i]:-0}" -gt "${b[$i]:-0}" ] && return 1
	done
	return 0
}

format_name() {
	case "$1" in
		elf) echo "ELF" ;;
		macho) echo "Mach-O" ;;
		pe) echo "PE" ;;
		*) echo "$1" ;;
	esac
}

TARBALL=""
while [ $# -gt 0 ]; do
	case "$1" in
		-h|--help)
			echo "usage: verify-linux.sh <tarball>"
			exit 0
			;;
		-*)
			echo "verify-linux.sh: unknown argument: $1" >&2
			usage
			;;
		*)
			[ -z "$TARBALL" ] || usage
			TARBALL="$1"
			shift
			;;
	esac
done
[ -n "$TARBALL" ] || usage

command -v python3 > /dev/null || die "python3 is required"
[ -f "$TARBALL" ] || die "no tarball at $TARBALL - run scripts/package-linux.sh first"
NAME="$(basename "$TARBALL")"
ARCH="$(printf '%s\n' "$NAME" | sed -En 's/^VibeSlopCode-linux-(x64|arm64)-[0-9][0-9.]*\.tar\.gz$/\1/p')"
VERSION="$(printf '%s\n' "$NAME" | sed -En 's/^VibeSlopCode-linux-(x64|arm64)-([0-9][0-9.]*)\.tar\.gz$/\2/p')"
[ -n "$ARCH" ] || die "$NAME is not named VibeSlopCode-linux-<arch>-<version>.tar.gz, which is where the arch and the version to expect come from"
case "$ARCH" in
	x64) MACHINE="x86_64" ;;
	arm64) MACHINE="aarch64" ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/vibe-verify-linux.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# --- the archive ------------------------------------------------------------------ #
SHA="$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
if [ -f "$TARBALL.sha256" ]; then
	WANT_SHA="$(cut -d' ' -f1 "$TARBALL.sha256")"
	[ "$SHA" = "$WANT_SHA" ] || die "sha256 of $TARBALL is $SHA, but $NAME.sha256 says $WANT_SHA"
	echo "ok: tarball $NAME, sha256 $SHA matches $NAME.sha256"
else
	echo "ok: tarball $NAME, sha256 $SHA (no $NAME.sha256 to compare with)"
fi

tar -xzf "$TARBALL" -C "$WORK"
TOP="$(ls -A "$WORK")"
[ -n "$TOP" ] && [ "$(printf '%s\n' "$TOP" | wc -l)" -eq 1 ] && [ -d "$WORK/$TOP" ] \
	|| die "expected one top-level directory, found: $(printf '%s' "$TOP" | tr '\n' ' ')"
ROOT="$WORK/$TOP"
echo "ok: one top-level directory $TOP/"

# --- product.json -------------------------------------------------------------------- #
PRODUCT="$ROOT/resources/app/product.json"
[ -f "$PRODUCT" ] || die "missing resources/app/product.json in $TOP/ - not a packaged app"
check_product nameLong "$NAME_LONG"
check_product applicationName vibe
check_product extensionsGallery.serviceUrl "$GALLERY_SERVICE"
check_product extensionsGallery.itemUrl "$GALLERY_ITEM"
APPNAME="$(json_str "$PRODUCT" applicationName)"
COMMIT="$(json_str "$PRODUCT" commit)"
if [ -f "$VIBE_PIN" ]; then
	WANT_COMMIT="$(vibe_pin commit)"
	[ "$COMMIT" = "$WANT_COMMIT" ] || die "product.json commit is '${COMMIT:-<unset>}', but $VIBE_PIN pins '$WANT_COMMIT'"
	echo "ok: product.json commit = $COMMIT, the pinned one"
else
	echo "ok: product.json commit = ${COMMIT:-<unset>} (no $VIBE_PIN to compare with)"
fi
HAVE="$(json_str "$PRODUCT" version)"
[ -z "$VERSION" ] || [ "$HAVE" = "$VERSION" ] || die "product.json version is '${HAVE:-<unset>}', but $NAME says '$VERSION'"
echo "ok: product.json version = $HAVE"

# --- launcher and the Electron binary --------------------------------------------- #
SCAN="$(python3 "$VIBE_SCRIPTS/server/natives.py" scan "$ROOT")"
TAB="$(printf '\t')"
[ -f "$ROOT/bin/$APPNAME" ] || die "missing bin/$APPNAME in $TOP/, the command line launcher"
[ -x "$ROOT/bin/$APPNAME" ] || die "bin/$APPNAME is not executable"
[ -f "$ROOT/resources/app/package.json" ] || die "missing resources/app/package.json"
MAIN_KIND="$(printf '%s\n' "$SCAN" | awk -F'\t' -v p="$APPNAME" '$5 == p { print $1 " " $2 }')"
[ -n "$MAIN_KIND" ] || die "missing $APPNAME (or not a binary) in $TOP/ - the Electron executable"
[ "$MAIN_KIND" = "elf $MACHINE" ] || die "$APPNAME is a $(format_name "${MAIN_KIND% *}") ${MAIN_KIND#* } binary, expected ELF $MACHINE"
echo "ok: launcher bin/$APPNAME, $APPNAME is ELF $MACHINE"

# --- native binaries ------------------------------------------------------------------- #
NODE_FILES=0
NEWEST_GLIBC="0"
NEWEST_GLIBC_PATH=""
NEWEST_GLIBCXX="0"
HELPERS_ABOVE=""
while IFS="$TAB" read -r format machine glibc glibcxx path; do
	[ -n "$format" ] || continue
	[ "$format" != "macho" ] || die "Mach-O $machine binary in a linux app: $path"
	case "$path" in
		*.node)
			[ "$format $machine" = "elf $MACHINE" ] || die "$path is $(format_name "$format") $machine, expected ELF $MACHINE"
			NODE_FILES=$((NODE_FILES + 1))
			;;
	esac
	[ "$format $machine" = "elf $MACHINE" ] || continue
	case "$path" in
		"$APPNAME"|*.node) ;;
		*)
			if [ "$glibc" != "-" ] && ! version_le "$glibc" "$MAX_GLIBC"; then
				HELPERS_ABOVE="$HELPERS_ABOVE $path (glibc $glibc)"
			fi
			continue
			;;
	esac
	if [ "$glibc" != "-" ] && ! version_le "$glibc" "$NEWEST_GLIBC"; then
		NEWEST_GLIBC="$glibc"
		NEWEST_GLIBC_PATH="$path"
	fi
	if [ "$glibcxx" != "-" ] && ! version_le "$glibcxx" "$NEWEST_GLIBCXX"; then
		NEWEST_GLIBCXX="$glibcxx"
	fi
done <<EOF
$SCAN
EOF
UNPACKED="resources/app/node_modules.asar.unpacked"
for native in \
	"$UNPACKED/node-pty/build/Release/pty.node" \
	"$UNPACKED/@vscode/spdlog/build/Release/spdlog.node" \
	"$UNPACKED/@parcel/watcher/build/Release/watcher.node" \
	"$UNPACKED/@vscode/sqlite3/build/Release/vscode-sqlite3.node" \
	"$UNPACKED/native-keymap/build/Release/keymapping.node"; do
	printf '%s\n' "$SCAN" | awk -F'\t' -v p="$native" '$5 == p { found = 1 } END { exit !found }' \
		|| die "missing native binary $native"
done
echo "ok: $NODE_FILES native modules (*.node), all ELF $MACHINE; no Mach-O file; the required ones are there"

FOREIGN="$(python3 "$VIBE_SCRIPTS/server/natives.py" foreign "$ROOT" "$ARCH")"
[ -z "$FOREIGN" ] || die "packages of another platform in the app: $(printf '%s' "$FOREIGN" | tr '\n' ' ')"
echo "ok: no package whose os/cpu excludes linux/$ARCH"

version_le "$NEWEST_GLIBC" "$MAX_GLIBC" \
	|| die "$NEWEST_GLIBC_PATH needs glibc $NEWEST_GLIBC, newer than the ceiling $MAX_GLIBC (\$VIBE_LINUX_MAX_GLIBC) - build the natives against an older glibc"
echo "ok: newest glibc needed by $APPNAME and the native modules is $NEWEST_GLIBC ($NEWEST_GLIBC_PATH), ceiling $MAX_GLIBC; newest libstdc++ symbols GLIBCXX_$NEWEST_GLIBCXX"
[ -z "$HELPERS_ABOVE" ] || echo "note: shipped binaries, loaded or spawned on demand, that will not run on a host below their glibc (ceiling $MAX_GLIBC):$HELPERS_ABOVE"

# --- the built-in extensions ------------------------------------------------------------ #
for extension in $EXTENSIONS; do
	EXT="$ROOT/resources/app/extensions/$extension"
	[ -f "$EXT/package.json" ] || die "missing extensions/$extension/package.json - the built-in extension is not in the app"
	MAIN="$(json_str "$EXT/package.json" main)"
	[ -n "$MAIN" ] || die "extensions/$extension/package.json declares no \"main\""
	# `main` is resolved by node, so it is usually written without the .js suffix.
	MAIN_FILE=""
	for candidate in "$EXT/$MAIN" "$EXT/$MAIN.js" "$EXT/$MAIN/index.js"; do
		if [ -f "$candidate" ]; then
			MAIN_FILE="$candidate"
			break
		fi
	done
	[ -n "$MAIN_FILE" ] || die "extensions/$extension: \"main\" is '$MAIN', which resolves to no file under dist/ - the extension was never bundled"
	MEDIA=""
	if [ "$extension" != "vibe-remote-ssh" ]; then
		[ -d "$EXT/media" ] || die "extensions/$extension has no media/ folder - the webview assets were never built"
		MEDIA="$(ls -A "$EXT/media" | wc -l | tr -d ' ')"
		[ "$MEDIA" -gt 0 ] || die "extensions/$extension has no media/ files - the webview assets were never built"
		MEDIA=", $MEDIA media files"
	fi
	echo "ok: extension $extension (main $MAIN -> ${MAIN_FILE#$EXT/}$MEDIA)"
done
