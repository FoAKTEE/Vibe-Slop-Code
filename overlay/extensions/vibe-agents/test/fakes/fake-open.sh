#!/bin/sh
# SPDX-License-Identifier: MIT
#
# A stand-in for /usr/bin/open, for tests and for a window under test: instead of starting or showing an app it flips
# a state file, so the real launcher is never touched. It understands the two command lines Vibe uses:
#
#   open -g -j -b <bundle id> --args --hidden    a stopped launcher starts without its window (running-hidden);
#                                                a running one shows its window, as the real one does
#   open -b <bundle id>                          the window shows, and a stopped launcher starts (running-visible)
#
# Anything else -- a file, a URL, an app by its path -- fails with exit code 1 and is written down as refused.
#
#   FAKE_LAUNCHER_STATE   the state file (default: ${TMPDIR:-/tmp}/vibe-fake-launcher-state); `<it>.calls` is the log
#   FAKE_LAUNCHER_FAILS=1 `open` fails, as it does when the app is not installed
set -eu
state_file="${FAKE_LAUNCHER_STATE:-${TMPDIR:-/tmp}/vibe-fake-launcher-state}"
printf 'open %s\n' "$*" >> "$state_file.calls"

hidden=no
bundle=
while [ $# -gt 0 ]; do
	case "$1" in
		-g|-j|--args) ;;
		--hidden) hidden=yes ;;
		-b) shift; bundle="${1:-}" ;;
		*) printf 'refused: open %s\n' "$1" >> "$state_file.calls"; echo "fake-open: not a command line of Vibe" >&2; exit 1 ;;
	esac
	shift
done
if [ -z "$bundle" ] || [ "${FAKE_LAUNCHER_FAILS:-0}" = 1 ]; then
	echo "Unable to find application named '$bundle'" >&2
	exit 1
fi

current=stopped
if [ -f "$state_file" ]; then current="$(cat "$state_file")"; fi
if [ "$hidden" = yes ] && [ "$current" = stopped ]; then
	echo running-hidden > "$state_file"
else
	echo running-visible > "$state_file"
fi
