// SPDX-License-Identifier: MIT

// The log of what VIBE did to the engine: one entry per operation, with the time, the documented command line, how
// it ended, how long it took and the exit code. Append-only and bounded. It is NOT the log of the launcher, which
// can hold prompts and answers and is never read.
//
// What an entry can hold is decided here, whatever the caller passes: the command line is rebuilt from documented
// words (never the path of a program, never a value), a note is one sanitized line and never the answer of a program,
// and every other field is a number or one of a few words. Deterministic: the time is passed in.
import { isOperationId, type OperationId } from './operations.ts';
import { describeCommand, sanitizeText, type Program } from './runtime.ts';

export type ActivityOutcome = 'ok' | 'failed' | 'timeout' | 'cancelled' | 'refused' | 'unparseable';

const OUTCOMES: ReadonlySet<string> = new Set<ActivityOutcome>(['ok', 'failed', 'timeout', 'cancelled', 'refused', 'unparseable']);

export interface ActivityInput {
	at: number;
	operation: OperationId;
	/** Not set: nothing was run (a read, a loopback GET, a refusal). */
	program?: Program;
	args?: readonly string[];
	outcome: ActivityOutcome;
	durationMs: number;
	exitCode?: number;
	/** A few words put together from a typed result, such as `route: installed, paused`. Never what a program wrote. */
	note?: string;
}

export interface ActivityEntry {
	/** Counts up for the life of the log, also over entries that were dropped. */
	readonly seq: number;
	readonly at: number;
	readonly operation: OperationId | 'unknown';
	readonly command: string | undefined;
	readonly outcome: ActivityOutcome;
	readonly durationMs: number;
	readonly exitCode: number | undefined;
	readonly note: string | undefined;
}

const DEFAULT_CAPACITY = 200;

function wholeNumber(value: number | undefined, max: number): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value) : undefined;
}

/** A note that looks like the answer of a program is none. */
function noteOf(note: string | undefined): string | undefined {
	const line = note === undefined ? '' : sanitizeText(note, 160);
	return line === '' || /^[{[<"]/.test(line) ? undefined : line;
}

export class ActivityLog {

	private list: readonly ActivityEntry[] = Object.freeze([]);
	private count = 0;
	private readonly capacity: number;
	private readonly listeners = new Set<() => void>();

	constructor(capacity = DEFAULT_CAPACITY) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new Error('the capacity of the activity log is a positive whole number');
		}
		this.capacity = capacity;
	}

	/** Oldest first. A new list for every entry: one that was handed out never changes. */
	get entries(): readonly ActivityEntry[] {
		return this.list;
	}

	/** How many of the oldest entries are gone. */
	get dropped(): number {
		return this.count - this.list.length;
	}

	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	}

	record(input: ActivityInput): ActivityEntry {
		const entry: ActivityEntry = Object.freeze({
			seq: ++this.count,
			at: wholeNumber(input.at, Number.MAX_SAFE_INTEGER) ?? 0,
			operation: isOperationId(input.operation) ? input.operation : 'unknown',
			command: input.program === undefined ? undefined : describeCommand(input.program, input.args ?? []),
			outcome: OUTCOMES.has(input.outcome) ? input.outcome : 'failed',
			durationMs: wholeNumber(input.durationMs, 86_400_000) ?? 0,
			exitCode: wholeNumber(input.exitCode, 255),
			note: noteOf(input.note),
		});
		this.list = Object.freeze([...this.list, entry].slice(-this.capacity));
		for (const listener of [...this.listeners]) {
			listener();
		}
		return entry;
	}
}
