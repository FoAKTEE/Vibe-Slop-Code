// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, reduce, type Session, type SessionEvent } from '../src/model/session.ts';
import { actionsOf, cardModelOf, compactCommand, glyphNameOf, timeTextOf } from '../src/view/cardModel.ts';

function make(...events: SessionEvent[]): Session {
	return events.reduce(reduce, createSession({ id: 'a1', profileId: 'claude', label: 'Claude Code', icon: 'sparkle', command: 'claude --resume', folder: 'Chandra', adopted: false }, 0));
}

test('working: time in state, the command line when the agent set no title', () => {
	const model = cardModelOf({ session: make({ type: 'started', at: 1000 }, { type: 'line', text: 'Reading the repository' }), stopArmed: false }, 131_000);
	assert.deepEqual(model, {
		id: 'a1',
		state: 'working',
		attention: false,
		glyph: 'sparkle',
		label: 'Claude Code',
		pill: 'Working',
		detail: 'Chandra \u00b7 claude --resume',
		detailTooltip: 'Chandra \u00b7 claude --resume',
		time: '2m 10s',
		timeTooltip: 'Working for 2m 10s',
		lastLine: 'Reading the repository',
		ariaLabel: 'Claude Code, Chandra, working for 2m 10s. Reading the repository',
		actions: ['focus', 'stop', 'restart', 'dismiss'],
		stopArmed: false,
	});
});

test('waiting: the title of the agent replaces the command line, attention is carried', () => {
	const model = cardModelOf({ session: make({ type: 'started', at: 0 }, { type: 'title', text: 'Fix login bug' }, { type: 'activity', activity: 'waiting', at: 60_000 }), stopArmed: false }, 105_000);
	assert.deepEqual([model.pill, model.attention, model.detail, model.time, model.timeTooltip, model.ariaLabel],
		['Waiting', true, 'Chandra \u00b7 Fix login bug', '45s', 'Waiting for you for 45s', 'Claude Code, Chandra, waiting for you for 45s']);
});

test('ended: when it ended and how long it ran, the exit code of a failure', () => {
	const failed = cardModelOf({ session: make({ type: 'started', at: 0 }, { type: 'exited', exitCode: 3, at: 185_000 }), stopArmed: false }, 485_000);
	assert.deepEqual([failed.pill, failed.time, failed.timeTooltip, failed.actions], ['Failed (3)', '5m ago', 'Failed 5m ago with exit code 3, ran 3m 5s', ['focus', 'restart', 'dismiss']]);

	const finished = cardModelOf({ session: make({ type: 'started', at: 0 }, { type: 'exited', exitCode: 0, at: 5000 }, { type: 'closed', at: 6000 }), stopArmed: false }, 6500);
	assert.deepEqual([finished.pill, finished.time, finished.timeTooltip, finished.actions], ['Finished', 'now', 'Finished just now, ran 5s', ['restart', 'dismiss']]);

	const closed = cardModelOf({ session: make({ type: 'started', at: 0 }, { type: 'closed', at: 6000 }), stopArmed: false }, 3_606_000);
	assert.deepEqual([closed.pill, closed.time, closed.actions], ['Closed', '1h ago', ['restart', 'dismiss']]);
});

test('a title that only repeats the name of the agent says nothing: the command line stays', () => {
	const titled = (text: string) => cardModelOf({ session: make({ type: 'started', at: 0 }, { type: 'title', text }), stopArmed: false }, 1000).detail;
	assert.deepEqual([titled('Claude Code'), titled('  claude code '), titled('Claude Code: fix login')], ['Chandra \u00b7 claude --resume', 'Chandra \u00b7 claude --resume', 'Chandra \u00b7 Claude Code: fix login']);
});

test('the command line is shown without the directories of what it names, the tooltip has all of it', () => {
	const session = { ...make({ type: 'started', at: 0 }), command: `/opt/node/bin/node /Users/me/agents/fake-agent.mjs --name 'Fake Tests' --log=/var/log/a.txt ./rel/path src/` };
	const model = cardModelOf({ session, stopArmed: false }, 1000);
	assert.equal(model.detail, `Chandra \u00b7 node fake-agent.mjs --name 'Fake Tests' --log=/var/log/a.txt ./rel/path src/`);
	assert.equal(model.detailTooltip, `Chandra \u00b7 ${session.command}`);
	assert.equal(compactCommand('claude --resume'), 'claude --resume');
	assert.equal(compactCommand('/'), '/');
});

test('no folder, an armed stop', () => {
	const session = { ...make({ type: 'started', at: 0 }), folder: undefined };
	const model = cardModelOf({ session, stopArmed: true }, 1000);
	assert.deepEqual([model.detail, model.stopArmed], ['claude --resume', true]);
});

test('actions, glyphs and the ticking text alone', () => {
	assert.deepEqual(actionsOf(make()), ['focus', 'stop', 'restart', 'dismiss']);
	assert.deepEqual(['sparkle', 'code', 'hubot', 'robot', 'terminal', 'beaker', undefined, 'no-such-icon'].map(glyphNameOf), ['sparkle', 'code', 'robot', 'robot', 'terminal', 'beaker', 'robot', 'robot']);
	assert.equal(timeTextOf(make(), 4000), '4s');
});
