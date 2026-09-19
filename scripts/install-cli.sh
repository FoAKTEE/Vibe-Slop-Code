#!/usr/bin/env bash
#
# install-cli.sh — symlink the `vibe` command into a user-writable bin dir.
#
# Target: the first writable of $VIBE_BIN_DIR, /opt/homebrew/bin, /usr/local/bin
# and $HOME/.local/bin ($VIBE_BIN_DIR and $HOME/.local/bin are created if they do
# not exist). Never sudo; never touches `code` — the only name we create is
# `vibe`, and only as a symlink.
#
#   install-cli.sh [--force]     install (--force replaces a foreign entry)
#   install-cli.sh --uninstall   remove our own symlink, nothing else
#
# Compatible with the bash 3.2 that ships with macOS.

set -u

FORCE=0
UNINSTALL=0
for arg in "$@"; do
	case "$arg" in
		--force) FORCE=1 ;;
		--uninstall) UNINSTALL=1 ;;
		-h|--help)
			echo "usage: install-cli.sh [--force] [--uninstall]"
			exit 0
			;;
		*)
			echo "install-cli.sh: unknown argument: $arg" >&2
			exit 2
			;;
	esac
done

SCRIPTS_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" > /dev/null 2>&1 && pwd)"
SOURCE="$(dirname "$SCRIPTS_DIR")/bin/vibe"

if [ ! -x "$SOURCE" ]; then
	echo "install-cli.sh: $SOURCE is missing or not executable" >&2
	exit 1
fi

on_path() {
	case ":$PATH:" in
		*":$1:"*) echo "yes" ;;
		*) echo "no" ;;
	esac
}

# `vibe` in a bin dir is ours only when it is a symlink resolving to $SOURCE.
is_ours() {
	[ -L "$1" ] || return 1
	[ "$(readlink "$1")" = "$SOURCE" ]
}

# --- uninstall ------------------------------------------------------------- #
if [ "$UNINSTALL" -eq 1 ]; then
	if [ -n "${VIBE_BIN_DIR:-}" ]; then
		set -- "$VIBE_BIN_DIR"
	else
		set -- /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"
	fi
	REMOVED=0
	FOREIGN=0
	for dir in "$@"; do
		link="$dir/vibe"
		if [ ! -e "$link" ] && [ ! -L "$link" ]; then
			continue
		fi
		if is_ours "$link"; then
			rm -f "$link" && echo "removed: $link" && REMOVED=1
		else
			echo "install-cli.sh: $link is not our symlink — left alone" >&2
			FOREIGN=1
		fi
	done
	[ "$REMOVED" -eq 1 ] && exit 0
	[ "$FOREIGN" -eq 1 ] && exit 1
	echo "install-cli.sh: nothing to uninstall" >&2
	exit 1
fi

# --- pick the target directory --------------------------------------------- #
TARGET_DIR=""
if [ -n "${VIBE_BIN_DIR:-}" ]; then
	mkdir -p "$VIBE_BIN_DIR" 2> /dev/null || true
	[ -w "$VIBE_BIN_DIR" ] && TARGET_DIR="$VIBE_BIN_DIR"
fi
if [ -z "$TARGET_DIR" ]; then
	for dir in /opt/homebrew/bin /usr/local/bin; do
		if [ -d "$dir" ] && [ -w "$dir" ]; then
			TARGET_DIR="$dir"
			break
		fi
	done
fi
if [ -z "$TARGET_DIR" ]; then
	mkdir -p "$HOME/.local/bin" 2> /dev/null || true
	[ -w "$HOME/.local/bin" ] && TARGET_DIR="$HOME/.local/bin"
fi
if [ -z "$TARGET_DIR" ]; then
	echo "install-cli.sh: no writable bin dir found (privileges are never escalated)." >&2
	echo "install-cli.sh: set VIBE_BIN_DIR to a directory you can write to." >&2
	exit 1
fi

LINK="$TARGET_DIR/vibe"

if [ -e "$LINK" ] || [ -L "$LINK" ]; then
	if is_ours "$LINK"; then
		echo "already installed: $LINK -> $SOURCE"
		echo "$TARGET_DIR on PATH: $(on_path "$TARGET_DIR")"
		exit 0
	fi
	if [ "$FORCE" -ne 1 ]; then
		echo "install-cli.sh: $LINK exists and is not ours — re-run with --force to replace it" >&2
		exit 1
	fi
	rm -f "$LINK" || exit 1
fi

ln -s "$SOURCE" "$LINK" || exit 1
echo "installed: $LINK -> $SOURCE"
echo "$TARGET_DIR on PATH: $(on_path "$TARGET_DIR")"
