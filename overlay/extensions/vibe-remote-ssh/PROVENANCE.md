# Provenance

`src/` (without `src/vibe/`), `resources/icon.png` and `LICENSE.txt` are a copy of

- repository: https://github.com/jeanp413/open-remote-ssh
- tag: `v0.3.1` (the release published on Open VSX as `jeanp413.open-remote-ssh` 0.3.1)
- commit: `1240a12185b8f671ad4ec45b92acbbffb7b8c95d`
- licence: MIT, see `LICENSE.txt`

Upstream is not shipped as it is because its only way to install a server is a download
that the remote host runs (`src/scripts/server-setup.sh`). No public place hosts a server of
this application, and research hosts often cannot reach the internet. The copy adds an
upload install mode; everything else is upstream.

## Modifications

Every edit of an upstream file carries a `// vibe:` comment. `diff -ru <upstream>/src src`
shows all of them.

| File | Change |
|---|---|
| `src/ssh/sshConnection.ts` | `sftp()`: a SFTP session over the open connection |
| `src/serverSetup.ts` | `installCodeServer` calls `ensureServerInstalled` before the install script runs and takes the commit it returns (a build from sources has none of its own) |
| `src/authResolver.ts` | hands setting, application root and progress to `installCodeServer`; the error dialog shows the reason of a failed install |
| `src/vibe/serverTarball.ts` | new, pure: platform of the host, where builds are searched, which build matches, what to do, the scripts that run on the host |
| `src/vibe/serverUpload.ts` | new: probe, SFTP upload with progress, sha256 check on the host, unpack into `~/.vibe-server/bin/<commit>/` |
| `test/*.test.ts` | new, `npm test`: the pure module, and the host scripts run against a temporary folder. The vitest suite of upstream is not part of the copy |
| `package.json` | identifier `vibe.vibe-remote-ssh` (an update of `jeanp413.open-remote-ssh` from the gallery must not replace the copy), setting `remote.SSH.vibeServerTarball`, `capabilities`, `ssh2` pinned to the tarball of the commit that the lock file of upstream resolves (`jeanp413/ssh2@a169f62`) instead of a git dependency, no development dependencies besides types |
| `esbuild.mts`, `tsconfig.json`, `.vscodeignore`, `.npmrc` | built like the other built-in extensions instead of webpack. The optional native addons of `ssh2` (`cpu-features`, `sshcrypto.node`) stay external and are never built: `ssh2` falls back to JavaScript |

## Updating

Check out the new tag of upstream, copy `src/` over this one without deleting `src/vibe/`,
apply the `// vibe:` edits again (`git diff` lists what was lost), bump the version and the
facts above, then `npm test` and `npm run gulp compile-extension:vibe-remote-ssh`.
