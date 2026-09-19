// SPDX-License-Identifier: MIT

/** One raw ledger row exactly as appended; Chandra's Python ledger modules own the schema. */
export type LedgerRow = Record<string, unknown>;

/** Rows of the four ledgers, each in append order. Rows of several papers may be mixed. */
export interface LedgerInput {
	knowledge: LedgerRow[];
	error?: LedgerRow[];
	claim?: LedgerRow[];
	result?: LedgerRow[];
}

/** Knowledge-ledger statuses, plus `unknown` for ghosts and rows carrying a status outside the enum. */
export type NodeStatus = 'hypothesis' | 'preliminary' | 'solid' | 'blocking' | 'future' | 'retired' | 'amended' | 'unknown';

export const NODE_STATUSES: readonly NodeStatus[] = ['solid', 'preliminary', 'hypothesis', 'blocking', 'future', 'retired', 'amended', 'unknown'];

export interface Metric {
	name?: string;
	value?: unknown;
	threshold?: unknown;
	pass?: boolean;
}

/** One error-ledger trial attached under a node (`node_id` + `node_seq`). */
export interface TrialInfo {
	seq?: number;
	outcome: string;
	timestamp?: string;
	taskId?: string;
	iteration?: number;
	stage?: string;
	changeSummary?: string;
	metric?: Metric;
	expected?: string;
	observed?: string;
	rootCause?: string;
	fixHypothesis?: string;
	failureMode?: string;
	gitCommit?: string;
}

export interface TrialStats {
	total: number;
	pass: number;
	fail: number;
	crash: number;
	partial: number;
	amended: number;
	/** fail + crash + partial: what the Mermaid badge and the dashboard count as failed. */
	failed: number;
	/** Consecutive failed trials at the end of the list; 0 once a trial passes. */
	failStreak: number;
	lastOutcome?: string;
	lastTimestamp?: string;
}

/** One knowledge-ledger row under a node: the promotion / revision history. */
export interface RevisionInfo {
	seq?: number;
	status: string;
	timestamp?: string;
	gitCommit?: string;
	actorRole?: string;
	rowHash?: string;
	supersedes?: string;
	supersededBy?: string;
	/** Present on the first revision and whenever the summary changed. */
	summary?: string;
}

export interface AttachedClaim {
	id: string;
	kind: string;
	status: string;
	statement: string;
	blocking?: boolean;
}

export interface AttachedResult {
	id: string;
	name: string;
	status: string;
	evidenceType?: string;
	verdict?: string;
}

export interface GraphNode {
	id: string;
	paper: string;
	/** The id without its `paper::` namespace. */
	label: string;
	summary: string;
	status: NodeStatus;
	/** False for retired nodes and legacy amended-only nodes: exactly the rows the Python `query` omits. */
	active: boolean;
	/** True when the id is only referenced (as a predecessor or a trial anchor) and has no knowledge row. */
	ghost: boolean;
	domain?: string;
	taskId?: string;
	riskTier?: string;
	evidence?: string;
	gitCommit?: string;
	timestamp?: string;
	paperAnchor?: string;
	notes?: string;
	conceptAdvance?: boolean;
	equationLabels?: string[];
	codeBlockRefs?: string[];
	predecessors: string[];
	revisionCount: number;
	revisions: RevisionInfo[];
	trialStats: TrialStats;
	trials: TrialInfo[];
	claimCount: number;
	resultCount: number;
	openObligations: number;
	claims: AttachedClaim[];
	results: AttachedResult[];
}

/** An AND-join: `target` depends on ALL of `sources`. One source degenerates to a plain edge. */
export interface Hyperedge {
	id: string;
	sources: string[];
	target: string;
}

export interface EdgeRef {
	source: string;
	target: string;
}

export interface CycleReport {
	cyclic: boolean;
	/** Non-trivial strongly connected components (two or more nodes, or a self-loop), in node order. */
	sccs: string[][];
	/** Edges whose removal leaves the graph acyclic; the layout draws them as loop-backs. */
	feedbackEdges: EdgeRef[];
}

/** Plain JSON by construction: this object crosses the webview `postMessage` boundary. */
export interface Hypergraph {
	papers: string[];
	nodes: GraphNode[];
	hyperedges: Hyperedge[];
	cycles: CycleReport;
	/** Ready set: active non-solid nodes whose predecessors are all solid. */
	frontier: string[];
	/** Node count per status; ghosts are counted under `ghost`. */
	statusCounts: Record<string, number>;
	warnings: string[];
}
