#!/usr/bin/env bash
# Package the checkout into a distributable linux app and pack it as
# .build/dist/VibeSlopCode-linux-<arch>-<version>.tar.gz (+ .sha256), one top-level
# directory holding upstream's own linux layout (the `vibe` binary, bin/vibe, resources/app).
# Upstream's gulp task vscode-linux-<arch> does the packaging, on this host: everything it
# does for the target is either pure JavaScript (asar, renames, inlined metadata) or a
# download (@vscode/gulp-electron fetches the linux-<arch> Electron).
# The one thing that cannot come from this host is node_modules, whose natives are built for
# this Mac, so the app's production dependencies are npm-installed in a linux container
# (scripts/linux/) into .build/linux/<target>/app and handed to gulp through
# VIBE_DESKTOP_ROOT - the one `// vibe:` edit in build/gulpfile.vscode.ts, the same seam the
# server build uses. What the built-in extensions drag in from this host is dropped afterwards.
# --package-only runs the -ci task alone, reusing out-vscode/ and .build/extensions/ of an
# earlier run; --print-plan prints the steps and runs nothing.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

usage() { echo "usage: package-linux.sh [--arch x64|arm64] [--package-only] [--print-plan]" >&2; exit 2; }
die() { echo "package-linux.sh: $*" >&2; exit 1; }
step() { echo "package-linux.sh: [$1] $2"; }

# json_str <file> <key>: a top-level string out of a JSON file, empty when absent.
json_str() {
	python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")' "$1" "$2"
}

ARCH="x64"
PACKAGE_ONLY=0
PRINT_PLAN=0
while [ $# -gt 0 ]; do
	case "$1" in
		--arch)
			[ $# -ge 2 ] || usage
			ARCH="$2"
			shift 2
			;;
		--package-only) PACKAGE_ONLY=1; shift ;;
		--print-plan) PRINT_PLAN=1; shift ;;
		-h|--help)
			echo "usage: package-linux.sh [--arch x64|arm64] [--package-only] [--print-plan]"
			exit 0
			;;
		*)
			echo "package-linux.sh: unknown argument: $1" >&2
			usage
			;;
	esac
done
case "$ARCH" in
	x64) DOCKER_PLATFORM="linux/amd64"; MACHINE="x86_64" ;;
	arm64) DOCKER_PLATFORM="linux/arm64"; MACHINE="aarch64" ;;
	*) echo "package-linux.sh: unknown arch: $ARCH" >&2; usage ;;
esac

TARGET="linux-$ARCH"
TASK="vscode-$TARGET"
[ "$PACKAGE_ONLY" -eq 0 ] || TASK="$TASK-ci"
HELPERS="$VIBE_SCRIPTS/linux"
IMAGE="vibe-linux-build:$TARGET"
BUILD="$VIBE_ROOT/.build/linux"
APP="$BUILD/$ARCH/app"
DIST="$VIBE_ROOT/.build/dist"
OUT="$(dirname "$VIBE_CHECKOUT")/VSCode-$TARGET"

VERSION="$(json_str "$VIBE_CHECKOUT/package.json" version 2> /dev/null || true)"
NODE_VERSION="$(sed -n 1p "$VIBE_CHECKOUT/.nvmrc" 2> /dev/null || true)"
TOP="VibeSlopCode-$TARGET-${VERSION:-<version>}"
TARBALL="$DIST/$TOP.tar.gz"

if [ "$PRINT_PLAN" -eq 1 ]; then
	cat <<-EOF
	plan: Vibe Slop Code for $TARGET, version ${VERSION:-<version>}
	1. image    docker build --platform $DOCKER_PLATFORM --build-arg NODE_VERSION=${NODE_VERSION:-<node>} --build-arg NODE_ARCH=$ARCH -t $IMAGE $HELPERS
	2. modules  docker run --rm --platform $DOCKER_PLATFORM -v $APP:/app -v $BUILD/cache:/cache -v $HELPERS:/scripts:ro $IMAGE bash /scripts/npm-ci.sh
	            (skipped while package-lock.json, .npmrc and scripts/linux/ are unchanged)
	3. package  cd $VIBE_CHECKOUT && VIBE_DESKTOP_ROOT=$APP npm run gulp $TASK
	            -> $OUT
	EOF
	if [ "$PACKAGE_ONLY" -eq 1 ]; then
		echo "            (--package-only: reuse $VIBE_CHECKOUT/out-vscode and .build/extensions)"
	fi
	cat <<-EOF
	4. natives  drop the binaries and packages of other platforms that the built-in extensions bring along
	5. tarball  $TARBALL (+ .sha256), one top-level directory $TOP/
	next: $VIBE_SCRIPTS/verify-linux.sh $TARBALL
	EOF
	exit 0
fi

# --- refusals: everything that can be known before work starts ------------------ #
[ -f "$VIBE_CHECKOUT/package.json" ] || die "no checkout at $VIBE_CHECKOUT - run scripts/bootstrap.sh first"
[ -d "$VIBE_CHECKOUT/node_modules" ] || die "$VIBE_CHECKOUT/node_modules is missing - run scripts/bootstrap.sh first"
[ -n "$VERSION" ] || die "cannot read the product version from $VIBE_CHECKOUT/package.json"
[ -n "$NODE_VERSION" ] || die "cannot read the Node version from $VIBE_CHECKOUT/.nvmrc"
grep -q "VIBE_DESKTOP_ROOT" "$VIBE_CHECKOUT/build/gulpfile.vscode.ts" \
	|| die "build/gulpfile.vscode.ts does not honour VIBE_DESKTOP_ROOT, so gulp would pack this host's node_modules - run scripts/apply.sh"
command -v python3 > /dev/null || die "python3 is required"
command -v docker > /dev/null || die "docker is not on PATH - the linux native modules are built in a container"
docker info > /dev/null 2>&1 || die "Docker is not running - start Docker Desktop (the linux native modules are built in a container)"

START="$(date +%s)"
mkdir -p "$APP" "$BUILD/cache" "$DIST"

# --- 1. image ------------------------------------------------------------------- #
step image "$IMAGE ($DOCKER_PLATFORM, Node $NODE_VERSION)"
docker build --platform "$DOCKER_PLATFORM" --build-arg "NODE_VERSION=$NODE_VERSION" --build-arg "NODE_ARCH=$ARCH" \
	-t "$IMAGE" "$HELPERS"

# --- 2. node_modules for the target ---------------------------------------------- #
STAMP="$(cat "$VIBE_CHECKOUT/package.json" "$VIBE_CHECKOUT/package-lock.json" "$VIBE_CHECKOUT/.npmrc" \
	"$VIBE_CHECKOUT/.nvmrc" "$HELPERS/Dockerfile" "$HELPERS/npm-ci.sh" | shasum -a 256 | cut -d' ' -f1)"
if [ -d "$APP/node_modules" ] && [ "$(cat "$APP/.stamp" 2> /dev/null || true)" = "$STAMP" ]; then
	step modules "up to date in $APP"
else
	step modules "npm ci in the container -> $APP (tens of minutes under emulation)"
	rm -f "$APP/.stamp"
	# What `npm ci` and upstream's own preinstall read: the root manifests, and build/npm,
	# which downloads the Electron headers and overlays the custom ones on top of them.
	rm -rf "$APP/build" "$APP/remote"
	mkdir -p "$APP/build" "$APP/remote"
	cp "$VIBE_CHECKOUT/package.json" "$VIBE_CHECKOUT/package-lock.json" "$VIBE_CHECKOUT/.npmrc" \
		"$VIBE_CHECKOUT/.nvmrc" "$APP/"
	cp "$VIBE_CHECKOUT/remote/.npmrc" "$APP/remote/"
	cp -R "$VIBE_CHECKOUT/build/npm" "$APP/build/npm"
	rm -rf "$APP/build/npm/gyp/node_modules"
	docker run --rm --platform "$DOCKER_PLATFORM" -v "$APP":/app -v "$BUILD/cache":/cache -v "$HELPERS":/scripts:ro \
		"$IMAGE" bash /scripts/npm-ci.sh
	echo "$STAMP" > "$APP/.stamp"
fi

# --- 3. upstream's own packaging task --------------------------------------------- #
if [ "$PACKAGE_ONLY" -eq 1 ]; then
	[ -f "$VIBE_CHECKOUT/out-vscode/main.js" ] && [ -d "$VIBE_CHECKOUT/.build/extensions" ] \
		|| die "--package-only needs the bundle and extensions of an earlier full run in $VIBE_CHECKOUT (out-vscode/, .build/extensions/)"
fi
step package "npm run gulp $TASK (minutes, not seconds)"
(cd "$VIBE_CHECKOUT" && VIBE_DESKTOP_ROOT="$APP" npm run gulp "$TASK")
[ -x "$OUT/bin/vibe" ] || die "$TASK finished but $OUT/bin/vibe is missing"

# --- 4. binaries of other platforms ---------------------------------------------------- #
# The built-in extensions bring their own node_modules from the checkout, i.e. installed on
# this host, and some packages ship prebuilds for every platform. None of that can load on
# the target, so it goes. The app's own node_modules are not affected: they come from the
# container through VIBE_DESKTOP_ROOT.
step natives "$OUT"
python3 "$VIBE_SCRIPTS/server/natives.py" foreign "$OUT" "$ARCH" | while IFS= read -r package; do
	rm -rf "$OUT/$package"
	echo "dropped: $package (package of another platform)"
done
python3 "$VIBE_SCRIPTS/server/natives.py" scan "$OUT" | while IFS="$(printf '\t')" read -r format machine _ _ path; do
	case "$format:$machine:$path" in
		macho:*) ;;
		elf:"$MACHINE":*) continue ;;
		*.node) ;;
		*) continue ;;
	esac
	rm -f "$OUT/$path"
	echo "dropped: $path ($format $machine)"
done

# --- 5. tarball ---------------------------------------------------------------------- #
# Upstream hard-codes the folder name next to the checkout; the archive carries the name of
# the download instead, so `tar xzf` leaves a directory that says which build it is. The
# rename is two moves on one filesystem, and the tree ends up where upstream put it again.
step tarball "$TARBALL"
STAGE="$BUILD/$ARCH/stage"
rm -rf "$STAGE" "$DIST"/VibeSlopCode-"$TARGET"-*.tar.gz "$DIST"/VibeSlopCode-"$TARGET"-*.tar.gz.sha256
mkdir -p "$STAGE"
mv "$OUT" "$STAGE/$TOP"
# No AppleDouble files, no extended attributes: the archive is unpacked by GNU tar.
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TARBALL" -C "$STAGE" "$TOP"
mv "$STAGE/$TOP" "$OUT"
rmdir "$STAGE"
(cd "$DIST" && shasum -a 256 "$(basename "$TARBALL")" > "$TARBALL.sha256")

echo "tarball: $TARBALL ($(du -h "$TARBALL" | cut -f1), unpacked $(du -sh "$OUT" | cut -f1), $(( ($(date +%s) - START) / 60 )) min)"
echo "sha256: $(cut -d' ' -f1 "$TARBALL.sha256")"
echo "next: $VIBE_SCRIPTS/verify-linux.sh $TARBALL"
