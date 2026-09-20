# Install

[Back to the start page](index.md)

Both builds are **unsigned**: no Apple Developer ID, no notarization, no Linux package signing.
Your operating system will say so. Everything below tells you what it will say and what to do.

## macOS (Apple silicon)

1. Download `VibeSlopCode-darwin-arm64-1.129.1.zip` and unzip it.
2. Move `Vibe Slop Code.app` to `/Applications`.
3. The first launch is refused: macOS reports that the app "is damaged" or cannot be opened
   because the developer cannot be verified. That is the quarantine flag on an unsigned download,
   not a diagnosis of the file. Either:
   - right-click the app, choose **Open**, then **Open** in the dialog; or
   - clear the flag yourself:

     ```sh
     xattr -dr com.apple.quarantine "/Applications/Vibe Slop Code.app"
     ```

4. Check what you downloaded before you run it:

   ```sh
   shasum -a 256 -c SHA256SUMS
   ```

There is no Intel build. Rosetta will not help: the app bundles an arm64 Electron.

## Linux (x64)

1. Download `VibeSlopCode-linux-x64-1.129.1.tar.gz`, verify it (`sha256sum -c SHA256SUMS`) and
   unpack it somewhere you own, for example `~/.local/opt/`.
2. Run the launcher inside the unpacked directory.
3. Electron's sandbox needs its helper to be owned by root and setuid. Upstream ships the same
   file, and most distributions expect you to fix it once after unpacking:

   ```sh
   sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox
   ```

   Without it the app exits with a sandbox error. Starting with `--no-sandbox` also works but
   turns off a real security boundary; prefer fixing the helper.
4. A minimal distribution may be missing the usual Electron dependencies (GTK 3, NSS, libX11 and
   friends, libsecret for credential storage). Install the set your distribution lists for
   Electron or for VS Code; the error message names the missing library.
5. To get a menu entry, copy the bundled `.desktop` file and icon into
   `~/.local/share/applications/` and `~/.local/share/icons/`, editing the `Exec=` path to where
   you unpacked it.

The Linux build is produced in a container and starts there. It has not been through a desktop
environment by its authors — see [Features](features.md) for what that means.

## The `vibe` command

The app bundles a command-line launcher, and the repository has a wrapper that finds whichever
build you have:

```sh
git clone https://github.com/FoAKTEE/Vibe-Slop-Code.git
cd Vibe-Slop-Code
scripts/install-cli.sh          # symlinks bin/vibe into the first writable bin dir on your PATH
bin/vibe --vibe-which           # prints which app or checkout it would start
```

`install-cli.sh` never uses sudo, never overwrites a file it did not create, and
`scripts/install-cli.sh --uninstall` removes only its own symlink. It does not touch `code`.

If you would rather not clone anything, symlink the launcher inside the app:

```sh
ln -s "/Applications/Vibe Slop Code.app/Contents/Resources/app/bin/code" ~/.local/bin/vibe
```

## First run

- Extensions come from [Open VSX](https://open-vsx.org), not the Microsoft Marketplace. See
  [Licences](licences.md).
- Settings, extensions and state live in `~/.vibe` (macOS also uses
  `~/Library/Application Support/Vibe`), separate from VS Code's own.
- The workspace bar, the workflow graph, the agents view and the ChatGPT Web panel are built in.
  Nothing to install.

## Uninstall

```sh
rm -rf "/Applications/Vibe Slop Code.app"   # or the unpacked Linux directory
rm -rf ~/.vibe ~/.vibe-shared               # settings, extensions, state
scripts/install-cli.sh --uninstall          # the symlink, if you made one
```

On any remote host you connected to, the server sits in `~/.vibe-server`; delete that directory to
remove it. `~/.vscode-server` on those hosts is never touched by this fork.
