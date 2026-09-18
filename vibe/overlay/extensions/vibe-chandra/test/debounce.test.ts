// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BurstDebouncer, type Clock } from '../src/host/debounce.ts';

/** A clock that only moves when the test says so. */
class FakeClock implements Clock {
	time = 0;
	private next = 1;
	private readonly timers = new Map<number, { at: number; run: () => void }>();

	now(): number {
		return this.time;
	}

	setTimeout(run: () => void, ms: number): number {
		this.timers.set(this.next, { at: this.time + ms, run });
		return this.next++;
	}

	clearTimeout(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	advance(ms: number): void {
		const end = this.time + ms;
		for (; ;) {
			const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) {
				break;
			}
			this.timers.delete(due[0]);
			this.time = due[1].at;
			due[1].run();
		}
		this.time = end;
	}
}

test('debounce: a burst of appends becomes one flush, carrying every path once', () => {
	const clock = new FakeClock();
	const flushes: string[][] = [];
	const debouncer = new BurstDebouncer<string>(items => flushes.push([...items]), { quietMs: 150, maxWaitMs: 1000 }, clock);
	for (const path of ['nodes', 'trials', 'nodes', 'summary', 'nodes']) {
		debouncer.push(path);
		clock.advance(40);
	}
	assert.deepEqual(flushes, [], 'still inside the burst');
	clock.advance(150);
	assert.deepEqual(flushes, [['nodes', 'trials', 'summary']]);
	clock.advance(5000);
	assert.equal(flushes.length, 1, 'nothing pending, nothing flushed');
});

test('debounce: a writer that never pauses is still shown at least once per maxWait', () => {
	const clock = new FakeClock();
	const flushes: { at: number; items: number[] }[] = [];
	const debouncer = new BurstDebouncer<number>(items => flushes.push({ at: clock.now(), items: [...items] }), { quietMs: 150, maxWaitMs: 1000 }, clock);
	for (let i = 0; i < 30; i++) {
		debouncer.push(i);
		clock.advance(100);
	}
	clock.advance(150);
	assert.deepEqual(flushes.map(f => f.at), [1000, 2000, 3000]);
	assert.deepEqual(flushes.flatMap(f => f.items), Array.from({ length: 30 }, (_, i) => i), 'every item is delivered exactly once, in order');
});

test('debounce: flushNow delivers what is pending; dispose drops it', () => {
	const clock = new FakeClock();
	const flushes: string[][] = [];
	const debouncer = new BurstDebouncer<string>(items => flushes.push([...items]), { quietMs: 150, maxWaitMs: 1000 }, clock);
	debouncer.push('a');
	debouncer.flushNow();
	assert.deepEqual(flushes, [['a']]);
	debouncer.flushNow();
	assert.equal(flushes.length, 1);
	debouncer.push('b');
	debouncer.dispose();
	clock.advance(5000);
	debouncer.push('c');
	clock.advance(5000);
	assert.deepEqual(flushes, [['a']]);
});
