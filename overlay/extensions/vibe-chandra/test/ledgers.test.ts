// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LedgerService, type LedgerFolder, type Snapshot } from '../src/host/ledgers.ts';
import { foldLedgers } from '../src/model/fold.ts';
import { fixtureInput, fixturesDir } from './helpers.ts';
import { MemoryFs } from './memoryFs.ts';

const ROOT = 'results/ledgers';
const node = (id: string, status = 'hypothesis', predecessors: string[] = []): string =>
	JSON.stringify({ paper: id.split('::')[0], node_id: id, status, summary: `${id} summary`, predecessors }) + '\n';
const trial = (id: string, outcome: string): string => JSON.stringify({ paper: id.split('::')[0], node_id: id, pass_fail: outcome }) + '\n';

function seed(fs: MemoryFs, paper: string, files: Record<string, string>): void {
	const place: Record<string, string> = { nodes: 'knowledge', trials: 'error', entries: 'claim', results: 'result' };
	for (const [name, text] of Object.entries(files)) {
		fs.write(`${ROOT}/${place[name]}/paper_${paper}/${name}.jsonl`, text);
	}
}

function service(folders: LedgerFolder[], papers: string[] = []): LedgerService {
	return new LedgerService({ folders: () => folders, options: () => ({ root: ROOT, papers }) });
}

const ids = (snapshot: Snapshot): string[] => snapshot.graph.nodes.map(n => n.id);

test('ledger service: discovers every paper of every folder and folds them like the model does', async () => {
	const fs = new MemoryFs();
	for (const paper of ['synth', 'self']) {
		for (const [db, file] of [['knowledge', 'nodes'], ['error', 'trials'], ['claim', 'entries'], ['result', 'results']]) {
			try {
				fs.write(`${ROOT}/${db}/paper_${paper}/${file}.jsonl`, readFileSync(join(fixturesDir, `paper_${paper}`, `${file}.jsonl`), 'utf8'));
			} catch {
				// this fixture paper has no such ledger
			}
		}
	}
	fs.write(`${ROOT}/.lock`, '').write(`${ROOT}/knowledge/paper_self/summary.csv`, 'x').write(`${ROOT}/knowledge/README.md`, 'x');
	const snapshot = await service([{ key: 'file:///w', name: 'w', fs }]).reload();
	assert.deepEqual(snapshot.available, ['self', 'synth']);
	assert.deepEqual(snapshot.selected, ['self', 'synth']);
	assert.deepEqual(snapshot.graph, foldLedgers([fixtureInput('self'), fixtureInput('synth')]));
	assert.deepEqual(snapshot.sources.map(s => [s.folder, s.paper, Object.keys(s.files).sort()]), [
		['file:///w', 'self', ['claim', 'error', 'knowledge']],
		['file:///w', 'synth', ['claim', 'error', 'knowledge', 'result']],
	]);
	assert.equal(snapshot.stats.filesRead, 7);
});

test('ledger service: no ledger root, no folders, an empty root: an empty graph and no error', async () => {
	for (const folders of [[], [{ key: 'a', name: 'a', fs: new MemoryFs() }], [{ key: 'a', name: 'a', fs: new MemoryFs().write(`${ROOT}/.lock`, '') }]]) {
		const snapshot = await service(folders).reload();
		assert.deepEqual([snapshot.available, snapshot.graph.nodes, snapshot.problems], [[], [], []]);
	}
});

test('ledger service: an append re-reads that one file only, and lists nothing', async () => {
	const fs = new MemoryFs();
	seed(fs, 'p', { nodes: node('p::a', 'solid') + node('p::b', 'hypothesis', ['p::a']), trials: trial('p::b', 'fail') });
	seed(fs, 'q', { nodes: node('q::a') });
	const ledgers = service([{ key: 'w', name: 'w', fs }]);
	const seen: Snapshot[] = [];
	ledgers.onDidChange(s => seen.push(s));
	await ledgers.reload();
	fs.reads = [];
	fs.lists = [];
	fs.append(`${ROOT}/knowledge/paper_p/nodes.jsonl`, node('p::c', 'hypothesis', ['p::a', 'p::b']));
	const snapshot = await ledgers.refresh([{ folder: 'w', path: ['knowledge', 'paper_p', 'nodes.jsonl'] }, { folder: 'w', path: ['knowledge', 'paper_p', 'summary.csv'] }, { folder: 'w', path: ['.lock'] }]);
	assert.deepEqual(fs.reads, [`${ROOT}/knowledge/paper_p/nodes.jsonl`]);
	assert.deepEqual(fs.lists, []);
	assert.deepEqual(ids(snapshot), ['p::a', 'p::b', 'p::c', 'q::a']);
	assert.deepEqual(snapshot.graph.hyperedges.find(h => h.target === 'p::c')?.sources, ['p::a', 'p::b']);
	assert.equal(snapshot.graph.nodes[1].trialStats.failStreak, 1, 'the untouched trial ledger is still attached');
	assert.equal(snapshot.stats.filesRead, 1);
	assert.deepEqual(seen.map(s => s.revision), [1, 2]);

	// A change that touches no ledger changes nothing and notifies nobody.
	await ledgers.refresh([{ folder: 'w', path: ['.lock'] }, { folder: 'elsewhere', path: ['knowledge', 'paper_p', 'nodes.jsonl'] }]);
	assert.equal(seen.length, 2);
});

test('ledger service: a torn tail is not a row until it is complete', async () => {
	const fs = new MemoryFs();
	seed(fs, 'p', { nodes: node('p::a') });
	const ledgers = service([{ key: 'w', name: 'w', fs }]);
	await ledgers.reload();
	const change = [{ folder: 'w', path: ['knowledge', 'paper_p', 'nodes.jsonl'] }];
	const next = node('p::b', 'hypothesis', ['p::a']);
	fs.append(`${ROOT}/knowledge/paper_p/nodes.jsonl`, next.slice(0, 25));
	let snapshot = await ledgers.refresh(change);
	assert.deepEqual([ids(snapshot), snapshot.problems], [['p::a'], []], 'a torn tail is normal while a writer is active: no problem reported');
	fs.append(`${ROOT}/knowledge/paper_p/nodes.jsonl`, next.slice(25));
	snapshot = await ledgers.refresh(change);
	assert.deepEqual(ids(snapshot), ['p::a', 'p::b']);
	fs.append(`${ROOT}/knowledge/paper_p/nodes.jsonl`, '{"node_id": oops}\n');
	snapshot = await ledgers.refresh(change);
	assert.deepEqual([ids(snapshot), snapshot.problems], [['p::a', 'p::b'], ['w: knowledge/paper_p/nodes.jsonl has 1 unreadable line']]);
});

test('ledger service: a file that vanishes mid-read, a paper that is deleted, a paper that appears', async () => {
	const fs = new MemoryFs();
	seed(fs, 'p', { nodes: node('p::a'), trials: trial('p::a', 'pass') });
	seed(fs, 'q', { nodes: node('q::a') });
	const ledgers = service([{ key: 'w', name: 'w', fs }]);
	fs.beforeRead = path => {
		if (path.endsWith('paper_p/trials.jsonl')) {
			fs.remove(path);
		}
	};
	let snapshot = await ledgers.reload();
	assert.deepEqual([ids(snapshot), snapshot.graph.nodes[0].trialStats.total, snapshot.problems], [['p::a', 'q::a'], 0, []]);
	fs.beforeRead = () => { };

	// The watcher reports a deleted directory by its top-most path only.
	fs.remove(`${ROOT}/knowledge/paper_q`);
	snapshot = await ledgers.refresh([{ folder: 'w', path: ['knowledge', 'paper_q'] }]);
	assert.deepEqual([snapshot.available, ids(snapshot)], [['p'], ['p::a']]);

	seed(fs, 'r', { nodes: node('r::a', 'solid'), trials: trial('r::a', 'pass') });
	snapshot = await ledgers.refresh([{ folder: 'w', path: ['knowledge', 'paper_r'] }, { folder: 'w', path: ['error', 'paper_r', 'trials.jsonl'] }]);
	assert.deepEqual([snapshot.available, ids(snapshot), snapshot.graph.nodes[1].trialStats.pass], [['p', 'r'], ['p::a', 'r::a'], 1]);

	fs.remove(ROOT);
	snapshot = await ledgers.refresh([{ folder: 'w', path: [] }]);
	assert.deepEqual([snapshot.available, ids(snapshot)], [[], []]);
});

test('ledger service: a read error keeps the rows already known and says so', async () => {
	const fs = new MemoryFs();
	seed(fs, 'p', { nodes: node('p::a') });
	const ledgers = service([{ key: 'w', name: 'w', fs }]);
	await ledgers.reload();
	fs.append(`${ROOT}/knowledge/paper_p/nodes.jsonl`, node('p::b'));
	fs.failing.add(`${ROOT}/knowledge/paper_p/nodes.jsonl`);
	let snapshot = await ledgers.refresh([{ folder: 'w', path: ['knowledge', 'paper_p', 'nodes.jsonl'] }]);
	assert.deepEqual([ids(snapshot), snapshot.problems], [['p::a'], ['w: knowledge/paper_p/nodes.jsonl could not be read (EIO: results/ledgers/knowledge/paper_p/nodes.jsonl)']]);
	fs.failing.clear();
	snapshot = await ledgers.refresh([{ folder: 'w', path: ['knowledge', 'paper_p', 'nodes.jsonl'] }]);
	assert.deepEqual([ids(snapshot), snapshot.problems], [['p::a', 'p::b'], []]);
});

test('ledger service: the papers option narrows the fold, not the discovery; folders merge by node id', async () => {
	const one = new MemoryFs();
	const two = new MemoryFs();
	seed(one, 'p', { nodes: node('p::a', 'solid') });
	seed(one, 'q', { nodes: node('q::a', 'hypothesis', ['p::a']) });
	seed(two, 'r', { nodes: node('r::a', 'hypothesis', ['q::a']) });
	const folders = [{ key: 'one', name: 'one', fs: one }, { key: 'two', name: 'two', fs: two }];
	const all = await service(folders).reload();
	assert.deepEqual([all.available, ids(all), all.graph.frontier], [['p', 'q', 'r'], ['p::a', 'q::a', 'r::a'], ['q::a']]);
	assert.equal(all.owner('r'), 'two');
	assert.equal(all.owner('nope'), undefined);
	const narrowed = await service(folders, ['q']).reload();
	assert.deepEqual([narrowed.available, narrowed.selected, ids(narrowed)], [['p', 'q', 'r'], ['q'], ['q::a', 'p::a']]);
	assert.equal(narrowed.graph.nodes[1].ghost, true, 'a predecessor from a paper that is not loaded is a ghost');
});

test('ledger service: changes that arrive during a refresh are merged into exactly one follow-up', async () => {
	const fs = new MemoryFs();
	seed(fs, 'p', { nodes: node('p::a') });
	const ledgers = service([{ key: 'w', name: 'w', fs }]);
	await ledgers.reload();
	const revisions: number[] = [];
	ledgers.onDidChange(s => revisions.push(s.graph.nodes.length));
	const change = [{ folder: 'w', path: ['knowledge', 'paper_p', 'nodes.jsonl'] }];
	let release!: () => void;
	const gate = new Promise<void>(resolve => release = resolve);
	fs.beforeRead = () => gate;
	fs.reads = [];
	fs.append(`${ROOT}/knowledge/paper_p/nodes.jsonl`, node('p::b'));
	const first = ledgers.refresh(change);
	await new Promise(resolve => setImmediate(resolve));
	fs.append(`${ROOT}/knowledge/paper_p/nodes.jsonl`, node('p::c'));
	const second = ledgers.refresh(change);
	const third = ledgers.refresh(change);
	fs.beforeRead = () => { };
	release();
	const results = await Promise.all([first, second, third]);
	assert.deepEqual(results.map(s => s.graph.nodes.length), [3, 3, 3], 'every caller gets the state that includes its change');
	assert.equal(fs.reads.length, 2, 'one read in flight, one follow-up for everything that queued up behind it');
	assert.deepEqual(revisions, [3]);
});
