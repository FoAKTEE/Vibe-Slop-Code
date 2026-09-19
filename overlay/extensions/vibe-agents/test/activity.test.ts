// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityTracker, DEFAULT_ACTIVITY_OPTIONS } from '../src/model/activity.ts';
import { SignalParser } from '../src/model/signals.ts';

const ESC = '\x1b';
const BEL = '\x07';

/** A tracker that is fed raw output, the way the host does it. Time only moves when the test says so. */
class Rig {
	readonly parser = new SignalParser();
	readonly tracker: ActivityTracker;
	now = 0;

	constructor(options: Partial<typeof DEFAULT_ACTIVITY_OPTIONS> = {}) {
		this.tracker = new ActivityTracker({ ...DEFAULT_ACTIVITY_OPTIONS, ...options }, this.now);
	}

	write(data: string): string {
		return this.tracker.output(this.now, data.length, this.parser.push(data));
	}

	/** Lets `ms` pass, ticking once a second like the host does. */
	wait(ms: number): string {
		const end = this.now + ms;
		while (this.now + 1000 <= end) {
			this.now += 1000;
			this.tracker.tick(this.now);
		}
		this.now = end;
		return this.tracker.tick(this.now);
	}

	/** A spinner: one redraw every 100 ms for `ms`. */
	spin(ms: number): string {
		const end = this.now + ms;
		let frame = 0;
		while (this.now < end) {
			this.write(`\r${ESC}[2K${'|/-\\'[frame++ % 4]} Working`);
			this.now += 100;
			this.tracker.tick(this.now);
		}
		return this.tracker.state;
	}
}

const TUI = `${ESC}[?2004h${ESC}[?25l`; // what an interactive agent turns on: bracketed paste, hidden cursor

test('an agent starts out working', () => {
	assert.equal(new Rig().tracker.state, 'working');
});

test('a notification or a bell means waiting, at once', () => {
	const osc9 = new Rig();
	osc9.spin(3000);
	assert.equal(osc9.write(`${ESC}]9;Turn complete${BEL}`), 'waiting');

	const bell = new Rig();
	bell.spin(3000);
	assert.equal(bell.write(BEL), 'waiting');

	const title = new Rig();
	title.spin(3000);
	assert.equal(title.write(`${ESC}]0;new title${BEL}`), 'working', 'the BEL of an OSC is no bell');
});

test('the redraw that follows a notification does not flip back to working', () => {
	const rig = new Rig();
	rig.write(TUI);
	rig.spin(3000);
	rig.write(`${ESC}]9;Turn complete${BEL}`);
	rig.now += 50;
	assert.equal(rig.write(`${ESC}[2J${ESC}[H> `), 'waiting');
	assert.equal(rig.wait(60_000), 'waiting', 'and a static screen does not flap');
});

test('quiescence means waiting for an interactive agent: default 8 s', () => {
	const rig = new Rig();
	rig.write(TUI);
	rig.spin(5000);
	assert.equal(rig.wait(7000), 'working');
	assert.equal(rig.wait(1000), 'waiting');
});

test('quiet seconds are tunable per profile, 0 never infers waiting from silence', () => {
	const fast = new Rig({ quietMs: 2000 });
	fast.write(TUI);
	assert.equal(fast.wait(1900), 'working');
	assert.equal(fast.wait(100), 'waiting');

	const never = new Rig({ quietMs: 0 });
	never.write(TUI);
	assert.equal(never.wait(3_600_000), 'working');
});

test('a plain program that is silent is still working: silence only counts once the agent is interactive', () => {
	const rig = new Rig();
	rig.write('Reading the repository...\r\n');
	assert.equal(rig.wait(600_000), 'working', 'a headless run prints nothing for minutes');
	assert.equal(rig.tracker.interactive, false);

	// the shell turned bracketed paste off before the command ran: that is no evidence
	const shell = new Rig();
	shell.write(`${ESC}[?2004l\r\nrunning\r\n`);
	assert.equal(shell.wait(60_000), 'working');

	// a mode that was turned on and off again is no evidence any more
	const onOff = new Rig();
	onOff.write(`${ESC}[?2004h`);
	onOff.write(`${ESC}[?2004l`);
	assert.equal(onOff.wait(60_000), 'working');
});

test('spinner redraws are activity: a working agent that only repaints one line never goes quiet', () => {
	const rig = new Rig();
	rig.write(TUI);
	assert.equal(rig.spin(120_000), 'working');
	// cursor movement only, not one printable character
	for (let i = 0; i < 300; i++) {
		rig.write(`${ESC}[1A${ESC}[1B`);
		rig.now += 100;
		assert.equal(rig.tracker.tick(rig.now), 'working');
	}
});

test('sustained output brings a waiting agent back to work, a keystroke echo does not', () => {
	const rig = new Rig();
	rig.write(TUI);
	rig.spin(2000);
	rig.write(`${ESC}]9;Turn complete${BEL}`);
	rig.wait(30_000);

	// the user types a few characters: echoes, each one a tiny burst
	for (const key of 'fix') {
		assert.equal(rig.write(key), 'waiting');
		rig.wait(1600);
	}

	// the agent gets going: output keeps coming
	assert.equal(rig.spin(1900), 'waiting');
	assert.equal(rig.spin(200), 'working');
});

test('known user input makes the next output count right away', () => {
	const rig = new Rig();
	rig.write(TUI);
	rig.write(BEL);
	rig.wait(10_000);
	rig.tracker.input(rig.now);
	rig.now += 300;
	assert.equal(rig.write('Thinking...'), 'working');
});

test('progress reports are explicit: busy means working at once', () => {
	const rig = new Rig();
	rig.write(TUI);
	rig.write(BEL);
	rig.wait(10_000);
	assert.equal(rig.write(`${ESC}]9;4;3;0${BEL}`), 'working');
	assert.equal(rig.write(`${ESC}]9;4;0${BEL}`), 'working', 'cleared progress alone says nothing');
});

test('waiting again after working again: each turn is detected', () => {
	const rig = new Rig();
	rig.write(TUI);
	const seen: string[] = [];
	for (let turn = 0; turn < 3; turn++) {
		seen.push(rig.spin(4000));
		seen.push(rig.wait(8000));
	}
	assert.deepEqual(seen, ['working', 'waiting', 'working', 'waiting', 'working', 'waiting']);
});

test('restoring: a tracker can start out waiting and interactive (after a window reload)', () => {
	const tracker = new ActivityTracker(DEFAULT_ACTIVITY_OPTIONS, 0, { state: 'waiting', interactive: true });
	assert.equal(tracker.tick(100_000), 'waiting');
	assert.equal(tracker.interactive, true);
});
