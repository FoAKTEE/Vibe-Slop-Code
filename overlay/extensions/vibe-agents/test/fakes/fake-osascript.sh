#!/bin/sh
# SPDX-License-Identifier: MIT
#
# A stand-in for /usr/bin/osascript, for tests and for a window under test. It understands ONE script, the quit event
# Vibe sends to the launcher, and turns it into `stopped` in the state file of fake-open.sh. Every other script is
# refused with exit code 97: nothing is ever run.
#
#   FAKE_LAUNCHER_STATE            as for fake-open.sh
#   FAKE_LAUNCHER_REFUSES_QUIT=1   the launcher stays: it refuses to quit while one of its own operations runs
set -eu
state_file="${FAKE_LAUNCHER_STATE:-${TMPDIR:-/tmp}/vibe-fake-launcher-state}"
printf 'osascript %s\n' "$*" >> "$state_file.calls"

if [ $# -ne 2 ] || [ "$1" != "-e" ]; then
	echo "fake-osascript: not a command line of Vibe" >&2
	exit 97
fi
case "$2" in
	'tell application id "'*'" to quit') ;;
	*) echo "fake-osascript: not the quit event" >&2; exit 97 ;;
esac

if [ "${FAKE_LAUNCHER_REFUSES_QUIT:-0}" = 1 ]; then
	echo running-visible > "$state_file"
	echo "execution error: User canceled. (-128)" >&2
	exit 1
fi
echo stopped > "$state_file"
