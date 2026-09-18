#!/usr/bin/env bash
# Checks on a server tarball from build-server.sh (vibe-server-linux-<arch>-<commit>.tar.gz).
# Local, on an unpacked scratch copy: one top-level directory, the launcher and the target's
# Node, the stamped product.json, every native binary (ELF for <arch>, nothing built for
# another platform, no loaded binary needing a glibc newer than the ceiling), the built-in
# extension.
# With --host <ssh-host>: upload it into a scratch directory under the host's $HOME, then run
# scripts/server/host-check.sh there (--version, load the natives, a real start and stop).
# ~/.vibe-server and ~/.vscode-server are never touched, and the scratch copy is removed on
# exit. One `ok:` line per check (`note:` for what is worth knowing but no failure); the
# first failure says what was expected and exits non-zero.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

APP_NAME="Vibe Studio Code.app"
# The newest glibc that what the server process loads (node, *.node) may need. 2.28 is the
# floor of the official Node 24 builds the server ships (RHEL 8 and later, Debian 10,
# Ubuntu 18.10): the server cannot start below it anyway, and a native module that needs
# more would break hosts where Node itself runs. Prebuilt helper executables that upstream
# ships and the server only spawns cannot be rebuilt here; those above the ceiling are
# named in a `note:` line instead, because their feature is missing on older hosts.
MAX_GLIBC="${VIBE_SERVER_MAX_GLIBC:-2.28}"

usage() { echo "usage: verify-server.sh <tarball> [--host <ssh-host>]" >&2; exit 2; }
die() { echo "verify-server.sh: $*" >&2; exit 1; }

# json_str <file> <key>: a top-level string out of a JSON file, empty when absent.
json_str() {
	python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")' "$1" "$2"
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
HOST=""
while [ $# -gt 0 ]; do
	case "$1" in
		--host)
			[ $# -ge 2 ] || usage
			HOST="$2"
			shift 2
			;;
		-h|--help)
			echo "usage: verify-server.sh <tarball> [--host <ssh-host>]"
			exit 0
			;;
		-*)
			echo "verify-server.sh: unknown argument: $1" >&2
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
[ -f "$TARBALL" ] || die "no tarball at $TARBALL - run scripts/build-server.sh first"
NAME="$(basename "$TARBALL")"
ARCH="$(printf '%s\n' "$NAME" | sed -En 's/^vibe-server-linux-(x64|arm64)-[0-9a-f]{40}\.tar\.gz$/\1/p')"
COMMIT="$(printf '%s\n' "$NAME" | sed -En 's/^vibe-server-linux-(x64|arm64)-([0-9a-f]{40})\.tar\.gz$/\2/p')"
[ -n "$ARCH" ] || die "$NAME is not named vibe-server-linux-<arch>-<commit>.tar.gz, which is where the arch and the commit to expect come from"
case "$ARCH" in
	x64) MACHINE="x86_64" ;;
	arm64) MACHINE="aarch64" ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/vibe-verify-server.XXXXXX")"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=12)
REMOTE_DIR=""
cleanup() {
	rm -rf "$WORK"
	if [ -n "$REMOTE_DIR" ]; then
		ssh "${SSH_OPTS[@]}" "$HOST" "rm -rf '$REMOTE_DIR'" || echo "verify-server.sh: could not remove $HOST:$REMOTE_DIR" >&2
	fi
}
trap cleanup EXIT

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
	|| die "expected one top-level directory (the resolver unpacks with --strip-components 1), found: $(printf '%s' "$TOP" | tr '\n' ' ')"
ROOT="$WORK/$TOP"
echo "ok: one top-level directory $TOP/"

# --- launcher and Node -------------------------------------------------------------- #
SCAN="$(python3 "$VIBE_SCRIPTS/server/natives.py" scan "$ROOT")"
TAB="$(printf '\t')"
[ -f "$ROOT/bin/vibe-server" ] || die "missing bin/vibe-server in $TOP/"
[ -x "$ROOT/bin/vibe-server" ] || die "bin/vibe-server is not executable"
[ -f "$ROOT/out/server-main.js" ] || die "missing out/server-main.js, which bin/vibe-server starts"
NODE_KIND="$(printf '%s\n' "$SCAN" | awk -F'\t' '$5 == "node" { print $1 " " $2 }')"
[ -n "$NODE_KIND" ] || die "missing node (or not a binary) in $TOP/"
[ "$NODE_KIND" = "elf $MACHINE" ] || die "node is a $(format_name "${NODE_KIND% *}") ${NODE_KIND#* } binary, expected ELF $MACHINE"
echo "ok: launcher bin/vibe-server, node is ELF $MACHINE"

# --- product.json -------------------------------------------------------------------- #
PRODUCT="$ROOT/product.json"
[ -f "$PRODUCT" ] || die "missing product.json in $TOP/"
HAVE="$(json_str "$PRODUCT" commit)"
[ "$HAVE" = "$COMMIT" ] || die "product.json commit is '${HAVE:-<unset>}', expected '$COMMIT' (from the tarball's name)"
echo "ok: product.json commit = $HAVE"
for pair in serverApplicationName=vibe-server serverDataFolderName=.vibe-server; do
	HAVE="$(json_str "$PRODUCT" "${pair%%=*}")"
	[ "$HAVE" = "${pair#*=}" ] || die "product.json ${pair%%=*} is '${HAVE:-<unset>}', expected '${pair#*=}'"
	echo "ok: product.json ${pair%%=*} = $HAVE"
done

# The handshake compares this commit with the client's, so check the client that is here.
APP="${VIBE_APP:-}"
if [ -z "$APP" ]; then
	for candidate in "$VIBE_ROOT/VSCode-darwin-arm64/$APP_NAME" "$VIBE_ROOT/VSCode-darwin-x64/$APP_NAME"; do
		if [ -d "$candidate" ]; then
			APP="$candidate"
			break
		fi
	done
fi
if [ -n "$APP" ] && [ -f "$APP/Contents/Resources/app/product.json" ]; then
	HAVE="$(json_str "$APP/Contents/Resources/app/product.json" commit)"
	[ "$HAVE" = "$COMMIT" ] || die "the packaged client $APP carries commit '$HAVE', the server '$COMMIT' - the client would refuse it"
	echo "ok: commit is the packaged client's ($APP)"
fi

# --- native binaries ------------------------------------------------------------------- #
NODE_FILES=0
NEWEST_GLIBC="0"
NEWEST_GLIBC_PATH=""
NEWEST_GLIBCXX="0"
HELPERS_ABOVE=""
while IFS="$TAB" read -r format machine glibc glibcxx path; do
	[ -n "$format" ] || continue
	[ "$format" != "macho" ] || die "Mach-O $machine binary in a linux server: $path"
	case "$path" in
		*.node)
			[ "$format $machine" = "elf $MACHINE" ] || die "$path is $(format_name "$format") $machine, expected ELF $MACHINE"
			NODE_FILES=$((NODE_FILES + 1))
			;;
	esac
	[ "$format $machine" = "elf $MACHINE" ] || continue
	case "$path" in
		node|*.node) ;;
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
for native in \
	node_modules/node-pty/build/Release/pty.node \
	node_modules/@vscode/spdlog/build/Release/spdlog.node \
	node_modules/@parcel/watcher/build/Release/watcher.node \
	node_modules/@vscode/native-watchdog/build/Release/watchdog.node \
	node_modules/@vscode/sqlite3/build/Release/vscode-sqlite3.node \
	node_modules/kerberos/build/Release/kerberos.node \
	"node_modules/@vscode/ripgrep-universal/bin/linux-$ARCH/rg"; do
	printf '%s\n' "$SCAN" | awk -F'\t' -v p="$native" '$5 == p { found = 1 } END { exit !found }' \
		|| die "missing native binary $native"
done
echo "ok: $NODE_FILES native modules (*.node), all ELF $MACHINE; no Mach-O file; the required ones are there"

version_le "$NEWEST_GLIBC" "$MAX_GLIBC" \
	|| die "$NEWEST_GLIBC_PATH needs glibc $NEWEST_GLIBC, newer than the ceiling $MAX_GLIBC (\$VIBE_SERVER_MAX_GLIBC) - build the natives against an older glibc"
echo "ok: newest glibc needed by node and the native modules is $NEWEST_GLIBC ($NEWEST_GLIBC_PATH), ceiling $MAX_GLIBC; newest libstdc++ symbols GLIBCXX_$NEWEST_GLIBCXX"
[ -z "$HELPERS_ABOVE" ] || echo "note: prebuilt helper executables, spawned on demand, that will not run on a host below their glibc (ceiling $MAX_GLIBC):$HELPERS_ABOVE"

FOREIGN="$(python3 "$VIBE_SCRIPTS/server/natives.py" foreign "$ROOT" "$ARCH")"
[ -z "$FOREIGN" ] || die "packages of another platform in the server: $(printf '%s' "$FOREIGN" | tr '\n' ' ')"
echo "ok: no package whose os/cpu excludes linux/$ARCH"

# --- the built-in extension ------------------------------------------------------------ #
# vibe-chandra declares extensionKind [ui, workspace]: next to a Vibe client it runs in the
# client and reads the remote ledgers through workspace.fs; the server's copy is upstream's
# default for such extensions and only runs for a client that lacks its own.
[ -f "$ROOT/extensions/vibe-chandra/package.json" ] || die "missing extensions/vibe-chandra/package.json - the built-in extension is not in the server"
echo "ok: extension vibe-chandra"

# --- on a real host -------------------------------------------------------------------- #
[ -n "$HOST" ] || exit 0
REMOTE_DIR="$(ssh "${SSH_OPTS[@]}" "$HOST" 'mktemp -d "$HOME/vibe-server-verify.XXXXXX"')" \
	|| die "cannot reach $HOST over ssh without a prompt (BatchMode)"
case "$REMOTE_DIR" in
	/*/vibe-server-verify.*) ;;
	*) HAVE="$REMOTE_DIR"; REMOTE_DIR=""; die "unexpected scratch directory on $HOST: '$HAVE'" ;;
esac
echo "ok: scratch directory $HOST:$REMOTE_DIR"
scp -q "${SSH_OPTS[@]}" "$TARBALL" "$HOST:$REMOTE_DIR/server.tar.gz" || die "upload to $HOST failed"
ssh "${SSH_OPTS[@]}" "$HOST" bash -s -- "$REMOTE_DIR" "$COMMIT" < "$VIBE_SCRIPTS/server/host-check.sh" \
	|| die "the checks on $HOST failed"
