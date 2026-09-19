// SPDX-License-Identifier: MIT

import { computeDepths } from '../model/derived.ts';
import type { GraphNode, Hypergraph } from '../model/types.ts';

/** One row of the Nodes tree: the keyboard and screen-reader twin of a node in the graph. */
export interface TreeNode {
	id: string;
	label: string;
	description: string;
	tooltip: string;
	/** Key of the group the node is listed under. */
	group: string;
	status: string;
	ghost: boolean;
	ready: boolean;
	failing: boolean;
}

export interface TreeGroup {
	key: string;
	label: string;
	description: string;
	expanded: boolean;
	children: TreeNode[];
}

// Working order: what stops the workflow, what is in flight, what is planned, what is done, what is gone.
const GROUPS: [key: string, label: string, expanded: boolean][] = [
	['blocking', 'Blocking', true], ['preliminary', 'Preliminary', true], ['hypothesis', 'Hypothesis', true], ['future', 'Future', true], ['solid', 'Solid', true],
	['ghost', 'Ghost', false], ['retired', 'Retired', false], ['amended', 'Amended', false], ['unknown', 'Unknown', false],
];

const SEP = ' \u00b7 ';
const TIMES = '\u00d7';
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function describeNode(node: GraphNode, ready: boolean): string {
	const stats = node.trialStats;
	return [
		node.taskId ?? '',
		node.ghost ? 'no ledger row' : '',
		ready ? 'ready' : '',
		stats.total ? plural(stats.total, 'trial') + (stats.failed ? ` (${stats.failed} failed)` : '') : '',
		stats.failStreak ? `failing ${TIMES}${stats.failStreak}` : '',
	].filter(Boolean).join(SEP);
}

function tooltipOf(node: GraphNode, ready: boolean): string {
	const stats = node.trialStats;
	const facts = [
		node.ghost ? 'ghost: referenced, but no loaded ledger defines it' : node.status,
		ready ? 'ready' : '',
		stats.total ? `${plural(stats.total, 'trial')}: ${stats.pass} pass, ${stats.failed} failed` : '',
		stats.failStreak ? `failing ${TIMES}${stats.failStreak}` : '',
	].filter(Boolean).join(SEP);
	return [
		`${node.id}\n${facts}`,
		node.summary,
		node.predecessors.length ? `Depends on: ${node.predecessors.join(', ')}` : '',
	].filter(Boolean).join('\n\n');
}

/** Groups by status; inside a group the frontier leads, failing nodes follow, the rest is in workflow order. */
export function buildTree(graph: Hypergraph): TreeGroup[] {
	const frontier = new Set(graph.frontier);
	const depth = computeDepths(graph.nodes, graph.cycles.feedbackEdges);
	const merged = new Set(graph.nodes.filter(n => !n.ghost).map(n => n.paper)).size > 1;
	const rank = (node: TreeNode): number => node.ready ? 0 : node.failing ? 1 : 2;
	const groups: TreeGroup[] = [];
	for (const [key, label, expanded] of GROUPS) {
		const children = graph.nodes.filter(node => (node.ghost ? 'ghost' : node.status) === key).map((node): TreeNode => {
			const ready = frontier.has(node.id);
			return {
				id: node.id, label: merged ? node.id : node.label, description: describeNode(node, ready), tooltip: tooltipOf(node, ready),
				group: key, status: node.status, ghost: node.ghost, ready, failing: node.trialStats.failStreak > 0,
			};
		}).sort((a, b) => rank(a) - rank(b) || depth.get(a.id)! - depth.get(b.id)! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		if (children.length) {
			const ready = children.filter(c => c.ready).length;
			const failing = children.filter(c => c.failing).length;
			groups.push({
				key, label, expanded, children,
				description: [String(children.length), ready ? `${ready} ready` : '', failing ? `${failing} failing` : ''].filter(Boolean).join(SEP),
			});
		}
	}
	return groups;
}

export function findTreeNode(tree: readonly TreeGroup[], id: string): { group: TreeGroup; node: TreeNode } | undefined {
	for (const group of tree) {
		const node = group.children.find(child => child.id === id);
		if (node) {
			return { group, node };
		}
	}
	return undefined;
}
