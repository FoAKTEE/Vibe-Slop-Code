// SPDX-License-Identifier: MIT

// Where the ledgers live: <root>/<db>/paper_<P>/<file>. Pure path logic; paths are lists of segments so
// that nothing here depends on a platform separator or on a local file system.

/** The four ledgers and the one file each of them keeps per paper (`ledger_common.LEDGER_FILENAMES`). */
export const LEDGER_FILES = {
	knowledge: 'nodes.jsonl',
	error: 'trials.jsonl',
	claim: 'entries.jsonl',
	result: 'results.jsonl',
} as const;

export type LedgerDb = keyof typeof LEDGER_FILES;

export const LEDGER_DBS = Object.keys(LEDGER_FILES) as LedgerDb[];

export const DEFAULT_ROOT: readonly string[] = ['results', 'ledgers'];

const PAPER_PREFIX = 'paper_';

function isDb(name: string): name is LedgerDb {
	return Object.hasOwn(LEDGER_FILES, name);
}

/** The paper a `paper_<P>` directory belongs to. */
export function paperOfDirectory(name: string): string | undefined {
	return name.startsWith(PAPER_PREFIX) && name.length > PAPER_PREFIX.length ? name.slice(PAPER_PREFIX.length) : undefined;
}

/** The `vibeChandra.ledgerRoot` setting as segments below a workspace folder; anything unusable is the default. */
export function normalizeRoot(setting: unknown): string[] {
	if (typeof setting !== 'string' || /^\s*(?:[/\\]|[A-Za-z]:)/.test(setting)) {
		return [...DEFAULT_ROOT];
	}
	const segments = setting.trim().split(/[/\\]+/).filter(s => s !== '' && s !== '.');
	return segments.length === 0 || segments.includes('..') ? [...DEFAULT_ROOT] : segments;
}

export function ledgerFileSegments(root: readonly string[], db: LedgerDb, paper: string): string[] {
	return [...root, db, PAPER_PREFIX + paper, LEDGER_FILES[db]];
}

/**
 * The segments of `resourcePath` below the ledger root of the folder at `folderPath` (both are URI
 * paths); undefined when the resource is not inside that root.
 */
export function relativeSegments(folderPath: string, root: readonly string[], resourcePath: string): string[] | undefined {
	const base = [...folderPath.split('/').filter(s => s !== ''), ...root];
	const segments = resourcePath.split('/').filter(s => s !== '');
	if (segments.length < base.length || base.some((s, i) => segments[i] !== s)) {
		return undefined;
	}
	return segments.slice(base.length);
}

export type ChangeKind =
	| { kind: 'file'; db: LedgerDb; paper: string }
	/** A directory that holds ledgers appeared or vanished; file watchers report only its top-most path. */
	| { kind: 'directory'; prefix: string[] }
	| { kind: 'ignore' };

/** What a change to the path `segments` (relative to the ledger root) means for the loaded ledgers. */
export function classifyChange(segments: readonly string[]): ChangeKind {
	const [db, directory, file] = segments;
	if (segments.length === 0) {
		return { kind: 'directory', prefix: [] };
	}
	if (segments.length > 3 || !isDb(db)) {
		return { kind: 'ignore' };
	}
	if (segments.length === 1) {
		return { kind: 'directory', prefix: [db] };
	}
	const paper = paperOfDirectory(directory);
	if (paper === undefined) {
		return { kind: 'ignore' };
	}
	if (segments.length === 2) {
		return { kind: 'directory', prefix: [db, directory] };
	}
	return file === LEDGER_FILES[db] ? { kind: 'file', db, paper } : { kind: 'ignore' };
}

/** The papers to fold: all that were found, or those of them the `vibeChandra.papers` setting names. */
export function selectPapers(available: readonly string[], wanted: unknown): string[] {
	const names = Array.isArray(wanted) ? new Set(wanted.filter((x): x is string => typeof x === 'string' && x !== '')) : new Set<string>();
	return names.size === 0 ? [...available] : available.filter(paper => names.has(paper));
}
