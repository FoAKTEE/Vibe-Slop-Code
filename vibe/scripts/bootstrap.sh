#!/usr/bin/env bash
# Idempotent setup: fetch the pinned Node into .toolchain/node, shallow-clone the
# pinned upstream tag into the checkout and verify its commit, apply patches + overlay
# (only onto a pristine checkout, so work in progress is never clobbered), then run
# `npm ci`. --no-install skips the install.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

usage() { echo "usage: bootstrap.sh [--no-install]" >&2; exit 2; }

install=1
if [ $# -gt 0 ]; then
	[ $# -eq 1 ] && [ "$1" = "--no-install" ] || usage
	install=0
fi

node_version="$(vibe_pin node)"
node="$VIBE_TOOLCHAIN/node/bin/node"
if [ ! -x "$node" ] || [ "$("$node" --version)" != "v$node_version" ]; then
	case "$(uname -s)" in
		Darwin) os=darwin ;;
		Linux) os=linux ;;
		*) echo "error: unsupported platform $(uname -s)" >&2; exit 1 ;;
	esac
	case "$(uname -m)" in
		arm64 | aarch64) arch=arm64 ;;
		x86_64 | amd64) arch=x64 ;;
		*) echo "error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
	esac
	name="node-v$node_version-$os-$arch"
	url="https://nodejs.org/dist/v$node_version"
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT
	echo "fetching $name"
	curl -fsSL -o "$tmp/$name.tar.gz" "$url/$name.tar.gz"
	curl -fsSL -o "$tmp/SHASUMS256.txt" "$url/SHASUMS256.txt"
	if command -v shasum > /dev/null; then sha256="shasum -a 256"; else sha256="sha256sum"; fi
	(cd "$tmp" && grep " $name.tar.gz\$" SHASUMS256.txt | $sha256 -c - > /dev/null)
	rm -rf "$VIBE_TOOLCHAIN/node"
	mkdir -p "$VIBE_TOOLCHAIN/node"
	tar -xzf "$tmp/$name.tar.gz" -C "$VIBE_TOOLCHAIN/node" --strip-components 1
fi
PATH="$VIBE_TOOLCHAIN/node/bin:$PATH"
export PATH

if [ ! -e "$VIBE_CHECKOUT/.git" ]; then
	git -c advice.detachedHead=false clone --depth 1 --branch "$(vibe_pin tag)" "$(vibe_pin repo)" "$VIBE_CHECKOUT"
fi
vibe_check_pin

if [ -z "$(vibe_checkout_changes)" ]; then
	"$VIBE_SCRIPTS/apply.sh"
else
	echo "checkout has local changes; left as is (apply.sh --force resets it to the tracked state)"
fi

if [ "$install" = 1 ]; then
	(cd "$VIBE_CHECKOUT" && npm ci)
fi
