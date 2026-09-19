// SPDX-License-Identifier: MIT

// Turns what the graph view asks to open (evidence, a task, a commit, a code reference) into a plan the
// extension can carry out. Pure: the extension adds the file system and the editor.
import type { OpenTarget } from '../protocol.ts';

/** A file below a workspace folder, optionally with a 1-based line range. */
export interface FileLocation {
	path: string[];
	line?: number;
	endLine?: number;
}

export type OpenPlan =
	| { kind: 'commit'; sha: string }
	| { kind: 'url'; url: string }
	| { kind: 'file'; location: FileLocation }
	| { kind: 'task'; paper: string; taskId: string }
	/** Nothing to open: the value is prose (or unsafe as a path); the host offers to copy it. */
	| { kind: 'text' };

// The admission gate's notion of a commit citation (`admission._COMMIT_RE`).
const COMMIT = /^(?:commit\s+)?(?<sha>[0-9a-f]{7,40})$/i;
const LINES = /(?::|#)L?(?<line>\d+)(?:-L?(?<endLine>\d+))?$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f]/;

/**
 * `dir/file.py`, `dir/file.py:12`, `dir/file.py:L10-24`, `dir/file.py#L3-L5`. Only paths that stay inside
 * the folder they are resolved against: no absolute paths, no drive letters, no schemes, no `..`.
 */
export function parseLocation(reference: string): FileLocation | undefined {
	let text = reference.trim();
	const location: FileLocation = { path: [] };
	const lines = LINES.exec(text);
	if (lines?.groups) {
		text = text.slice(0, lines.index);
		location.line = Number(lines.groups.line);
		if (lines.groups.endLine !== undefined) {
			location.endLine = Number(lines.groups.endLine);
		}
	}
	if (text === '' || /^(?:[/\\~]|[A-Za-z][A-Za-z0-9+.-]*:)/.test(text) || CONTROL.test(text)) {
		return undefined;
	}
	location.path = text.split(/[/\\]+/).filter(s => s !== '' && s !== '.');
	return location.path.length === 0 || location.path.includes('..') ? undefined : location;
}

/** Evidence is free-form: a commit citation, a link, a file of the repository, or a sentence. */
export function classifyEvidence(value: string): OpenPlan {
	const text = value.trim();
	const commit = COMMIT.exec(text);
	if (commit?.groups) {
		return { kind: 'commit', sha: commit.groups.sha.toLowerCase() };
	}
	if (/^https?:\/\/\S+$/i.test(text)) {
		return { kind: 'url', url: text };
	}
	// A file is one token that looks like a path: it has a directory or an extension.
	if (!/\s/.test(text) && /[/\\]|\.[A-Za-z0-9]{1,8}(?:[:#]L?\d+(?:-L?\d+)?)?$/.test(text)) {
		const location = parseLocation(text);
		if (location) {
			return { kind: 'file', location };
		}
	}
	return { kind: 'text' };
}

function isSafeName(name: string): boolean {
	return name !== '' && name !== '.' && name !== '..' && !/[/\\]/.test(name) && !CONTROL.test(name);
}

/**
 * Where the task file of `taskId` may be: `results/<project>/paper_<P>/tasks/<task>/implementation.md`
 * (the stage-2 layout) or a flat `tasks/<task>.md`. The results directory is the parent of the ledger root;
 * `projects` are its sub-directories. Most likely first.
 */
export function taskCandidates(root: readonly string[], paper: string, taskId: string, projects: readonly string[]): string[][] {
	if (!isSafeName(paper) || !isSafeName(taskId)) {
		return [];
	}
	const results = root.slice(0, -1);
	const ledgers = root[root.length - 1];
	return projects.filter(project => project !== ledgers && isSafeName(project)).flatMap(project => {
		const tasks = [...results, project, `paper_${paper}`, 'tasks'];
		return [[...tasks, taskId, 'implementation.md'], [...tasks, `${taskId}.md`]];
	});
}

export function planOpen(target: OpenTarget): OpenPlan {
	switch (target.kind) {
		case 'commit': {
			const plan = classifyEvidence(target.value);
			return plan.kind === 'commit' ? plan : { kind: 'text' };
		}
		case 'evidence':
			return classifyEvidence(target.value);
		case 'code': {
			const location = parseLocation(target.value);
			return location ? { kind: 'file', location } : { kind: 'text' };
		}
		case 'task':
			return { kind: 'task', paper: target.paper, taskId: target.value };
		default:
			return { kind: 'text' };
	}
}

/** The physical line (0-based) and length of the latest complete row of `nodeId` in a `nodes.jsonl` text. */
export function findNodeRow(text: string, nodeId: string): { line: number; length: number } | undefined {
	const lines = text.split('\n');
	// The last element is either empty (the file ends in a newline) or a torn tail: not a row either way.
	for (let i = lines.length - 2; i >= 0; i--) {
		const raw = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
		if (!raw.includes('node_id')) {
			continue;
		}
		try {
			if ((JSON.parse(raw) as { node_id?: unknown } | null)?.node_id === nodeId) {
				return { line: i, length: raw.length };
			}
		} catch {
			// an unreadable line is nobody's row
		}
	}
	return undefined;
}
