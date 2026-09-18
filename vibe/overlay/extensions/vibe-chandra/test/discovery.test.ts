// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChange, ledgerFileSegments, normalizeRoot, relativeSegments, selectPapers } from '../src/host/discovery.ts';

test('discovery: the ledger root setting is a relative path, whatever the user typed', () => {
	assert.deepEqual(normalizeRoot('results/ledgers'), ['results', 'ledgers']);
	assert.deepEqual(normalizeRoot('./results//ledgers/'), ['results', 'ledgers']);
	assert.deepEqual(normalizeRoot('results\\ledgers'), ['results', 'ledgers']);
	assert.deepEqual(normalizeRoot('ledgers'), ['ledgers']);
	for (const hostile of [undefined, 42, '', '   ', '/', '/etc/ledgers', '../outside', 'results/../../x', 'C:\\ledgers', '.']) {
		assert.deepEqual(normalizeRoot(hostile), ['results', 'ledgers'], String(hostile));
	}
});

test('discovery: a path below the root is classified by what a change to it means', () => {
	const cases: [string, ReturnType<typeof classifyChange>][] = [
		['knowledge/paper_vibe/nodes.jsonl', { kind: 'file', db: 'knowledge', paper: 'vibe' }],
		['error/paper_vibe/trials.jsonl', { kind: 'file', db: 'error', paper: 'vibe' }],
		['claim/paper_2401.01234/entries.jsonl', { kind: 'file', db: 'claim', paper: '2401.01234' }],
		['result/paper_a_b/results.jsonl', { kind: 'file', db: 'result', paper: 'a_b' }],
		// The right file name in the wrong database is not a ledger.
		['knowledge/paper_vibe/trials.jsonl', { kind: 'ignore' }],
		['knowledge/paper_vibe/summary.csv', { kind: 'ignore' }],
		['knowledge/paper_vibe/nodes.jsonl.tmp', { kind: 'ignore' }],
		['knowledge/paper_/nodes.jsonl', { kind: 'ignore' }],
		['knowledge/notes/nodes.jsonl', { kind: 'ignore' }],
		['knowledge/paper_vibe/deep/nodes.jsonl', { kind: 'ignore' }],
		['.lock', { kind: 'ignore' }],
		['scratch', { kind: 'ignore' }],
		// Directories appear and vanish as a whole: only their top-most path is reported.
		['', { kind: 'directory', prefix: [] }],
		['knowledge', { kind: 'directory', prefix: ['knowledge'] }],
		['error/paper_new', { kind: 'directory', prefix: ['error', 'paper_new'] }],
		['error/summary.csv', { kind: 'ignore' }],
	];
	for (const [path, expected] of cases) {
		assert.deepEqual(classifyChange(path === '' ? [] : path.split('/')), expected, path);
	}
});

test('discovery: every ledger of a paper has one well-known place', () => {
	assert.deepEqual(ledgerFileSegments(['results', 'ledgers'], 'knowledge', 'vibe'), ['results', 'ledgers', 'knowledge', 'paper_vibe', 'nodes.jsonl']);
	assert.deepEqual(ledgerFileSegments(['l'], 'result', 'x'), ['l', 'result', 'paper_x', 'results.jsonl']);
});

test('discovery: a changed resource is addressed relative to the ledger root of its folder', () => {
	assert.deepEqual(relativeSegments('/w/chandra', ['results', 'ledgers'], '/w/chandra/results/ledgers/knowledge/paper_a/nodes.jsonl'), ['knowledge', 'paper_a', 'nodes.jsonl']);
	assert.deepEqual(relativeSegments('/w/chandra/', ['results', 'ledgers'], '/w/chandra/results/ledgers'), []);
	assert.deepEqual(relativeSegments('/', ['ledgers'], '/ledgers/error'), ['error']);
	assert.equal(relativeSegments('/w/chandra', ['results', 'ledgers'], '/w/chandra/results/ledgers-old/x'), undefined);
	assert.equal(relativeSegments('/w/chandra', ['results', 'ledgers'], '/w/other/results/ledgers/x'), undefined);
	assert.equal(relativeSegments('/w/chandra', ['results', 'ledgers'], '/w/chandra/results'), undefined);
});

test('discovery: the papers setting narrows what is there and never invents a paper', () => {
	const available = ['self', 'vibe', '2401.01234'];
	assert.deepEqual(selectPapers(available, []), available);
	assert.deepEqual(selectPapers(available, undefined), available);
	assert.deepEqual(selectPapers(available, 'vibe'), available, 'not a list: ignored');
	assert.deepEqual(selectPapers(available, ['vibe']), ['vibe']);
	assert.deepEqual(selectPapers(available, ['vibe', 'self', 'vibe', 7]), ['self', 'vibe'], 'order of discovery, no duplicates');
	assert.deepEqual(selectPapers(available, ['gone']), [], 'an explicit choice that matches nothing shows nothing');
});
