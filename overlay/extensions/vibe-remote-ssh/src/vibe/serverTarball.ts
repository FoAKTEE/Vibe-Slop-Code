// SPDX-License-Identifier: MIT

// vibe: the decisions of the upload install mode. Nothing in here touches the network, the
// disk or the `vscode` API, so that all of it is covered by plain unit tests.

import * as path from 'path';

//#region Platform

export interface RemotePlatform {
	readonly os: 'linux' | 'darwin';
	readonly arch: 'x64' | 'arm64' | 'armhf';
}

const REMOTE_OS: Record<string, RemotePlatform['os']> = {
	'linux': 'linux',
	'darwin': 'darwin'
};

const REMOTE_ARCH: Record<string, RemotePlatform['arch']> = {
	'x86_64': 'x64',
	'amd64': 'x64',
	'aarch64': 'arm64',
	'arm64': 'arm64',
	'armv7l': 'armhf',
	'armv8l': 'armhf'
};

/**
 * The platform of a server build from what `uname -sm` prints on the host,
 * `undefined` for a platform that no server is built for.
 */
export function parseUname(output: string): RemotePlatform | undefined {
	const [kernel, machine] = output.trim().split(/\s+/);
	const os = REMOTE_OS[(kernel ?? '').toLowerCase()];
	const arch = REMOTE_ARCH[(machine ?? '').toLowerCase()];

	return os && arch ? { os, arch } : undefined;
}

//#endregion

//#region Finding the build

export interface TarballName {
	readonly os: string;
	readonly arch: string;
	readonly commit: string;
}

/**
 * Builds are named `<serverApplicationName>-<os>-<arch>-<commit>.tar.gz`.
 */
export function parseTarballName(fileName: string, serverApplicationName: string): TarballName | undefined {
	const prefix = `${serverApplicationName}-`;
	if (!fileName.startsWith(prefix)) {
		return undefined;
	}

	const match = /^(?<os>[a-z0-9]+)-(?<arch>[a-z0-9]+)-(?<commit>[0-9a-f]{40})\.tar\.gz$/.exec(fileName.substring(prefix.length));

	return match?.groups ? { os: match.groups.os, arch: match.groups.arch, commit: match.groups.commit } : undefined;
}

export interface TarballSearchInput {

	/**
	 * The setting `remote.SSH.vibeServerTarball`: a build or a folder of builds.
	 */
	readonly setting: string | undefined;

	/**
	 * The environment variable `VIBE_SERVER_DIR`.
	 */
	readonly envDir: string | undefined;

	/**
	 * Where the application runs from: `resources/app` of a
	 * package, the checkout of a build from sources.
	 */
	readonly appRoot: string;
	readonly homeDir: string;
	readonly isDevBuild: boolean;
}

/**
 * Where a build of the server is looked for, best first.
 */
export function getTarballSearchPaths(input: TarballSearchInput): string[] {
	const paths: string[] = [];
	if (input.setting) {
		paths.push(path.resolve(input.setting.replace(/^~(?=$|\/|\\)/, input.homeDir)));
	}

	if (input.envDir) {
		paths.push(path.resolve(input.envDir));
	}

	paths.push(path.join(path.dirname(input.appRoot), 'server'));
	paths.push(path.join(input.homeDir, '.vibe', 'servers'));

	const buildTree = input.isDevBuild ? path.dirname(input.appRoot) : getPackageBuildTree(input.appRoot);
	if (buildTree) {
		paths.push(path.join(buildTree, '.build', 'server'));
	}

	return paths;
}

/**
 * A package that was not moved out of the tree it was built in sits
 * in a folder `VSCode-<platform>-<arch>` next to the checkout.
 */
function getPackageBuildTree(appRoot: string): string | undefined {
	for (let current = appRoot, parent = path.dirname(current); parent !== current; current = parent, parent = path.dirname(current)) {
		if (/^VSCode-[a-z0-9]+-[a-z0-9]+$/.test(path.basename(current))) {
			return parent;
		}
	}

	return undefined;
}

export interface DirectoryListing {

	/**
	 * One of the search paths.
	 */
	readonly path: string;

	/**
	 * The files of the folder, `undefined` when the path is a file itself.
	 */
	readonly files: readonly { readonly name: string; readonly mtimeMs: number }[] | undefined;
}

export interface SelectedTarball {
	readonly path: string;
	readonly commit: string;
}

/**
 * The build to upload to a host of `platform`. With a `commit` only the build of that commit
 * is good. A build from sources has no commit: the newest build of the first folder that
 * has one is taken, and its name tells the commit the host is going to run.
 */
export function selectServerTarball(listings: readonly DirectoryListing[], platform: RemotePlatform, commit: string | undefined, serverApplicationName: string): SelectedTarball | undefined {
	const matches = (name: TarballName | undefined): name is TarballName => !!name && name.os === platform.os && name.arch === platform.arch && (!commit || name.commit === commit);

	for (const listing of listings) {
		if (!listing.files) {
			const name = parseTarballName(path.basename(listing.path), serverApplicationName);
			if (matches(name)) {
				return { path: listing.path, commit: name.commit };
			}

			if (!name && commit) {
				return { path: listing.path, commit }; // the user names a file: it is taken at their word
			}

			continue;
		}

		let best: { readonly fileName: string; readonly commit: string; readonly mtimeMs: number } | undefined;
		for (const file of listing.files) {
			const name = parseTarballName(file.name, serverApplicationName);
			if (matches(name) && (!best || file.mtimeMs > best.mtimeMs)) {
				best = { fileName: file.name, commit: name.commit, mtimeMs: file.mtimeMs };
			}
		}

		if (best) {
			return { path: path.join(listing.path, best.fileName), commit: best.commit };
		}
	}

	return undefined;
}

/**
 * The digest of a `.sha256` file: bare or as `sha256sum` prints it.
 */
export function parseSha256File(content: string): string | undefined {
	return /^(?<digest>[0-9a-f]{64})(\s|$)/i.exec(content.trim())?.groups?.digest.toLowerCase();
}

//#endregion

//#region Asking the host

export interface ProbeResult {
	readonly uname: string;

	/**
	 * The absolute path of the folder of the server on the host.
	 */
	readonly dataDir: string;
	readonly installedCommits: string[];
	readonly hasTar: boolean;
	readonly sha256Tool: string | undefined;
}

/**
 * A script that tells platform, installed servers and tools of the host. It prints
 * `key==value==` lines between two markers, as the install script of upstream does.
 */
export function generateProbeScript(id: string, serverDataDir: string, serverApplicationName: string): string {
	return [
		`DATA_DIR="${serverDataDir}"`,
		`echo "${id}: start"`,
		'echo "uname==$(uname -sm)=="',
		'echo "dataDir==$DATA_DIR=="',
		'for SERVER_DIR in "$DATA_DIR"/bin/*; do',
		`  if [ -s "$SERVER_DIR/bin/${serverApplicationName}" ]; then echo "installed==$(basename "$SERVER_DIR")=="; fi`,
		'done',
		'if command -v tar >/dev/null 2>&1; then echo "tar==yes=="; else echo "tar====";  fi',
		'if command -v sha256sum >/dev/null 2>&1; then echo "sha256==sha256sum=="; elif command -v shasum >/dev/null 2>&1; then echo "sha256==shasum -a 256=="; else echo "sha256===="; fi',
		`echo "${id}: end"`,
		''
	].join('\n');
}

export function parseProbeOutput(stdout: string, id: string): ProbeResult | undefined {
	const lines = getMarkedLines(stdout, id);
	if (!lines) {
		return undefined;
	}

	const values = new Map<string, string[]>();
	for (const line of lines) {
		const [key, value] = line.split('==');
		if (key && value !== undefined) {
			values.set(key, [...(values.get(key) ?? []), value]);
		}
	}

	const dataDir = values.get('dataDir')?.[0];
	if (!dataDir) {
		return undefined;
	}

	return {
		uname: values.get('uname')?.[0] ?? '',
		dataDir,
		installedCommits: (values.get('installed') ?? []).filter(commit => commit.length > 0),
		hasTar: values.get('tar')?.[0] === 'yes',
		sha256Tool: values.get('sha256')?.[0] || undefined
	};
}

/**
 * The lines between the markers of a script, `undefined` when the script did not finish.
 * Whatever a login shell prints around them is dropped.
 */
export function getMarkedLines(stdout: string, id: string): string[] | undefined {
	const startMarker = `${id}: start`;
	const start = stdout.indexOf(startMarker);
	const end = start < 0 ? -1 : stdout.indexOf(`${id}: end`, start + startMarker.length);
	if (end < 0) {
		return undefined;
	}

	return stdout.substring(start + startMarker.length, end).split(/\r?\n/).filter(line => line.length > 0);
}

//#endregion

//#region Unpacking on the host

export interface UnpackScriptOptions {
	readonly id: string;

	/**
	 * The absolute path of the folder of the server on the host, as the probe reported it.
	 */
	readonly dataDir: string;
	readonly commit: string;
	readonly serverApplicationName: string;

	/**
	 * The name of the uploaded file inside `dataDir`.
	 */
	readonly uploadName: string;
	readonly size: number;
	readonly sha256: string | undefined;
	readonly sha256Tool: string | undefined;
}

/**
 * The name of the upload of one attempt. Two windows that connect
 * to the same host at the same time do not share a file.
 */
export function getUploadName(serverApplicationName: string, commit: string, id: string): string {
	return `${serverApplicationName}-${commit}.${id}.tar.gz.part`;
}

/**
 * A script that verifies an upload, unpacks it next to the place of the server and moves it
 * there in one step, so that a server folder is complete or absent. Whatever happens, the
 * upload and the unpacked copy do not stay behind.
 */
export function generateUnpackScript(options: UnpackScriptOptions): string {
	if (!/^[0-9a-f]{7,64}$/.test(options.commit) || !/^[0-9a-f]+$/.test(options.id) || !path.posix.isAbsolute(options.dataDir) || /["$`\\\n]/.test(options.dataDir + options.uploadName + options.serverApplicationName)) {
		throw new Error(`Refusing to unpack the server into '${options.dataDir}' for commit '${options.commit}'`);
	}

	const verifyDigest = options.sha256 && options.sha256Tool
		? [
			`ACTUAL_SHA256="$(${options.sha256Tool} "$PART" | cut -d ' ' -f 1)"`,
			`if [ "$ACTUAL_SHA256" != "${options.sha256}" ]; then fail "the sha256 of the upload is $ACTUAL_SHA256, expected was ${options.sha256}"; fi`,
			'echo "sha256==verified=="'
		]
		: ['echo "sha256==skipped=="'];

	return [
		`DATA_DIR="${options.dataDir}"`,
		`SERVER_DIR="$DATA_DIR/bin/${options.commit}"`,
		`STAGING_DIR="$DATA_DIR/bin/${options.commit}.${options.id}.staging"`,
		`PART="$DATA_DIR/${options.uploadName}"`,
		`SERVER_SCRIPT="bin/${options.serverApplicationName}"`,
		'fail() {',
		'  rm -rf "$STAGING_DIR" "$PART"',
		'  echo "error==$1=="',
		`  echo "${options.id}: end"`,
		'  exit 0',
		'}',
		`echo "${options.id}: start"`,
		'if [ ! -f "$PART" ]; then fail "the upload $PART does not exist"; fi',
		'ACTUAL_SIZE="$(wc -c < "$PART" | tr -d \' \')"',
		`if [ "$ACTUAL_SIZE" != "${options.size}" ]; then fail "the upload has $ACTUAL_SIZE bytes, expected were ${options.size}"; fi`,
		...verifyDigest,
		'mkdir -p "$STAGING_DIR" || fail "cannot create $STAGING_DIR"',
		'tar -xzf "$PART" -C "$STAGING_DIR" --strip-components 1 || fail "cannot unpack the upload"',
		'if [ ! -s "$STAGING_DIR/$SERVER_SCRIPT" ]; then fail "the upload contains no $SERVER_SCRIPT"; fi',
		'if [ -s "$SERVER_DIR/$SERVER_SCRIPT" ]; then',
		'  rm -rf "$STAGING_DIR"', // another window was faster
		'else',
		'  rm -rf "$SERVER_DIR"',
		'  mv "$STAGING_DIR" "$SERVER_DIR" || fail "cannot move the server to $SERVER_DIR"',
		'fi',
		'rm -f "$PART"',
		'echo "result==ok=="',
		`echo "${options.id}: end"`,
		''
	].join('\n');
}

export interface UnpackResult {
	readonly error: string | undefined;
	readonly sha256Verified: boolean;
}

export function parseUnpackOutput(stdout: string, id: string): UnpackResult | undefined {
	const lines = getMarkedLines(stdout, id);
	if (!lines) {
		return undefined;
	}

	const values = new Map(lines.map(line => line.split('==')).map(([key, value]) => [key, value ?? ''] as const));
	if (values.get('result') !== 'ok' && !values.has('error')) {
		return undefined;
	}

	return { error: values.get('error'), sha256Verified: values.get('sha256') === 'verified' };
}

//#endregion

//#region The plan

export interface ServerInstallPlanInput {

	/**
	 * The commit of the application, `undefined` for a build from sources.
	 */
	readonly productCommit: string | undefined;
	readonly uname: string;
	readonly installedCommits: readonly string[];
	readonly hasTar: boolean;
	readonly listings: readonly DirectoryListing[];
	readonly serverApplicationName: string;

	/**
	 * Whether the user configured a place to download the server from.
	 */
	readonly hasDownloadUrlTemplate: boolean;
}

export type ServerInstallPlan =
	{ readonly kind: 'skip'; readonly commit: string } |
	{ readonly kind: 'upload'; readonly commit: string; readonly tarball: string } |

	/**
	 * What upstream does: the host downloads the server.
	 */
	{ readonly kind: 'upstream'; readonly commit: string } |
	{ readonly kind: 'error'; readonly message: string };

/**
 * What has to happen before the server can start on the host.
 */
export function planServerInstall(input: ServerInstallPlanInput): ServerInstallPlan {
	const platform = parseUname(input.uname);
	const tarball = platform ? selectServerTarball(input.listings, platform, input.productCommit, input.serverApplicationName) : undefined;
	const platformLabel = platform ? `${platform.os}-${platform.arch}` : `'${input.uname.trim()}'`;
	const searched = input.listings.map(listing => listing.path).join(', ') || '-';

	const commit = input.productCommit ?? tarball?.commit;
	if (!commit) {
		return { kind: 'error', message: `No build of ${input.serverApplicationName} for ${platformLabel} was found, and this build from sources has no commit of its own to look for on the host. Build the server with scripts/build-server.sh, or point the setting remote.SSH.vibeServerTarball to a build. Searched: ${searched}` };
	}

	if (input.installedCommits.includes(commit)) {
		return { kind: 'skip', commit };
	}

	if (tarball) {
		if (!input.hasTar) {
			return { kind: 'error', message: `The host has no 'tar' command to unpack ${input.serverApplicationName} with. Install tar on the host, or unpack ${tarball.path} there by hand into bin/${commit} of the server folder.` };
		}

		return { kind: 'upload', commit, tarball: tarball.path };
	}

	if (input.hasDownloadUrlTemplate || !platform) {
		return { kind: 'upstream', commit };
	}

	return { kind: 'error', message: `No build of ${input.serverApplicationName} for ${platformLabel} (commit ${commit}) was found to upload to the host. Build the server with scripts/build-server.sh, or point the setting remote.SSH.vibeServerTarball to a build. Searched: ${searched}` };
}

//#endregion
