# Third-party software this extension operates

## codex-chatgpt-web ("Codex Web GPT" launcher and runtime)

- Project: https://github.com/miuuyy/codex-chatgpt-web
- Licence: MIT, Copyright (c) 2026 codex-chatgpt-web contributors
- Checked against: commit `eaf4f09` (v5.0.8)

The ChatGPT Web parts of this extension (`src/model/chatgptWeb.ts`, `src/host/chatgptWeb.ts`, `src/model/launcher/`,
`src/host/launcher/`) are an **interface to** that project. They contain none of it and ship none of it: no code, no
binaries, no icons, images or videos of the project are part of Vibe. The extension runs the copy the user installed --
a handful of documented, prompt-free commands of its runtime (`--version`, `route status|connect|disconnect`,
`doctor --json`, `subagents status|compatibility-v1|native`, `service cancel-turns`), one unauthenticated
`GET /healthz` on loopback, and the launcher app through macOS (`open`, the quit event). Everything else (sign-in, smoke
test, Install models, MCP credentials, its settings, Remove integration) stays in the launcher's own window.

What follows upstream closely, and is therefore attributed here:

- the **shapes** of the command outputs that `src/model/launcher/runtime.ts` parses, and the stand-ins under
  `test/fakes/` that reproduce them, including the usage block of `--help` (upstream `src/cli.ts`, `src/doctor.ts`);
- the **redaction rules** of `sanitizeText` in `src/model/launcher/runtime.ts` (tunnel ids, `sk-` keys, bearer tokens,
  URLs reduced to their origin, the home directory), which follow upstream `launcher/electron/logging.cjs`;
- short functional strings that state a **consequence** (what Install models changes in Codex, what the smoke test
  sends, what full harness mode allows, the unofficial-automation notice). They are written in this project's own
  words and are never softer than upstream's.

codex-chatgpt-web is independent, unofficial browser automation of the user's own ChatGPT account. It is not affiliated
with or endorsed by OpenAI, and neither is this extension. "ChatGPT", "Codex" and "OpenAI" name the products that are
being operated or linked, nothing more.

### MIT License (codex-chatgpt-web)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
