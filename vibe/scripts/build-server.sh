#!/usr/bin/env bash
# Build the remote server (vibe-server) for linux-<arch> and pack it as
# vibe/.build/server/vibe-server-linux-<arch>-<commit>.tar.gz (+ .sha256), one top-level
# directory, which is what the SSH resolver unpacks into ~/.vibe-server/bin/<commit>/.
# The JS comes from upstream's esbuild bundler (build/next, target server), the way the
# desktop package is built at this pin, and upstream's gulp task vscode-reh-linux-<arch>-ci
# assembles it with the target's Node. The top-level task vscode-reh-linux-<arch> is NOT
# used: it still starts the legacy mangling compile, which no longer compiles.
# node_modules cannot come from the checkout, whose natives are built for this host, so
# they are npm-installed in a linux container (scripts/server/) into .build/server/ and
# handed to gulp through VIBE_REH_REMOTE. <commit> is the one upstream stamps (git HEAD of
# the checkout): a client only talks to a server that carries its own.
# The tarball is finally linked into $VIBE_SERVERS_DIR (~/.vibe/servers), where an app that
# does not sit in this build tree - one copied to /Applications - looks for it.
# --package-only reuses the previous bundle and extensions, e.g. for the second arch;
# --no-link skips the link step, --link-only is that step alone for a tarball already
# built (no Docker needed); --print-plan prints the steps and runs nothing.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

usage() { echo "usage: build-server.sh [--arch x64|arm64] [--package-only] [--no-link|--link-only] [--print-plan]" >&2; exit 2; }
die() { echo "build-server.sh: $*" >&2; exit 1; }
step() { echo "build-server.sh: [$1] $2"; }

# json_str <file> <key>: a top-level string out of a JSON file, empty when absent.
json_str() {
	python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")' "$1" "$2"
}

ARCH="x64"
PACKAGE_ONLY=0
PRINT_PLAN=0
LINK=1
LINK_ONLY=0
while [ $# -gt 0 ]; do
	case "$1" in
		--arch)
			[ $# -ge 2 ] || usage
			ARCH="$2"
			shift 2
			;;
		--package-only) PACKAGE_ONLY=1; shift ;;
		--no-link) LINK=0; shift ;;
		--link-only) LINK_ONLY=1; shift ;;
		--print-plan) PRINT_PLAN=1; shift ;;
		-h|--help)
			echo "usage: build-server.sh [--arch x64|arm64] [--package-only] [--no-link|--link-only] [--print-plan]"
			exit 0
			;;
		*)
			echo "build-server.sh: unknown argument: $1" >&2
			usage
			;;
	esac
done
if [ "$LINK_ONLY" -eq 1 ] && [ "$LINK" -eq 0 ]; then
	echo "build-server.sh: --link-only and --no-link contradict each other" >&2
	usage
fi
case "$ARCH" in
	x64) DOCKER_PLATFORM="linux/amd64"; MACHINE="x86_64" ;;
	arm64) DOCKER_PLATFORM="linux/arm64"; MACHINE="aarch64" ;;
	*) echo "build-server.sh: unknown arch: $ARCH" >&2; usage ;;
esac

TARGET="linux-$ARCH"
TASK="vscode-reh-$TARGET-ci"
EXTENSION_TASKS="compile-non-native-extensions-build compile-copilot-extension-build compile-extension-media-build"
BUNDLE="node build/next/index.ts bundle --nls --target server --out out-vscode-reh"
HELPERS="$VIBE_SCRIPTS/server"
IMAGE="vibe-server-build:$TARGET"
BUILD="$VIBE_ROOT/.build/server"
REMOTE="$BUILD/$TARGET/remote"
OUT="$(dirname "$VIBE_CHECKOUT")/vscode-reh-$TARGET"

# The commit upstream stamps into product.json (build/lib/getVersion.ts): the checkout's
# own HEAD, never that of a repository the checkout merely sits in.
COMMIT="${BUILD_SOURCEVERSION:-}"
if ! printf '%s' "$COMMIT" | grep -Eq '^[0-9a-f]{40}$'; then
	COMMIT=""
	if [ -e "$VIBE_CHECKOUT/.git" ]; then
		COMMIT="$(git -C "$VIBE_CHECKOUT" rev-parse HEAD 2> /dev/null || true)"
	fi
fi
NODE_VERSION="$(sed -n 's/^target="\(.*\)"$/\1/p' "$VIBE_CHECKOUT/remote/.npmrc" 2> /dev/null || true)"
TARBALL="$BUILD/vibe-server-$TARGET-${COMMIT:-<commit>}.tar.gz"
SERVERS_DIR="${VIBE_SERVERS_DIR:-$HOME/.vibe/servers}"

# Makes the tarball findable by an app outside this build tree: the SSH resolver searches
# $SERVERS_DIR, and a bundle in /Applications has nowhere else to look. Only our own links
# and dangling ones are replaced; anything else of that name is left where it is.
link_into_servers() {
	local src name dest have
	mkdir -p "$SERVERS_DIR"
	for src in "$TARBALL" "$TARBALL.sha256"; do
		name="$(basename "$src")"
		dest="$SERVERS_DIR/$name"
		if [ -L "$dest" ]; then
			have="$(readlink "$dest")"
			case "$have" in
				"$BUILD"/*) ;;
				*)
					if [ -e "$dest" ]; then
						echo "build-server.sh: $dest points at $have - left alone, link $src by hand" >&2
						continue
					fi
					;;
			esac
			rm -f "$dest"
		elif [ -e "$dest" ]; then
			echo "build-server.sh: $dest is a file of its own - left alone, link $src by hand" >&2
			continue
		fi
		ln -s "$src" "$dest"
		echo "linked: $dest -> $src"
	done
}

if [ "$PRINT_PLAN" -eq 1 ]; then
	cat <<-EOF
	plan: vibe-server for $TARGET, commit ${COMMIT:-<commit>}
	1. image    docker build --platform $DOCKER_PLATFORM --build-arg NODE_VERSION=${NODE_VERSION:-<node>} --build-arg NODE_ARCH=$ARCH -t $IMAGE $HELPERS
	2. modules  docker run --rm --platform $DOCKER_PLATFORM -v $REMOTE:/remote -v $BUILD/cache:/cache -v $HELPERS:/scripts:ro $IMAGE bash /scripts/npm-ci.sh
	            (skipped while remote/package-lock.json, remote/.npmrc and scripts/server/ are unchanged)
	EOF
	if [ "$PACKAGE_ONLY" -eq 0 ]; then
		cat <<-EOF
		3. bundle   cd $VIBE_CHECKOUT && rm -rf .build/extensions && npm run gulp $EXTENSION_TASKS
		            $BUNDLE
		EOF
	else
		echo "3. bundle   (--package-only: reuse $VIBE_CHECKOUT/out-vscode-reh and .build/extensions)"
	fi
	cat <<-EOF
	   package  cd $VIBE_CHECKOUT && VIBE_REH_REMOTE=$REMOTE npm run gulp $TASK
	            -> $OUT
	4. natives  drop the binaries and packages of other platforms that extensions and prebuilds bring along
	5. tarball  $TARBALL (+ .sha256)
	EOF
	if [ "$LINK" -eq 1 ]; then
		echo "6. link     $SERVERS_DIR/$(basename "$TARBALL") (+ .sha256) -> the tarball"
	fi
	echo "next: scripts/verify-server.sh <tarball> [--host <ssh-host>]"
	exit 0
fi

# --link-only: the tarball is there already, only the link into $SERVERS_DIR is missing.
if [ "$LINK_ONLY" -eq 1 ]; then
	[ -n "$COMMIT" ] || die "cannot tell the commit of $VIBE_CHECKOUT (no git HEAD, no BUILD_SOURCEVERSION)"
	[ -f "$TARBALL" ] || die "$TARBALL is missing - build it first (without --link-only)"
	link_into_servers
	exit 0
fi

# --- refusals: everything that can be known before work starts ------------------ #
[ -f "$VIBE_CHECKOUT/package.json" ] || die "no checkout at $VIBE_CHECKOUT - run scripts/bootstrap.sh first"
[ -d "$VIBE_CHECKOUT/node_modules" ] || die "$VIBE_CHECKOUT/node_modules is missing - run scripts/bootstrap.sh first"
[ -n "$COMMIT" ] || die "cannot tell the commit of $VIBE_CHECKOUT (no git HEAD, no BUILD_SOURCEVERSION)"
[ -n "$NODE_VERSION" ] || die "cannot read the server's Node version (target=) from $VIBE_CHECKOUT/remote/.npmrc"
grep -q "VIBE_REH_REMOTE" "$VIBE_CHECKOUT/build/gulpfile.reh.ts" \
	|| die "build/gulpfile.reh.ts does not honour VIBE_REH_REMOTE, so gulp would pack this host's node_modules - run scripts/apply.sh"
command -v python3 > /dev/null || die "python3 is required"

# A client only accepts a server with its own commit: refuse to build one it would reject.
for client in "$VIBE_ROOT"/VSCode-*/*.app/Contents/Resources/app/product.json "$VIBE_ROOT"/VSCode-linux-*/resources/app/product.json; do
	[ -f "$client" ] || continue
	have="$(json_str "$client" commit)"
	[ "$have" = "$COMMIT" ] || die "the packaged client $client carries commit '$have', but this build would be stamped '$COMMIT' - repackage the client or fix the checkout"
done

command -v docker > /dev/null || die "docker is not on PATH - the linux native modules are built in a container"
docker info > /dev/null 2>&1 || die "Docker is not running - start Docker Desktop (the linux native modules are built in a container)"

START="$(date +%s)"
mkdir -p "$REMOTE" "$BUILD/cache"

# --- 1. image ------------------------------------------------------------------- #
step image "$IMAGE ($DOCKER_PLATFORM, Node $NODE_VERSION)"
docker build --platform "$DOCKER_PLATFORM" --build-arg "NODE_VERSION=$NODE_VERSION" --build-arg "NODE_ARCH=$ARCH" \
	-t "$IMAGE" "$HELPERS"

# --- 2. node_modules for the target ---------------------------------------------- #
STAMP="$(cat "$VIBE_CHECKOUT/remote/package.json" "$VIBE_CHECKOUT/remote/package-lock.json" "$VIBE_CHECKOUT/remote/.npmrc" \
	"$HELPERS/Dockerfile" "$HELPERS/npm-ci.sh" | shasum -a 256 | cut -d' ' -f1)"
if [ -d "$REMOTE/node_modules" ] && [ "$(cat "$REMOTE/.stamp" 2> /dev/null || true)" = "$STAMP" ]; then
	step modules "up to date in $REMOTE"
else
	step modules "npm ci in the container -> $REMOTE (minutes under emulation)"
	rm -f "$REMOTE/.stamp"
	cp "$VIBE_CHECKOUT/remote/package.json" "$VIBE_CHECKOUT/remote/package-lock.json" "$VIBE_CHECKOUT/remote/.npmrc" "$REMOTE/"
	docker run --rm --platform "$DOCKER_PLATFORM" -v "$REMOTE":/remote -v "$BUILD/cache":/cache -v "$HELPERS":/scripts:ro \
		"$IMAGE" bash /scripts/npm-ci.sh
	echo "$STAMP" > "$REMOTE/.stamp"
fi

# --- 3. upstream's server build ---------------------------------------------------- #
# The same sequence as upstream's esbuild desktop task (build/gulpfile.vscode.ts), with the
# server as the bundle target. clean-extensions-build is no registered task, hence the rm.
if [ "$PACKAGE_ONLY" -eq 0 ]; then
	step bundle "built-in extensions, then $BUNDLE"
	# shellcheck disable=SC2086
	(cd "$VIBE_CHECKOUT" && rm -rf .build/extensions && npm run gulp $EXTENSION_TASKS && $BUNDLE)
else
	[ -f "$VIBE_CHECKOUT/out-vscode-reh/server-main.js" ] && [ -d "$VIBE_CHECKOUT/.build/extensions" ] \
		|| die "--package-only needs the bundle and extensions of an earlier full run in $VIBE_CHECKOUT (out-vscode-reh/, .build/extensions/)"
fi
step package "npm run gulp $TASK"
(cd "$VIBE_CHECKOUT" && VIBE_REH_REMOTE="$REMOTE" npm run gulp "$TASK")
[ -x "$OUT/bin/vibe-server" ] || die "$TASK finished but $OUT/bin/vibe-server is missing"
have="$(json_str "$OUT/product.json" commit)"
[ "$have" = "$COMMIT" ] || die "$OUT/product.json carries commit '$have', expected '$COMMIT'"

# --- 4. binaries of other platforms ---------------------------------------------------- #
# Built-in extensions bring their own node_modules from the checkout, i.e. installed on
# this host, and some packages ship prebuilds for every platform. None of that can load on
# the target, so it goes. Nothing has to be put back: the one native the git extension
# carries (@vscode/fs-copyfile) exists on macOS only and is not loaded anywhere else.
step natives "$OUT"
python3 "$HELPERS/natives.py" foreign "$OUT" "$ARCH" | while IFS= read -r package; do
	rm -rf "$OUT/$package"
	echo "dropped: $package (package of another platform)"
done
python3 "$HELPERS/natives.py" scan "$OUT" | while IFS="$(printf '\t')" read -r format machine _ _ path; do
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
step tarball "$TARBALL"
rm -f "$BUILD"/vibe-server-"$TARGET"-*.tar.gz "$BUILD"/vibe-server-"$TARGET"-*.tar.gz.sha256
# No AppleDouble files, no extended attributes: the archive is unpacked by GNU tar.
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TARBALL" -C "$(dirname "$OUT")" "$(basename "$OUT")"
(cd "$BUILD" && shasum -a 256 "$(basename "$TARBALL")" > "$TARBALL.sha256")

# --- 6. where an app outside this tree looks --------------------------------------------- #
if [ "$LINK" -eq 1 ]; then
	step link "$SERVERS_DIR"
	link_into_servers
fi

echo "tarball: $TARBALL ($(du -h "$TARBALL" | cut -f1), $(( ($(date +%s) - START) / 60 )) min)"
echo "sha256: $(cut -d' ' -f1 "$TARBALL.sha256")"
echo "next: $VIBE_SCRIPTS/verify-server.sh $TARBALL [--host <ssh-host>]"
