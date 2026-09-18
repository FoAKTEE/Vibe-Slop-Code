#!/usr/bin/env bash
# Runs INSIDE the build container (see Dockerfile), never on the host: installs the
# server's node_modules for /remote, a copy of the checkout's
# remote/{package.json,package-lock.json,.npmrc}, and leaves them in /remote/node_modules.
# The install happens on the container's own disk, because thousands of small writes
# through a bind mount are slow, and the natives are built from source against the Node
# headers .npmrc names, as upstream's postinstall does.
set -euo pipefail

WORK=/tmp/remote
rm -rf "$WORK"
mkdir -p "$WORK"
cp /remote/package.json /remote/package-lock.json /remote/.npmrc "$WORK/"
cd "$WORK"

# npm hands .npmrc to node-gyp only through the environment (build/npm/postinstall.ts).
while IFS='=' read -r key value || [ -n "$key" ]; do
	case "$key" in ''|'#'*) continue ;; esac
	value="${value%\"}"
	export "npm_config_$(printf '%s' "$key" | tr '-' '_')=${value#\"}"
done < .npmrc

export npm_config_cache=/cache/npm
export npm_config_devdir=/cache/node-gyp
export npm_config_python=/usr/bin/python3.11
export JOBS="${JOBS:-$(nproc)}"
export npm_config_jobs="$JOBS"

echo "npm-ci.sh: node $(node -v), npm $(npm -v), $(gcc --version | sed -n 1p), $(ldd --version | sed -n 1p)"
npm ci

# Upstream drops the prebuilt watchers so that the source build is the one that loads.
rm -rf node_modules/@parcel/watcher-*

rm -rf /remote/node_modules
tar -cf - node_modules | tar -xf - -C /remote
echo "npm-ci.sh: node_modules -> /remote"
