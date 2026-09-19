// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { SessionRegistry } from '../src/model/registry.ts';

const fakeAgent = join(import.meta.dirname, 'fake-agent.mjs');

/**
 * The stand-in agent, run for real and read by the registry the way the host reads a terminal. Time is
 * injected: the clock of the registry runs 8 times as fast as the wall clock, so that half a second of
 * spinner is four seconds of work and one second of silence is the quiet time.
 */
function runFakeAgent(args: string[], onWaiting: (write: (line: string) => void) => void): Promise<{ transitions: string[]; lastLine: string | undefined; title: string | undefined; exitCode: number | undefined }> {
	return new Promise((resolve, reject) => {
		const registry = new SessionRegistry();
		const transitions: string[] = [];
		const start = Date.now();
		const now = () => (Date.now() - start) * 8;

		const child = spawn(process.execPath, [fakeAgent, ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
		const id = registry.create({ profileId: 'fake', label: 'Fake Agent', command: 'fake', folder: undefined, adopted: false, quietMs: 8000 }, now()).id;
		registry.onDidChange(changes => {
			for (const change of changes) {
				if (change.from !== change.to) {
					transitions.push(`${change.from}>${change.to}`);
					if (change.to === 'waiting') {
						onWaiting(line => child.stdin.write(`${line}\n`));
					}
				}
			}
		});
		registry.started(id, now());

		const ticker = setInterval(() => registry.tick(now()), 25);
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => registry.output(id, chunk, now()));
		child.on('error', reject);
		child.on('close', code => {
			clearInterval(ticker);
			registry.exited(id, code ?? undefined, now());
			const session = registry.get(id);
			resolve({ transitions, lastLine: session?.lastLine, title: session?.title, exitCode: session?.exitCode });
		});
	});
}

test('fake agent: works, notifies and waits, works again after a line, exits 0', async () => {
	const result = await runFakeAgent(['--work', '0.5', '--turns', '2'], write => setTimeout(() => write('go on'), 250));
	assert.deepEqual(result, {
		transitions: ['starting>working', 'working>waiting', 'waiting>working', 'working>finished'],
		lastLine: 'Fake Agent: done',
		title: 'Fake Agent',
		exitCode: 0,
	});
});

test('fake agent: a chosen exit code fails the session', async () => {
	const result = await runFakeAgent(['--work', '0.2', '--turns', '1', '--exit', '3', '--name', 'Broken'], () => { });
	assert.deepEqual(result, { transitions: ['starting>working', 'working>failed'], lastLine: 'Broken: done', title: 'Broken', exitCode: 3 });
});

test('fake agent: without notification and bell, silence tells that the turn is over', async () => {
	const result = await runFakeAgent(['--work', '0.3', '--turns', '2', '--quiet'], write => setTimeout(() => write('exit'), 50));
	assert.deepEqual(result.transitions, ['starting>working', 'working>waiting', 'waiting>finished']);
});
