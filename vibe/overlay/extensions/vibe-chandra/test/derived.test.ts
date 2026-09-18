// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldLedgers } from '../src/model/fold.ts';
import { downstream, indexGraph, routeBetween, shortestRoute, upstream, visibleSubgraph } from '../src/model/derived.ts';
import { fixtureInput } from './helpers.ts';
import { stressInput } from './fixtures/synthetic.ts';

const synth = foldLedgers(fixtureInput('synth'));
const ix = indexGraph(synth);
const s = (slug: string): string => `synth::${slug}`;

test('frontier: non-solid active nodes whose predecessors are all solid, in depth-then-id order', () => {
	assert.deepEqual(synth.frontier, [s('d'), s('g'), s('ready')]);
	assert.deepEqual(foldLedgers(fixtureInput('self')).frontier, []);
	assert.deepEqual(foldLedgers(fixtureInput('vibe')).frontier, ['vibe::scaffold']);
});

test('frontier: ghosts, retired predecessors and unfinished cycle members block', () => {
	for (const blocked of ['e', 'join5', 'r1', 'r2', 'r3', 'selfloop']) {
		assert.ok(!synth.frontier.includes(s(blocked)), `${blocked} is not ready`);
	}
	assert.ok(!synth.frontier.includes(s('missing')), 'a ghost is never ready');
	assert.ok(!synth.frontier.includes(s('c')), 'a retired node is never ready');
});

test('status counts cover every node exactly once', () => {
	assert.deepEqual(synth.statusCounts, { solid: 2, retired: 1, hypothesis: 6, preliminary: 1, future: 1, blocking: 1, amended: 1, ghost: 3 });
	const total = Object.values(synth.statusCounts).reduce((a, b) => a + b, 0);
	assert.equal(total, synth.nodes.length);
});

test('closures: upstream and downstream reach, the start node excluded', () => {
	assert.deepEqual([...upstream(ix, s('join5'))].sort(),
		['_shared::lemma', s('a'), s('b'), s('c'), s('d'), s('e'), s('g'), s('missing')].sort());
	assert.deepEqual([...downstream(ix, s('b'))].sort(), [s('g'), s('join5'), s('ready'), s('selfloop')].sort());
	assert.deepEqual([...upstream(ix, s('a'))], []);
	assert.deepEqual([...upstream(ix, 'no-such-node')], []);
});

test('closures terminate on cycles and exclude the start node even when it is on the cycle', () => {
	assert.deepEqual([...upstream(ix, s('r1'))].sort(), [s('a'), s('r2'), s('r3')].sort());
	assert.deepEqual([...downstream(ix, s('r2'))].sort(), [s('r1'), s('r3')].sort());
	assert.deepEqual([...downstream(ix, s('selfloop'))], []);
});

test('shortest route follows edge direction and terminates on cyclic graphs', () => {
	assert.deepEqual(shortestRoute(ix, s('a'), s('join5')), [s('a'), s('join5')]);
	assert.deepEqual(shortestRoute(ix, s('a'), s('r3')), [s('a'), s('r1'), s('r2'), s('r3')]);
	assert.deepEqual(shortestRoute(ix, s('r3'), s('r2')), [s('r3'), s('r1'), s('r2')], 'through the loop-back');
	assert.equal(shortestRoute(ix, s('join5'), s('a')), null);
	assert.equal(shortestRoute(ix, s('r1'), s('ready')), null);
	assert.deepEqual(shortestRoute(ix, s('a'), s('a')), [s('a')]);
	assert.equal(shortestRoute(ix, s('a'), 'no-such-node'), null);
});

test('route probe: falls back to the reverse direction and reports the corridor', () => {
	const forward = routeBetween(ix, s('b'), s('join5'));
	assert.deepEqual(forward?.path, [s('b'), s('join5')]);
	assert.equal(forward?.reversed, false);
	assert.deepEqual([...forward!.corridor].sort(), [s('b'), s('g'), s('join5')].sort(), 'every node on some b to join5 route');
	const backward = routeBetween(ix, s('join5'), s('b'));
	assert.deepEqual(backward?.path, [s('b'), s('join5')]);
	assert.equal(backward?.reversed, true);
	assert.equal(routeBetween(ix, s('r1'), s('ready')), null);
});

test('route probe stays fast on the 500-node stress graph', () => {
	const g = foldLedgers(stressInput(500, 7));
	const big = indexGraph(g);
	const t0 = performance.now();
	let found = 0;
	for (let i = 0; i < 200; i++) {
		const a = g.nodes[(i * 37) % g.nodes.length].id;
		const b = g.nodes[(i * 101 + 250) % g.nodes.length].id;
		if (routeBetween(big, a, b)) {
			found++;
		}
	}
	assert.ok(found > 0);
	assert.ok(performance.now() - t0 < 1000);
});

test('visible subgraph: inactive nodes are hidden unless an active node still depends on them', () => {
	const shown = visibleSubgraph(synth, { showInactive: false });
	const ids = new Set(shown.nodes.map(n => n.id));
	assert.ok(ids.has(s('c')), 'retired c stays: active e lists it as a predecessor');
	assert.ok(!ids.has(s('f')), 'amended-only f is hidden');
	assert.ok(ids.has(s('missing')), 'ghosts are always shown');
	for (const h of shown.hyperedges) {
		assert.ok(ids.has(h.target));
		assert.ok(h.sources.every(x => ids.has(x)), 'a shown join never loses a source');
	}
	const all = visibleSubgraph(synth, { showInactive: true });
	assert.equal(all.nodes.length, synth.nodes.length);
});
