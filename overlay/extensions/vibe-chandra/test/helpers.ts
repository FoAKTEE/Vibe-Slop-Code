// SPDX-License-Identifier: MIT

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseJsonl } from '../src/model/jsonl.ts';
import type { LedgerInput, LedgerRow } from '../src/model/types.ts';

export const fixturesDir = join(import.meta.dirname, 'fixtures');

export const LEDGER_FILES = {
	knowledge: 'nodes.jsonl',
	error: 'trials.jsonl',
	claim: 'entries.jsonl',
	result: 'results.jsonl',
} as const;

export function readText(path: string): string {
	return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

export function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** The four ledgers of one fixture paper, parsed (missing files are empty ledgers). */
export function fixtureInput(paper: string): LedgerInput {
	const dir = join(fixturesDir, `paper_${paper}`);
	const rows = (file: string): LedgerRow[] => parseJsonl(readText(join(dir, file))).rows;
	return {
		knowledge: rows(LEDGER_FILES.knowledge),
		error: rows(LEDGER_FILES.error),
		claim: rows(LEDGER_FILES.claim),
		result: rows(LEDGER_FILES.result),
	};
}

/** The Chandra checkout that `CHANDRA_ROOT` names (its Python ledger tools and its ledgers), if it is set. */
export function chandraRoot(): string | undefined {
	const root = process.env['CHANDRA_ROOT'];
	return root ? resolve(root) : undefined;
}
