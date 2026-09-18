// SPDX-License-Identifier: MIT

// The fold is checked against the Python sources of truth. `fixtures/paper_self` and `fixtures/paper_vibe` are
// verbatim snapshots of this repository's ledgers, `fixtures/paper_synth` is hand-made to cover what they lack
// (supersedes, retired and revived nodes, amended pointers, ghosts, cycles, a torn tail). The `*.expected.json`
// files next to them are the unedited output of, run against a repo root that holds only the snapshot:
//   python3 _common/knowledge_database.py query --repo-root <root> --paper <P>          -> query.expected.json
//   python3 _common/visualization/dag_mermaid.py progress --repo-root <root> --papers <P> -> progress.expected.json
// The last test repeats the comparison live whenever the Python tools and the real ledgers are reachable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonl } from '../src/model/jsonl.ts';
import { foldLedgers, latestPerNode } from '../src/model/fold.ts';
import type { GraphNode, Hypergraph, LedgerRow } from '../src/model/types.ts';
import { findChandraRoot, fixtureInput, fixturesDir, readJson, readText } from './helpers.ts';

interface ProgressRow { paper: string; node_id: string; status: string | null; n_knowledge: number; n_trials: number; pass: number; fail: number }

function node(graph: Hypergraph, id: string): GraphNode {
	const n = graph.nodes.find(x => x.id === id);
	assert.ok(n, `node ${id} exists`);
	return n;
}

/** The graph's active nodes must be exactly the rows the Python `query` returns, in the same order. */
function assertAgreesWithPythonQuery(graph: Hypergraph, expected: LedgerRow[]): void {
	const active = graph.nodes.filter(n => n.active && !n.ghost);
	assert.deepEqual(active.map(n => n.id), expected.map(r => r.node_id));
	for (const row of expected) {
		const n = node(graph, row.node_id as string);
		assert.equal(n.status, row.status);
		assert.equal(n.paper, row.paper);
		assert.equal(n.summary, row.summary);
		assert.equal(n.taskId, row.task_id);
		assert.equal(n.domain, row.domain);
		assert.equal(n.evidence, row.evidence);
		assert.equal(n.gitCommit, row.git_commit);
		assert.equal(n.riskTier, row.risk_tier);
		assert.deepEqual(n.predecessors, [...new Set(row.predecessors as string[])]);
		assert.equal(n.revisions.find(r => r.rowHash === row.row_hash)?.seq, row.node_seq);
	}
}

/** Record and trial counts must be exactly what `dag_mermaid.py progress` reports. */
function assertAgreesWithPythonProgress(graph: Hypergraph, expected: ProgressRow[]): void {
	for (const p of expected) {
		const n = node(graph, p.node_id);
		assert.equal(n.ghost ? null : n.status, p.status, `${p.node_id} status`);
		assert.equal(n.revisionCount, p.n_knowledge, `${p.node_id} n_knowledge`);
		assert.equal(n.trialStats.total, p.n_trials, `${p.node_id} n_trials`);
		assert.equal(n.trialStats.pass, p.pass, `${p.node_id} pass`);
		assert.equal(n.trialStats.failed, p.fail, `${p.node_id} fail`);
	}
	const listed = new Set(expected.map(p => p.node_id));
	for (const n of graph.nodes) {
		if (!listed.has(n.id)) {
			assert.ok(!n.active || n.ghost, `${n.id} is not in the Python progress readout, so it must be inactive or a ghost`);
		}
	}
}

for (const paper of ['self', 'vibe', 'synth']) {
	test(`fold agrees with the Python query on the committed paper_${paper} snapshot`, () => {
		const dir = join(fixturesDir, `paper_${paper}`);
		const expected = readJson<LedgerRow[]>(join(dir, 'query.expected.json'));
		const rows = parseJsonl(readText(join(dir, 'nodes.jsonl'))).rows;
		assert.deepEqual(latestPerNode(rows), expected, 'latestPerNode returns the very rows of `knowledge_database.py query`');
		assertAgreesWithPythonQuery(foldLedgers(fixtureInput(paper)), expected);
	});
}

for (const paper of ['self', 'synth']) {
	test(`record and trial counts agree with the Python progress readout on paper_${paper}`, () => {
		const expected = readJson<ProgressRow[]>(join(fixturesDir, `paper_${paper}`, 'progress.expected.json'));
		assertAgreesWithPythonProgress(foldLedgers(fixtureInput(paper)), expected);
	});
}

test('real snapshot: 22 solid nodes, a 5-source join, claims attached, no ghosts, no cycles', () => {
	const g = foldLedgers(fixtureInput('self'));
	assert.equal(g.nodes.length, 22);
	assert.deepEqual(g.statusCounts, { solid: 22 });
	assert.equal(g.nodes.filter(n => n.ghost).length, 0);
	assert.equal(g.cycles.cyclic, false);
	assert.deepEqual(g.frontier, []);
	const join5 = g.hyperedges.find(h => h.target === 'self::docs-index');
	assert.equal(join5?.sources.length, 5);
	assert.ok(g.nodes.some(n => n.claimCount > 0));
	assert.deepEqual(g.papers, ['self']);
});

test('latest row wins; promotions accrue as revisions under one node', () => {
	const g = foldLedgers(fixtureInput('synth'));
	const a = node(g, 'synth::a');
	assert.equal(a.status, 'solid');
	assert.equal(a.revisionCount, 3);
	assert.deepEqual(a.revisions.map(r => r.status), ['hypothesis', 'preliminary', 'solid']);
	assert.equal(a.evidence, 'results/synth/a.log');
	assert.equal(a.riskTier, 'R2');
	assert.equal(a.conceptAdvance, true);
	assert.equal(a.label, 'a');
});

test('amended rows are ignored pointers; a node with only amended rows is inactive', () => {
	const g = foldLedgers(fixtureInput('synth'));
	const b = node(g, 'synth::b');
	assert.equal(b.status, 'solid');
	assert.equal(b.summary, 'b does its thing');
	assert.equal(b.revisionCount, 2);
	const f = node(g, 'synth::f');
	assert.equal(f.status, 'amended');
	assert.equal(f.active, false);
});

test('retired hides a node from the active set; a later active row revives it', () => {
	const g = foldLedgers(fixtureInput('synth'));
	const c = node(g, 'synth::c');
	assert.equal(c.status, 'retired');
	assert.equal(c.active, false);
	assert.equal(c.ghost, false);
	const d = node(g, 'synth::d');
	assert.equal(d.status, 'hypothesis');
	assert.equal(d.active, true);
	assert.deepEqual(d.revisions.map(r => r.status), ['retired', 'hypothesis']);
});

test('supersedes replaces the semantic payload and is recorded as lineage in both directions', () => {
	const g = foldLedgers(fixtureInput('synth'));
	const n = node(g, 'synth::g');
	assert.deepEqual(n.predecessors, ['synth::b']);
	assert.equal(n.summary, 'g reformulated on top of b');
	const [first, second] = n.revisions;
	assert.equal(second.supersedes, first.rowHash);
	assert.equal(first.supersededBy, second.rowHash);
	assert.deepEqual(g.hyperedges.find(h => h.target === 'synth::g')?.sources, ['synth::b']);
});

test('ghost nodes: referenced predecessors and trial anchors without a row are kept, not dropped', () => {
	const g = foldLedgers(fixtureInput('synth'));
	const ghosts = g.nodes.filter(n => n.ghost).map(n => n.id).sort();
	assert.deepEqual(ghosts, ['_shared::lemma', 'synth::missing', 'synth::orphan']);
	const lemma = node(g, '_shared::lemma');
	assert.equal(lemma.paper, '_shared');
	assert.equal(lemma.label, 'lemma');
	assert.equal(lemma.status, 'unknown');
	assert.equal(node(g, 'synth::orphan').trialStats.failed, 1);
	assert.ok(!g.nodes.some(n => n.id === 'synth::torn'), 'the torn tail row never becomes a node');
});

test('hyperedges: one per node carrying its full predecessor set', () => {
	const g = foldLedgers(fixtureInput('synth'));
	const byTarget = new Map(g.hyperedges.map(h => [h.target, h]));
	assert.equal(byTarget.size, g.hyperedges.length, 'at most one hyperedge per target');
	assert.deepEqual(byTarget.get('synth::join5')?.sources, ['synth::a', 'synth::b', 'synth::d', 'synth::g', 'synth::e']);
	assert.deepEqual(byTarget.get('synth::r2')?.sources, ['synth::r1']);
	assert.equal(byTarget.has('synth::a'), false, 'no predecessors, no hyperedge');
	const ids = new Set(g.nodes.map(n => n.id));
	for (const h of g.hyperedges) {
		assert.ok(ids.has(h.target));
		for (const s of h.sources) {
			assert.ok(ids.has(s), `${s} is a node (possibly a ghost)`);
		}
		assert.equal(new Set(h.sources).size, h.sources.length);
	}
	assert.equal(new Set(g.hyperedges.map(h => h.id)).size, g.hyperedges.length);
});

test('duplicate and malformed predecessors are normalised', () => {
	const g = foldLedgers({
		knowledge: [
			{ paper: 'p', node_id: 'p::x', status: 'solid', summary: 'x', predecessors: [] },
			{ paper: 'p', node_id: 'p::y', status: 'hypothesis', summary: 'y', predecessors: ['p::x', 'p::x', 7, null, ''] },
			{ paper: 'p', node_id: 'p::z', status: 'hypothesis', summary: 'z', predecessors: 'p::x' },
			{ paper: 'p', status: 'solid', summary: 'row without node_id' },
			{ paper: 'p', node_id: 'p::w', status: 'not-a-status', summary: 'w' },
		],
	});
	assert.deepEqual(node(g, 'p::y').predecessors, ['p::x']);
	assert.deepEqual(node(g, 'p::z').predecessors, []);
	assert.equal(node(g, 'p::w').status, 'unknown');
	assert.equal(g.nodes.length, 4);
	assert.ok(g.warnings.length > 0);
});

test('trial stats and the trial list attach under the node', () => {
	const g = foldLedgers(fixtureInput('synth'));
	const a = node(g, 'synth::a');
	assert.deepEqual(
		{ total: a.trialStats.total, pass: a.trialStats.pass, fail: a.trialStats.fail, crash: a.trialStats.crash, partial: a.trialStats.partial, failed: a.trialStats.failed },
		{ total: 4, pass: 1, fail: 1, crash: 1, partial: 1, failed: 3 });
	assert.equal(a.trialStats.lastOutcome, 'pass');
	assert.ok(a.trialStats.lastTimestamp);
	assert.deepEqual(a.trials.map(t => t.outcome), ['fail', 'crash', 'partial', 'pass']);
	assert.equal(a.trials[0].rootCause, 'root cause of fail 1');
	assert.equal(a.trials[0].fixHypothesis, 'structural fix after fail 1');
	const r1 = node(g, 'synth::r1');
	assert.equal(r1.trialStats.lastOutcome, 'fail');
	assert.equal(r1.trialStats.failStreak, 2);
	const b = node(g, 'synth::b');
	assert.equal(b.trialStats.total, 2);
	assert.equal(b.trialStats.amended, 1);
	assert.equal(b.trialStats.lastOutcome, 'pass', 'an amended pointer is not an outcome');
});

test('claims and results attach through node_ids, latest row per entry', () => {
	const g = foldLedgers(fixtureInput('synth'));
	const a = node(g, 'synth::a');
	assert.equal(a.claimCount, 2);
	assert.equal(a.resultCount, 1);
	assert.equal(a.claims.find(c => c.id === 'cl-1')?.status, 'admitted');
	assert.equal(a.results[0].status, 'checked');
	assert.equal(node(g, 'synth::r1').claimCount, 1);
	assert.equal(node(g, 'synth::r1').openObligations, 1);
});

test('multi-paper: several papers and _shared nodes fold into one graph', () => {
	const shared = {
		knowledge: [
			{ paper: '_shared', node_id: '_shared::lemma', status: 'solid', summary: 'shared lemma', predecessors: [], evidence: 'x' },
		],
	};
	const g = foldLedgers([fixtureInput('self'), fixtureInput('vibe'), fixtureInput('synth'), shared]);
	assert.deepEqual(g.papers, ['self', 'vibe', 'synth', '_shared']);
	assert.equal(g.nodes.filter(n => n.paper === 'self').length, 22);
	assert.equal(g.nodes.filter(n => n.paper === 'vibe').length, 11);
	const lemma = node(g, '_shared::lemma');
	assert.equal(lemma.ghost, false, 'the row from the _shared paper resolves what was a ghost');
	assert.equal(lemma.status, 'solid');
	assert.equal(new Set(g.nodes.map(n => n.id)).size, g.nodes.length);
});

test('multi-paper: the same node_id claimed by two papers is reported, first owner wins', () => {
	const g = foldLedgers([
		{ knowledge: [{ paper: 'p', node_id: 'dup', status: 'solid', summary: 'from p' }] },
		{ knowledge: [{ paper: 'q', node_id: 'dup', status: 'hypothesis', summary: 'from q' }] },
	]);
	assert.equal(g.nodes.length, 1);
	assert.equal(g.nodes[0].summary, 'from p');
	assert.ok(g.warnings.some(w => w.includes('dup')));
});

test('the graph is plain JSON (it crosses a postMessage boundary)', () => {
	const g = foldLedgers(fixtureInput('synth'));
	assert.deepEqual(JSON.parse(JSON.stringify(g)), g);
});

test('empty input folds to an empty graph', () => {
	const g = foldLedgers({ knowledge: [] });
	assert.deepEqual(g.nodes, []);
	assert.deepEqual(g.hyperedges, []);
	assert.equal(g.cycles.cyclic, false);
});

test('live ledgers: fold agrees with the Python query run right now (skipped outside the Chandra repo)', t => {
	const root = findChandraRoot();
	if (!root) {
		t.skip('Chandra repository not found above this extension');
		return;
	}
	try {
		execFileSync('python3', ['--version'], { stdio: 'ignore' });
	} catch {
		t.skip('python3 not available');
		return;
	}
	const base = join(root, 'results', 'ledgers', 'knowledge');
	const papers = readdirSync(base).filter(d => d.startsWith('paper_')).map(d => d.slice('paper_'.length));
	for (const paper of papers) {
		const file = join(base, `paper_${paper}`, 'nodes.jsonl');
		if (!existsSync(file)) {
			continue;
		}
		// The ledger is appended while we read: retry until the file is unchanged around the Python run.
		for (let attempt = 0; ; attempt++) {
			const before = readText(file);
			const out: string = execFileSync('python3', [join(root, '_common', 'knowledge_database.py'), 'query', '--repo-root', root, '--paper', paper],
				{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 });
			if (readText(file) !== before && attempt < 3) {
				continue;
			}
			assert.deepEqual(latestPerNode(parseJsonl(before).rows), JSON.parse(out), `paper ${paper}`);
			break;
		}
	}
});
