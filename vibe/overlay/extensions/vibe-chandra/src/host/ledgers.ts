// SPDX-License-Identifier: MIT

import { foldLedgers } from '../model/fold.ts';
import type { Hypergraph, LedgerInput } from '../model/types.ts';
import { classifyChange, LEDGER_DBS, ledgerFileSegments, normalizeRoot, paperOfDirectory, selectPapers, type LedgerDb } from './discovery.ts';
import { LedgerFileCache } from './fileCache.ts';

export interface DirectoryEntry {
	name: string;
	directory: boolean;
}

/**
 * All the ledger service needs from a workspace folder. The editor backs it with `workspace.fs`, so a
 * remote or virtual folder works like a local one. Paths are segments below the folder.
 */
export interface FolderFs {
	/** The entries of a directory; undefined when it does not exist. */
	list(segments: readonly string[]): Promise<DirectoryEntry[] | undefined>;
	/** The content of a file; undefined when it does not exist. Any other failure may throw. */
	read(segments: readonly string[]): Promise<Uint8Array | undefined>;
}

export interface LedgerFolder {
	/** Stable identity of the folder (its URI). */
	key: string;
	name: string;
	fs: FolderFs;
}

export interface LedgerOptions {
	/** The `vibeChandra.ledgerRoot` setting, as typed. */
	root: unknown;
	/** The papers to show; empty means all. */
	papers: unknown;
}

export interface LedgerEnvironment {
	folders(): readonly LedgerFolder[];
	options(): LedgerOptions;
	now?(): number;
}

/** A change reported by a file watcher: a path relative to the ledger root of a folder. */
export interface LedgerChange {
	folder: string;
	path: readonly string[];
}

/** The ledgers of one paper in one folder; `files` holds the segments (below the folder) of those that exist. */
export interface PaperSource {
	folder: string;
	paper: string;
	files: Partial<Record<LedgerDb, string[]>>;
}

export interface LoadStats {
	/** Ledger files that exist. */
	files: number;
	/** Files read by the refresh that produced this snapshot (one, for a typical append). */
	filesRead: number;
	bytesRead: number;
	rowsParsed: number;
	rows: number;
	readMs: number;
	foldMs: number;
}

export interface Snapshot {
	revision: number;
	graph: Hypergraph;
	/** Every paper found under the ledger roots. */
	available: string[];
	/** The papers folded into `graph`. */
	selected: string[];
	root: string[];
	sources: PaperSource[];
	problems: string[];
	stats: LoadStats;
	/** The folder (key) whose ledgers define `paper`: relative evidence paths resolve against it. */
	owner(paper: string): string | undefined;
}

interface Candidate {
	folder: LedgerFolder;
	db: LedgerDb;
	paper: string;
	segments: string[];
}

const fileKey = (folder: string, segments: readonly string[]): string => `${folder}\n${segments.join('/')}`;

/**
 * Finds, reads and folds the ledgers of every workspace folder. After the first load a change costs one
 * file read: the rows of every other file are kept, and the changed file is parsed from its old end.
 */
export class LedgerService {
	private readonly env: LedgerEnvironment;
	private readonly cache = new LedgerFileCache();
	private readonly listeners = new Set<(snapshot: Snapshot) => void>();
	/** Every ledger file that exists, by cache key. */
	private known = new Map<string, Candidate>();
	private failures = new Map<string, string>();
	private current: Snapshot;
	private running: Promise<Snapshot> | undefined;
	private queued: { changes: LedgerChange[] | 'all'; done: Promise<Snapshot> } | undefined;

	constructor(env: LedgerEnvironment) {
		this.env = env;
		this.current = this.fold(0, { filesRead: 0, bytesRead: 0, rowsParsed: 0, readMs: 0 });
	}

	get snapshot(): Snapshot {
		return this.current;
	}

	onDidChange(listener: (snapshot: Snapshot) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	/** Forgets everything and reads every ledger again (first load, settings or folders changed, manual refresh). */
	reload(): Promise<Snapshot> {
		return this.enqueue('all');
	}

	/** Applies what a file watcher saw. Resolves with a snapshot that includes these changes. */
	refresh(changes: Iterable<LedgerChange>): Promise<Snapshot> {
		return this.enqueue([...changes]);
	}

	/** Refreshes never overlap: what arrives during one is merged into a single follow-up. */
	private enqueue(changes: LedgerChange[] | 'all'): Promise<Snapshot> {
		if (!this.running) {
			const run = this.run(changes).finally(() => {
				if (this.running === run) {
					this.running = undefined;
				}
			});
			this.running = run;
			return run;
		}
		if (this.queued) {
			this.queued.changes = this.queued.changes === 'all' || changes === 'all' ? 'all' : [...this.queued.changes, ...changes];
			return this.queued.done;
		}
		const queued: NonNullable<LedgerService['queued']> = {
			changes,
			done: this.running.then(() => {
				this.queued = undefined;
				this.running = undefined;
				return this.enqueue(queued.changes);
			}),
		};
		this.queued = queued;
		return queued.done;
	}

	private now(): number {
		return this.env.now ? this.env.now() : Date.now();
	}

	private async run(changes: LedgerChange[] | 'all'): Promise<Snapshot> {
		const started = this.now();
		const root = normalizeRoot(this.env.options().root);
		const folders = new Map(this.env.folders().map(folder => [folder.key, folder]));
		const toRead = new Map<string, Candidate>();
		let sourcesChanged = false;
		if (changes === 'all') {
			this.cache.clear();
			this.failures.clear();
			sourcesChanged = this.known.size > 0;
			this.known = new Map();
			for (const folder of folders.values()) {
				for (const candidate of await this.discover(folder, root, [])) {
					toRead.set(fileKey(folder.key, candidate.segments), candidate);
				}
			}
		} else {
			for (const change of changes) {
				const folder = folders.get(change.folder);
				const kind = classifyChange(change.path);
				if (!folder || kind.kind === 'ignore') {
					continue;
				}
				if (kind.kind === 'file') {
					const segments = ledgerFileSegments(root, kind.db, kind.paper);
					toRead.set(fileKey(folder.key, segments), { folder, db: kind.db, paper: kind.paper, segments });
					continue;
				}
				// A directory came or went: look again below it, and re-read what was known there.
				const prefix = fileKey(folder.key, [...root, ...kind.prefix]);
				for (const [key, candidate] of this.known) {
					if (key === prefix || key.startsWith(prefix + '/') || kind.prefix.length === 0 && candidate.folder.key === folder.key) {
						toRead.set(key, candidate);
					}
				}
				for (const candidate of await this.discover(folder, root, kind.prefix)) {
					toRead.set(fileKey(folder.key, candidate.segments), candidate);
				}
			}
		}

		let bytesRead = 0, rowsParsed = 0, contentChanged = false;
		await Promise.all([...toRead].map(async ([key, candidate]) => {
			let bytes: Uint8Array | undefined;
			try {
				bytes = await candidate.folder.fs.read(candidate.segments);
			} catch (error) {
				// Not "gone", just unreadable right now: keep the rows already known and say so.
				contentChanged ||= !this.failures.has(key);
				this.failures.set(key, error instanceof Error ? error.message : String(error));
				return;
			}
			contentChanged ||= this.failures.delete(key);
			bytesRead += bytes?.length ?? 0;
			const problemsBefore = this.cache.problems(key).badLines;
			const update = this.cache.update(key, bytes);
			rowsParsed += update.parsed;
			contentChanged ||= update.mode === 'reloaded' || update.mode === 'removed' || update.parsed > 0 || this.cache.problems(key).badLines !== problemsBefore;
			if (bytes === undefined) {
				sourcesChanged = this.known.delete(key) || sourcesChanged;
			} else if (!this.known.has(key)) {
				this.known.set(key, candidate);
				sourcesChanged = true;
			}
		}));

		if (changes !== 'all' && !contentChanged && !sourcesChanged) {
			return this.current;
		}
		this.current = this.fold(this.current.revision + 1, { filesRead: toRead.size, bytesRead, rowsParsed, readMs: this.now() - started });
		for (const listener of [...this.listeners]) {
			listener(this.current);
		}
		return this.current;
	}

	/** The ledger files that may exist below `<root>/<prefix>`, found by listing the directories above them. */
	private async discover(folder: LedgerFolder, root: readonly string[], prefix: readonly string[]): Promise<Candidate[]> {
		const list = async (segments: readonly string[]): Promise<DirectoryEntry[]> => {
			try {
				return await folder.fs.list(segments) ?? [];
			} catch {
				return [];
			}
		};
		const dbs = prefix.length > 0 ? [prefix[0] as LedgerDb] : (await list(root)).filter(e => e.directory && LEDGER_DBS.includes(e.name as LedgerDb)).map(e => e.name as LedgerDb);
		const found: Candidate[] = [];
		await Promise.all(dbs.map(async db => {
			const directories = prefix.length > 1 ? [prefix[1]] : (await list([...root, db])).filter(e => e.directory).map(e => e.name);
			for (const directory of directories) {
				const paper = paperOfDirectory(directory);
				if (paper !== undefined) {
					found.push({ folder, db, paper, segments: ledgerFileSegments(root, db, paper) });
				}
			}
		}));
		return found;
	}

	private fold(revision: number, read: Pick<LoadStats, 'filesRead' | 'bytesRead' | 'rowsParsed' | 'readMs'>): Snapshot {
		const started = this.now();
		const options = this.env.options();
		const folderOrder = new Map(this.env.folders().map((folder, i) => [folder.key, i]));
		const bySource = new Map<string, PaperSource>();
		for (const candidate of this.known.values()) {
			const id = `${candidate.folder.key}\n${candidate.paper}`;
			let source = bySource.get(id);
			if (!source) {
				source = { folder: candidate.folder.key, paper: candidate.paper, files: {} };
				bySource.set(id, source);
			}
			source.files[candidate.db] = candidate.segments;
		}
		const sources = [...bySource.values()].sort((a, b) => (folderOrder.get(a.folder) ?? 0) - (folderOrder.get(b.folder) ?? 0) || (a.paper < b.paper ? -1 : a.paper > b.paper ? 1 : 0));
		const available = [...new Set(sources.map(s => s.paper))].sort();
		const selected = selectPapers(available, options.papers);
		const rowsOf = (source: PaperSource, db: LedgerDb): LedgerInput['knowledge'] => source.files[db] ? this.cache.rows(fileKey(source.folder, source.files[db])) : [];
		const inputs: LedgerInput[] = sources.filter(s => selected.includes(s.paper))
			.map(s => ({ knowledge: rowsOf(s, 'knowledge'), error: rowsOf(s, 'error'), claim: rowsOf(s, 'claim'), result: rowsOf(s, 'result') }));
		const graph = foldLedgers(inputs);

		const names = new Map(this.env.folders().map(folder => [folder.key, folder.name]));
		const root = normalizeRoot(options.root);
		const problems: string[] = [];
		const describe = (key: string): string => {
			const [folder, path] = key.split('\n');
			return `${names.get(folder) ?? folder}: ${path.split('/').slice(root.length).join('/')}`;
		};
		for (const key of [...this.known.keys()].sort()) {
			const bad = this.cache.problems(key).badLines;
			if (bad > 0) {
				problems.push(`${describe(key)} has ${bad} unreadable line${bad === 1 ? '' : 's'}`);
			}
		}
		for (const [key, message] of this.failures) {
			problems.push(`${describe(key)} could not be read (${message})`);
		}
		return {
			revision, graph, available, selected, root, sources, problems,
			stats: { ...read, files: this.known.size, rows: inputs.reduce((n, i) => n + i.knowledge.length + (i.error?.length ?? 0) + (i.claim?.length ?? 0) + (i.result?.length ?? 0), 0), foldMs: this.now() - started },
			owner: paper => sources.find(s => s.paper === paper)?.folder,
		};
	}
}
