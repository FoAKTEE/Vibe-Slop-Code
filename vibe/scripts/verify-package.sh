#!/usr/bin/env bash
# Read-only checks on a packaged app ($VIBE_APP, else vibe/VSCode-darwin-<arch>/): bundle
# identity, the rebranded product.json, the built-in vibe-chandra extension, and the
# bundled CLI's --version against the checkout's version and the upstream pin. One `ok:`
# line per check; the first failure says what was expected and exits non-zero.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

APP_NAME="Vibe Studio Code.app"

[ $# -eq 0 ] || { echo "usage: verify-package.sh   (the app comes from \$VIBE_APP)" >&2; exit 2; }

die() { echo "verify-package.sh: $*" >&2; exit 1; }

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

command -v python3 > /dev/null || die "python3 is required to read the bundled JSON"

# --- the bundle ------------------------------------------------------------- #
APP="${VIBE_APP:-}"
if [ -z "$APP" ]; then
	case "$(uname -m)" in
		arm64|aarch64) APP="$VIBE_ROOT/VSCode-darwin-arm64/$APP_NAME" ;;
		x86_64|amd64) APP="$VIBE_ROOT/VSCode-darwin-x64/$APP_NAME" ;;
		*) die "unknown machine $(uname -m) — point \$VIBE_APP at the bundle" ;;
	esac
fi
[ -d "$APP" ] || die "no app bundle at $APP — run scripts/package.sh first (or set \$VIBE_APP)"
RES="$APP/Contents/Resources/app"
[ -d "$RES" ] || die "$APP has no Contents/Resources/app — not a packaged bundle"
echo "ok: bundle $APP"

# --- bundle identity -------------------------------------------------------- #
PLIST="$APP/Contents/Info.plist"
[ -f "$PLIST" ] || die "missing $PLIST"
IDENTIFIER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST" 2> /dev/null || true)"
[ "$IDENTIFIER" = "dev.chandra.vibe" ] || die "CFBundleIdentifier is '${IDENTIFIER:-<unset>}', expected 'dev.chandra.vibe'"
echo "ok: identifier $IDENTIFIER"

# --- branding --------------------------------------------------------------- #
PRODUCT="$RES/product.json"
[ -f "$PRODUCT" ] || die "missing $PRODUCT"
check_product nameLong "Vibe Studio Code"
check_product applicationName "vibe"
check_product extensionsGallery.serviceUrl "https://open-vsx.org/vscode/gallery"
check_product extensionsGallery.itemUrl "https://open-vsx.org/vscode/item"

# --- the built-in extension ------------------------------------------------- #
EXT="$RES/extensions/vibe-chandra"
[ -f "$EXT/package.json" ] || die "missing $EXT/package.json — the built-in extension is not in the bundle"
MAIN="$(json_str "$EXT/package.json" main)"
[ -n "$MAIN" ] || die "$EXT/package.json declares no \"main\""
# `main` is resolved by node, so it is usually written without the .js suffix.
MAIN_FILE=""
for candidate in "$EXT/$MAIN" "$EXT/$MAIN.js" "$EXT/$MAIN/index.js"; do
	if [ -f "$candidate" ]; then
		MAIN_FILE="$candidate"
		break
	fi
done
[ -n "$MAIN_FILE" ] || die "$EXT/package.json \"main\" is '$MAIN', which resolves to no file under $EXT (tried it as-is, +.js and /index.js)"
for asset in media/graph.js media/graph.css; do
	[ -f "$EXT/$asset" ] || die "missing $EXT/$asset"
done
echo "ok: extension vibe-chandra (main $MAIN -> ${MAIN_FILE#$EXT/}, media/graph.js, media/graph.css)"

# --- the bundled CLI -------------------------------------------------------- #
# Upstream's darwin task renames code.sh to the fixed name bin/code; try the branded
# name first in case that ever changes.
APP_CLI=""
for candidate in "$RES/bin/$(json_str "$PRODUCT" applicationName)" "$RES/bin/code"; do
	if [ -x "$candidate" ]; then
		APP_CLI="$candidate"
		break
	fi
done
[ -n "$APP_CLI" ] || die "no executable CLI in $RES/bin"

if ! CLI_OUT="$("$APP_CLI" --version)"; then
	die "$APP_CLI --version failed"
fi
CLI_VERSION="$(printf '%s\n' "$CLI_OUT" | sed -n '1p')"
CLI_COMMIT="$(printf '%s\n' "$CLI_OUT" | sed -n '2p')"

if [ -f "$VIBE_CHECKOUT/package.json" ]; then
	VERSION_SRC="$VIBE_CHECKOUT/package.json"
else
	VERSION_SRC="$RES/package.json"
fi
WANT_VERSION="$(json_str "$VERSION_SRC" version)"
[ "$CLI_VERSION" = "$WANT_VERSION" ] || die "bundled CLI reports version '$CLI_VERSION', but $VERSION_SRC says '$WANT_VERSION'"

# The second line is product.json's `commit`. Upstream stamps it from the checkout's git
# HEAD (build/lib/getVersion), so it is not a build id: a fork build carries the pinned
# upstream commit, because the checkout is never committed to.
PRODUCT_COMMIT="$(json_str "$PRODUCT" commit)"
[ "$CLI_COMMIT" = "$PRODUCT_COMMIT" ] || die "bundled CLI reports commit '$CLI_COMMIT', but $PRODUCT says '$PRODUCT_COMMIT'"
echo "ok: cli $APP_CLI -> $CLI_VERSION / $CLI_COMMIT"

if [ -f "$VIBE_PIN" ]; then
	WANT_COMMIT="$(vibe_pin commit)"
	[ "$CLI_COMMIT" = "$WANT_COMMIT" ] || die "the bundle carries commit '$CLI_COMMIT', but $VIBE_PIN pins '$WANT_COMMIT'"
	echo "ok: commit is the pinned $WANT_COMMIT"
fi
