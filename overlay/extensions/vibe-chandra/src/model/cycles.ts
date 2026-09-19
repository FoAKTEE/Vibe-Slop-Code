// SPDX-License-Identifier: MIT

import type { CycleReport, EdgeRef, Hyperedge } from './types.ts';

/**
 * Tarjan's strongly connected components over nodes `0..n-1`, iterative so that a very long dependency
 * chain cannot exhaust the call stack. Components come out in reverse topological order.
 */
export function stronglyConnectedComponents(n: number, successors: (node: number) => readonly number[]): number[][] {
	const index = new Int32Array(n).fill(-1);
	const low = new Int32Array(n);
	const onStack = new Uint8Array(n);
	const stack: number[] = [];
	const components: number[][] = [];
	let counter = 0;
	// Explicit DFS frames: the node and the position of the next successor to visit.
	const frameNode: number[] = [];
	const frameNext: number[] = [];

	for (let root = 0; root < n; root++) {
		if (index[root] !== -1) {
			continue;
		}
		frameNode.push(root);
		frameNext.push(0);
		index[root] = low[root] = counter++;
		stack.push(root);
		onStack[root] = 1;
		while (frameNode.length) {
			const v = frameNode[frameNode.length - 1];
			const succ = successors(v);
			const i = frameNext[frameNext.length - 1];
			if (i < succ.length) {
				frameNext[frameNext.length - 1] = i + 1;
				const w = succ[i];
				if (index[w] === -1) {
					index[w] = low[w] = counter++;
					stack.push(w);
					onStack[w] = 1;
					frameNode.push(w);
					frameNext.push(0);
				} else if (onStack[w]) {
					low[v] = Math.min(low[v], index[w]);
				}
				continue;
			}
			frameNode.pop();
			frameNext.pop();
			if (frameNode.length) {
				const parent = frameNode[frameNode.length - 1];
				low[parent] = Math.min(low[parent], low[v]);
			}
			if (low[v] === index[v]) {
				const component: number[] = [];
				let w: number;
				do {
					w = stack.pop()!;
					onStack[w] = 0;
					component.push(w);
				} while (w !== v);
				components.push(component);
			}
		}
	}
	return components;
}

/**
 * Back edges of an iterative DFS that starts at the dependency roots (nodes without predecessors), in node
 * order. Starting at the roots makes the chosen edge of a repair loop the one that points back to the loop
 * entry, which is how a reader thinks of it. Removing these edges leaves the graph acyclic.
 */
function dfsBackEdges(n: number, successors: number[][], hasPredecessor: Uint8Array): [number, number][] {
	const WHITE = 0, GREY = 1, BLACK = 2;
	const colour = new Uint8Array(n);
	const back: [number, number][] = [];
	const frameNode: number[] = [];
	const frameNext: number[] = [];
	const roots: number[] = [];
	for (let v = 0; v < n; v++) {
		if (!hasPredecessor[v]) {
			roots.push(v);
		}
	}
	for (let v = 0; v < n; v++) {
		if (hasPredecessor[v]) {
			roots.push(v);
		}
	}
	for (const root of roots) {
		if (colour[root] !== WHITE) {
			continue;
		}
		colour[root] = GREY;
		frameNode.push(root);
		frameNext.push(0);
		while (frameNode.length) {
			const v = frameNode[frameNode.length - 1];
			const i = frameNext[frameNext.length - 1];
			if (i < successors[v].length) {
				frameNext[frameNext.length - 1] = i + 1;
				const w = successors[v][i];
				if (colour[w] === WHITE) {
					colour[w] = GREY;
					frameNode.push(w);
					frameNext.push(0);
				} else if (colour[w] === GREY) {
					back.push([v, w]);
				}
				continue;
			}
			colour[v] = BLACK;
			frameNode.pop();
			frameNext.pop();
		}
	}
	return back;
}

/** Cycles are legal input (repair and retry loops, cross-paper merges): report them, never reject. */
export function analyzeCycles(ids: readonly string[], hyperedges: readonly Hyperedge[]): CycleReport {
	const n = ids.length;
	const indexOf = new Map<string, number>();
	ids.forEach((id, i) => indexOf.set(id, i));
	const successors: number[][] = Array.from({ length: n }, () => []);
	const hasPredecessor = new Uint8Array(n);
	const selfLoop = new Uint8Array(n);
	for (const h of hyperedges) {
		const t = indexOf.get(h.target);
		if (t === undefined) {
			continue;
		}
		for (const source of h.sources) {
			const s = indexOf.get(source);
			if (s === undefined) {
				continue;
			}
			successors[s].push(t);
			if (s === t) {
				selfLoop[s] = 1;
			} else {
				hasPredecessor[t] = 1;
			}
		}
	}
	const sccs = stronglyConnectedComponents(n, v => successors[v])
		.filter(c => c.length > 1 || selfLoop[c[0]])
		.map(c => c.sort((a, b) => a - b))
		.sort((a, b) => a[0] - b[0]);
	const feedbackEdges: EdgeRef[] = sccs.length === 0 ? [] :
		dfsBackEdges(n, successors, hasPredecessor).map(([s, t]) => ({ source: ids[s], target: ids[t] }));
	return { cyclic: sccs.length > 0, sccs: sccs.map(c => c.map(i => ids[i])), feedbackEdges };
}
