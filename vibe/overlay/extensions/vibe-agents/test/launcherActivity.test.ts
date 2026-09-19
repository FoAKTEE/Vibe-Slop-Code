// SPDX-License-Identifier: MIT

// The log of what Vibe itself did to the engine. It is written down for the user, so what it can hold is decided
// here and nowhere else: never what a program answered, never a path below the home, never anything token-shaped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityLog, type ActivityInput } from '../src/model/launcher/activity.ts';
import { openArgv, quitArgv } from '../src/model/launcher/runtime.ts';

const input = (patch: Partial<ActivityInput>): ActivityInput => ({ at: 1000, operation: 'probe.routeStatus', program: 'runtime', args: ['route', 'status'], outcome: 'ok', durationMs: 12, ...patch });

test('an entry: when, which operation, the documented command line, how it ended', () => {
	const log = new ActivityLog();
	assert.deepEqual(log.record(input({ exitCode: 0, note: 'route: installed, connected' })), {
		seq: 1, at: 1000, operation: 'probe.routeStatus', command: 'codex-chatgpt-web route status', outcome: 'ok', durationMs: 12, exitCode: 0, note: 'route: installed, connected',
	});
	assert.deepEqual(log.record(input({ at: 2000, operation: 'engine.startHidden', program: 'open', args: openArgv('dev.codexwebgpt.launcher', { hidden: true }), outcome: 'failed', durationMs: 3.7, exitCode: 1 })), {
		seq: 2, at: 2000, operation: 'engine.startHidden', command: 'open -g -j -b dev.codexwebgpt.launcher --args --hidden', outcome: 'failed', durationMs: 4, exitCode: 1, note: undefined,
	});
	assert.deepEqual(log.record(input({ at: 3000, operation: 'probe.health', program: undefined, args: undefined, outcome: 'timeout', durationMs: 1500 })), {
		seq: 3, at: 3000, operation: 'probe.health', command: undefined, outcome: 'timeout', durationMs: 1500, exitCode: undefined, note: undefined,
	});
	assert.equal(log.record(input({ operation: 'engine.quit', program: 'osascript', args: quitArgv('dev.codexwebgpt.launcher') })).command, 'osascript -e [quit dev.codexwebgpt.launcher]');
	assert.deepEqual(log.entries.map(entry => entry.seq), [1, 2, 3, 4], 'oldest first');
});

test('append-only and bounded: the oldest entries go, the numbering goes on, what was handed out does not change', () => {
	const log = new ActivityLog(3);
	const seen: number[] = [];
	log.onDidChange(() => seen.push(log.entries.length));
	const first = log.record(input({ at: 1 }));
	const before = log.entries;
	for (let at = 2; at <= 5; at++) {
		log.record(input({ at }));
	}
	assert.deepEqual([log.entries.map(entry => [entry.seq, entry.at]), log.dropped, seen], [[[3, 3], [4, 4], [5, 5]], 2, [1, 2, 3, 3, 3]]);
	assert.deepEqual([before.length, Object.isFrozen(before), Object.isFrozen(first)], [1, true, true]);
	assert.throws(() => { (first as { outcome: string }).outcome = 'ok'; });
	assert.throws(() => new ActivityLog(0));
});

test('redaction: no answer of a program, no token-shaped text, no home path and no path of a program can enter', () => {
	const log = new ActivityLog();
	const home = '/Users/someone';
	const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEf';
	const hostile: Partial<ActivityInput>[] = [
		{ args: ['--home', `${home}/.codex-chatgpt-web`, 'route', 'status'] },
		{ args: ['setup', '--runtime-key-file', `${home}/key`, 'sk-abcdefghijklmnop1234'] },
		{ args: ['route', 'status', `Bearer ${token}`] },
		{ program: 'codex', args: ['exec', 'summarise my private notes'] },
		{ program: 'osascript', args: ['-e', `do shell script "cat ${home}/.codex/auth.json"`] },
		{ program: 'open', args: [`${home}/Library/Application Support/Codex Web GPT/Cookies`] },
		{ note: `Configuration is valid (${home}/.codex-chatgpt-web/config.json)` },
		{ note: `control token ${token} and Bearer ${token} and sk-abcdefghijklmnop1234 and tunnel_0123456789abcdef0123456789abcdef` },
		{ note: '{"installed":true,"active":true,"routeUrl":"http://127.0.0.1:17841/v1","errors":[]}' },
		{ note: '[{"slug":"chatgpt-web/high"}]' },
		{ note: '<html><body>the conversation</body></html>' },
		{ note: 'first line\nUSER PROMPT: the second line of an answer' },
		{ note: 'see https://chatgpt.com/c/68f1-private-conversation?model=x' },
		{ operation: `${home}/evil` as ActivityInput['operation'] },
		{ exitCode: Number.NaN }, { exitCode: 1e9 }, { durationMs: -5 }, { durationMs: Number.POSITIVE_INFINITY }, { at: Number.NaN },
		{ outcome: 'sk-abcdefghijklmnop1234' as ActivityInput['outcome'] },
	];
	for (const patch of hostile) {
		log.record(input(patch));
	}
	const written = JSON.stringify(log.entries);
	assert.ok(!/\/Users\/|someone|AbCdEf|sk-abc|tunnel_0|Bearer [A-Za-z0-9]|private|PROMPT|conversation|auth\.json|Cookies|"installed"|slug|<html|routeUrl/.test(written), written);

	assert.deepEqual(log.entries.map(entry => entry.command).slice(0, 6), [
		'codex-chatgpt-web --home [path] route status',
		'codex-chatgpt-web [arg] [arg] [arg] [arg]',
		'codex-chatgpt-web route status [arg]',
		'codex [arg] [arg]',
		'osascript -e [script]',
		'open [arg]',
	]);
	assert.deepEqual(log.entries.map(entry => entry.note).slice(6, 13), [
		'Configuration is valid (~/.codex-chatgpt-web/config.json)',
		'control token [redacted] and Bearer [redacted] and [key] and [tunnel-id]',
		undefined, undefined, undefined,
		'first line',
		'see https://chatgpt.com',
	]);
	assert.deepEqual(log.entries.slice(13).map(entry => [entry.operation, entry.exitCode, entry.durationMs, entry.at, entry.outcome]), [
		['unknown', undefined, 12, 1000, 'ok'], ['probe.routeStatus', undefined, 12, 1000, 'ok'], ['probe.routeStatus', undefined, 12, 1000, 'ok'],
		['probe.routeStatus', undefined, 0, 1000, 'ok'], ['probe.routeStatus', undefined, 0, 1000, 'ok'], ['probe.routeStatus', undefined, 12, 0, 'ok'], ['probe.routeStatus', undefined, 12, 1000, 'failed'],
	]);
});
