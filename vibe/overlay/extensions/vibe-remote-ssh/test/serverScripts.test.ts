// SPDX-License-Identifier: MIT

// The scripts that run on the host are run here against a temporary folder: no network, no host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateProbeScript, generateUnpackScript, getUploadName, parseProbeOutput, parseUnpackOutput, type UnpackScriptOptions } from '../src/vibe/serverTarball.ts';

const APP = 'vibe-server';
const COMMIT = '8a7abeba6e03ea3af87bfbce9a1b7e48fed567b8';
const ID = 'abcdef012345';

function bash(script: string): string {
	const result = spawnSync('bash', [], { input: script, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);

	return result.stdout;
}

/**
 * A folder of a server on a host, with an upload of a build in it.
 */
function withUpload(run: (dataDir: string, options: UnpackScriptOptions) => void): void {
	const root = mkdtempSync(join(tmpdir(), 'vibe-remote-ssh-'));
	try {
		const build = join(root, 'build', `${APP}-linux-x64`);
		mkdirSync(join(build, 'bin'), { recursive: true });
		writeFileSync(join(build, 'bin', APP), '#!/bin/sh\necho server\n');
		writeFileSync(join(build, 'product.json'), '{}');

		const dataDir = join(root, 'home', '.vibe-server');
		mkdirSync(dataDir, { recursive: true });

		const uploadName = getUploadName(APP, COMMIT, ID);
		const upload = join(dataDir, uploadName);
		assert.equal(spawnSync('tar', ['-czf', upload, '-C', join(root, 'build'), `${APP}-linux-x64`]).status, 0);

		run(dataDir, {
			id: ID, dataDir, commit: COMMIT, serverApplicationName: APP, uploadName,
			size: statSync(upload).size,
			sha256: createHash('sha256').update(readFileSync(upload)).digest('hex'),
			sha256Tool: 'shasum -a 256'
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('probe: a host without servers, then with one that is complete and one that is not', () => {
	withUpload(dataDir => {
		const probe = () => parseProbeOutput(bash(generateProbeScript(ID, dataDir, APP)), ID);
		const before = probe();

		mkdirSync(join(dataDir, 'bin', COMMIT, 'bin'), { recursive: true });
		writeFileSync(join(dataDir, 'bin', COMMIT, 'bin', APP), '#!/bin/sh\n');
		mkdirSync(join(dataDir, 'bin', '1'.repeat(40), 'bin'), { recursive: true }); // an install that broke off

		assert.deepEqual([before?.installedCommits, before?.dataDir, before?.hasTar, probe()?.installedCommits], [[], dataDir, true, [COMMIT]]);
	});
});

test('probe: `$HOME` of the folder of the server is expanded on the host', () => {
	const result = parseProbeOutput(bash(generateProbeScript(ID, '$HOME/.vibe-server-that-does-not-exist', APP)), ID);

	assert.deepEqual([result?.dataDir, result?.installedCommits], [`${process.env['HOME']}/.vibe-server-that-does-not-exist`, []]);
});

test('unpack: the build ends up in bin/<commit> without its top folder, nothing else stays behind', () => {
	withUpload((dataDir, options) => {
		const result = parseUnpackOutput(bash(generateUnpackScript(options)), ID);

		assert.deepEqual({
			result,
			dataDir: readdirSync(dataDir),
			bin: readdirSync(join(dataDir, 'bin')),
			server: readdirSync(join(dataDir, 'bin', COMMIT)).sort(),
			script: readFileSync(join(dataDir, 'bin', COMMIT, 'bin', APP), 'utf8')
		}, {
			result: { error: undefined, sha256Verified: true },
			dataDir: ['bin'],
			bin: [COMMIT],
			server: ['bin', 'product.json'],
			script: '#!/bin/sh\necho server\n'
		});
	});
});

test('unpack: a wrong digest or size is an error and leaves the host as it was', () => {
	withUpload((dataDir, options) => {
		const wrongDigest = parseUnpackOutput(bash(generateUnpackScript({ ...options, sha256: '0'.repeat(64) })), ID);

		assert.match(wrongDigest?.error ?? '', /sha256/);
		assert.deepEqual([readdirSync(dataDir), existsSync(join(dataDir, 'bin', COMMIT))], [[], false]);
	});

	withUpload((dataDir, options) => {
		const wrongSize = parseUnpackOutput(bash(generateUnpackScript({ ...options, size: options.size + 1 })), ID);

		assert.match(wrongSize?.error ?? '', /bytes/);
		assert.deepEqual(readdirSync(dataDir), []);
	});
});

test('unpack: a host without a tool for digests still checks the size', () => {
	withUpload((dataDir, options) => {
		const result = parseUnpackOutput(bash(generateUnpackScript({ ...options, sha256Tool: undefined })), ID);

		assert.deepEqual([result, existsSync(join(dataDir, 'bin', COMMIT, 'bin', APP))], [{ error: undefined, sha256Verified: false }, true]);
	});
});

test('unpack: a server folder that broke off is replaced, one that is complete is kept', () => {
	withUpload((dataDir, options) => {
		mkdirSync(join(dataDir, 'bin', COMMIT, 'leftover'), { recursive: true });
		const result = parseUnpackOutput(bash(generateUnpackScript(options)), ID);

		assert.deepEqual([result?.error, readdirSync(join(dataDir, 'bin', COMMIT)).sort()], [undefined, ['bin', 'product.json']]);
	});

	withUpload((dataDir, options) => {
		mkdirSync(join(dataDir, 'bin', COMMIT, 'bin'), { recursive: true });
		writeFileSync(join(dataDir, 'bin', COMMIT, 'bin', APP), 'the other window was faster');
		const result = parseUnpackOutput(bash(generateUnpackScript(options)), ID);

		assert.deepEqual([result?.error, readFileSync(join(dataDir, 'bin', COMMIT, 'bin', APP), 'utf8'), readdirSync(join(dataDir, 'bin')), readdirSync(dataDir)], [undefined, 'the other window was faster', [COMMIT], ['bin']]);
	});
});

test('unpack: what does not look like a commit or a folder of a host is refused', () => {
	withUpload((_dataDir, options) => {
		assert.throws(() => generateUnpackScript({ ...options, commit: '../..' }));
		assert.throws(() => generateUnpackScript({ ...options, commit: 'undefined' }));
		assert.throws(() => generateUnpackScript({ ...options, dataDir: 'relative/folder' }));
		assert.throws(() => generateUnpackScript({ ...options, dataDir: '/home/$(reboot)' }));
	});
});
