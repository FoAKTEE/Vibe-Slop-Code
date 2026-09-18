// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCycles, stronglyConnectedComponents } from '../src/model/cycles.ts';
import { foldLedgers } from '../src/model/fold.ts';
import type { Hyperedge } from '../src/model/types.ts';
import { fixtureInput } from './helpers.ts';

function hyperedges(spec: Record<string, string[]>): Hyperedge[] {
	return Object.entries(spec).map(([target, sources]) => ({ id: `he:${target}`, sources, target }));
}

/** True when the graph minus the feedback edges has a topological order. */
function acyclicWithout(ids: string[], edges: Hyperedge[], feedback: { source: string; target: string }[]): boolean {
	const cut = new Set(feedback.map(e => `${e.source}\n${e.target}`));
	const indeg = new Map(ids.map(id => [id, 0]));
	const succ = new Map<string, string[]>(ids.map(id => [id, []]));
	for (const h of edges) {
		for (const s of h.sources) {
			if (!cut.has(`${s}\n${h.target}`)) {
				succ.get(s)!.push(h.target);
				indeg.set(h.target, indeg.get(h.target)! + 1);
			}
		}
	}
	const queue = ids.filter(id => indeg.get(id) === 0);
	let seen = 0;
	while (queue.length) {
		const id = queue.pop()!;
		seen++;
		for (const t of succ.get(id)!) {
			indeg.set(t, indeg.get(t)! - 1);
			if (indeg.get(t) === 0) {
				queue.push(t);
			}
		}
	}
	return seen === ids.length;
}

test('acyclic input: no SCCs, no feedback edges', () => {
	const ids = ['a', 'b', 'c', 'd'];
	const r = analyzeCycles(ids, hyperedges({ b: ['a'], c: ['a'], d: ['b', 'c'] }));
	assert.deepEqual(r, { cyclic: false, sccs: [], feedbackEdges: [] });
});

test('cyclic input is reported, never rejected: 3-node SCC and a self-loop', () => {
	const g = foldLedgers(fixtureInput('synth'));
	assert.equal(g.cycles.cyclic, true);
	assert.deepEqual(g.cycles.sccs, [['synth::r1', 'synth::r2', 'synth::r3'], ['synth::selfloop']]);
	assert.ok(g.cycles.feedbackEdges.some(e => e.source === 'synth::selfloop' && e.target === 'synth::selfloop'));
	assert.equal(g.cycles.feedbackEdges.length, 2);
	assert.ok(acyclicWithout(g.nodes.map(n => n.id), g.hyperedges, g.cycles.feedbackEdges));
});

test('the feedback edge of a repair loop is the edge that points back to the loop entry', () => {
	const g = foldLedgers(fixtureInput('synth'));
	const loop = g.cycles.feedbackEdges.find(e => e.source !== e.target);
	assert.deepEqual(loop, { source: 'synth::r3', target: 'synth::r1' });
});

test('feedback edges always break every cycle, including interlocking ones', () => {
	const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
	const edges = hyperedges({ b: ['a', 'c'], c: ['b', 'd'], d: ['c', 'e'], e: ['d', 'b'], f: ['e'], a: ['f'] });
	const r = analyzeCycles(ids, edges);
	assert.equal(r.cyclic, true);
	assert.deepEqual(r.sccs, [['a', 'b', 'c', 'd', 'e', 'f']]);
	assert.ok(acyclicWithout(ids, edges, r.feedbackEdges));
	for (const e of r.feedbackEdges) {
		assert.ok(edges.some(h => h.target === e.target && h.sources.includes(e.source)), 'feedback edges are real edges');
	}
});

test('SCC is iterative: a 50 000-node chain closed into one ring does not overflow the stack', () => {
	const n = 50_000;
	const succ = (i: number): number[] => [(i + 1) % n];
	const comps = stronglyConnectedComponents(n, succ);
	assert.equal(comps.length, 1);
	assert.equal(comps[0].length, n);
	const ids = Array.from({ length: n }, (_, i) => `n${i}`);
	const edges = ids.map((id, i) => ({ id: `he:${id}`, sources: [ids[(i + n - 1) % n]], target: id }));
	const r = analyzeCycles(ids, edges);
	assert.equal(r.feedbackEdges.length, 1);
});

test('analysis is deterministic and ignores edges to unknown ids', () => {
	const ids = ['x', 'y'];
	const edges = hyperedges({ y: ['x', 'nowhere'], x: ['y'] });
	const a = analyzeCycles(ids, edges);
	const b = analyzeCycles(ids, edges);
	assert.deepEqual(a, b);
	assert.deepEqual(a.sccs, [['x', 'y']]);
});
