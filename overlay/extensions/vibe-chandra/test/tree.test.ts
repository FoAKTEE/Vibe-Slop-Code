// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, findTreeNode } from '../src/host/tree.ts';
import { summarize, statusBarText, statusBarTooltip } from '../src/host/status.ts';
import { foldLedgers } from '../src/model/fold.ts';
import type { LedgerRow } from '../src/model/types.ts';
import { fixtureInput } from './helpers.ts';

const node = (id: string, status: string, predecessors: string[] = [], task?: string): LedgerRow => ({ paper: id.split('::')[0], node_id: id, status, summary: `${id} summary`, predecessors, task_id: task });
const trial = (id: string, outcome: string): LedgerRow => ({ node_id: id, pass_fail: outcome });

const graph = foldLedgers({
	knowledge: [
		node('p::root', 'solid', [], 'T0'), node('p::zeta', 'hypothesis', ['p::root'], 'T1'), node('p::alpha', 'hypothesis', ['p::root']),
		node('p::late', 'hypothesis', ['p::alpha', 'p::zeta']), node('p::flaky', 'hypothesis', ['p::late']), node('p::stuck', 'blocking', ['p::ghost']),
		node('p::old', 'retired'), node('p::draft', 'preliminary', ['p::root']), node('p::someday', 'future', ['p::late']),
	],
	error: [
		trial('p::root', 'pass'), trial('p::flaky', 'pass'), trial('p::flaky', 'fail'), trial('p::flaky', 'crash'), trial('p::zeta', 'fail'), trial('p::zeta', 'pass'),
		trial('p::ghost', 'fail'), trial('p::old', 'fail'),
	],
});

test('tree: groups follow the working order, ready nodes lead their group, failing ones follow', () => {
	const tree = buildTree(graph);
	assert.deepEqual(tree.map(g => [g.key, g.label, g.description, g.expanded, g.children.map(c => c.label)]), [
		['blocking', 'Blocking', '1', true, ['stuck']],
		['preliminary', 'Preliminary', '1 \u00b7 1 ready', true, ['draft']],
		['hypothesis', 'Hypothesis', '4 \u00b7 2 ready \u00b7 1 failing', true, ['alpha', 'zeta', 'flaky', 'late']],
		['future', 'Future', '1', true, ['someday']],
		['solid', 'Solid', '1', true, ['root']],
		['ghost', 'Ghost', '1 \u00b7 1 failing', false, ['ghost']],
		['retired', 'Retired', '1 \u00b7 1 failing', false, ['old']],
	]);
});

test('tree: a node row says what a glance at the graph would say', () => {
	const rows = new Map(buildTree(graph).flatMap(g => g.children).map(c => [c.label, c]));
	assert.deepEqual([rows.get('zeta')?.description, rows.get('flaky')?.description, rows.get('root')?.description, rows.get('alpha')?.description, rows.get('ghost')?.description], [
		'T1 \u00b7 ready \u00b7 2 trials (1 failed)',
		'3 trials (2 failed) \u00b7 failing \u00d72',
		'T0 \u00b7 1 trial',
		'ready',
		'no ledger row \u00b7 1 trial (1 failed) \u00b7 failing \u00d71',
	]);
	assert.deepEqual(rows.get('flaky'), {
		id: 'p::flaky', label: 'flaky', description: '3 trials (2 failed) \u00b7 failing \u00d72', group: 'hypothesis', status: 'hypothesis', ghost: false, ready: false, failing: true,
		tooltip: 'p::flaky\nhypothesis \u00b7 3 trials: 1 pass, 2 failed \u00b7 failing \u00d72\n\np::flaky summary\n\nDepends on: p::late',
	});
});

test('tree: several papers keep their namespace in the label; lookups find a node and its group', () => {
	const merged = foldLedgers([fixtureInput('self'), fixtureInput('vibe')]);
	const tree = buildTree(merged);
	const labels = tree.flatMap(g => g.children).map(c => c.label);
	assert.ok(labels.includes('vibe::dag-integration') && labels.includes('self::docs-index'), labels.join(' '));
	assert.equal(tree.reduce((n, g) => n + g.children.length, 0), merged.nodes.length, 'every node of the graph is in the tree exactly once');
	const found = findTreeNode(tree, 'vibe::dag-integration');
	assert.deepEqual([found?.node.id, found?.group.key], ['vibe::dag-integration', found?.node.group]);
	assert.equal(findTreeNode(tree, 'nope::x'), undefined);
	assert.deepEqual(buildTree(foldLedgers({ knowledge: [] })), []);
});

test('status bar: solid over total, ready, failing; the totals are the active nodes, failing is what the graph marks', () => {
	const summary = summarize(graph);
	// p::flaky and the ghost are failing on screen; the retired p::old is hidden, so its failed trial does not count.
	assert.deepEqual(summary, { solid: 1, total: 8, ready: 3, failing: 2, papers: ['p'], ghosts: 1, inactive: 1, cycles: 0 });
	assert.equal(statusBarText(summary), 'Chandra: 1/8 \u00b7 3 ready \u00b7 2 failing');
	assert.equal(statusBarText(summarize(foldLedgers({ knowledge: [] }))), 'Chandra: 0/0 \u00b7 0 ready \u00b7 0 failing');
	assert.equal(statusBarTooltip(summary), 'Chandra workflow graph \u00b7 paper p\n1 of 8 nodes solid \u00b7 3 ready to work \u00b7 2 failing\n1 ghost \u00b7 1 inactive\nClick to open the graph');
	const vibe = summarize(foldLedgers(fixtureInput('vibe')));
	assert.deepEqual([vibe.solid, vibe.total, vibe.ready, vibe.papers], [0, 11, 1, ['vibe']]);
});
