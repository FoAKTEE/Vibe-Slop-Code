// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, reduce, type Session, type SessionEvent } from '../src/model/session.ts';
import { announcementOf, badgeOf, countSessions, orderSessions, statusBarTextOf, summaryTextOf, windowStatusOf } from '../src/model/summary.ts';

let nextId = 0;
function make(createdAt: number, ...events: SessionEvent[]): Session {
	return events.reduce(reduce, createSession({ id: `s${nextId++}`, profileId: 'claude', label: 'Claude Code', command: 'claude', folder: 'Chandra', adopted: false }, createdAt));
}

const working = (at: number) => make(at, { type: 'started', at });
const waiting = (at: number) => make(at, { type: 'started', at }, { type: 'activity', activity: 'waiting', at: at + 10 });
const seen = (s: Session) => reduce(s, { type: 'seen' });
const finished = (at: number) => make(at, { type: 'started', at }, { type: 'exited', exitCode: 0, at: at + 10 });
const failed = (at: number) => make(at, { type: 'started', at }, { type: 'exited', exitCode: 3, at: at + 10 });
const closed = (at: number) => make(at, { type: 'started', at }, { type: 'closed', at: at + 10 });

test('counts: starting counts as working, attention is what nobody looked at yet', () => {
	const counts = countSessions([make(1), working(2), working(3), waiting(4), seen(waiting(5)), finished(6), failed(7), closed(8)]);
	assert.deepEqual(counts, { total: 8, working: 3, waiting: 2, finished: 1, failed: 1, closed: 1, attention: 3, needsUser: 4 });
});

test('the summary names what is there, in the order of urgency for the reader', () => {
	assert.equal(summaryTextOf(countSessions([working(1), working(2), waiting(3)])), '2 working \u00b7 1 waiting');
	assert.equal(summaryTextOf(countSessions([failed(1), finished(2), finished(3)])), '1 failed \u00b7 2 finished');
	assert.equal(summaryTextOf(countSessions([working(1), waiting(2), failed(3), finished(4), closed(5)])), '1 working \u00b7 1 waiting \u00b7 1 failed \u00b7 1 finished');
	assert.equal(summaryTextOf(countSessions([closed(1)])), '1 closed');
	assert.equal(summaryTextOf(countSessions([])), 'No agents');
});

test('status bar, badge and window status', () => {
	const counts = countSessions([working(1), working(2), waiting(3)]);
	assert.equal(statusBarTextOf(counts), '$(hubot) 2 working \u00b7 1 waiting');
	assert.deepEqual(badgeOf(counts), { value: 1, tooltip: '1 agent needs you \u00b7 2 working \u00b7 1 waiting' });
	assert.deepEqual(windowStatusOf(counts), { working: 2, attention: 1, label: '2 working \u00b7 1 waiting' });

	// An agent that was looked at but not answered is still blocked on the user. The badge of the view counts
	// news, and that is none any more; the tab of the window is what other windows see, and there it counts.
	const calm = countSessions([working(1), seen(waiting(2))]);
	assert.equal(badgeOf(calm), undefined);
	assert.deepEqual(windowStatusOf(calm), { working: 1, attention: 1, label: '1 working \u00b7 1 waiting' });
	assert.deepEqual(windowStatusOf(countSessions([seen(waiting(1)), waiting(2), seen(finished(3)), failed(4)])), { working: 0, attention: 3, label: '2 waiting \u00b7 1 failed \u00b7 1 finished' }, 'waiting, seen or not, and what ended unseen');

	const none = countSessions([]);
	assert.equal(statusBarTextOf(none), undefined, 'no sessions: no status bar entry');
	assert.equal(windowStatusOf(none), undefined);
	assert.equal(windowStatusOf(countSessions([closed(1)])), undefined, 'nothing runs, nothing to look at: no badge on the tab');
	assert.deepEqual(badgeOf(countSessions([failed(1), waiting(2)])), { value: 2, tooltip: '2 agents need you \u00b7 1 waiting \u00b7 1 failed' });
});

test('order: attention first, then waiting, working, done, closed; newest first within', () => {
	const sessions = [closed(1), finished(2), working(3), working(4), seen(waiting(5)), waiting(6), failed(7), seen(finished(8)), make(9)];
	const names = new Map(sessions.map((s, i) => [s.id, ['closed', 'finished!', 'working3', 'working4', 'waiting-seen', 'waiting!', 'failed!', 'finished-seen', 'starting'][i]]));
	assert.deepEqual(orderSessions(sessions).map(s => names.get(s.id)), ['failed!', 'waiting!', 'finished!', 'waiting-seen', 'starting', 'working4', 'working3', 'finished-seen', 'closed']);
	assert.deepEqual(sessions.map(s => names.get(s.id))[0], 'closed', 'the input is not reordered');
});

test('announcements for screen readers name the session and what happened', () => {
	const s = waiting(1);
	assert.equal(announcementOf(s), 'Claude Code in Chandra is waiting for you');
	assert.equal(announcementOf(failed(1)), 'Claude Code in Chandra failed with exit code 3');
	assert.equal(announcementOf(finished(1)), 'Claude Code in Chandra finished');
	assert.equal(announcementOf(working(1)), 'Claude Code in Chandra is working');
	assert.equal(announcementOf(closed(1)), 'Claude Code in Chandra was closed');
});
