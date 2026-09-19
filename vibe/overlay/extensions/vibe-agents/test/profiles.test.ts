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

test('a provider prepares the start of its own profiles: it may fill them in, and it may refuse', async () => {
	const registry = new ProfileRegistry();
	const asked: (string | undefined)[] = [];
	const bridge: AgentProfile = { id: 'web-bridge', label: 'Web Bridge', command: 'codex' };
	let ready = true;
	registry.registerProvider({
		id: 'bridge',
		provideProfiles: () => [bridge, { id: 'codex', label: 'Shadowed', command: 'other' }],
		prepareLaunch: async request => {
			asked.push(request.restartOf);
			return ready ? { ...request.profile, label: 'Web Bridge (High)', args: ['-m', 'high'] } : undefined;
		},
	});
	registry.registerProvider({ id: 'plain', provideProfiles: () => [{ id: 'plain', label: 'Plain', command: 'plain' }] });

	assert.deepEqual(await registry.prepareLaunch(bridge), { id: 'web-bridge', label: 'Web Bridge (High)', command: 'codex', args: ['-m', 'high'] });
	assert.deepEqual(await registry.prepareLaunch(bridge, 'codex -m high'), { id: 'web-bridge', label: 'Web Bridge (High)', command: 'codex', args: ['-m', 'high'] });
	ready = false;
	assert.equal(await registry.prepareLaunch(bridge), undefined, 'refused: nothing starts');
	assert.deepEqual(asked, [undefined, 'codex -m high', undefined]);

	// profiles nobody prepares start as they are: built-in ones, the ones of the user, and an id a provider lost to them
	const codex = registry.get('codex');
	assert.equal(codex?.label, 'Codex');
	assert.equal(await registry.prepareLaunch(codex!), codex);
	assert.equal((await registry.prepareLaunch(registry.get('plain')!))?.label, 'Plain');
	registry.setUserProfiles([{ id: 'web-bridge', label: 'Mine', command: 'mine' }]);
	assert.equal((await registry.prepareLaunch(registry.get('web-bridge')!))?.label, 'Mine');
	assert.equal(asked.length, 3);
});

test('providers of status rows are told whether the rows are on screen', () => {
	const registry = new ProfileRegistry();
	const seen: boolean[] = [];
	const registration = registry.registerStatusRowProvider({ id: 'bridge', provideStatusRows: () => [], setVisible: visible => seen.push(visible) });
	registry.setRowsVisible(true);
	registry.setRowsVisible(true);
	registry.setRowsVisible(false);
	assert.deepEqual(seen, [false, true, false]);

	registry.setRowsVisible(true);
	const late: boolean[] = [];
	registry.registerStatusRowProvider({ id: 'late', provideStatusRows: () => [], setVisible: visible => late.push(visible) });
	assert.deepEqual(late, [true], 'a provider that comes late learns what is so');
	registration.dispose();
	registry.setRowsVisible(false);
	assert.deepEqual(seen, [false, true, false, true], 'and one that left learns nothing more');
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
	registry.registerProvider({ id: 'bridge', provideProfiles: () => [{ id: 'web', label: 'Web Bridge', command: 'codex', matchCommand: '^codex\\s(?:.*\\s)?-m\\s+web/' }] });
	assert.deepEqual(match('codex -m web/high'), ['web', 'Web Bridge'], 'the profile that matches more of the command line claims it, not the first one');
	assert.deepEqual(match('codex -m native'), ['codex', 'Codex']);
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
