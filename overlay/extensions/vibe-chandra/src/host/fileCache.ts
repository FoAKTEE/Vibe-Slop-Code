// SPDX-License-Identifier: MIT

import { parseJsonl } from '../model/jsonl.ts';
import type { LedgerRow } from '../model/types.ts';

export interface CacheUpdate {
	/** `appended`: only the new tail was parsed. `reloaded`: parsed from the start. */
	mode: 'unchanged' | 'appended' | 'reloaded' | 'removed';
	/** Rows parsed by this update. */
	parsed: number;
}

export interface FileProblems {
	/** Complete lines that are not a JSON object. */
	badLines: number;
	/** The file ends in an incomplete append; it becomes a row once its newline is written. */
	tornTail: boolean;
}

interface Entry {
	rows: LedgerRow[];
	/** Bytes consumed so far: always the offset just behind a newline. */
	consumed: number;
	/** The last bytes before `consumed`: if they still match, the file was appended to, not rewritten. */
	guard: Uint8Array;
	size: number;
	badLines: number;
	tornTail: boolean;
}

const GUARD_BYTES = 256;
const NEWLINE = 0x0a;

/**
 * Parsed rows of the append-only ledger files. A ledger grows by whole lines, so a changed file is parsed
 * from where the previous read stopped; the rows before that are kept. Anything that does not look like an
 * append (shorter, or different bytes at the end of what was consumed) is parsed again from the start.
 */
export class LedgerFileCache {
	private readonly entries = new Map<string, Entry>();
	private readonly decoder = new TextDecoder('utf-8');

	has(key: string): boolean {
		return this.entries.has(key);
	}

	keys(): string[] {
		return [...this.entries.keys()];
	}

	rows(key: string): LedgerRow[] {
		return this.entries.get(key)?.rows ?? [];
	}

	problems(key: string): FileProblems {
		const entry = this.entries.get(key);
		return { badLines: entry?.badLines ?? 0, tornTail: entry?.tornTail ?? false };
	}

	clear(): void {
		this.entries.clear();
	}

	/** Takes the current content of a file; `undefined` means the file does not exist (any more). */
	update(key: string, bytes: Uint8Array | undefined): CacheUpdate {
		const before = this.entries.get(key);
		if (bytes === undefined) {
			return { mode: this.entries.delete(key) ? 'removed' : 'unchanged', parsed: 0 };
		}
		const appended = before !== undefined && bytes.length >= before.consumed && matchesGuard(bytes, before);
		if (appended && bytes.length === before.size) {
			return { mode: 'unchanged', parsed: 0 };
		}
		const entry: Entry = appended ? before : { rows: [], consumed: 0, guard: new Uint8Array(), size: 0, badLines: 0, tornTail: false };
		const end = bytes.lastIndexOf(NEWLINE) + 1;
		let parsed = 0;
		if (end > entry.consumed) {
			// Whole lines only, and a line break is a single byte in UTF-8: decoding never splits a character.
			const result = parseJsonl(this.decoder.decode(bytes.subarray(entry.consumed, end)));
			parsed = result.rows.length;
			// A fresh array: a snapshot folded from the old one must not see rows it was not built from.
			entry.rows = entry.rows.concat(result.rows);
			entry.badLines += result.bad.length;
			entry.consumed = end;
			entry.guard = bytes.slice(Math.max(0, end - GUARD_BYTES), end);
		}
		entry.size = bytes.length;
		entry.tornTail = bytes.subarray(end).some(byte => byte > 0x20);
		this.entries.set(key, entry);
		return { mode: appended ? 'appended' : 'reloaded', parsed };
	}
}

function matchesGuard(bytes: Uint8Array, entry: Entry): boolean {
	const start = entry.consumed - entry.guard.length;
	return entry.guard.every((byte, i) => bytes[start + i] === byte);
}
