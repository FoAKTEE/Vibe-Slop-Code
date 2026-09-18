#!/usr/bin/env bash
# Package the checkout into a distributable app: maps the host (or --arch) to upstream's
# gulp task `vscode-<platform>-<arch>[-min]` and runs it. Upstream hard-codes the output
# folder next to the checkout, so the app lands in vibe/VSCode-<platform>-<arch>/ (a
# gitignored 1.4 GB tree). --print-task prints the task and exits without building.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

usage() { echo "usage: package.sh [--arch arm64|x64] [--min] [--print-task]" >&2; exit 2; }
die() { echo "package.sh: $*" >&2; exit 1; }

ARCH=""
MIN=""
PRINT_TASK=0
while [ $# -gt 0 ]; do
	case "$1" in
		--arch)
			[ $# -ge 2 ] || usage
			ARCH="$2"
			shift 2
			;;
		--min) MIN="-min"; shift ;;
		--print-task) PRINT_TASK=1; shift ;;
		-h|--help)
			echo "usage: package.sh [--arch arm64|x64] [--min] [--print-task]"
			exit 0
			;;
		*)
			echo "package.sh: unknown argument: $1" >&2
			usage
			;;
	esac
done

# Host detection, overridable so the mapping can be exercised for another platform.
UNAME_S="${VIBE_UNAME_S:-$(uname -s)}"
UNAME_M="${VIBE_UNAME_M:-$(uname -m)}"
case "$UNAME_S" in
	Darwin) PLATFORM="darwin" ;;
	Linux) PLATFORM="linux" ;;
	CYGWIN*|MINGW*|MSYS*) PLATFORM="win32" ;;
	*) die "unsupported platform: $UNAME_S" ;;
esac
if [ -z "$ARCH" ]; then
	case "$UNAME_M" in
		arm64|aarch64) ARCH="arm64" ;;
		x86_64|amd64) ARCH="x64" ;;
		*) die "unsupported machine: $UNAME_M — pass --arch arm64|x64" ;;
	esac
fi
case "$ARCH" in
	arm64|x64) ;;
	*) echo "package.sh: unknown arch: $ARCH" >&2; usage ;;
esac

TASK="vscode-$PLATFORM-$ARCH$MIN"
if [ "$PRINT_TASK" -eq 1 ]; then
	echo "$TASK"
	exit 0
fi

[ -f "$VIBE_CHECKOUT/package.json" ] || die "no checkout at $VIBE_CHECKOUT — run scripts/bootstrap.sh first"
[ -d "$VIBE_CHECKOUT/node_modules" ] || die "$VIBE_CHECKOUT/node_modules is missing — run scripts/bootstrap.sh first"

OUT="$(dirname "$VIBE_CHECKOUT")/VSCode-$PLATFORM-$ARCH"
NAME_LONG="$(sed -n 's/^[[:space:]]*"nameLong"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/p' "$VIBE_CHECKOUT/product.json")"
case "$PLATFORM" in
	darwin) APP="$OUT/$NAME_LONG.app" ;;
	*) APP="$OUT" ;;
esac

echo "package.sh: npm run gulp $TASK (minutes, not seconds)"
cd "$VIBE_CHECKOUT"
npm run gulp "$TASK"

[ -e "$APP" ] || die "$TASK finished but $APP is missing"
echo "app: $APP"
"$VIBE_ROOT/bin/vibe" --vibe-which || true
