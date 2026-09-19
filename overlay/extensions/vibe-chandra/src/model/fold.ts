// SPDX-License-Identifier: MIT

import { analyzeCycles } from './cycles.ts';
import { computeFrontier, countStatuses } from './derived.ts';
import type {
	AttachedClaim, AttachedResult, GraphNode, Hyperedge, Hypergraph, LedgerInput, LedgerRow, NodeStatus, RevisionInfo, TrialInfo, TrialStats,
} from './types.ts';

const KNOWN_STATUSES = new Set<string>(['hypothesis', 'preliminary', 'solid', 'blocking', 'future', 'retired', 'amended']);
const FAILED_OUTCOMES = new Set<string>(['fail', 'crash', 'partial']);

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? [...new Set(value.filter((x): x is string => typeof x === 'string' && x !== ''))] : [];
}

/**
 * Latest active row per `node_id` in append order: the exact fold of Chandra's `ledger_common.latest_per_node`.
 * Legacy `amended` rows are ignored pointers, the last remaining row wins, and a node whose winning row is
 * `retired` disappears (a later active row revives it). Order is that of each node's first counted row.
 */
export function latestPerNode(rows: readonly LedgerRow[]): LedgerRow[] {
	const byNode = new Map<unknown, LedgerRow>();
	for (const row of rows) {
		if (row.status === 'amended' || row.node_id === undefined || row.node_id === null) {
			continue;
		}
		byNode.set(row.node_id, row);
	}
	return [...byNode.values()].filter(row => row.status !== 'retired');
}

/** Latest row per key (claim `entry_id`, result `result_id`): `latest_per_entry` / `latest_per_result`. */
export function latestPerKey(rows: readonly LedgerRow[], key: string): LedgerRow[] {
	const byKey = new Map<unknown, LedgerRow>();
	for (const row of rows) {
		if (row[key] !== undefined && row[key] !== null) {
			byKey.set(row[key], row);
		}
	}
	return [...byKey.values()];
}

function splitId(id: string, fallbackPaper: string): { paper: string; label: string } {
	const at = id.indexOf('::');
	return at > 0 ? { paper: id.slice(0, at), label: id.slice(at + 2) } : { paper: fallbackPaper, label: id };
}

function emptyStats(): TrialStats {
	return { total: 0, pass: 0, fail: 0, crash: 0, partial: 0, amended: 0, failed: 0, failStreak: 0 };
}

function newNode(id: string, paper: string): GraphNode {
	return {
		id, paper, label: splitId(id, paper).label, summary: '', status: 'unknown', active: false, ghost: true,
		predecessors: [], revisionCount: 0, revisions: [], trialStats: emptyStats(), trials: [],
		claimCount: 0, resultCount: 0, openObligations: 0, claims: [], results: [],
	};
}

/** Copies the current row's payload onto the node. Optional fields are only set when present (plain JSON, no `undefined`). */
function applyRow(node: GraphNode, row: LedgerRow): void {
	const status = str(row.status);
	node.status = status && KNOWN_STATUSES.has(status) ? status as NodeStatus : 'unknown';
	node.summary = str(row.summary) ?? '';
	node.predecessors = strings(row.predecessors);
	const optional: [keyof GraphNode, unknown][] = [
		['domain', str(row.domain)], ['taskId', str(row.task_id)], ['riskTier', str(row.risk_tier)], ['evidence', str(row.evidence)],
		['gitCommit', str(row.git_commit)], ['timestamp', str(row.timestamp)], ['paperAnchor', str(row.paper_anchor)], ['notes', str(row.notes)],
		['conceptAdvance', typeof row.concept_advance === 'boolean' ? row.concept_advance : undefined],
		['equationLabels', Array.isArray(row.equation_labels) ? strings(row.equation_labels) : undefined],
		['codeBlockRefs', Array.isArray(row.code_block_refs) ? strings(row.code_block_refs) : undefined],
	];
	const target = node as unknown as Record<string, unknown>;
	for (const [key, value] of optional) {
		if (value === undefined) {
			delete target[key];
		} else {
			target[key] = value;
		}
	}
}

function revisionOf(row: LedgerRow, previousSummary: string | undefined): RevisionInfo {
	const revision: RevisionInfo = { status: str(row.status) ?? 'unknown' };
	const fields: [keyof RevisionInfo, unknown][] = [
		['seq', num(row.node_seq)], ['timestamp', str(row.timestamp)], ['gitCommit', str(row.git_commit)], ['actorRole', str(row.actor_role)],
		['rowHash', str(row.row_hash)], ['supersedes', str(row.supersedes)],
		['summary', str(row.summary) !== previousSummary ? str(row.summary) : undefined],
	];
	for (const [key, value] of fields) {
		if (value !== undefined) {
			(revision as unknown as Record<string, unknown>)[key] = value;
		}
	}
	return revision;
}

function trialOf(row: LedgerRow): TrialInfo {
	const trial: TrialInfo = { outcome: str(row.pass_fail) ?? 'unknown' };
	const metric = row.metric !== null && typeof row.metric === 'object' && !Array.isArray(row.metric) ? row.metric as TrialInfo['metric'] : undefined;
	const fields: [keyof TrialInfo, unknown][] = [
		['seq', num(row.node_seq)], ['timestamp', str(row.timestamp)], ['taskId', str(row.task_id)], ['iteration', num(row.iteration)],
		['stage', str(row.stage)], ['changeSummary', str(row.change_summary)], ['metric', metric], ['expected', str(row.expected)],
		['observed', str(row.observed)], ['rootCause', str(row.root_cause)], ['fixHypothesis', str(row.fix_hypothesis)],
		['failureMode', str(row.failure_mode)], ['gitCommit', str(row.git_commit)],
	];
	for (const [key, value] of fields) {
		if (value !== undefined) {
			(trial as unknown as Record<string, unknown>)[key] = value;
		}
	}
	return trial;
}

function addTrial(node: GraphNode, trial: TrialInfo): void {
	node.trials.push(trial);
	const stats = node.trialStats;
	stats.total++;
	if (trial.outcome === 'amended') {
		stats.amended++;
		return;
	}
	if (trial.outcome === 'pass') {
		stats.pass++;
	} else if (trial.outcome === 'fail') {
		stats.fail++;
	} else if (trial.outcome === 'crash') {
		stats.crash++;
	} else if (trial.outcome === 'partial') {
		stats.partial++;
	}
	const failed = FAILED_OUTCOMES.has(trial.outcome);
	stats.failed += failed ? 1 : 0;
	stats.failStreak = failed ? stats.failStreak + 1 : 0;
	stats.lastOutcome = trial.outcome;
	if (trial.timestamp !== undefined) {
		stats.lastTimestamp = trial.timestamp;
	} else {
		delete stats.lastTimestamp;
	}
}

/**
 * Folds the append-only ledgers into the workflow hypergraph. Accepts one input or several (one per
 * paper); node ids are globally namespaced (`paper::slug`, `_shared::slug`), so papers merge by id.
 */
export function foldLedgers(input: LedgerInput | readonly LedgerInput[]): Hypergraph {
	const inputs = Array.isArray(input) ? input as readonly LedgerInput[] : [input as LedgerInput];
	const warnings: string[] = [];
	const papers: string[] = [];
	const notePaper = (paper: string): void => {
		if (paper !== '' && !papers.includes(paper)) {
			papers.push(paper);
		}
	};

	// Knowledge rows: group under their node, remembering the latest non-amended row (the current state).
	interface Accrual { paper: string; rows: LedgerRow[]; current?: LedgerRow }
	const accruals = new Map<string, Accrual>();
	let skippedRows = 0;
	for (const one of inputs) {
		for (const row of one.knowledge ?? []) {
			const id = str(row?.node_id);
			if (id === undefined) {
				skippedRows++;
				continue;
			}
			const paper = str(row.paper) ?? splitId(id, '').paper;
			let accrual = accruals.get(id);
			if (!accrual) {
				accrual = { paper, rows: [] };
				accruals.set(id, accrual);
			} else if (accrual.paper !== paper) {
				warnings.push(`node ${id} is claimed by papers ${accrual.paper} and ${paper}; keeping ${accrual.paper}`);
				continue;
			}
			notePaper(paper);
			accrual.rows.push(row);
			if (row.status !== 'amended') {
				accrual.current = row;
			}
		}
	}
	if (skippedRows > 0) {
		warnings.push(`${skippedRows} knowledge row(s) without a node_id were skipped`);
	}

	// Node order: first counted (non-amended) row, as in the Python fold; amended-only nodes follow.
	const ordered: [string, Accrual][] = [];
	const seen = new Set<string>();
	for (const one of inputs) {
		for (const row of one.knowledge ?? []) {
			const id = str(row?.node_id);
			if (id !== undefined && row.status !== 'amended' && !seen.has(id) && accruals.get(id)?.rows.includes(row)) {
				seen.add(id);
				ordered.push([id, accruals.get(id)!]);
			}
		}
	}
	for (const [id, accrual] of accruals) {
		if (!seen.has(id)) {
			ordered.push([id, accrual]);
		}
	}

	const nodes = new Map<string, GraphNode>();
	for (const [id, accrual] of ordered) {
		const node = newNode(id, accrual.paper);
		node.ghost = false;
		applyRow(node, accrual.current ?? accrual.rows[accrual.rows.length - 1]);
		node.active = node.status !== 'retired' && node.status !== 'amended';
		node.revisionCount = accrual.rows.length;
		let previousSummary: string | undefined;
		const byHash = new Map<string, RevisionInfo>();
		for (const row of accrual.rows) {
			const revision = revisionOf(row, previousSummary);
			previousSummary = str(row.summary);
			node.revisions.push(revision);
			if (revision.rowHash !== undefined) {
				byHash.set(revision.rowHash, revision);
			}
			const superseded = revision.supersedes !== undefined ? byHash.get(revision.supersedes) : undefined;
			if (superseded && revision.rowHash !== undefined) {
				superseded.supersededBy = revision.rowHash;
			}
		}
		if (node.status === 'unknown') {
			warnings.push(`node ${id} carries a status outside the ledger enum`);
		}
		nodes.set(id, node);
	}

	const ghost = (id: string, fallbackPaper: string): GraphNode => {
		let node = nodes.get(id);
		if (!node) {
			node = newNode(id, splitId(id, fallbackPaper).paper);
			nodes.set(id, node);
		}
		return node;
	};

	// Ghosts: predecessors that no loaded paper defines are displayed, never dropped.
	for (const node of [...nodes.values()]) {
		for (const predecessor of node.predecessors) {
			ghost(predecessor, node.paper);
		}
	}

	// Trials attach UNDER their DAG node; a trial anchored at an unknown node makes a ghost too.
	for (const one of inputs) {
		for (const row of one.error ?? []) {
			const id = str(row?.node_id);
			if (id !== undefined) {
				addTrial(ghost(id, str(row.paper) ?? ''), trialOf(row));
			}
		}
	}

	for (const one of inputs) {
		for (const row of latestPerKey(one.claim ?? [], 'entry_id')) {
			const claim: AttachedClaim = {
				id: String(row.entry_id), kind: str(row.kind) ?? 'claim', status: str(row.status) ?? 'unknown', statement: str(row.statement) ?? '',
			};
			if (typeof row.blocking === 'boolean') {
				claim.blocking = row.blocking;
			}
			for (const id of strings(row.node_ids)) {
				const node = nodes.get(id);
				if (node) {
					node.claims.push(claim);
					node.claimCount++;
					node.openObligations += claim.kind === 'obligation' && claim.status === 'open' ? 1 : 0;
				}
			}
		}
		for (const row of latestPerKey(one.result ?? [], 'result_id')) {
			const result: AttachedResult = { id: String(row.result_id), name: str(row.name) ?? String(row.result_id), status: str(row.status) ?? 'unknown' };
			const evidenceType = str(row.evidence_type);
			if (evidenceType !== undefined) {
				result.evidenceType = evidenceType;
			}
			const verdict = row.verifier_result !== null && typeof row.verifier_result === 'object' ? str((row.verifier_result as LedgerRow).verdict) : undefined;
			if (verdict !== undefined) {
				result.verdict = verdict;
			}
			for (const id of strings(row.node_ids)) {
				const node = nodes.get(id);
				if (node) {
					node.results.push(result);
					node.resultCount++;
				}
			}
		}
	}

	const nodeList = [...nodes.values()];
	for (const node of nodeList) {
		notePaper(node.paper);
	}
	const hyperedges: Hyperedge[] = nodeList
		.filter(node => node.predecessors.length > 0)
		.map(node => ({ id: `he:${node.id}`, sources: [...node.predecessors], target: node.id }));
	const cycles = analyzeCycles(nodeList.map(n => n.id), hyperedges);
	return {
		papers, nodes: nodeList, hyperedges, cycles,
		frontier: computeFrontier(nodeList, cycles.feedbackEdges),
		statusCounts: countStatuses(nodeList),
		warnings,
	};
}
