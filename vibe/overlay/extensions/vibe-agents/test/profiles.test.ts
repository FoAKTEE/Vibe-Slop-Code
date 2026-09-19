// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PROFILES, DEFAULT_ADOPT_PATTERN, ProfileRegistry, commandLineOf, matchCommandLine, normalizeCommandLine, parseUserProfiles, quietMsOf, type AgentProfile } from '../src/model/profiles.ts';

test('built-in profiles: Claude Code and Codex', () => {
	assert.deepEqual(BUILTIN_PROFILES.map(profile => [profile.id, profile.label, profile.command]), [
		['claude', 'Claude Code', 'claude'],
		['codex', 'Codex', 'codex'],
	]);
});

test('user profiles: valid ones are taken, broken ones are reported and skipped', () => {
	const { profiles, problems } = parseUserProfiles([
		{ id: 'review', label: 'Codex Review', command: 'codex', args: ['exec', 'review the diff'], env: { CODEX_HOME: '/tmp/c' }, cwd: '${workspaceFolder}/src', icon: 'eye', quietSeconds: 20, matchCommand: '^codex exec' },
		{ id: 'no-command', label: 'Broken' },
		{ id: 'bad regex', label: 'Bad', command: 'x', matchCommand: '(' },
		'not an object',
		{ id: 'claude', label: 'Claude (work)', command: 'claude', args: ['--model', 'large'] },
		{ id: 'review', label: 'Duplicate', command: 'codex' },
		{ id: 'typed', label: 'Typed', command: 'agent', args: 'exec', env: { A: 1 }, quietSeconds: -3 },
	]);
	assert.deepEqual(profiles.map(profile => profile.id), ['review', 'claude']);
	assert.deepEqual(profiles[0], { id: 'review', label: 'Codex Review', command: 'codex', args: ['exec', 'review the diff'], env: { CODEX_HOME: '/tmp/c' }, cwd: '${workspaceFolder}/src', icon: 'eye', quietSeconds: 20, matchCommand: '^codex exec' });
	assert.equal(problems.length, 5);
	assert.deepEqual(parseUserProfiles(undefined), { profiles: [], problems: [] });
	assert.equal(parseUserProfiles({}).problems.length, 1);
});

test('the registry merges built-in, user and provided profiles; a user profile replaces a built-in of the same id', () => {
	const registry = new ProfileRegistry();
	let changes = 0;
	registry.onDidChange(() => changes++);
	registry.setUserProfiles([{ id: 'claude', label: 'Claude (work)', command: 'claude', args: ['--model', 'large'] }, { id: 'mine', label: 'Mine', command: 'my-agent' }]);
	assert.deepEqual(registry.profiles.map(profile => profile.label), ['Claude (work)', 'Codex', 'Mine']);

	// the seam for a later node: a provider adds profiles without this extension knowing about them
	const provided: AgentProfile[] = [{ id: 'web-bridge', label: 'Web Bridge (via Codex)', command: 'codex', args: ['--profile', 'web'] }];
	const registration = registry.registerProvider({ id: 'bridge', provideProfiles: () => provided });
	assert.deepEqual(registry.profiles.map(profile => profile.id), ['claude', 'codex', 'mine', 'web-bridge']);
	assert.equal(registry.get('web-bridge')?.label, 'Web Bridge (via Codex)');
	registration.dispose();
	assert.deepEqual(registry.profiles.map(profile => profile.id), ['claude', 'codex', 'mine']);
	assert.equal(changes, 3);
});

test('status rows come from providers, a failing provider is skipped', async () => {
	const registry = new ProfileRegistry();
	registry.registerStatusRowProvider({ id: 'bridge', provideStatusRows: async () => [{ id: 'launcher', label: 'Bridge Launcher', detail: 'not running', state: 'off', action: { label: 'Open Launcher', command: 'x.open' } }] });
	registry.registerStatusRowProvider({ id: 'broken', provideStatusRows: () => { throw new Error('boom'); } });
	assert.deepEqual(await registry.statusRows(), [{ id: 'launcher', label: 'Bridge Launcher', detail: 'not running', state: 'off', action: { label: 'Open Launcher', command: 'x.open' } }]);
});

test('the command line of a profile quotes what a shell would split', () => {
	assert.equal(commandLineOf({ id: 'a', label: 'A', command: 'claude' }), 'claude');
	assert.equal(commandLineOf({ id: 'a', label: 'A', command: 'codex', args: ['exec', 'fix the bug', '--model=fast', `it's`, ''] }), `codex exec 'fix the bug' --model=fast 'it'\\''s' ''`);
	assert.equal(commandLineOf({ id: 'a', label: 'A', command: 'node /tmp/fake agent.mjs' }), 'node /tmp/fake agent.mjs', 'the command itself is shell text and stays as written');
});

test('quiet time: profile value in seconds, default 8 s', () => {
	assert.equal(quietMsOf({ id: 'a', label: 'A', command: 'a' }), 8000);
	assert.equal(quietMsOf({ id: 'a', label: 'A', command: 'a', quietSeconds: 2.5 }), 2500);
	assert.equal(quietMsOf({ id: 'a', label: 'A', command: 'a', quietSeconds: 0 }), 0);
});

test('adoption: a typed command line is matched against the profiles first, then against the default pattern', () => {
	const registry = new ProfileRegistry();
	registry.setUserProfiles([{ id: 'fake', label: 'Fake Agent', command: 'node fake-agent.mjs', matchCommand: 'fake-agent\\.mjs' }]);
	const match = (line: string) => {
		const found = matchCommandLine(registry.profiles, line, DEFAULT_ADOPT_PATTERN);
		return found ? [found.profile?.id, found.label] : undefined;
	};
	assert.deepEqual(match('claude'), ['claude', 'Claude Code']);
	assert.deepEqual(match('claude --resume'), ['claude', 'Claude Code']);
	assert.deepEqual(match('  codex exec "fix it"'), ['codex', 'Codex']);
	assert.deepEqual(match('AGENT_MODEL=large FOO="a b" claude -c'), ['claude', 'Claude Code'], 'leading environment assignments');
	assert.deepEqual(match('/opt/homebrew/bin/codex'), ['codex', 'Codex'], 'a path to the command');
	assert.deepEqual(match('npx codex'), undefined);
	assert.deepEqual(match('gemini -p hi'), [undefined, 'gemini'], 'known by the default pattern only: named after the command');
	assert.deepEqual(match('aider'), [undefined, 'aider']);
	assert.deepEqual(match('node /x/test/fake-agent.mjs --work 3'), ['fake', 'Fake Agent']);
	assert.deepEqual(match('claudette'), undefined);
	assert.deepEqual(match('echo claude'), undefined);
	assert.deepEqual(match(''), undefined);
	assert.equal(matchCommandLine(registry.profiles, 'gemini', ''), undefined, 'an empty pattern turns the default adoption off');
	assert.equal(matchCommandLine(registry.profiles, 'gemini', '('), undefined, 'a broken pattern adopts nothing');
});

test('normalizeCommandLine', () => {
	assert.equal(normalizeCommandLine('  A=1 B="x y" C=\'z\' ./node_modules/.bin/codex  exec '), 'codex  exec');
	assert.equal(normalizeCommandLine('claude'), 'claude');
	assert.equal(normalizeCommandLine('A=1'), '');
});
