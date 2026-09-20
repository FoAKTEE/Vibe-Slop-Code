#!/usr/bin/env bash
# Runs INSIDE the build container (see Dockerfile), never on the host: installs the app's
# root node_modules for /app, a copy of the checkout's root
# {package.json,package-lock.json,.npmrc,.nvmrc} plus the build/npm and remote/.npmrc its
# install scripts read, and leaves them in /app/node_modules. Gulp takes the production
# subset of that tree; the rest is what npm needs to install it the way upstream does.
# The install happens on the container's own disk, because thousands of small writes
# through a bind mount are slow, and the natives are built from source against the Electron
# headers .npmrc names - which upstream's own preinstall downloads and patches, so it runs
# here unchanged.
set -euo pipefail

WORK=/tmp/app
rm -rf "$WORK"
mkdir -p "$WORK"
cp /app/package.json /app/package-lock.json /app/.npmrc /app/.nvmrc "$WORK/"
cp -R /app/build /app/remote "$WORK/"
cd "$WORK"

# The root postinstall installs build/, remote/ and every extension of the checkout, which
# is not here: only the root dependencies are wanted. The preinstall is kept - it is what
# fetches the Electron headers and overlays upstream's custom ones. Nothing else of
# package.json changes, so `npm ci` still matches it against the lockfile.
node -e 'const f="package.json",j=JSON.parse(require("fs").readFileSync(f,"utf8"));delete j.scripts.postinstall;require("fs").writeFileSync(f,JSON.stringify(j,null,2)+"\n")'

# npm hands .npmrc to node-gyp only through the environment (build/npm/postinstall.ts).
while IFS='=' read -r key value || [ -n "$key" ]; do
	case "$key" in ''|'#'*) continue ;; esac
	value="${value%\"}"
	export "npm_config_$(printf '%s' "$key" | tr '-' '_')=${value#\"}"
done < .npmrc

export npm_config_cache=/cache/npm
# node-gyp puts the headers under $XDG_CACHE_HOME/node-gyp, and upstream's preinstall looks
# for them at that same place to overlay its own: one setting has to serve both.
export XDG_CACHE_HOME=/cache
export npm_config_python=/usr/bin/python3.11
export VSCODE_FORCE_INSTALL=1
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export JOBS="${JOBS:-$(nproc)}"
export npm_config_jobs="$JOBS"

echo "npm-ci.sh: node $(node -v), npm $(npm -v), $(gcc --version | sed -n 1p), $(ldd --version | sed -n 1p)"
# Upstream's plain `npm ci`, devDependencies included. --omit=dev would install only what
# gulp packages, but npm passes it down to the install the preinstall runs in build/npm/gyp,
# whose only dependency - node-gyp - is a devDependency: the headers would never be fetched.
npm ci

# Upstream drops the prebuilt watchers so that the source build is the one that loads.
rm -rf node_modules/@parcel/watcher-*

# The same fix upstream's postinstall applies to the installed tree (missing .js extension
# on an ESM import); without it the agent host fails to load @github/copilot-sdk.
SESSION=node_modules/@github/copilot-sdk/dist/session.js
[ ! -f "$SESSION" ] || sed -i 's#from "vscode-jsonrpc/node"#from "vscode-jsonrpc/node.js"#g' "$SESSION"

rm -rf /app/node_modules
tar -cf - node_modules | tar -xf - -C /app
echo "npm-ci.sh: node_modules -> /app"
