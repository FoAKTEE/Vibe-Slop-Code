# Licences

[Back to the start page](index.md)

**This repository** is MIT — see [LICENSE](https://github.com/FoAKTEE/Vibe-Slop-Code/blob/main/LICENSE).
It contains the fork's own code: patches against upstream files, new files under `overlay/`, the
build scripts and the tests.

**Upstream VS Code** is MIT ([microsoft/vscode](https://github.com/microsoft/vscode)). This is a
fork of Code - OSS at the pin recorded in `upstream.json`. It is **not** Visual Studio Code and is
not affiliated with or endorsed by Microsoft. Microsoft's product name, logo and the telemetry,
gallery and remote services of their branded build are theirs and are not used here. Every patch in
`patches/` is a derivative of an MIT-licensed upstream file and stays under that licence.

**The SSH resolver** in `overlay/extensions/vibe-remote-ssh/` is a vendored copy of
[jeanp413/open-remote-ssh](https://github.com/jeanp413/open-remote-ssh) (MIT), with an upload
install mode added. Its `LICENSE.txt` and a `PROVENANCE.md` naming the upstream tag, commit and
every modification ship with it.

**codex-chatgpt-web** ([miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web),
MIT) is **not** included. The ChatGPT Web panel operates the copy you install yourself; see
[ChatGPT Web](chatgpt-web.md). ChatGPT, Codex and OpenAI are OpenAI's; this fork is not affiliated
with or endorsed by them.

**Electron, Node.js and the third-party packages** bundled by the build keep their own licences;
the app ships the notices upstream generates.

## Extensions come from Open VSX

The Microsoft Marketplace is licensed for Microsoft's own products, so a fork may not use it. This
build is configured for [Open VSX](https://open-vsx.org). In practice:

- Most open-source extensions are there, often the same builds.
- Microsoft's own extensions are not, and their licences do not allow using them in a fork. That
  includes Remote-SSH, which is why this fork ships its own resolver, and the C++, Python, Pylance,
  Remote Containers and Live Share extensions.
- A `.vsix` you have can still be installed by hand from the Extensions view.
