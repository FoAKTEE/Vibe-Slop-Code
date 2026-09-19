// SPDX-License-Identifier: MIT

/** The few timer functions the debouncer needs; the default is the global clock, tests bring their own. */
export interface Clock {
	now(): number;
	setTimeout(run: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const systemClock: Clock = {
	now: () => Date.now(),
	setTimeout: (run, ms) => setTimeout(run, ms),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface BurstOptions {
	/** A burst ends when nothing arrived for this long. */
	quietMs: number;
	/** A burst that never ends is flushed at least this often, so a busy writer still shows progress. */
	maxWaitMs: number;
}

/**
 * Collects items that arrive in bursts (ledger rows are appended several files at a time, and every append
 * raises more than one file event) and hands them over once per burst, each item once, in arrival order.
 */
export class BurstDebouncer<T> {
	private pending = new Set<T>();
	private timer: unknown;
	private burstStart = 0;
	private disposed = false;
	private readonly flush: (items: Set<T>) => void;
	private readonly options: BurstOptions;
	private readonly clock: Clock;

	constructor(flush: (items: Set<T>) => void, options: BurstOptions = { quietMs: 150, maxWaitMs: 1000 }, clock: Clock = systemClock) {
		this.flush = flush;
		this.options = options;
		this.clock = clock;
	}

	push(item: T): void {
		if (this.disposed) {
			return;
		}
		const now = this.clock.now();
		if (this.pending.size === 0) {
			this.burstStart = now;
		}
		this.pending.add(item);
		this.clock.clearTimeout(this.timer);
		const wait = Math.max(0, Math.min(this.options.quietMs, this.burstStart + this.options.maxWaitMs - now));
		this.timer = this.clock.setTimeout(() => this.flushNow(), wait);
	}

	flushNow(): void {
		this.clock.clearTimeout(this.timer);
		this.timer = undefined;
		if (this.pending.size === 0 || this.disposed) {
			return;
		}
		const items = this.pending;
		this.pending = new Set();
		this.flush(items);
	}

	dispose(): void {
		this.disposed = true;
		this.clock.clearTimeout(this.timer);
		this.pending.clear();
	}
}
