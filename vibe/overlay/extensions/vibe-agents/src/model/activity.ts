// SPDX-License-Identifier: MIT

// Working or waiting: what an interactive agent that never exits is doing, told from its output alone.
// Deterministic: every method takes the time, nothing in here reads a clock.
import type { Signal } from './signals.ts';

export type Activity = 'working' | 'waiting';

export interface ActivityOptions {
	/** Silence of an interactive agent for this long means it waits for the user. 0 never infers that from silence. */
	quietMs: number;
	/** A waiting agent works again once its output kept coming for this long. */
	resumeMs: number;
	/** Output that pauses for longer than this is a new burst. */
	burstGapMs: number;
	/** Output for this long after a notification is the redraw that comes with it, not new work. */
	settleMs: number;
	/** For this long after known user input the first output counts as work. */
	inputMs: number;
}

export const DEFAULT_ACTIVITY_OPTIONS: Readonly<ActivityOptions> = Object.freeze({
	quietMs: 8000,
	resumeMs: 2000,
	burstGapMs: 1500,
	settleMs: 1500,
	inputMs: 5000,
});

/**
 * Modes only a program that talks to a person turns on: alternate screen, bracketed paste, focus
 * and mouse reporting. A hidden cursor (mode 25 reset) counts as well. A program without any of
 * them is a batch run: it is done when it exits, however long it stays silent.
 */
const INTERACTIVE_MODES: ReadonlySet<number> = new Set([47, 1047, 1049, 2004, 1004, 1000, 1002, 1003, 1006]);
const CURSOR_MODE = 25;

export interface ActivityRestore {
	state: Activity;
	interactive: boolean;
}

/**
 * The rules, in the order they apply:
 * - a bell or a desktop notification: waiting, at once. The redraw that follows is not work.
 * - a progress report that says busy: working, at once.
 * - waiting and output keeps coming for `resumeMs`: working. One redraw or the echo of a key is not enough.
 *   Spinners count: a redraw is output, whether it prints a character or only moves the cursor.
 * - working, interactive and no output for `quietMs`: waiting. No output never means working again, so a
 *   screen that stands still does not flap.
 */
export class ActivityTracker {

	private readonly options: Readonly<ActivityOptions>;
	private current: Activity;
	private readonly modes = new Set<number>();
	/** Known from before a window reload: the modes that were on then cannot be read again. */
	private readonly restoredInteractive: boolean;

	private lastOutputAt: number | undefined = undefined;
	private burstStartAt: number | undefined = undefined;
	private settleUntil = Number.NEGATIVE_INFINITY;
	private inputUntil = Number.NEGATIVE_INFINITY;

	constructor(options: Readonly<ActivityOptions>, now: number, restore?: ActivityRestore) {
		this.options = options;
		this.current = restore?.state ?? 'working';
		this.restoredInteractive = restore?.interactive ?? false;
		if (restore) {
			this.lastOutputAt = now; // what was before is not known: silence counts from here
		}
	}

	get state(): Activity {
		return this.current;
	}

	/** Whether the program shows signs of talking to a person right now. */
	get interactive(): boolean {
		return this.restoredInteractive || this.modes.size > 0;
	}

	/** Output arrived: `length` characters that parsed to `signals`. */
	output(now: number, length: number, signals: readonly Signal[]): Activity {
		if (length <= 0) {
			return this.current;
		}

		let notified = false;
		let busy = false;
		for (const signal of signals) {
			if (signal.kind === 'bell' || signal.kind === 'notification') {
				notified = true;
			} else if (signal.kind === 'progress') {
				busy = signal.state === 1 || signal.state === 3;
			} else if (signal.kind === 'mode') {
				this.onMode(signal.mode, signal.set);
			}
		}

		const isNewBurst = this.lastOutputAt === undefined || this.burstStartAt === undefined || now - this.lastOutputAt > this.options.burstGapMs;
		this.lastOutputAt = now;

		if (notified) {
			this.current = 'waiting';
			this.burstStartAt = undefined;
			this.settleUntil = now + this.options.settleMs;
			this.inputUntil = Number.NEGATIVE_INFINITY;
			return this.current;
		}

		if (busy) {
			this.current = 'working';
			this.burstStartAt = now;
			return this.current;
		}

		if (now < this.settleUntil) {
			return this.current;
		}

		if (isNewBurst) {
			this.burstStartAt = now;
		}

		if (this.current === 'waiting' && (now <= this.inputUntil || now - (this.burstStartAt ?? now) >= this.options.resumeMs)) {
			this.current = 'working';
			this.inputUntil = Number.NEGATIVE_INFINITY;
		}

		return this.current;
	}

	/** The user is known to have answered the agent, such as by text that was sent on their behalf. */
	input(now: number): void {
		this.inputUntil = now + this.options.inputMs;
		this.settleUntil = Number.NEGATIVE_INFINITY;
	}

	/** Time passed. */
	tick(now: number): Activity {
		if (this.current === 'working' && this.interactive && this.options.quietMs > 0 && this.lastOutputAt !== undefined && now - this.lastOutputAt >= this.options.quietMs) {
			this.current = 'waiting';
			this.burstStartAt = undefined;
		}

		return this.current;
	}

	private onMode(mode: number, set: boolean): void {
		if (mode === CURSOR_MODE) {
			set = !set; // the cursor is hidden by resetting the mode
		} else if (!INTERACTIVE_MODES.has(mode)) {
			return;
		}

		if (set) {
			this.modes.add(mode);
		} else {
			this.modes.delete(mode);
		}
	}
}
