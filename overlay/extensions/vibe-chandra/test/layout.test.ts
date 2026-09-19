// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldLedgers } from '../src/model/fold.ts';
import { visibleSubgraph } from '../src/model/derived.ts';
import type { Hypergraph } from '../src/model/types.ts';
import { layoutGraph, type Direction, type Layout } from '../src/view/layout.ts';
import { fixtureInput } from './helpers.ts';
import { stressInput } from './fixtures/synthetic.ts';

const graphs: Record<string, Hypergraph> = {
	self: foldLedgers(fixtureInput('self')),
	synth: foldLedgers(fixtureInput('synth')),
	merged: foldLedgers([fixtureInput('self'), fixtureInput('vibe'), fixtureInput('synth')]),
	stress: foldLedgers(stressInput(500, 7)),
};

function lay(graph: Hypergraph, direction: Direction): Layout {
	return layoutGraph(visibleSubgraph(graph, { showInactive: true }), { direction });
}

function checkInvariants(name: string, graph: Hypergraph, direction: Direction): Layout {
	const layout = lay(graph, direction);
	const placed = new Map(layout.nodes.map(n => [n.id, n]));

	assert.equal(layout.nodes.length, graph.nodes.length, `${name}: every node is placed exactly once`);
	for (const node of graph.nodes) {
		const p = placed.get(node.id);
		assert.ok(p, `${name}: ${node.id} placed`);
		for (const v of [p.x, p.y, p.w, p.h]) {
			assert.ok(Number.isFinite(v), `${name}: ${node.id} has finite geometry`);
		}
		assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= layout.width && p.y + p.h <= layout.height, `${name}: ${node.id} inside the canvas`);
	}

	// No two node boxes overlap: sweep over x, compare only boxes whose x-ranges intersect.
	const boxes = [...layout.nodes].sort((a, b) => a.x - b.x);
	for (let i = 0; i < boxes.length; i++) {
		for (let j = i + 1; j < boxes.length && boxes[j].x < boxes[i].x + boxes[i].w; j++) {
			const a = boxes[i], b = boxes[j];
			assert.ok(a.y + a.h <= b.y || b.y + b.h <= a.y, `${name}: ${a.id} overlaps ${b.id}`);
		}
	}

	// Dependencies run forward along the rank axis; only feedback edges run backwards.
	const feedback = new Set(graph.cycles.feedbackEdges.map(e => `${e.source}\n${e.target}`));
	let edgeCount = 0;
	for (const h of graph.hyperedges) {
		for (const source of h.sources) {
			edgeCount++;
			const s = placed.get(source)!, t = placed.get(h.target)!;
			if (feedback.has(`${source}\n${h.target}`)) {
				assert.ok(s.layer >= t.layer, `${name}: feedback edge ${source} → ${h.target} points back`);
			} else if (direction === 'lr') {
				assert.ok(s.x + s.w < t.x, `${name}: ${source} is left of ${h.target}`);
			} else {
				assert.ok(s.y + s.h < t.y, `${name}: ${source} is above ${h.target}`);
			}
		}
	}

	// Hyperedge routing: a join has ONE junction and ONE arrow into its target; every edge is drawn.
	assert.equal(layout.edges.length, edgeCount);
	const junctionTargets = new Set(layout.junctions.map(j => j.target));
	assert.equal(junctionTargets.size, layout.junctions.length);
	for (const h of graph.hyperedges) {
		assert.equal(junctionTargets.has(h.target), h.sources.length > 1, `${name}: junction iff more than one source (${h.target})`);
		const arrows = layout.segments.filter(sg => sg.arrow && sg.edges.some(e => layout.edges[e].target === h.target));
		assert.equal(arrows.length, 1, `${name}: exactly one arrow enters ${h.target}`);
		if (h.sources.length > 1) {
			assert.equal(arrows[0].edges.length, h.sources.length, `${name}: the stem of ${h.target} carries all its sources`);
		}
	}
	const drawn = new Set(layout.segments.flatMap(sg => sg.edges));
	assert.equal(drawn.size, layout.edges.length, `${name}: every edge owns at least one segment`);
	for (const sg of layout.segments) {
		assert.ok(sg.d.startsWith('M') && !sg.d.includes('NaN'), `${name}: segment path is well formed`);
		assert.equal(sg.feedback, sg.edges.every(e => layout.edges[e].feedback) && sg.kind === 'loop');
	}
	assert.equal(layout.segments.filter(sg => sg.kind === 'loop').length, graph.cycles.feedbackEdges.length, `${name}: one loop-back per feedback edge`);
	return layout;
}

for (const direction of ['lr', 'td'] as const) {
	for (const name of Object.keys(graphs)) {
		test(`layout invariants: ${name} (${direction})`, () => {
			checkInvariants(name, graphs[name], direction);
		});
	}
}

test('layout is deterministic for identical input', () => {
	for (const name of ['synth', 'stress']) {
		const a = JSON.stringify(lay(graphs[name], 'lr'));
		const b = JSON.stringify(lay(foldLedgers(name === 'synth' ? fixtureInput('synth') : stressInput(500, 7)), 'lr'));
		assert.equal(a, b, name);
	}
});

test('a 5-source join is one junction: five branches in, one arrow out', () => {
	const layout = lay(graphs.synth, 'lr');
	const target = 'synth::join5';
	const junction = layout.junctions.find(j => j.target === target);
	assert.ok(junction);
	const box = layout.nodes.find(n => n.id === target)!;
	assert.ok(junction.x < box.x && junction.x > box.x - 60, 'the junction sits just before its target');
	assert.ok(Math.abs(junction.y - (box.y + box.h / 2)) < 0.01, 'and on its centre line');
	const into = layout.segments.filter(sg => sg.kind === 'branch' && sg.edges.some(e => layout.edges[e].target === target));
	assert.equal(new Set(into.flatMap(sg => sg.edges)).size, 5);
});

test('long edges share one trunk per source instead of one dummy chain per edge', () => {
	const layout = lay(graphs.stress, 'lr');
	const naive = layout.edges.reduce((sum, e) => {
		const s = layout.nodes.find(n => n.id === e.source)!, t = layout.nodes.find(n => n.id === e.target)!;
		return sum + Math.max(1, Math.abs(t.layer - s.layer));
	}, 0);
	assert.ok(layout.segments.length < naive, `${layout.segments.length} segments < ${naive} without sharing`);
});

test('isolated nodes are packed into a block instead of stretching the first layer', () => {
	const rows = Array.from({ length: 40 }, (_, i) => ({ paper: 'p', node_id: `p::lonely${i}`, status: 'future', summary: '' }));
	const chain = ['a', 'b', 'c'].map((slug, i, all) => ({ paper: 'p', node_id: `p::${slug}`, status: 'solid', summary: '', predecessors: i ? [`p::${all[i - 1]}`] : [] }));
	const layout = checkInvariants('isolated', foldLedgers({ knowledge: [...chain, ...rows] }), 'lr');
	assert.ok(layout.height < 40 * 40, 'not one 40-node column');
});

test('degenerate inputs lay out without throwing', () => {
	assert.equal(layoutGraph({ nodes: [], hyperedges: [], feedbackEdges: [] }).nodes.length, 0);
	const two = foldLedgers({
		knowledge: [
			{ paper: 'p', node_id: 'p::a', status: 'hypothesis', summary: '', predecessors: ['p::b'] },
			{ paper: 'p', node_id: 'p::b', status: 'hypothesis', summary: '', predecessors: ['p::a'] },
		],
	});
	checkInvariants('two-cycle', two, 'lr');
	// A caller that forgets the feedback edges still gets a layout: the layout breaks the cycle itself.
	const careless = layoutGraph({ nodes: two.nodes, hyperedges: two.hyperedges, feedbackEdges: [] });
	assert.equal(careless.nodes.length, 2);
	assert.equal(careless.segments.filter(sg => sg.feedback).length, 1);
});

test('500 nodes / ~1500 edge segments lay out within the 300 ms budget', () => {
	const graph = graphs.stress;
	const sub = visibleSubgraph(graph, { showInactive: true });
	assert.equal(sub.nodes.length, 500);
	layoutGraph(sub, { direction: 'lr' });
	const times: number[] = [];
	let layout!: Layout;
	for (let i = 0; i < 5; i++) {
		const t0 = performance.now();
		layout = layoutGraph(sub, { direction: i % 2 ? 'td' : 'lr' });
		times.push(performance.now() - t0);
	}
	const worst = Math.max(...times);
	console.log(`stress layout: ${sub.nodes.length} nodes, ${layout.edges.length} edges, ${layout.segments.length} segments, ${layout.stats.dummies} dummies, ` +
		`${layout.stats.layers} layers, ${layout.stats.crossings} crossings; worst of 5 runs ${worst.toFixed(1)} ms (median ${times.sort((a, b) => a - b)[2].toFixed(1)} ms)`);
	assert.ok(layout.segments.length >= 1200, `enough segments to be a stress test (${layout.segments.length})`);
	assert.ok(worst < 300, `layout took ${worst.toFixed(1)} ms`);
});
