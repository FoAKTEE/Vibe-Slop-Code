// SPDX-License-Identifier: MIT

// vibe: the upload install mode. No public place hosts a server of this application, and many
// hosts cannot reach the internet anyway: the server comes from a build on this machine and
// travels over the SSH connection that is open already. `serverTarball.ts` decides, this file acts.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import type { SFTPWrapper } from 'ssh2';
import type { Log } from '../common/logger';
import { type DirectoryListing, generateProbeScript, generateUnpackScript, getTarballSearchPaths, getUploadName, parseProbeOutput, parseSha256File, parseUnpackOutput, planServerInstall } from './serverTarball.ts';

/**
 * What the upload needs of `SSHConnection`.
 */
export interface ServerUploadConnection {
	exec(cmd: string): Promise<{ stdout: string; stderr: string }>;
	sftp(): Promise<Pick<SFTPWrapper, 'fastPut' | 'unlink' | 'end'>>;
}

export type ServerUploadLog = Pick<Log, 'info' | 'trace'>;

export interface ServerUploadOptions {

	/**
	 * The commit of the application, `undefined` for a build from sources.
	 */
	readonly productCommit: string | undefined;
	readonly serverApplicationName: string;

	/**
	 * The folder of the server on the host as the install script
	 * takes it, which is with `$HOME` for the shell to expand.
	 */
	readonly serverDataDir: string;
	readonly hasDownloadUrlTemplate: boolean;

	/**
	 * The setting `remote.SSH.vibeServerTarball`.
	 */
	readonly tarballSetting: string | undefined;
	readonly appRoot: string;

	/**
	 * The home of the user and the environment variable `VIBE_SERVER_DIR`, if not the ones of the process.
	 */
	readonly environment?: { readonly homeDir: string; readonly serverDir: string | undefined };
}

export type ServerUploadProgress = (message: string) => void;

/**
 * Makes sure that the host has the server of this application and uploads
 * it otherwise. Returns the commit of the server the host is going to run.
 */
export async function ensureServerInstalled(conn: ServerUploadConnection, options: ServerUploadOptions, logger: ServerUploadLog, report: ServerUploadProgress): Promise<string> {
	const id = crypto.randomBytes(12).toString('hex');
	const app = options.serverApplicationName;

	const probeOutput = await execScript(conn, generateProbeScript(id, options.serverDataDir, app));
	const probe = parseProbeOutput(probeOutput.stdout, id);
	if (!probe) {
		logger.trace('Probe stdout:', probeOutput.stdout);
		logger.trace('Probe stderr:', probeOutput.stderr);
		throw new Error(`Could not find out what the host runs and whether it has ${app}`);
	}

	const searchPaths = getTarballSearchPaths({
		setting: options.tarballSetting,
		envDir: options.environment ? options.environment.serverDir : process.env['VIBE_SERVER_DIR'],
		appRoot: options.appRoot,
		homeDir: options.environment?.homeDir ?? os.homedir(),
		isDevBuild: !options.productCommit
	});
	const plan = planServerInstall({
		productCommit: options.productCommit,
		uname: probe.uname,
		installedCommits: probe.installedCommits,
		hasTar: probe.hasTar,
		listings: await listSearchPaths(searchPaths),
		serverApplicationName: app,
		hasDownloadUrlTemplate: options.hasDownloadUrlTemplate
	});

	logger.info(`Host is '${probe.uname}', ${app} in ${probe.dataDir}: ${probe.installedCommits.length ? probe.installedCommits.join(', ') : 'none'}`);

	switch (plan.kind) {
		case 'error':
			throw new Error(plan.message);
		case 'skip':
			logger.info(`${app} ${plan.commit} is installed on the host already, nothing to upload`);
			return plan.commit;
		case 'upstream':
			logger.info(`No build of ${app} ${plan.commit} to upload, the host is going to download it`);
			return plan.commit;
		case 'upload':
			break;
	}

	const started = Date.now();
	const size = (await fs.promises.stat(plan.tarball)).size;
	const sha256 = await getSha256(plan.tarball, logger);
	const uploadName = getUploadName(app, plan.commit, id);
	const uploadPath = `${probe.dataDir}/${uploadName}`;

	logger.info(`Uploading ${plan.tarball} (${formatSize(size)}, sha256 ${sha256}) to ${uploadPath}`);
	report(`Uploading ${app} (${formatSize(size)})`);

	const mkdir = await conn.exec(`mkdir -p '${probe.dataDir.replace(/'/g, `'\\''`)}/bin'`);
	if (mkdir.stderr.trim()) {
		logger.trace('mkdir stderr:', mkdir.stderr);
	}

	const sftp = await conn.sftp();
	try {
		await upload(sftp, plan.tarball, uploadPath, size, app, report);
	} catch (e) {
		await new Promise<void>(resolve => sftp.unlink(uploadPath, () => resolve())); // no half of an upload stays behind
		throw new Error(`Uploading ${app} to the host failed: ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		sftp.end();
	}

	const uploaded = Date.now();
	report(`Unpacking ${app} on the host`);

	const unpackOutput = await execScript(conn, generateUnpackScript({ id, dataDir: probe.dataDir, commit: plan.commit, serverApplicationName: app, uploadName, size, sha256, sha256Tool: probe.sha256Tool }));
	const unpack = parseUnpackOutput(unpackOutput.stdout, id);
	if (!unpack || unpack.error) {
		logger.trace('Unpack stdout:', unpackOutput.stdout);
		logger.trace('Unpack stderr:', unpackOutput.stderr);
		throw new Error(`Installing ${app} on the host failed: ${unpack?.error ?? 'the script did not finish'}`);
	}

	logger.info(`Installed ${app} ${plan.commit} on the host: upload ${formatDuration(uploaded - started)}, unpack ${formatDuration(Date.now() - uploaded)}, sha256 ${unpack.sha256Verified ? 'verified on the host' : 'not verified, the host has no tool for it'}`);

	return plan.commit;
}

/**
 * Runs a script the way the install script of upstream runs: whatever
 * the login shell of the user is, `bash` gets it without any quoting.
 */
function execScript(conn: ServerUploadConnection, script: string): Promise<{ stdout: string; stderr: string }> {
	return conn.exec(`echo ${Buffer.from(script).toString('base64')} | base64 -d | bash`);
}

async function listSearchPaths(searchPaths: readonly string[]): Promise<DirectoryListing[]> {
	const listings: DirectoryListing[] = [];
	for (const searchPath of searchPaths) {
		try {
			if (!(await fs.promises.stat(searchPath)).isDirectory()) {
				listings.push({ path: searchPath, files: undefined });
				continue;
			}

			const files: { name: string; mtimeMs: number }[] = [];
			for (const name of await fs.promises.readdir(searchPath)) {
				if (name.endsWith('.tar.gz')) {
					files.push({ name, mtimeMs: (await fs.promises.stat(`${searchPath}/${name}`)).mtimeMs });
				}
			}
			listings.push({ path: searchPath, files });
		} catch {
			listings.push({ path: searchPath, files: [] }); // does not exist: still part of what was searched
		}
	}

	return listings;
}

/**
 * The digest the upload must have on the host. A `.sha256` file next to
 * the build has to agree with the build, a build alone is its own reference.
 */
async function getSha256(tarball: string, logger: ServerUploadLog): Promise<string> {
	const hash = crypto.createHash('sha256');
	for await (const chunk of fs.createReadStream(tarball)) {
		hash.update(chunk);
	}
	const actual = hash.digest('hex');

	let expected: string | undefined;
	try {
		expected = parseSha256File(await fs.promises.readFile(`${tarball}.sha256`, 'utf8'));
	} catch {
		logger.trace(`No ${tarball}.sha256, the digest of the build itself is what the host has to match`);
	}

	if (expected && expected !== actual) {
		throw new Error(`${tarball} is damaged: its sha256 is ${actual}, ${tarball}.sha256 says ${expected}. Build the server again with scripts/build-server.sh.`);
	}

	return actual;
}

function upload(sftp: Pick<SFTPWrapper, 'fastPut'>, localPath: string, remotePath: string, size: number, app: string, report: ServerUploadProgress): Promise<void> {
	let reportedPercent = 0;

	return new Promise<void>((resolve, reject) => {
		sftp.fastPut(localPath, remotePath, {
			step: transferred => {
				const percent = Math.floor(transferred / size * 100);
				if (percent >= reportedPercent + 5 || (percent === 100 && reportedPercent !== 100)) {
					reportedPercent = percent;
					report(`Uploading ${app}: ${formatSize(transferred)} of ${formatSize(size)} (${percent}%)`);
				}
			}
		}, err => err ? reject(err) : resolve());
	});
}

function formatSize(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}
