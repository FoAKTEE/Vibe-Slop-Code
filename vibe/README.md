# Vibe Studio Code

`vibe` is a patch-level fork of VS Code (Code - OSS) that adds a workspace bar
(hosts × workspaces in one frame) and a built-in Chandra workflow-graph view. The
design, its limits and the node DAG are in [DESIGN.md](DESIGN.md).

Upstream is never vendored. This directory tracks only:

| Path | Content |
|---|---|
| `upstream.json` | the pin: `repo`, `tag`, `commit`, `node` |
| `patches/` | edits to upstream files, one patch per upstream path (`/` → `__`) |
| `overlay/` | brand-new files, mirrored at their checkout path |
| `scripts/` | the tooling below |

`vscode/` (the checkout), `.toolchain/` (the pinned Node) and `.build/` are gitignored.

## Quickstart

    vibe/scripts/bootstrap.sh     # pinned Node + shallow clone of the pin + apply + npm ci
    vibe/scripts/build.sh         # npm run compile
    vibe/scripts/run.sh [args]    # launch the dev build (scripts/code.sh)

`bootstrap.sh` is idempotent and never overwrites work in an existing checkout;
`--no-install` skips `npm ci`. Always go through these scripts (or `. scripts/env.sh`)
so the pinned Node is used rather than the system one.

## Development loop

1. Edit inside `vscode/` as if it were a normal VS Code clone. Do not `git add` or
   commit there: the checkout's index must stay at the pinned commit.
2. `scripts/test-core.sh <test-file>... | <glob>` runs core unit tests (compile first,
   or keep `npm run watch` running: tests load from `out/`).
3. `scripts/export.sh` regenerates `patches/` + `overlay/` from the checkout. It
   rebuilds both from scratch, so reverted edits and deleted files drop out.
4. `scripts/check.sh` exits 0 iff the tracked state equals the checkout. Run it
   before every commit; commit only `patches/`, `overlay/` and friends.

`scripts/apply.sh` is the inverse of export: it rebuilds the fork in a pristine
checkout. It refuses a checkout with local changes; `--force` discards them first
(ignored content such as `node_modules/` and `out/` survives). `export.sh --out DIR`
writes to `DIR/patches` + `DIR/overlay` for inspection without touching tracked files.

Every path is overridable for testing: `VIBE_ROOT`, `VIBE_CHECKOUT`, `VIBE_PATCHES`,
`VIBE_OVERLAY`, `VIBE_PIN`, `VIBE_TOOLCHAIN`; `VIBE_SKIP_PIN_CHECK=1` disables the
commit check. The roundtrip is covered by `tests/test_vibe_scaffold.py`.

## Package and install

    vibe/scripts/package.sh [--arch arm64|x64] [--min]   # npm run gulp vscode-<platform>-<arch>
    vibe/scripts/verify-package.sh                       # read-only checks on the result
    vibe/scripts/install-cli.sh                          # symlink `vibe` into a bin dir

`package.sh` maps the host to upstream's gulp task — `--print-task` prints the task and
builds nothing — and takes minutes, not seconds. Upstream hard-codes the output folder
next to the checkout, so the app lands in `vibe/VSCode-<platform>-<arch>/` (e.g.
`VSCode-darwin-arm64/Vibe Studio Code.app`, ~1.4 GB, gitignored), with the built-in
`vibe-chandra` extension inside and the bundled CLI at `Contents/Resources/app/bin/code`
— the name upstream fixes on darwin.

`verify-package.sh` then checks an existing bundle (`$VIBE_APP`, else that default
location): bundle identifier, the rebranded `product.json`, the built-in extension and
the bundled CLI's version/commit against `upstream.json`. One `ok:` line per check.

`install-cli.sh` symlinks `bin/vibe` into the first writable of `$VIBE_BIN_DIR`,
`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`; `code` is never touched and sudo
is never used. `vibe --vibe-which` names the backend it resolves to — the packaged app
when there is one, else the dev build. To undo: `install-cli.sh --uninstall` removes the
symlink, and `rm -rf vibe/VSCode-*` removes the app.

## Remote server

    vibe/scripts/build-server.sh [--arch x64|arm64] [--package-only]   # needs Docker running
    vibe/scripts/verify-server.sh <tarball> [--host <ssh-host>]

A remote (SSH) window talks to a server on the host whose `commit` equals the client's.
Microsoft's server build is licensed for their products only, and nobody publishes one
for our pin, so Vibe builds its own: `vibe-server`, upstream's remote extension host from
the same checkout. The JS comes from upstream's esbuild bundler (`build/next`, target
`server`) — the way the desktop app is packaged at this pin — and the gulp task
`vscode-reh-linux-<arch>-ci` assembles it with the target's Node. The top-level task
`vscode-reh-linux-<arch>` is not used: it still starts the legacy mangling compile, which
fails at this pin after twenty minutes. The
native modules cannot come from the checkout, where they are built for this Mac, so
`remote/` is npm-installed in a linux container (`scripts/server/`: AlmaLinux 8, i.e. glibc
2.28, the floor of the Node the server ships) into `.build/server/linux-<arch>/remote/`, and
gulp takes `node_modules` from there through `VIBE_REH_REMOTE` — the one `// vibe:` edit in
`build/gulpfile.reh.ts`. The checkout's own `remote/node_modules` is never touched.

The result is `.build/server/vibe-server-linux-<arch>-<commit>.tar.gz` plus `.sha256`, one
top-level directory, gitignored. `<commit>` is what upstream stamps — the checkout's git
HEAD, hence the pinned upstream commit — and `build-server.sh` refuses to build when a
packaged client next to it carries another one. `--print-plan` prints the steps and runs
nothing; `--package-only` reuses the previous bundle and extensions (for the second arch).
The x64 natives are built under emulation, which is the slow part of a first run.

`verify-server.sh` unpacks a scratch copy and checks the layout, the stamped
`product.json`, that every native binary is ELF for the target with nothing left over from
another platform, and that none needs a glibc newer than 2.28 (`$VIBE_SERVER_MAX_GLIBC`).
With `--host` it also uploads the tarball into a scratch directory under the host's `$HOME`,
asks the server for its version, loads every native module (including a real pty), starts
the server on a loopback port, stops it and removes the directory again. `~/.vscode-server`
is never touched, and neither is `~/.vibe-server`: the server creates its data folder as
soon as its code is loaded, `--version` included, so every invocation is pointed at the
scratch directory and the last check fails if `~/.vibe-server` changed. A `note:` line
names prebuilt helpers that upstream ships and that need more than the ceiling (today the
`@microsoft/mxc-sdk` sandbox launcher, glibc 2.34): the server runs without them, their
feature does not.

Install is upload, not download: there is no URL that hosts this server, and many hosts
have no outbound internet. On connect the SSH resolver looks for the tarball that matches
the client's commit, uploads it over the connection it already has and unpacks it into
`~/.vibe-server/bin/<commit>/`.

## Bumping the upstream pin

1. `scripts/check.sh` — make sure nothing in the checkout is unexported.
2. Edit `upstream.json`: new `tag`, its `commit`, and `node` from upstream's `.nvmrc`.
3. Remove `vscode/` and run `scripts/bootstrap.sh` (it re-fetches Node by itself when
   `node` changed).
4. If some patches no longer apply, `apply.sh` lists all of them and changes nothing.
   Move those patch files out of `patches/`, run `scripts/apply.sh` to apply the rest,
   then port each moved patch by hand in the checkout. `git -C vscode apply --reject
   <patch>` applies the hunks that still fit and writes `.rej` files for the others;
   delete the `.rej` files afterwards, or they are exported as overlay files.
5. `scripts/export.sh`, `scripts/check.sh`, build and test, then commit the pin
   together with the refreshed patches.
