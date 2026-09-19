#!/usr/bin/env bash
# Activate the tracked git hooks for this clone: point core.hooksPath at .githooks, so
# git runs .githooks/commit-msg (the title gate of docs/commit_template.md) on every
# commit. Idempotent, and says what it changed. Undo: git config --unset core.hooksPath;
# bypass the gate for one commit: git commit --no-verify.
set -euo pipefail

usage() { echo "usage: install-hooks.sh" >&2; exit 2; }
die() { echo "install-hooks.sh: $*" >&2; exit 1; }

if [ $# -gt 0 ]; then
	case "$1" in
		-h|--help) echo "usage: install-hooks.sh"; exit 0 ;;
		*) usage ;;
	esac
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
HOOKS=".githooks"

top="$(git -C "$ROOT" rev-parse --show-toplevel 2> /dev/null)" || die "$ROOT is not a git work tree"
# git resolves a relative core.hooksPath against the top of the work tree.
[ "$(cd "$top" && pwd -P)" = "$ROOT" ] || die "$ROOT is not the top of its git work tree ($top)"
[ -x "$ROOT/$HOOKS/commit-msg" ] || die "$ROOT/$HOOKS/commit-msg is missing or not executable"

have="$(git -C "$ROOT" config --local --get core.hooksPath || true)"
if [ "$have" = "$HOOKS" ]; then
	echo "already set: core.hooksPath = $HOOKS ($ROOT)"
else
	git -C "$ROOT" config --local core.hooksPath "$HOOKS"
	echo "set: core.hooksPath = $HOOKS ($ROOT)${have:+, was $have}"
fi
echo "commit-msg gate active, spec docs/commit_template.md; bypass once: git commit --no-verify"
echo "undo: git -C \"$ROOT\" config --unset core.hooksPath"
