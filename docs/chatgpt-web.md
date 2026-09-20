# ChatGPT Web

[Back to the start page](index.md)

The **ChatGPT Web** panel is an interface, not an integration with OpenAI. It operates a separate
program you install yourself: [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web)
(MIT) and its "Codex Web GPT" launcher, which lets the
[Codex CLI](https://github.com/openai/codex) talk to the ChatGPT web interface through browser
automation of your own account.

None of that project's code is included here. This fork only drives the parts of it that have a
command-line or loopback interface, and shows you what it finds.

## What this fork never does

- It never sees your ChatGPT login. The ChatGPT page and its session live inside the launcher's own
  window and profile; the panel does not read the launcher's browser profile, its tokens or its
  logs.
- It never sends a prompt on its own. The only thing it calls without your click is a local health
  check that sends nothing.
- Signing in, the smoke test, installing models, connecting the tool harness and the feature
  toggles are all **hand-offs**: the panel opens the launcher's window at the right step and tells
  you what to do there, because those operations exist only inside that program.

## What it costs and what it changes

Read these before you set it up.

- **"Install models" reroutes all of Codex.** It writes a loopback base URL into your Codex config,
  so from then on *every* Codex run on that machine goes through the launcher's daemon — including
  runs on ordinary models. Quit the launcher and every Codex run fails until you reopen it or pause
  the bridge. The panel's Bridge screen pauses it for you, and works even with the launcher closed.
- **The smoke test spends one real ChatGPT message** on your account.
- **Full-harness mode gives ChatGPT tool access** to the session folder. The panel's default path
  does not enable it.
- **It automates your own account.** OpenAI's terms and your workspace's policy apply, usage limits
  apply, and prompts reach OpenAI even in a temporary chat. Upstream reports accounts being limited
  when several turns start at once; the panel runs one at a time.
- **It is unofficial and can break.** When the ChatGPT page changes, the automation changes with
  it — that is upstream's problem to fix, not this fork's.

## Setting it up

1. Install the launcher from [its repository](https://github.com/miuuyy/codex-chatgpt-web) and
   install the [Codex CLI](https://github.com/openai/codex) if you do not have it.
2. In Vibe Slop Code: **Agents** in the activity bar, then the **ChatGPT Web** row, then
   **Open ChatGPT Web Panel**.
3. On the **Setup** screen, work down the checklist. `Start Engine Hidden` runs the launcher
   without its window; the steps marked *in the launcher* open its window at the right place.
4. After **Install models**, quit and reopen Codex once, then press **Refresh** in the panel. The
   row should read ready. If it reads *bridge paused*, press **Connect Bridge**.
5. Start a session from **New Agent ▸ ChatGPT Web (via Codex)** and pick a model. It runs
   `codex -m chatgpt-web/<model>` in an ordinary terminal, tracked like any other agent.

Before quitting the launcher, use **Quit Engine ▸ Pause Bridge First**, or Codex stays broken until
it is back.

## The panel's screens

**Overview** — what the launcher, its daemon and Codex look like from here, and the unofficial-
automation notice. **Setup** — the checklist above. **Models** — the ChatGPT Web models Codex can
see. **Bridge** — connect or pause the global Codex route, cancel active turns. **Engine** — start
hidden, show the window, quit. **Subagents**, **Full Harness (MCP)**, **Doctor** — the launcher's
own diagnostics and guides. **Activity** — what this panel itself ran, with arguments redacted.

## Status

Every state the panel shows was verified against stand-in programs: a fake runtime, a fake daemon
and a fake `codex`. It has never been driven against a live ChatGPT account by its authors. Expect
rough edges the first time you use it for real, and report them.
