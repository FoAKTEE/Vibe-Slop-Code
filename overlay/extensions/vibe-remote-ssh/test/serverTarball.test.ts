// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	getTarballSearchPaths, parseProbeOutput, parseSha256File, parseTarballName, parseUname, planServerInstall, selectServerTarball,
	type DirectoryListing, type ServerInstallPlanInput
} from '../src/vibe/serverTarball.ts';

const APP = 'vibe-server';
const COMMIT = '8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8';
const OTHER_COMMIT = '1111111111111111111111111111111111111111';

function tarball(os: string, arch: string, commit: string): string {
	return `${APP}-${os}-${arch}-${commit}.tar.gz`;
}

test('parseUname maps what `uname -sm` prints to the platform of a server build', () => {
	assert.deepEqual([
		parseUname('Linux x86_64\n'),
		parseUname('Linux amd64'),
		parseUname('Linux aarch64'),
		parseUname('Linux armv7l'),
		parseUname('Darwin arm64'),
		parseUname('Darwin x86_64'),
		parseUname('FreeBSD amd64'),
		parseUname('Linux riscv64'),
		parseUname(''),
		parseUname('MINGW64_NT-10.0 x86_64')
	], [
		{ os: 'linux', arch: 'x64' },
		{ os: 'linux', arch: 'x64' },
		{ os: 'linux', arch: 'arm64' },
		{ os: 'linux', arch: 'armhf' },
		{ os: 'darwin', arch: 'arm64' },
		{ os: 'darwin', arch: 'x64' },
		undefined,
		undefined,
		undefined,
		undefined
	]);
});

test('parseTarballName reads platform and commit, and nothing else', () => {
	assert.deepEqual([
		parseTarballName(tarball('linux', 'x64', COMMIT), APP),
		parseTarballName(tarball('linux', 'arm64', COMMIT), APP),
		parseTarballName(`${APP}-linux-x64-${COMMIT}.tar.gz.sha256`, APP),
		parseTarballName(`other-server-linux-x64-${COMMIT}.tar.gz`, APP),
		parseTarballName(`${APP}-linux-x64-notacommit.tar.gz`, APP),
		parseTarballName(`${APP}-linux-x64-${COMMIT}.zip`, APP)
	], [
		{ os: 'linux', arch: 'x64', commit: COMMIT },
		{ os: 'linux', arch: 'arm64', commit: COMMIT },
		undefined,
		undefined,
		undefined,
		undefined
	]);
});

test('getTarballSearchPaths: setting, environment, next to the application, user folder, build tree', () => {
	assert.deepEqual(getTarballSearchPaths({
		setting: '~/my/servers',
		envDir: '/env/servers',
		appRoot: '/Applications/Vibe Slop Code.app/Contents/Resources/app',
		homeDir: '/Users/me',
		isDevBuild: false
	}), [
		'/Users/me/my/servers',
		'/env/servers',
		'/Applications/Vibe Slop Code.app/Contents/Resources/server',
		'/Users/me/.vibe/servers'
	]);
});

test('getTarballSearchPaths: a packaged application inside its build tree finds the tree', () => {
	const paths = getTarballSearchPaths({
		setting: '',
		envDir: undefined,
		appRoot: '/repo/VSCode-darwin-arm64/Vibe Slop Code.app/Contents/Resources/app',
		homeDir: '/Users/me',
		isDevBuild: false
	});

	assert.deepEqual(paths, [
		'/repo/VSCode-darwin-arm64/Vibe Slop Code.app/Contents/Resources/server',
		'/Users/me/.vibe/servers',
		'/repo/.build/server'
	]);
});

test('getTarballSearchPaths: a build from sources looks into the build folder next to the checkout', () => {
	assert.deepEqual(getTarballSearchPaths({
		setting: undefined,
		envDir: '',
		appRoot: '/repo/vscode',
		homeDir: '/Users/me',
		isDevBuild: true
	}), [
		'/repo/server',
		'/Users/me/.vibe/servers',
		'/repo/.build/server'
	]);
});

test('selectServerTarball: platform and commit must match, the search order decides', () => {
	const listings: DirectoryListing[] = [
		{ path: '/first', files: [{ name: tarball('linux', 'arm64', COMMIT), mtimeMs: 5 }, { name: tarball('linux', 'x64', OTHER_COMMIT), mtimeMs: 9 }] },
		{ path: '/second', files: [{ name: tarball('linux', 'x64', COMMIT), mtimeMs: 1 }, { name: 'README.md', mtimeMs: 2 }] },
		{ path: '/third', files: [{ name: tarball('linux', 'x64', COMMIT), mtimeMs: 7 }] }
	];

	assert.deepEqual([
		selectServerTarball(listings, { os: 'linux', arch: 'x64' }, COMMIT, APP),
		selectServerTarball(listings, { os: 'linux', arch: 'arm64' }, COMMIT, APP),
		selectServerTarball(listings, { os: 'linux', arch: 'arm64' }, OTHER_COMMIT, APP),
		selectServerTarball(listings, { os: 'darwin', arch: 'arm64' }, COMMIT, APP),
		selectServerTarball([], { os: 'linux', arch: 'x64' }, COMMIT, APP)
	], [
		{ path: '/second/' + tarball('linux', 'x64', COMMIT), commit: COMMIT },
		{ path: '/first/' + tarball('linux', 'arm64', COMMIT), commit: COMMIT },
		undefined,
		undefined,
		undefined
	]);
});

test('selectServerTarball: without a commit (build from sources) the newest build of the first folder wins', () => {
	const listings: DirectoryListing[] = [
		{ path: '/empty', files: [] },
		{ path: '/builds', files: [{ name: tarball('linux', 'x64', OTHER_COMMIT), mtimeMs: 10 }, { name: tarball('linux', 'x64', COMMIT), mtimeMs: 20 }, { name: tarball('linux', 'arm64', OTHER_COMMIT), mtimeMs: 30 }] },
		{ path: '/later', files: [{ name: tarball('linux', 'x64', OTHER_COMMIT), mtimeMs: 99 }] }
	];

	assert.deepEqual(selectServerTarball(listings, { os: 'linux', arch: 'x64' }, undefined, APP), { path: '/builds/' + tarball('linux', 'x64', COMMIT), commit: COMMIT });
});

test('selectServerTarball: a setting that names a file is taken as is when the commit is known', () => {
	const listings: DirectoryListing[] = [{ path: '/downloads/server.tar.gz', files: undefined }];

	assert.deepEqual([
		selectServerTarball(listings, { os: 'linux', arch: 'x64' }, COMMIT, APP),
		selectServerTarball(listings, { os: 'linux', arch: 'x64' }, undefined, APP), // nothing tells the commit
		selectServerTarball([{ path: '/downloads/' + tarball('linux', 'x64', COMMIT), files: undefined }], { os: 'linux', arch: 'x64' }, undefined, APP),
		selectServerTarball([{ path: '/downloads/' + tarball('linux', 'arm64', COMMIT), files: undefined }], { os: 'linux', arch: 'x64' }, COMMIT, APP)
	], [
		{ path: '/downloads/server.tar.gz', commit: COMMIT },
		undefined,
		{ path: '/downloads/' + tarball('linux', 'x64', COMMIT), commit: COMMIT },
		undefined
	]);
});

test('parseProbeOutput reads the answer of the host between its markers', () => {
	const stdout = [
		'Welcome to the host, a login shell is chatty',
		'abc: start',
		'uname==Linux x86_64==',
		'dataDir==/home/me/.vibe-server==',
		`installed==${COMMIT}==`,
		`installed==${OTHER_COMMIT}==`,
		'tar==yes==',
		'sha256==sha256sum==',
		'abc: end',
		'logout'
	].join('\n');

	assert.deepEqual([
		parseProbeOutput(stdout, 'abc'),
		parseProbeOutput('abc: start\nuname==Darwin arm64==\ndataDir==/Users/me/.vibe-server==\ntar====\nsha256====\nabc: end', 'abc'),
		parseProbeOutput(stdout, 'other'),
		parseProbeOutput('abc: start\nuname==Linux x86_64==', 'abc')
	], [
		{ uname: 'Linux x86_64', dataDir: '/home/me/.vibe-server', installedCommits: [COMMIT, OTHER_COMMIT], hasTar: true, sha256Tool: 'sha256sum' },
		{ uname: 'Darwin arm64', dataDir: '/Users/me/.vibe-server', installedCommits: [], hasTar: false, sha256Tool: undefined },
		undefined,
		undefined
	]);
});

test('parseSha256File accepts the output of sha256sum and a bare digest', () => {
	const digest = 'a'.repeat(64);

	assert.deepEqual([
		parseSha256File(`${digest}  ${tarball('linux', 'x64', COMMIT)}\n`),
		parseSha256File(digest.toUpperCase()),
		parseSha256File('not a digest'),
		parseSha256File('')
	], [digest, digest, undefined, undefined]);
});

function plan(overrides: Partial<ServerInstallPlanInput>): ServerInstallPlanInput {
	return {
		productCommit: COMMIT,
		uname: 'Linux x86_64',
		installedCommits: [],
		hasTar: true,
		listings: [{ path: '/builds', files: [{ name: tarball('linux', 'x64', COMMIT), mtimeMs: 1 }] }],
		serverApplicationName: APP,
		hasDownloadUrlTemplate: false,
		...overrides
	};
}

test('planServerInstall: present -> skip, absent with a build -> upload, absent without -> error that tells what to do', () => {
	const uploaded = { kind: 'upload', commit: COMMIT, tarball: '/builds/' + tarball('linux', 'x64', COMMIT) };

	assert.deepEqual([
		planServerInstall(plan({ installedCommits: [OTHER_COMMIT, COMMIT] })),
		planServerInstall(plan({ installedCommits: [COMMIT], listings: [] })), // needs no build when installed
		planServerInstall(plan({})),
		planServerInstall(plan({ installedCommits: [OTHER_COMMIT] })),
		planServerInstall(plan({ listings: [], hasDownloadUrlTemplate: true })),
		planServerInstall(plan({ uname: 'FreeBSD amd64', listings: [] })), // no build of ours: what upstream does
		planServerInstall(plan({ hasTar: false }))
	].map(result => result.kind === 'error' ? { kind: 'error' } : result), [
		{ kind: 'skip', commit: COMMIT },
		{ kind: 'skip', commit: COMMIT },
		uploaded,
		uploaded,
		{ kind: 'upstream', commit: COMMIT },
		{ kind: 'upstream', commit: COMMIT },
		{ kind: 'error' }
	]);
});

test('planServerInstall: the error names platform, commit, the build script and where it looked', () => {
	const result = planServerInstall(plan({ uname: 'Linux aarch64', listings: [{ path: '/builds', files: [{ name: tarball('linux', 'x64', COMMIT), mtimeMs: 1 }] }, { path: '/home/.vibe/servers', files: [] }] }));

	assert.equal(result.kind, 'error');
	assert.match(result.kind === 'error' ? result.message : '', new RegExp(`linux-arm64.*${COMMIT}.*scripts/build-server\\.sh.*remote\\.SSH\\.vibeServerTarball.*/builds.*/home/\\.vibe/servers`, 's'));
});

test('planServerInstall: a build from sources has no commit and takes the one of the build it finds', () => {
	const listings: DirectoryListing[] = [{ path: '/builds', files: [{ name: tarball('linux', 'x64', OTHER_COMMIT), mtimeMs: 1 }, { name: tarball('linux', 'x64', COMMIT), mtimeMs: 2 }] }];

	assert.deepEqual([
		planServerInstall(plan({ productCommit: undefined, listings })),
		planServerInstall(plan({ productCommit: undefined, listings, installedCommits: [COMMIT] })),
		planServerInstall(plan({ productCommit: undefined, listings: [], installedCommits: [COMMIT] })).kind,
		planServerInstall(plan({ productCommit: undefined, listings: [], hasDownloadUrlTemplate: true })).kind
	], [
		{ kind: 'upload', commit: COMMIT, tarball: '/builds/' + tarball('linux', 'x64', COMMIT) },
		{ kind: 'skip', commit: COMMIT },
		'error',
		'error'
	]);
});
