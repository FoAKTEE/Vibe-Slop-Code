# Vibe Studio Code — design record

Source prompt: `progress/prompt/init.md`. Vibe Studio Code (`vibe`) is a patch-level
fork of VS Code (Code - OSS) that folds two Chandra needs into the editor while
staying as close to upstream as possible.

## 0. Principles

- **Small fork.** Upstream is never vendored. `vibe/vscode/` is a gitignored checkout
  pinned by `vibe/upstream.json`; this repo tracks only `vibe/patches/` (edits to
  upstream files, one patch per upstream path) and `vibe/overlay/` (new files, mirrored
  tree). `scripts/apply.sh` rebuilds the checkout; `scripts/export.sh` regenerates
  patches + overlay from it. Rebase onto a new upstream = bump the pin, re-apply.
- **Core only where an extension cannot reach.** The workspace bar needs the workbench
  grid and the main process, so it is core. The Chandra graph is a *built-in extension*
  (`extensions/vibe-chandra`): shipped in the app, zero install, no core coupling.
- **Every window stays a vanilla VS Code window.** One workspace + one remote authority
  + one extension host per window is upstream's load-bearing assumption. We do not
  break it; we change how windows are *presented*.

## 1. Workspace bar (hosts × workspaces in one frame)

Problem: one VS Code window per host/folder. Goal: one frame, a bar to switch.

- **Presentation trick (single frame).** All Vibe windows share one on-screen frame.
  Switching to entry B = place B's window at the active window's bounds, show + focus
  it, hide the previous one. Hidden windows keep their renderer, extension host and
  remote connection alive, so agents/terminals on other hosts keep running.
- **Main-process service** `IWorkspaceBarMainService` (`src/vs/platform/workspaceBar/`):
  owns the entry list, persists pinned entries (`IStateService`), tracks
  open windows (`IWindowsMainService` open/destroy/workspace-change events), performs
  the switch, and broadcasts `onDidChangeEntries` to every renderer over an IPC channel.
  - Entry: `{ id, uri (folder | .code-workspace, may carry vscode-remote authority),
    label, host ('local' | remote authority label), pinned, windowId? , active }`.
  - Every window with a workspace is auto-listed; pinned entries survive close.
  - Closing the visible window reveals the most-recently-used hidden one in place.
- **Renderer part** `Parts.WORKSPACEBAR_PART` (`src/vs/workbench/browser/parts/workspacebar/`):
  full-width row in the workbench grid directly under the title bar (above banner,
  sidebar and editor tabs). Entries are grouped by host: `host ▸ ws | ws   host ▸ ws`.
  Active entry highlighted; hidden-but-open entries carry a live dot; pinned-but-closed
  are dimmed. `+` opens a quick pick (open folder, recent workspaces incl. remote,
  connect to host when a remote extension is present). Context menu: pin/unpin, close
  window, remove. Commands: `workbench.action.workspaceBar.{next,previous,switchTo1..9,toggle}`;
  setting `workbench.workspaceBar.visible` (default true).
- Pure model logic (grouping, ordering, MRU, id derivation from URI) lives in
  `common/` and is unit-tested without Electron.

Known limits, recorded not hidden: native macOS fullscreen (each window is its own
Space) is handled by leaving fullscreen on switch [FUTURE: simple-fullscreen sync];
Remote-SSH from Microsoft is licence-locked to official builds — host entries rely on
an OSS remote extension (Open VSX gallery configured in product.json) [OPEN].

## 2. Chandra workflow graph (directed acyclic/cyclic hypergraph)

Built-in extension `vibe-chandra`, three layers, only the last one imports `vscode`:

1. **model** (`src/model/`): reads the four ledgers under `results/ledgers/<db>/paper_<P>/`
   (knowledge `nodes.jsonl`, error `trials.jsonl`, claim `entries.jsonl`, result rows),
   folds append-only history to the latest active row per node (respecting
   `supersedes` / `retired`), and produces a hypergraph:
   nodes (status, domain, task, trial counts, evidence), and **hyperedges**
   `{sources[] → target}` — one per node with its full predecessor set (AND-join), which
   is what a Chandra dependency actually is. Cycles are legal input (repair / retry
   loops, cross-paper merges): SCCs are computed and reported, never rejected.
2. **view** (`src/view/`): dependency-free layered layout (cycle-breaking by DFS
   back-edge reversal → longest-path layering → barycenter ordering → hyperedge
   junction routing: sources merge into one junction, one arrow into the target;
   reversed edges drawn as loop-backs) rendered to SVG. Interaction modelled on
   archify (github.com/tt-a1i/archify): search, focus a node → upstream/downstream
   reach, route probe between two nodes, status lens, keyboard-first, stable
   `#focus=` state, light/dark from VS Code theme variables. Runs unmodified in a plain
   browser page (`harness/index.html`) for visual tests.
3. **integration** (`src/extension.ts`): activity-bar container "Chandra", graph as a
   webview view + openable as an editor panel, ledger file watcher for live refresh,
   node drill-down (trial list, evidence, task file → open in editor), paper picker.
   Activates only when the workspace has `results/ledgers/`.

Mermaid stays the repo's text view (`_common/visualization/dag_mermaid.py`); the
extension reads the same ledgers, so the two can never disagree about state.

## 3. Branding + CLI

`product.json` patch: nameShort `Vibe`, nameLong `Vibe Studio Code`, applicationName
`vibe`, dataFolderName `.vibe`, urlProtocol `vibe`, bundle id `dev.chandra.vibe`,
Open VSX gallery. `vibe/bin/vibe` launches the packaged app if present, else the dev
build; `scripts/install-cli.sh` symlinks it into a user-writable bin dir. `code` is
left untouched.

## 4. Verification

- Unit: upstream mocha runner for core (`scripts/test.sh --run <file>`), node test
  runner for the extension model/layout. Tests land before/with code.
- Visual: `vibe/scripts/shot.mjs` drives the dev build over CDP, saves PNGs under
  `/tmp/chandra/…` (never committed); the orchestrating session inspects them and
  iterates. The graph view is also checked in a browser via the harness page.
- Progress: knowledge-ledger nodes `vibe::<slug>` (paper `vibe`, domain `software`),
  one gated commit per node, promotion to `solid` only through the admission gate.

## 5. DAG

```
scaffold ─┬─ build ─┬─ branding ───────────────┐
          │         ├─ wsbar-model ─ wsbar-main ─ wsbar-part ─┬─ visual ─ package
          │         └──────────────────────────────────────────┤
          └─ dag-model ─ dag-view ─ dag-integration ───────────┘
```

## 6. Remote hosts over SSH (`~/.ssh/config`, like VS Code)

Goal: pick a `Host` from `~/.ssh/config` (first target: `anta`) and get a remote window
whose host shows up as its own group in the workspace bar — no per-host setup.

- **Resolver.** Microsoft's Remote-SSH is licence-locked to official builds. Vibe ships
  the MIT `open-remote-ssh` resolver (authority `ssh-remote+<host>`, its own
  `~/.ssh/config` parser incl. ProxyJump/agent/identity files, Remote Explorer) as a
  built-in, with the API proposals it needs allow-listed in `product.json`.
- **Server.** A remote window needs a server whose `commit` equals the client's.
  Microsoft's server build is licence-restricted to their products, and VSCodium
  publishes no build of our pinned upstream version — so Vibe builds its own
  `vibe-server` (upstream `vscode-reh-<platform>-<arch>` from the same checkout; JS
  bundle + target Node on the Mac, the handful of native modules compiled for
  linux-x64 against an old glibc in a container). Output is a gitignored tarball keyed
  by commit under `vibe/.build/server/`.
- **Install = upload, not download.** There is no public URL hosting our server, and
  many research hosts have no outbound internet anyway. On connect, if
  `~/.vibe-server/bin/<commit>/` is missing, the local tarball is uploaded over the
  already-authenticated SSH connection and unpacked (VS Code's `localServerDownload`
  behaviour). `~/.vscode-server` is never touched.
- **Workspace bar.** `+` lists the concrete hosts of `~/.ssh/config`; picking one opens
  an empty remote window in the frame, where Open Folder browses the remote disk.
  The model already labels `ssh-remote+anta` as host `anta`.

DAG: `package → remote-server → remote-ssh → remote-anta` (end-to-end acceptance on the
real host: connect, open a folder, run `hostname` in the terminal, screenshot).

## 7. Name and icon

The application is **Vibe Slop Code** (`nameLong`); the short name, command, data
folders, bundle id and URL scheme stay `Vibe` / `vibe` / `.vibe` / `dev.chandra.vibe`,
so profiles, the CLI link and installed servers survive the rename. The icon is the
product's own idea drawn small: a directed hypergraph of **five rectangular nodes** with
one AND-join (two sources meet in a junction, one arrow continues), readable at 16 px.
Source of truth is `vibe/branding/icon.svg`; `vibe/scripts/make-icon.sh` renders the
platform files (`.icns`, `.png`, `.ico`) deterministically into the checkout.

## 8. Agents (activity bar) — which agent has finished, which has not

Built-in extension `vibe-agents`: an **Agents** container in the activity bar with a
webview dashboard — one card per agent session (profile, workspace, state, elapsed,
last line, Focus / Stop / Restart / Dismiss) — a view badge, and a status-bar summary.
Agents run in ordinary integrated terminals, started from a profile (`claude`, `codex`,
ChatGPT Web, custom) or adopted when the user starts a known agent command by hand.
State comes from the terminal itself, no agent cooperation needed: shell-integration
start/end events and exit codes (running / finished / failed), and for interactive
agents that never exit, the output stream — BEL / OSC 9 / OSC 777 notifications and
output quiescence mean *turn finished, waiting for you*; new output means *working*.
Because hidden windows keep running (§1), each window reports its counts to the
workspace-bar service, and the bar shows a per-tab badge: one glance answers "where is
an agent waiting for me" across every host and workspace.

## 9. ChatGPT Web through Codex (codex-chatgpt-web)

`github.com/miuuyy/codex-chatgpt-web` (MIT, unofficial browser automation; its launcher
"Codex Web GPT" holds the user's ChatGPT login) exposes ChatGPT Web models inside the
Codex CLI. Vibe does not embed or drive it; it integrates at the seam that already
exists — Codex: an agent profile that starts Codex on a ChatGPT Web model, a launcher
status row (installed / running / models present) with an Open Launcher action, and a
Chandra skill so a mission can route a worker or a cross-model review through it. The
bridge's state directory, browser profile and tokens are never read.

DAG: `remote-anta → rename → icon`, `rename → agents → chatgpt-web`, all → `release`.
