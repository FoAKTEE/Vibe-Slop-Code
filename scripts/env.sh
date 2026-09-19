#!/usr/bin/env bash
# Shared environment, sourced by the other scripts: resolves the vibe paths (each one
# overridable through its env var), reads the upstream pin, and puts the pinned Node
# first on PATH when it is installed. Sets no shell options, so it is safe to source
# from an interactive shell too.

_vibe_abs() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s\n' "$PWD/$1" ;; esac; }

VIBE_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
VIBE_ROOT="$(_vibe_abs "${VIBE_ROOT:-$(dirname "$VIBE_SCRIPTS")}")"
VIBE_CHECKOUT="$(_vibe_abs "${VIBE_CHECKOUT:-$VIBE_ROOT/vscode}")"
VIBE_PATCHES="$(_vibe_abs "${VIBE_PATCHES:-$VIBE_ROOT/patches}")"
VIBE_OVERLAY="$(_vibe_abs "${VIBE_OVERLAY:-$VIBE_ROOT/overlay}")"
VIBE_PIN="$(_vibe_abs "${VIBE_PIN:-$VIBE_ROOT/upstream.json}")"
VIBE_TOOLCHAIN="$(_vibe_abs "${VIBE_TOOLCHAIN:-$VIBE_ROOT/.toolchain}")"
export VIBE_ROOT VIBE_CHECKOUT VIBE_PATCHES VIBE_OVERLAY VIBE_PIN VIBE_TOOLCHAIN

if [ -d "$VIBE_TOOLCHAIN/node/bin" ]; then
	PATH="$VIBE_TOOLCHAIN/node/bin:$PATH"
	export PATH
fi

# vibe_pin <key>: one string field of the (flat) pin file.
vibe_pin() {
	sed -n 's/^[[:space:]]*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/p' "$VIBE_PIN"
}

# Fails unless the checkout HEAD is the pinned commit. VIBE_SKIP_PIN_CHECK=1 disables it.
vibe_check_pin() {
	[ "${VIBE_SKIP_PIN_CHECK:-0}" != "1" ] || return 0
	local want have
	want="$(vibe_pin commit)"
	have="$(git -C "$VIBE_CHECKOUT" rev-parse HEAD)"
	if [ "$want" != "$have" ]; then
		echo "error: $VIBE_CHECKOUT is at $have, but $VIBE_PIN pins $want" >&2
		return 1
	fi
}

# Prints the checkout's local changes (tracked edits + non-ignored untracked files); empty when pristine.
vibe_checkout_changes() {
	git -C "$VIBE_CHECKOUT" status --porcelain
}
