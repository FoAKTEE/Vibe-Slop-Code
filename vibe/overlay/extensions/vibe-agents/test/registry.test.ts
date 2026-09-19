// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry, type SessionChange } from '../src/model/registry.ts';

const ESC = '\x1b';
const BEL = '\x07';
const TUI = `${ESC}[?2004h${ESC}[?25l`;

function rig() {
	const registry = new SessionRegistry();
	const changes: SessionChange[] = [];
	registry.onDidChange(batch => changes.push(...batch));
	const transitions = () => changes.filter(change => change.from !== change.to).map(change => `${change.from ?? 'none'}>${change.to ?? 'none'}`);
	return { registry, changes, transitions };
}

const INIT = { profileId: 'claude', label: 'Claude Code', command: 'claude', folder: 'Chandra', adopted: false, quietMs: 8000 };

test('a whole life: start, work, notify, work again, exit', () => {
	const { registry, transitions } = rig();
	const id = registry.create(INIT, 0).id;
	registry.started(id, 100);
	registry.output(id, `${TUI}Reading the repository\r\n`, 200);
	registry.output(id, `${ESC}]9;Turn complete${BEL}`, 5000);
	assert.deepEqual([registry.get(id)?.state, registry.get(id)?.lastLine, registry.get(id)?.attention], ['waiting', 'Turn complete', true]);

	for (let t = 20_000; t <= 23_000; t += 100) {
		registry.output(id, `\r${ESC}[2KEditing files ${t}`, t);
	}
	assert.equal(registry.get(id)?.state, 'working');
	registry.exited(id, 0, 30_000);
	assert.deepEqual(transitions(), ['none>starting', 'starting>working', 'working>waiting', 'waiting>working', 'working>finished']);
});

test('quiescence is found by the clock, not by output', () => {
	const { registry } = rig();
	const id = registry.create(INIT, 0).id;
	registry.started(id, 0);
	registry.output(id, `${TUI}hello\r\n`, 1000);
	registry.tick(8000);
	assert.equal(registry.get(id)?.state, 'working');
	registry.tick(9000);
	assert.equal(registry.get(id)?.state, 'waiting');
});

test('the exit is also read from the stream: a shell integration mark ends a session without an API event', () => {
	const { registry } = rig();
	const id = registry.create(INIT, 0).id;
	registry.started(id, 0);
	registry.output(id, `bye\r\n${ESC}]633;D;3${BEL}`, 1000);
	assert.deepEqual([registry.get(id)?.state, registry.get(id)?.exitCode], ['failed', 3]);
	registry.exited(id, 3, 1001);
	assert.deepEqual([registry.get(id)?.state, registry.get(id)?.exitCode], ['failed', 3]);
});

test('marks before the command runs are not an exit: the prompt of the shell ends the previous command', () => {
	const { registry } = rig();
	const id = registry.create(INIT, 0).id;
	// a new terminal: the shell draws its first prompt, the command line is typed, then it executes
	registry.output(id, `${ESC}]633;D${BEL}${ESC}]633;A${BEL}$ ${ESC}]633;B${BEL}claude\r\n${ESC}]633;E;claude${BEL}${ESC}]633;C${BEL}`, 500);
	assert.equal(registry.get(id)?.state, 'working', 'the C mark starts it');
	registry.output(id, `${ESC}]633;D;0${BEL}`, 900);
	assert.equal(registry.get(id)?.state, 'finished');
});

// As captured from zsh with powerlevel10k, which draws no shell integration marks at all
const P10K_PROMPT = `${ESC}]633;P;PromptType=p10k${BEL}${ESC}]2;me@mac:~/Chandra${BEL}${ESC}]7;file://mac.local/Users/me/Chandra${BEL}~/Chandra > ${ESC}[?1h${ESC}=${ESC}[?25h${ESC}[?2004h`;

test('a shell without marks: it is ready for a command line once its line editor is on, not while it asks something', () => {
	const { registry } = rig();
	const id = registry.create(INIT, 0).id;
	assert.equal(registry.isPromptReady(id), false);

	registry.output(id, '[oh-my-zsh] Would you like to update? [Y/n] ', 100);
	assert.equal(registry.isPromptReady(id), false, 'typing now would answer the question');

	registry.output(id, `n\r\n${P10K_PROMPT}`, 5000);
	assert.deepEqual([registry.isPromptReady(id), registry.get(id)?.state], [true, 'starting']);

	// the line editor goes off when a command line is accepted
	registry.output(id, `${ESC}[?2004l\r\n`, 6000);
	assert.equal(registry.isPromptReady(id), false);
	assert.equal(registry.isPromptReady('nope'), false);
});

test('a shell without marks: its prompt coming back ends the session, the exit code is not known', () => {
	const { registry, transitions } = rig();
	const id = registry.create(INIT, 0).id;
	registry.output(id, P10K_PROMPT, 100);
	assert.equal(registry.get(id)?.state, 'starting', 'the prompt before the command is no exit');

	registry.started(id, 200); // the command line was typed into the terminal
	registry.output(id, `claude${ESC}[?2004l\r\n${TUI}Welcome back\r\n`, 300);
	registry.output(id, `${ESC}]9;Turn complete${BEL}`, 5000);
	assert.equal(registry.get(id)?.state, 'waiting');

	registry.output(id, `${ESC}[?2004l${ESC}[?25hGoodbye for now\r\n${P10K_PROMPT}`, 9000);
	assert.deepEqual([registry.get(id)?.state, registry.get(id)?.exitCode, registry.get(id)?.lastLine], ['finished', undefined, 'Goodbye for now']);
	assert.deepEqual(transitions(), ['none>starting', 'starting>working', 'working>waiting', 'waiting>finished']);
});

test('the last words of an agent count although the editor reports its exit before its last output arrives', () => {
	const { registry } = rig();
	const id = registry.create(INIT, 0).id;
	registry.started(id, 0);
	registry.output(id, `\r${ESC}[2K| Working (2s)`, 100);
	registry.exited(id, 3, 200); // the API event overtakes the data
	registry.output(id, `\r${ESC}[2KTurn 1 of 1 complete\r\nFake Tests: done\r\n${ESC}]633;D;3${BEL}${ESC}]633;A${BEL}Chandra % ${ESC}]633;B${BEL}`, 210);
	assert.deepEqual([registry.get(id)?.state, registry.get(id)?.exitCode, registry.get(id)?.lastLine], ['failed', 3, 'Fake Tests: done']);

	// what the shell prints once its prompt is back is not the agent any more
	registry.output(id, 'ls\r\nREADME.md notes.txt\r\n', 5000);
	assert.equal(registry.get(id)?.lastLine, 'Fake Tests: done');
});

test('captured: zsh marks a partial line with % before its exit mark, which must not replace the last words', () => {
	// window.onDidWriteTerminalData of a command that exits with 3, the exit event of the editor came first
	const { registry } = rig();
	const id = registry.create(INIT, 0).id;
	registry.started(id, 0);
	registry.output(id, `\r${ESC}[2K${ESC}[36m\u2807${ESC}[0m Working\u2026 (2s \u2022 esc to interrupt)`, 100);
	registry.exited(id, 3, 200);
	registry.output(id, `\r${ESC}[2K${ESC}[36m\u280f${ESC}[0m Working\u2026 (3s \u2022 esc to interrupt)\r${ESC}[2K${ESC}[32m\u2713${ESC}[0m Turn 1 of 1 complete: 3 files changed\r\r\n${ESC}[?25hFake Tests: done\r\r\n${ESC}[?25h${ESC}[?2004l${ESC}[1m${ESC}[7m%${ESC}[27m${ESC}[1m${ESC}[0m${' '.repeat(80)}\r \r${ESC}]633;D;3${BEL}`, 240);
	registry.output(id, `${ESC}]633;P;Cwd=/Users/me/Chandra${BEL}\r${ESC}[0m${ESC}[J${ESC}]633;A${BEL}${ESC}[36mChandra${ESC}[39m % ${ESC}]633;B${BEL}${ESC}[K${ESC}[?2004h`, 245);
	assert.deepEqual([registry.get(id)?.state, registry.get(id)?.exitCode, registry.get(id)?.lastLine], ['failed', 3, 'Fake Tests: done']);
});

test('a line that says nothing does not hide the one before it in the same output', () => {
	const { registry } = rig();
	const id = registry.create(INIT, 0).id;
	registry.started(id, 0);
	registry.output(id, 'Wrote 3 files\r\n\u2570\u2500\u2500\u2500\u256f\r\n> \r\n', 100);
	assert.equal(registry.get(id)?.lastLine, 'Wrote 3 files');
});

test('the prompt that follows the exit in the same output is not the last line of the agent', () => {
	const { registry } = rig();
	const id = registry.create(INIT, 0).id;
	registry.started(id, 0);
	registry.output(id, `All done here\r\n${ESC}]633;D;0${BEL}${ESC}[1;1Hme@host ~/work on main${ESC}[2;1H> `, 100);
	assert.deepEqual([registry.get(id)?.state, registry.get(id)?.lastLine], ['finished', 'All done here']);
});

test('no change, no event; unknown ids are ignored', () => {
	const { registry, changes } = rig();
	const id = registry.create(INIT, 0).id;
	registry.started(id, 0);
	const before = changes.length;
	registry.started(id, 10);
	registry.tick(20);
	registry.seen(id);
	registry.output('nope', 'x', 30);
	registry.exited('nope', 0, 30);
	assert.equal(changes.length, before);
});

test('output lines update the card, but not more than the last one per chunk', () => {
	const { registry, changes } = rig();
	const id = registry.create(INIT, 0).id;
	registry.started(id, 0);
	const before = changes.length;
	registry.output(id, 'first line of many\r\nsecond line of many\r\nthird line of many\r\n', 100);
	assert.equal(registry.get(id)?.lastLine, 'third line of many');
	assert.equal(changes.length, before + 1);
});

test('what the shell says before the command runs is not the agent: no title, no last line, no notification', () => {
	const { registry } = rig();
	const id = registry.create(INIT, 0).id;
	// a login shell on a remote host: a title, what its startup files print, a bell, then the prompt
	registry.output(id, `${ESC}]0;me@anta: ~/packages${BEL}credential.usehttppath=true\r\nLast login: Fri Sep 18\r\n${BEL}${ESC}]633;A${BEL}me@anta:~/packages$ ${ESC}]633;B${BEL}`, 100);
	assert.deepEqual([registry.get(id)?.state, registry.get(id)?.title, registry.get(id)?.lastLine, registry.get(id)?.attention], ['starting', undefined, undefined, false]);

	// from the moment the command executes, it is the agent that talks
	registry.output(id, `node agent.mjs\r\n${ESC}]633;C${BEL}${ESC}]0;Fix login bug${BEL}Reading the repository\r\n`, 200);
	assert.deepEqual([registry.get(id)?.state, registry.get(id)?.title, registry.get(id)?.lastLine], ['working', 'Fix login bug', 'Reading the repository']);
});

test('a note of the host shows on the card until the agent has something to say', () => {
	const { registry, changes } = rig();
	const id = registry.create(INIT, 0).id;
	const before = changes.length;
	registry.note(id, 'Waiting for the shell prompt');
	registry.note(id, 'Waiting for the shell prompt');
	assert.deepEqual([registry.get(id)?.lastLine, registry.get(id)?.state, changes.length], ['Waiting for the shell prompt', 'starting', before + 1]);
	registry.started(id, 10);
	registry.output(id, 'Reading the repository\r\n', 20);
	assert.equal(registry.get(id)?.lastLine, 'Reading the repository');
	registry.note('nope', 'ignored');
});

test('seen, dismiss, clear finished', () => {
	const { registry } = rig();
	const a = registry.create(INIT, 0).id;
	const b = registry.create(INIT, 1).id;
	const c = registry.create(INIT, 2).id;
	registry.started(a, 10);
	registry.started(b, 10);
	registry.started(c, 10);
	registry.exited(a, 0, 20);
	registry.closed(b, 20);
	registry.seen(a);
	assert.equal(registry.get(a)?.attention, false);
	assert.deepEqual(registry.clearEnded().map(session => session.id), [a, b]);
	assert.deepEqual(registry.sessions.map(session => session.id), [c]);
	registry.dismiss(c);
	assert.deepEqual(registry.sessions, []);
});

test('restart gives the same card a fresh tracker', () => {
	const { registry } = rig();
	const id = registry.create(INIT, 0).id;
	registry.started(id, 0);
	registry.output(id, `${TUI}x`, 10);
	registry.exited(id, 1, 20);
	registry.restarted(id, 30);
	assert.deepEqual([registry.get(id)?.state, registry.get(id)?.runs], ['starting', 2]);
	registry.started(id, 40);
	registry.tick(100_000);
	assert.equal(registry.get(id)?.state, 'working', 'the evidence of the previous run is gone');
});

test('snapshots survive a reload: sessions come back as they were, trackers know whether the agent was interactive', () => {
	const { registry } = rig();
	const id = registry.create(INIT, 0).id;
	registry.started(id, 0);
	registry.output(id, `${TUI}hello\r\n`, 1000);
	const snapshot = JSON.parse(JSON.stringify(registry.snapshot()));

	const next = new SessionRegistry();
	assert.deepEqual(next.restore(snapshot, 50_000).map(session => session.id), [id]);
	assert.equal(next.get(id)?.state, 'working');
	next.output(id, 'more\r\n', 51_000);
	next.tick(60_000);
	assert.equal(next.get(id)?.state, 'waiting', 'quiescence still works: the restored tracker knows the agent is interactive');

	// a new session never reuses an id that is taken
	assert.notEqual(next.create(INIT, 60_000).id, id);

	assert.deepEqual(new SessionRegistry().restore({ version: 99, sessions: [] }, 0), []);
	assert.deepEqual(new SessionRegistry().restore('garbage', 0), []);
});
