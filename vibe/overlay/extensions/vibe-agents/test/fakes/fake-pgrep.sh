#!/bin/sh
# SPDX-License-Identifier: MIT
#
# A stand-in for /usr/bin/pgrep, for tests and for a window under test: whether "the launcher runs" is what the state
# file of fake-open.sh says, not what the process list of this machine says. Exit code 0 and a pid: it runs. 1: not.
#
#   FAKE_LAUNCHER_STATE   as for fake-open.sh
set -eu
state_file="${FAKE_LAUNCHER_STATE:-${TMPDIR:-/tmp}/vibe-fake-launcher-state}"
current=stopped
if [ -f "$state_file" ]; then current="$(cat "$state_file")"; fi
case "$current" in
	running-*) echo 4242; exit 0 ;;
	*) exit 1 ;;
esac
