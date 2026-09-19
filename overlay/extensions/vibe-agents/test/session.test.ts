// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, elapsed, formatDuration, isLive, needsAttention, reduce, restoreSession, type Session, type SessionEvent } from '../src/model/session.ts';

function session(): Session {
	return createSession({ id: 's1', profileId: 'claude', label: 'Claude Code', command: 'claude', folder: 'Chandra', adopted: false }, 1000);
}

function run(start: Session, ...events: SessionEvent[]): Session {
	return events.reduce(reduce, start);
}

test('a session starts out starting, without attention', () => {
	const s = session();
	assert.deepEqual([s.state, s.attention, s.createdAt, s.stateSince, s.runs, s.terminalGone], ['starting', false, 1000, 1000, 1, false]);
});

test('starting -> working <-> waiting -> finished | failed', () => {
	let s = run(session(), { type: 'started', at: 2000 });
	assert.deepEqual([s.state, s.startedAt, s.stateSince], ['working', 2000, 2000]);

	s = reduce(s, { type: 'activity', activity: 'waiting', at: 9000 });
	assert.deepEqual([s.state, s.stateSince, s.attention], ['waiting', 9000, true]);

	s = reduce(s, { type: 'activity', activity: 'working', at: 12_000 });
	assert.deepEqual([s.state, s.stateSince, s.attention], ['working', 12_000, false], 'an agent that works again needs nobody');

	const finished = reduce(s, { type: 'exited', exitCode: 0, at: 20_000 });
	assert.deepEqual([finished.state, finished.exitCode, finished.endedAt, finished.attention], ['finished', 0, 20_000, true]);

	const failed = reduce(s, { type: 'exited', exitCode: 3, at: 20_000 });
	assert.deepEqual([failed.state, failed.exitCode, failed.attention], ['failed', 3, true]);

	const unknown = reduce(s, { type: 'exited', exitCode: undefined, at: 20_000 });
	assert.deepEqual([unknown.state, unknown.exitCode], ['finished', undefined], 'a shell that reports no exit code reports no failure');
});

test('output before the start is known also means working', () => {
	const s = reduce(session(), { type: 'activity', activity: 'working', at: 1500 });
	assert.deepEqual([s.state, s.startedAt], ['working', 1500]);
});

test('events that change nothing return the very same object', () => {
	const s = run(session(), { type: 'started', at: 2000 });
	assert.equal(reduce(s, { type: 'activity', activity: 'working', at: 3000 }), s);
	assert.equal(reduce(s, { type: 'started', at: 3000 }), s);
	assert.equal(reduce(s, { type: 'seen' }), s);
	const withLine = reduce(s, { type: 'line', text: 'Reading files' });
	assert.equal(reduce(withLine, { type: 'line', text: 'Reading files' }), withLine);
});

test('attention is cleared by looking, and only set by a transition', () => {
	let s = run(session(), { type: 'started', at: 2000 }, { type: 'activity', activity: 'waiting', at: 9000 });
	s = reduce(s, { type: 'seen' });
	assert.deepEqual([s.state, s.attention], ['waiting', false]);
	assert.equal(reduce(s, { type: 'activity', activity: 'waiting', at: 10_000 }), s, 'still waiting: nothing new to see');
	assert.equal(needsAttention(s), false);
	assert.equal(needsAttention(reduce(s, { type: 'exited', exitCode: 1, at: 11_000 })), true);
});

test('what ended stays ended: no activity, no second exit', () => {
	const s = run(session(), { type: 'started', at: 2000 }, { type: 'exited', exitCode: 2, at: 5000 });
	assert.equal(reduce(s, { type: 'activity', activity: 'working', at: 6000 }), s);
	assert.equal(reduce(s, { type: 'exited', exitCode: 0, at: 6000 }), s, 'the API event and the shell integration mark report the same exit');
	assert.equal(reduce(s, { type: 'started', at: 6000 }), s);
});

test('a terminal that goes away: a running session is closed, an ended one keeps its result', () => {
	const running = run(session(), { type: 'started', at: 2000 }, { type: 'closed', at: 4000 });
	assert.deepEqual([running.state, running.terminalGone, running.endedAt, running.attention], ['closed', true, 4000, false]);

	const failed = run(session(), { type: 'started', at: 2000 }, { type: 'exited', exitCode: 3, at: 3000 }, { type: 'closed', at: 4000 });
	assert.deepEqual([failed.state, failed.exitCode, failed.terminalGone, failed.endedAt], ['failed', 3, true, 3000]);
	assert.equal(isLive(failed), false);
	assert.equal(isLive(run(session(), { type: 'started', at: 2000 })), true);
});

test('the last line: whitespace collapsed, control characters gone, bounded, meaningless lines ignored', () => {
	let s = reduce(session(), { type: 'line', text: '  \u2502  Fix   the login\tbug  \u2502 ' });
	assert.equal(s.lastLine, 'Fix the login bug');
	s = reduce(s, { type: 'line', text: '\u2570\u2500\u2500\u2500\u256f' });
	assert.equal(s.lastLine, 'Fix the login bug');
	s = reduce(s, { type: 'line', text: 'x'.repeat(500) });
	assert.equal(s.lastLine?.length, 240);
	s = reduce(s, { type: 'notified', text: 'Turn complete', at: 5000 });
	assert.equal(s.lastLine, 'Turn complete');
	s = reduce(s, { type: 'title', text: '\u2733 Fix login bug' });
	assert.equal(s.title, '\u2733 Fix login bug');
});

test('restart: a new run in the same card', () => {
	const ended = run(session(), { type: 'started', at: 2000 }, { type: 'line', text: 'Goodbye for now' }, { type: 'exited', exitCode: 1, at: 5000 }, { type: 'closed', at: 6000 });
	const again = reduce(ended, { type: 'restarted', at: 7000 });
	assert.deepEqual(
		[again.state, again.runs, again.stateSince, again.startedAt, again.endedAt, again.exitCode, again.attention, again.terminalGone, again.lastLine, again.createdAt],
		['starting', 2, 7000, undefined, undefined, undefined, false, false, undefined, 1000]);
});

test('elapsed: time in the current state and total run time, frozen once ended', () => {
	const working = run(session(), { type: 'started', at: 2000 }, { type: 'activity', activity: 'waiting', at: 9000 });
	assert.deepEqual(elapsed(working, 12_000), { inState: 3000, total: 10_000 });
	const ended = reduce(working, { type: 'exited', exitCode: 0, at: 20_000 });
	assert.deepEqual(elapsed(ended, 99_000), { inState: 79_000, total: 18_000 });
	assert.deepEqual(elapsed(session(), 500), { inState: 0, total: 0 }, 'a clock that runs behind never shows negative time');
});

test('formatDuration', () => {
	assert.deepEqual([0, 999, 1000, 59_000, 60_000, 61_000, 3_599_000, 3_600_000, 3_660_000, 90_000_000].map(formatDuration),
		['0s', '0s', '1s', '59s', '1m', '1m 1s', '59m 59s', '1h', '1h 1m', '25h']);
});

test('restoreSession: only what a snapshot can carry, anything else is rejected', () => {
	const s = run(session(), { type: 'started', at: 2000 }, { type: 'activity', activity: 'waiting', at: 9000 });
	assert.deepEqual(restoreSession(JSON.parse(JSON.stringify(s))), s);
	assert.equal(restoreSession({ ...s, state: 'exploded' }), undefined);
	assert.equal(restoreSession({ ...s, id: 7 }), undefined);
	assert.equal(restoreSession(null), undefined);
	assert.equal(restoreSession('s1'), undefined);
});
