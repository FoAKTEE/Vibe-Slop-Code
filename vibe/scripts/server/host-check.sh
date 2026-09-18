#!/usr/bin/env bash
# Runs ON THE REMOTE HOST, fed to `bash -s -- <dir> <commit>` by verify-server.sh --host:
# unpacks <dir>/server.tar.gz the way the SSH resolver installs it, asks the server for
# its version, loads every native module (and opens a real pty), then starts the server
# for real on a loopback port and stops it again. Everything stays inside <dir>, a
# scratch directory that verify-server.sh creates and removes; one `ok:` line per check.
set -euo pipefail

DIR="${1:-}"
COMMIT="${2:-}"
die() { echo "host-check.sh: $*" >&2; exit 1; }

case "$DIR" in
	/*/vibe-server-verify.*) ;;
	*) die "refusing to work outside a vibe-server-verify.* scratch directory: '$DIR'" ;;
esac
[ -f "$DIR/server.tar.gz" ] || die "no $DIR/server.tar.gz"
command -v setsid > /dev/null || die "setsid (util-linux) is needed to stop the server with its children"

SERVER="$DIR/server"
DATA="$DIR/data"
LOG="$DIR/server.log"
mkdir -p "$SERVER" "$DATA"
# The server creates its data folder when its code is loaded - by --version too - and
# falls back to ~/.vibe-server. Every invocation below is given the scratch folder twice,
# by flag and by environment, and the end of this script checks that $HOME stayed clean.
export VSCODE_AGENT_FOLDER="$DATA"
HOME_DATA="$HOME/.vibe-server"
HOME_DATA_BEFORE="$(ls -lad --time-style=full-iso "$HOME_DATA" 2> /dev/null || echo absent)"
tar -xzf "$DIR/server.tar.gz" -C "$SERVER" --strip-components 1
echo "ok: host $(uname -n): $(uname -sm), $(ldd --version 2>&1 | sed -n 1p)"

# --- version ---------------------------------------------------------------------- #
VERSION_OUT="$("$SERVER/bin/vibe-server" --version --server-data-dir "$DATA" 2>&1 < /dev/null)" || die "bin/vibe-server --version failed: $VERSION_OUT"
HAVE="$(printf '%s\n' "$VERSION_OUT" | sed -n 2p)"
[ "$HAVE" = "$COMMIT" ] || die "bin/vibe-server --version reports commit '$HAVE', expected '$COMMIT'"
echo "ok: bin/vibe-server --version -> $(printf '%s' "$VERSION_OUT" | tr '\n' ' ')"

# --- native modules ------------------------------------------------------------------ #
# A start alone loads only the logger; the terminal, the file watcher and the rest are
# loaded on first use, so load them here. kerberos needs the host's libgssapi and is only
# used for proxy authentication: reported, not required.
LOADED="$(cd "$SERVER" && ./node -e '
const mods = ["node-pty", "@vscode/spdlog", "@parcel/watcher", "@vscode/native-watchdog", "@vscode/sqlite3", "@vscode/fs-copyfile"];
for (const mod of mods) { require("./node_modules/" + mod); }
require("./extensions/git/node_modules/@vscode/fs-copyfile");
let kerberos = "kerberos";
try { require("./node_modules/kerberos"); } catch (err) { kerberos = "kerberos unavailable (" + String(err.message).split("\n")[0] + ")"; }
let seen = "";
const pty = require("./node_modules/node-pty").spawn("/bin/sh", ["-c", "echo pty-$((6*7))"], {});
pty.onData(data => { seen += data; });
pty.onExit(() => {
	if (!seen.includes("pty-42")) { console.error("the pty printed: " + JSON.stringify(seen)); process.exit(1); }
	console.log(mods.concat(["git/@vscode/fs-copyfile", kerberos]).join(", ") + "; a pty round trip works");
});
' 2>&1 < /dev/null)" || die "native modules do not load on this host: $LOADED"
echo "ok: native modules load: $LOADED"

# --- a real start ---------------------------------------------------------------------- #
setsid "$SERVER/bin/vibe-server" --accept-server-license-terms --host 127.0.0.1 --port 0 --without-connection-token \
	--server-data-dir "$DATA" --telemetry-level off > "$LOG" 2>&1 < /dev/null &
PID=$!
stop() { kill -TERM -- "-$PID" 2> /dev/null || true; }
trap stop EXIT

LISTENING=""
for _ in $(seq 1 120); do
	LISTENING="$(grep -m1 "Extension host agent listening" "$LOG" || true)"
	[ -z "$LISTENING" ] || break
	kill -0 "$PID" 2> /dev/null || die "the server exited before it listened: $(tail -n 20 "$LOG")"
	sleep 0.5
done
[ -n "$LISTENING" ] || die "the server did not listen within 60 s: $(tail -n 20 "$LOG")"
echo "ok: server started: $LISTENING"

# The agent log is written through @vscode/spdlog: it exists only if the logger loaded.
sleep 1
AGENT_LOG="$(find "$DATA" -name 'remoteagent.log' -size +0c 2> /dev/null | sed -n 1p || true)"
[ -n "$AGENT_LOG" ] || die "no remoteagent.log under $DATA - the spdlog logger did not come up: $(tail -n 20 "$LOG")"
ERRORS="$(grep -rhiE "cannot find module|invalid ELF|wrong ELF class|GLIBC(XX)?_[0-9.]+' not found|cannot open shared object|\berror\b" "$LOG" "$(dirname "$AGENT_LOG")" || true)"
[ -z "$ERRORS" ] || die "errors in the server log: $ERRORS"
echo "ok: server log is clean (${AGENT_LOG#$DIR/} written through spdlog)"

# --- stop -------------------------------------------------------------------------------- #
stop
for _ in $(seq 1 20); do
	kill -0 "$PID" 2> /dev/null || break
	sleep 0.5
done
kill -KILL -- "-$PID" 2> /dev/null || true
wait "$PID" 2> /dev/null || true
LEFT="$(pgrep -u "$(id -u)" -f "$DIR/server/" || true)"
[ -z "$LEFT" ] || die "processes left behind: $LEFT"
echo "ok: server stopped, no process left behind"

HOME_DATA_AFTER="$(ls -lad --time-style=full-iso "$HOME_DATA" 2> /dev/null || echo absent)"
[ "$HOME_DATA_AFTER" = "$HOME_DATA_BEFORE" ] || die "$HOME_DATA was touched by this check (before: $HOME_DATA_BEFORE; after: $HOME_DATA_AFTER)"
echo "ok: $HOME_DATA untouched ($HOME_DATA_AFTER)"
