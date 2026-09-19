# Vibe Slop Code

Vibe Slop Code (`vibe`) is a patch-level fork of VS Code (Code - OSS, pinned at
1.129.1) that adds:

- a **workspace bar**: every host and workspace in one frame, grouped by host. Switching
  swaps windows in place, and hidden ones keep their terminals, agents and remote
  connections running;
- the **Chandra workflow graph**, built in: the directed hypergraph of a Chandra
  project, folded live from its append-only ledgers under `results/ledgers/`;
- **SSH hosts** straight from `~/.ssh/config`, served by `vibe-server`, which is built
  from the same checkout and uploaded over the connection;
- an **Agents** view: which agent session is working, which is waiting for you, which
  has finished or failed, and a per-tab badge in the workspace bar that says where;
- a **ChatGPT Web** panel that operates the Codex Web GPT launcher of
  [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web): setup, models,
  bridge, engine, doctor.

The design, its limits and the node DAG are in [DESIGN.md](DESIGN.md).

Upstream is never vendored. This repository tracks:

| Path | Content |
|---|---|
| `upstream.json` | the pin: `repo`, `tag`, `commit`, `node` |
| `patches/` | edits to upstream files, one patch per upstream path (`/` → `__`) |
| `overlay/` | brand-new files, mirrored at their checkout path |
| `scripts/` | the tooling below |
| `bin/vibe` | the `vibe` command |
| `branding/` | the icon sources |
| `tests/` | tests of the tooling (`python3 -m pytest`) |
| `docs/`, `.githooks/` | the commit-message template and its gate (see Commits) |

`vscode/` (the checkout), `.toolchain/` (the pinned Node) and `.build/` are gitignored.

## Requirements

Built and tested on macOS arm64. Beyond git, curl, python3 and what upstream's `npm ci`
needs to compile native modules (Xcode command-line tools), nothing is installed by
hand: `bootstrap.sh` fetches the pinned Node itself. Docker is needed only for
`build-server.sh`; `make-icon.sh` needs `rsvg-convert`, `magick` and `iconutil`.

## Quickstart

From a fresh clone:

    scripts/bootstrap.sh     # pinned Node + shallow clone of the pin + apply + npm ci
    scripts/build.sh         # npm run compile
    scripts/run.sh [args]    # launch the dev build (vscode/scripts/code.sh)

`bootstrap.sh` is idempotent and never overwrites work in an existing checkout;
`--no-install` skips `npm ci`. Always go through these scripts (or `. scripts/env.sh`)
so the pinned Node is used rather than the system one.

For an app and a `vibe` command on your PATH:

    scripts/package.sh           # the app, in VSCode-darwin-arm64/
    scripts/verify-package.sh    # read-only checks on it
    scripts/install-cli.sh       # symlink `vibe` into a bin dir

## Development loop

1. Edit inside `vscode/` as if it were a normal VS Code clone. Do not `git add` or
   commit there: the checkout's index must stay at the pinned commit.
2. `scripts/test-core.sh <test-file>... | <glob>` runs core unit tests (compile first,
   or keep `npm run watch` running: tests load from `out/`). `npm test` in
   `vscode/extensions/vibe-*` runs an extension's tests (pinned Node on PATH:
   `. scripts/env.sh`); `python3 -m pytest` runs `tests/`.
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

## Commits

- One commit per node of the DAG in DESIGN.md, or finer — never two nodes in one.
- Tests land with the code or before it, never after.
- Messages follow [docs/commit_template.md](docs/commit_template.md): a
  `type(scope): summary` title, then optional `- kind:` body objects and trailers. Run
  `scripts/install-hooks.sh` once per clone: git then runs `.githooks/commit-msg`, which
  rejects a title that breaks the grammar and warns about the rest
  (`COMMIT_GATE_STRICT=1` makes the warnings errors).
- Never commit large data: the checkout, the toolchain, packaged apps, server tarballs
  and screenshots stay out of git.

## Package and install

    scripts/package.sh [--arch arm64|x64] [--min]   # npm run gulp vscode-<platform>-<arch>
    scripts/verify-package.sh                       # read-only checks on the result
    scripts/install-cli.sh                          # symlink `vibe` into a bin dir

`package.sh` maps the host to upstream's gulp task — `--print-task` prints the task and
builds nothing — and takes minutes, not seconds. Upstream hard-codes the output folder
next to the checkout, so the app lands in `VSCode-<platform>-<arch>/` (e.g.
`VSCode-darwin-arm64/Vibe Slop Code.app`, ~1.4 GB, gitignored), with the built-in
`vibe-chandra` extension inside and the bundled CLI at `Contents/Resources/app/bin/code`
— the name upstream fixes on darwin.

`verify-package.sh` then checks an existing bundle (`$VIBE_APP`, else that default
location): bundle identifier, the rebranded `product.json`, the built-in extension and
the bundled CLI's version/commit against `upstream.json`. One `ok:` line per check.

`install-cli.sh` symlinks `bin/vibe` into the first writable of `$VIBE_BIN_DIR`,
`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`; `code` is never touched and sudo
is never used. `vibe --vibe-which` names the backend it resolves to — the packaged app
when there is one, else the dev build. When several `VSCode-<platform>-<arch>*` folders
sit side by side, the newest bundle wins (`--vibe-which` lists the rest as `candidates:`,
`package.sh` names them, and neither deletes anything). A bundle under the app's previous
long name is listed last, after every bundle under the current one: renaming the app
renames nothing on disk, so the last package keeps working until the next one. To undo:
`install-cli.sh --uninstall` removes the symlink, and `rm -rf VSCode-*` removes the app.

## Icon

    scripts/make-icon.sh [--check] [--out DIR]   # needs rsvg-convert, magick, iconutil

The icon is the product's idea drawn small: a directed hypergraph of five rectangular
nodes, two of which meet in one junction from which one arrow continues. The sources are
three hand-written SVGs in `branding/`: `icon.svg` (the master on the macOS tile grid,
48 px and up), `icon-small.svg` (redrawn on the 16 px pixel grid for 32 px and down) and
`mark.svg` (the graph alone, `currentColor`). `make-icon.sh` renders them to the upstream
paths in the checkout — `resources/darwin/code.icns`, `resources/win32/code.ico` and the
two tile PNGs, `resources/linux/code.png`, the server favicon and PNGs, the in-workbench
`code-icon.svg` and the four `letterpress-*.svg` editor watermarks — from where
`export.sh` picks them up as patches. The same inputs give the same bytes, so `--check`
re-renders into a temp dir and compares without writing; `--out DIR` renders elsewhere.
The contract (five `<rect data-node>`, a `data-junction`, no text, no external reference)
and the file formats are covered by `tests/test_vibe_icon.py`.

## Remote server

    scripts/build-server.sh [--arch x64|arm64] [--package-only]   # needs Docker running
    scripts/verify-server.sh <tarball> [--host <ssh-host>]

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
`~/.vibe-server/bin/<commit>/`. It searches the setting `remote.SSH.vibeServerTarball`,
`$VIBE_SERVER_DIR`, a `server` folder next to the app and `~/.vibe/servers/` — the last is
the only one an app copied to `/Applications` has, so `build-server.sh` symlinks the tarball
and its `.sha256` there (`$VIBE_SERVERS_DIR`; `--no-link` skips it, `--link-only` is that
step alone for a tarball that is already built, and no build is ever overwritten).

## Connect to an SSH host

Hosts come from `~/.ssh/config`, with no per-host setup: the workspace bar's `+` lists them
under *SSH hosts*, the Remote Explorer shows the same list, and the command is
`workbench.action.workspaceBar.connectToSshHost` ("Connect to SSH Host…"). Picking one opens
an `SSH: <host>` window in the frame, where Open Folder browses the remote disk.

The first connect to a host uploads the server over the SSH connection (~200 MB, under a
minute on a fast link) and unpacks it into `~/.vibe-server`; every later connect finds it
there and takes seconds. `~/.vscode-server` is never touched, so a host you also use with
VS Code keeps working.

A new upstream pin means a new commit, hence a new server: run `build-server.sh` again and
the next connect uploads it. Older builds under `~/.vibe-server/bin/` on the host are just
disk space and can be deleted.

Limits so far: linux-x64 hosts only (`--arch arm64` builds the other one), and only
key/agent authentication has been used — password/2FA prompts and `ProxyJump` are untested.

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

## Licences

This repository is MIT-licensed ([LICENSE](LICENSE)). VS Code (Code - OSS) is MIT-licensed
upstream, and the patches in `patches/` are derived from it.
`overlay/extensions/vibe-remote-ssh` is a copy of open-remote-ssh and keeps its own MIT
licence (`LICENSE.txt`) and a `PROVENANCE.md` that lists every change. codex-chatgpt-web
is operated, not included: `overlay/extensions/vibe-agents/THIRD_PARTY.md` says what the
Agents extension runs of it and what it follows.
