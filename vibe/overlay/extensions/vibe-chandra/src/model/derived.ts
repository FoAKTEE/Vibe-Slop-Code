// SPDX-License-Identifier: MIT

import type { EdgeRef, GraphNode, Hyperedge, Hypergraph } from './types.ts';

export interface GraphIndex {
	byId: Map<string, GraphNode>;
	predecessors: Map<string, string[]>;
	successors: Map<string, string[]>;
}

export function indexGraph(graph: Pick<Hypergraph, 'nodes' | 'hyperedges'>): GraphIndex {
	const byId = new Map<string, GraphNode>();
	const predecessors = new Map<string, string[]>();
	const successors = new Map<string, string[]>();
	for (const node of graph.nodes) {
		byId.set(node.id, node);
		predecessors.set(node.id, []);
		successors.set(node.id, []);
	}
	for (const h of graph.hyperedges) {
		for (const source of h.sources) {
			if (byId.has(source) && byId.has(h.target)) {
				predecessors.get(h.target)!.push(source);
				successors.get(source)!.push(h.target);
			}
		}
	}
	return { byId, predecessors, successors };
}

function closure(adjacency: Map<string, string[]>, start: string): Set<string> {
	const reached = new Set<string>();
	const stack = [...(adjacency.get(start) ?? [])];
	while (stack.length) {
		const id = stack.pop()!;
		if (reached.has(id)) {
			continue;
		}
		reached.add(id);
		stack.push(...(adjacency.get(id) ?? []));
	}
	reached.delete(start);
	return reached;
}

/** Everything `id` transitively depends on. The node itself is excluded, also when it sits on a cycle. */
export function upstream(index: GraphIndex, id: string): Set<string> {
	return closure(index.predecessors, id);
}

/** Everything that transitively depends on `id`. */
export function downstream(index: GraphIndex, id: string): Set<string> {
	return closure(index.successors, id);
}

/** Shortest directed route `from → to` along dependency edges (breadth-first, so it terminates on cycles). */
export function shortestRoute(index: GraphIndex, from: string, to: string): string[] | null {
	if (!index.byId.has(from) || !index.byId.has(to)) {
		return null;
	}
	if (from === to) {
		return [from];
	}
	const cameFrom = new Map<string, string>([[from, from]]);
	let level = [from];
	while (level.length) {
		const next: string[] = [];
		for (const id of level) {
			for (const successor of index.successors.get(id) ?? []) {
				if (cameFrom.has(successor)) {
					continue;
				}
				cameFrom.set(successor, id);
				if (successor === to) {
					const path = [to];
					while (path[0] !== from) {
						path.unshift(cameFrom.get(path[0])!);
					}
					return path;
				}
				next.push(successor);
			}
		}
		level = next;
	}
	return null;
}

export interface Route {
	/** Shortest route, always listed in dependency direction. */
	path: string[];
	/** True when no route `a → b` exists and the route `b → a` is reported instead. */
	reversed: boolean;
	/** Every node that lies on some route between the two ends (the ends included). */
	corridor: Set<string>;
}

/** Route probe between two picked nodes, in whichever direction the dependency runs. */
export function routeBetween(index: GraphIndex, a: string, b: string): Route | null {
	let path = shortestRoute(index, a, b);
	const reversed = path === null;
	if (path === null) {
		path = shortestRoute(index, b, a);
	}
	if (path === null) {
		return null;
	}
	const [from, to] = [path[0], path[path.length - 1]];
	const below = downstream(index, from).add(from);
	const above = upstream(index, to).add(to);
	return { path, reversed, corridor: new Set([...below].filter(id => above.has(id))) };
}

/** Longest-path depth of every node once the feedback edges are removed; ghosts and roots are depth 0. */
export function computeDepths(nodes: readonly GraphNode[], feedbackEdges: readonly EdgeRef[]): Map<string, number> {
	const cut = new Set(feedbackEdges.map(e => `${e.source}\n${e.target}`));
	const depth = new Map<string, number>();
	const pending = new Map<string, number>();
	const successors = new Map<string, string[]>();
	for (const node of nodes) {
		depth.set(node.id, 0);
		successors.set(node.id, []);
	}
	for (const node of nodes) {
		const sources = node.predecessors.filter(p => depth.has(p) && !cut.has(`${p}\n${node.id}`));
		pending.set(node.id, sources.length);
		for (const source of sources) {
			successors.get(source)!.push(node.id);
		}
	}
	const queue = nodes.filter(n => pending.get(n.id) === 0).map(n => n.id);
	for (let head = 0; head < queue.length; head++) {
		const id = queue[head];
		for (const successor of successors.get(id)!) {
			depth.set(successor, Math.max(depth.get(successor)!, depth.get(id)! + 1));
			pending.set(successor, pending.get(successor)! - 1);
			if (pending.get(successor) === 0) {
				queue.push(successor);
			}
		}
	}
	return depth;
}

/**
 * The ready set: active, non-solid, non-ghost nodes whose predecessors are all solid. A ghost or retired
 * predecessor is not solid, so it blocks. Ordered by depth, then id, like the orchestrator's frontier.
 */
export function computeFrontier(nodes: readonly GraphNode[], feedbackEdges: readonly EdgeRef[]): string[] {
	const byId = new Map(nodes.map(n => [n.id, n]));
	const depth = computeDepths(nodes, feedbackEdges);
	return nodes
		.filter(n => n.active && !n.ghost && n.status !== 'solid' && n.predecessors.every(p => byId.get(p)?.status === 'solid'))
		.map(n => n.id)
		.sort((a, b) => depth.get(a)! - depth.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
}

export function countStatuses(nodes: readonly GraphNode[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const node of nodes) {
		const key = node.ghost ? 'ghost' : node.status;
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

export interface Subgraph {
	nodes: GraphNode[];
	hyperedges: Hyperedge[];
	feedbackEdges: EdgeRef[];
}

/**
 * What the view lays out. Inactive (retired, amended-only) nodes are hidden like in every other Chandra
 * view, except those that a shown node still depends on: a join must never silently lose a source.
 */
export function visibleSubgraph(graph: Hypergraph, options: { showInactive: boolean }): Subgraph {
	const byId = new Map(graph.nodes.map(n => [n.id, n]));
	const shown = new Set<string>();
	const stack = graph.nodes.filter(n => options.showInactive || n.active || n.ghost).map(n => n.id);
	while (stack.length) {
		const id = stack.pop()!;
		if (shown.has(id)) {
			continue;
		}
		shown.add(id);
		stack.push(...(byId.get(id)?.predecessors ?? []));
	}
	return {
		nodes: graph.nodes.filter(n => shown.has(n.id)),
		hyperedges: graph.hyperedges.filter(h => shown.has(h.target)),
		feedbackEdges: graph.cycles.feedbackEdges.filter(e => shown.has(e.source) && shown.has(e.target)),
	};
}
