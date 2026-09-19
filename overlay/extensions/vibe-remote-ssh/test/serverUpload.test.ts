// SPDX-License-Identifier: MIT

// The upload install mode from end to end against a host that is a temporary folder of this
// machine: commands run in a local bash, the SFTP session copies files. No network, no host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureServerInstalled, type ServerUploadConnection, type ServerUploadOptions } from '../src/vibe/serverUpload.ts';

const APP = 'vibe-server';
const COMMIT = '8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8';

interface Host {
	readonly conn: ServerUploadConnection;
	readonly options: ServerUploadOptions;
	readonly dataDir: string;
	readonly builds: string;
	readonly uploads: string[];
	readonly log: string[];
	readonly progress: string[];
	failUpload: boolean;
}

function withHost(run: (host: Host) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), 'vibe-remote-ssh-'));
	const dataDir = join(root, 'host', '.vibe-server');
	const builds = join(root, 'builds');
	mkdirSync(builds, { recursive: true });

	const uname = spawnSync('uname', ['-sm'], { encoding: 'utf8' }).stdout.trim().split(' ');
	const platform = `${uname[0].toLowerCase()}-${uname[1] === 'x86_64' ? 'x64' : 'arm64'}`;

	const build = join(root, 'tree', `${APP}-${platform}`);
	mkdirSync(join(build, 'bin'), { recursive: true });
	writeFileSync(join(build, 'bin', APP), '#!/bin/sh\necho server\n');
	const tarball = join(builds, `${APP}-${platform}-${COMMIT}.tar.gz`);
	assert.equal(spawnSync('tar', ['-czf', tarball, '-C', join(root, 'tree'), `${APP}-${platform}`]).status, 0);
	writeFileSync(`${tarball}.sha256`, `${createHash('sha256').update(readFileSync(tarball)).digest('hex')}  ${APP}-${platform}-${COMMIT}.tar.gz\n`);

	const host: Host = {
		dataDir, builds, uploads: [], log: [], progress: [], failUpload: false,
		conn: {
			exec: async cmd => {
				const result = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
				return { stdout: result.stdout, stderr: result.stderr };
			},
			sftp: async () => ({
				fastPut: (localPath: string, remotePath: string, options: { step?: (transferred: number, chunk: number, total: number) => void }, callback: (err?: Error) => void) => {
					host.uploads.push(remotePath);
					copyFileSync(localPath, remotePath);
					if (host.failUpload) {
						return callback(new Error('connection lost'));
					}
					const size = statSync(localPath).size;
					options.step?.(size, size, size);
					callback();
				},
				unlink: (path: string, callback: (err?: Error) => void) => { unlinkSync(path); callback(); },
				end: () => { }
			}) as unknown as Awaited<ReturnType<ServerUploadConnection['sftp']>>
		},
		options: {
			productCommit: COMMIT,
			serverApplicationName: APP,
			serverDataDir: dataDir,
			hasDownloadUrlTemplate: false,
			tarballSetting: builds,
			appRoot: join(root, 'app'),
			environment: { homeDir: join(root, 'home'), serverDir: undefined }
		}
	};

	return run(host).finally(() => rmSync(root, { recursive: true, force: true }));
}

function install(host: Host, options: Partial<ServerUploadOptions> = {}): Promise<string> {
	return ensureServerInstalled(host.conn, { ...host.options, ...options }, { info: message => host.log.push(message), trace: () => { } }, message => host.progress.push(message));
}

test('absent with a build: uploaded, verified, unpacked. Present: nothing is uploaded again', () => withHost(async host => {
	assert.equal(await install(host), COMMIT);
	assert.deepEqual({
		uploads: host.uploads.length,
		dataDir: readdirSync(host.dataDir),
		server: readFileSync(join(host.dataDir, 'bin', COMMIT, 'bin', APP), 'utf8'),
		verified: host.log.some(line => line.includes('sha256 verified on the host')),
		progress: host.progress.map(message => message.replace(/[\d.]+ MB/g, 'N MB'))
	}, {
		uploads: 1,
		dataDir: ['bin'],
		server: '#!/bin/sh\necho server\n',
		verified: true,
		progress: [`Uploading ${APP} (N MB)`, `Uploading ${APP}: N MB of N MB (100%)`, `Unpacking ${APP} on the host`]
	});

	assert.equal(await install(host), COMMIT);
	assert.deepEqual([host.uploads.length, host.log.at(-1)], [1, `${APP} ${COMMIT} is installed on the host already, nothing to upload`]);
}));

test('a build from sources has no commit: the build tells it, and the second connect finds the server', () => withHost(async host => {
	assert.deepEqual([await install(host, { productCommit: undefined }), await install(host, { productCommit: undefined }), host.uploads.length], [COMMIT, COMMIT, 1]);
}));

test('absent without a build: an error that tells what to do, the host is not touched', () => withHost(async host => {
	await assert.rejects(install(host, { tarballSetting: join(host.builds, 'nothing-here') }), /scripts\/build-server\.sh.*remote\.SSH\.vibeServerTarball/s);
	assert.deepEqual([host.uploads, existsSync(host.dataDir)], [[], false]);
}));

test('a damaged build is refused before anything is uploaded', () => withHost(async host => {
	const [name] = readdirSync(host.builds).filter(candidate => candidate.endsWith('.tar.gz'));
	writeFileSync(join(host.builds, `${name}.sha256`), `${'0'.repeat(64)}  ${name}\n`);

	await assert.rejects(install(host), /is damaged/);
	assert.deepEqual(host.uploads, []);
}));

test('an upload that breaks off leaves nothing on the host', () => withHost(async host => {
	host.failUpload = true;

	await assert.rejects(install(host), /Uploading vibe-server to the host failed: connection lost/);
	assert.deepEqual([host.uploads.length, readdirSync(host.dataDir)], [1, ['bin']]);
	assert.deepEqual(readdirSync(join(host.dataDir, 'bin')), []);
}));
