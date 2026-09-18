// SPDX-License-Identifier: MIT

import type { LedgerRow } from './types.ts';

export interface BadLine {
	/** 1-based physical line number. */
	line: number;
	reason: 'torn-tail' | 'invalid-json' | 'not-an-object';
	text: string;
}

export interface ParsedJsonl {
	rows: LedgerRow[];
	bad: BadLine[];
	/** True when the final line was an incomplete append and was ignored. */
	tornTail: boolean;
}

const MAX_REPORTED_TEXT = 160;

function parseObject(text: string): LedgerRow | 'invalid-json' | 'not-an-object' {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return 'invalid-json';
	}
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as LedgerRow : 'not-an-object';
}

/**
 * Parses an append-only JSONL ledger that may be written while it is read.
 *
 * Mirrors `ledger_common._complete_lines`: a row is appended as `json + "\n"` in one write, so only the
 * final physical line can be torn. It is torn when it lacks its newline (even if it happens to parse)
 * or when it does not parse. Bad interior lines are reported and skipped. Never throws.
 */
export function parseJsonl(text: string): ParsedJsonl {
	const result: ParsedJsonl = { rows: [], bad: [], tornTail: false };
	if (typeof text !== 'string' || text.length === 0) {
		return result;
	}
	const lines = text.split('\n');
	const endsWithNewline = lines[lines.length - 1] === '';
	if (endsWithNewline) {
		lines.pop();
	}
	const report = (index: number, reason: BadLine['reason'], raw: string): void => {
		result.bad.push({ line: index + 1, reason, text: raw.length > MAX_REPORTED_TEXT ? raw.slice(0, MAX_REPORTED_TEXT) + '…' : raw });
	};
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
		if (raw.trim() === '') {
			continue;
		}
		const isLast = i === lines.length - 1;
		if (isLast && !endsWithNewline) {
			result.tornTail = true;
			report(i, 'torn-tail', raw);
			continue;
		}
		const parsed = parseObject(raw);
		if (typeof parsed !== 'string') {
			result.rows.push(parsed);
		} else if (isLast && parsed === 'invalid-json') {
			result.tornTail = true;
			report(i, 'torn-tail', raw);
		} else {
			report(i, parsed, raw);
		}
	}
	return result;
}
