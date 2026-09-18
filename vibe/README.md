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
