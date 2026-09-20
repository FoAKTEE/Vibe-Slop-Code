# Remote SSH

[Back to the start page](index.md)

Microsoft's Remote-SSH extension and Microsoft's remote server are licensed for Microsoft's own
products, so a fork cannot use them. This fork ships its own resolver and builds its own server.

## How it works

1. The workspace bar's `+` menu lists the concrete hosts of your `~/.ssh/config` (`Include` is
   followed; wildcard and negated patterns are skipped). Picking one opens an empty remote window.
2. On connect, the resolver looks for `~/.vibe-server/bin/<commit>/` on the host. If it is not
   there, it **uploads** the matching server over the SSH connection you just authenticated,
   verifies its checksum on the host and unpacks it. There is no download step on the host, so
   hosts without outbound internet work.
3. Later connects find the server already installed and take a couple of seconds.
4. Open a folder, use the terminal, run tasks — as in any remote window. The status bar reads
   `SSH: <host>`.

`~/.vscode-server` on the host is never read or written. This fork uses `~/.vibe-server`.

Authentication is your own SSH setup: agent, identity files, `ProxyJump` and the rest are read
from `~/.ssh/config` by the resolver.

## The server tarball

A remote window needs a server whose commit matches the client's. Downloaded apps do not carry
one, so put it where the resolver looks:

```sh
mkdir -p ~/.vibe/servers
mv vibe-server-linux-x64-<commit>.tar.gz ~/.vibe/servers/
```

The resolver also accepts `remote.SSH.vibeServerTarball` (a direct path), `$VIBE_SERVER_DIR`, a
`server/` directory next to the app, and — in a clone — `.build/server/`. If nothing matches the
host's platform and the client's commit, the dialog says so and names the build script.

To build one yourself (Docker required, the native modules are compiled in a container against an
old glibc):

```sh
scripts/build-server.sh            # writes .build/server/vibe-server-linux-x64-<commit>.tar.gz
scripts/verify-server.sh <tarball> # layout, ELF checks, product identity, glibc ceiling
scripts/build-server.sh --link-only   # links it into ~/.vibe/servers for an installed app
```

## Requirements and limits

- **linux-x64 hosts only.** No arm64 server build yet; `scripts/build-server.sh --arch arm64`
  exists but has not been produced or tested. No Windows remotes.
- **glibc 2.28 or newer** on the host (RHEL/CentOS 8, Debian 10, Ubuntu 18.10 and later). The
  server's Node and every native module are built against that floor; two prebuilt helper binaries
  that upstream ships need glibc 2.34 and are only spawned by features that use them.
- **The upload is about 200 MB** the first time per host and commit, over your SSH connection.
- **Untested:** hosts that need a password or 2FA at connect time, and `ProxyJump` chains. They may
  work — the resolver reads the same config — but nobody has run them.
- Changing the upstream pin changes the commit, which means a new server build and a new upload.
