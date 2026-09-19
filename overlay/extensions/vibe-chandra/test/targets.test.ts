// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvidence, findNodeRow, parseLocation, planOpen, taskCandidates } from '../src/host/targets.ts';

test('targets: a reference into the workspace is a safe relative path with an optional line range', () => {
	assert.deepEqual(parseLocation('results/synth/b.log'), { path: ['results', 'synth', 'b.log'] });
	assert.deepEqual(parseLocation('./results/demo/paper_x/codes/solver.py:L10-24'), { path: ['results', 'demo', 'paper_x', 'codes', 'solver.py'], line: 10, endLine: 24 });
	assert.deepEqual(parseLocation('codes/solver.py:L7'), { path: ['codes', 'solver.py'], line: 7 });
	assert.deepEqual(parseLocation('codes/solver.py:12'), { path: ['codes', 'solver.py'], line: 12 });
	assert.deepEqual(parseLocation('codes/solver.py#L3-L5'), { path: ['codes', 'solver.py'], line: 3, endLine: 5 });
	assert.deepEqual(parseLocation('notes\\a b.md'), { path: ['notes', 'a b.md'] });
	for (const hostile of ['', '  ', '/etc/passwd', '../secrets.txt', 'a/../../b', '~/x', 'C:\\x', 'file:///etc/passwd', 'a/\u0000b']) {
		assert.equal(parseLocation(hostile), undefined, JSON.stringify(hostile));
	}
});

test('targets: evidence is a commit citation, a link, a file, or just words', () => {
	assert.deepEqual(classifyEvidence('c849a4f'), { kind: 'commit', sha: 'c849a4f' });
	assert.deepEqual(classifyEvidence(' commit 2D9BDD9c849a4f11 '), { kind: 'commit', sha: '2d9bdd9c849a4f11' });
	assert.deepEqual(classifyEvidence('https://arxiv.org/abs/2401.01234'), { kind: 'url', url: 'https://arxiv.org/abs/2401.01234' });
	assert.deepEqual(classifyEvidence('results/synth/b.log'), { kind: 'file', location: { path: ['results', 'synth', 'b.log'] } });
	assert.deepEqual(classifyEvidence('README.md'), { kind: 'file', location: { path: ['README.md'] } });
	// Seven hex digits are a commit before they are a file name, exactly like the admission gate reads them.
	assert.deepEqual(classifyEvidence('deadbeef'), { kind: 'commit', sha: 'deadbeef' });
	assert.deepEqual(classifyEvidence('67 tests pass, see the verification run'), { kind: 'text' });
	assert.deepEqual(classifyEvidence('abc123'), { kind: 'text' }, 'too short for a commit, no path shape');
	assert.deepEqual(classifyEvidence('../escape.log'), { kind: 'text' });
});

test('targets: a task file is looked for in every project of the results directory', () => {
	assert.deepEqual(taskCandidates(['results', 'ledgers'], 'vibe', 'V8', ['ledgers', 'demo', 'other']), [
		['results', 'demo', 'paper_vibe', 'tasks', 'V8', 'implementation.md'],
		['results', 'demo', 'paper_vibe', 'tasks', 'V8.md'],
		['results', 'other', 'paper_vibe', 'tasks', 'V8', 'implementation.md'],
		['results', 'other', 'paper_vibe', 'tasks', 'V8.md'],
	]);
	assert.deepEqual(taskCandidates(['ledgers'], 'p', 'T1', ['ledgers', 'proj']), [['proj', 'paper_p', 'tasks', 'T1', 'implementation.md'], ['proj', 'paper_p', 'tasks', 'T1.md']]);
	assert.deepEqual(taskCandidates(['results', 'ledgers'], 'vibe', '../x', ['demo']), []);
	assert.deepEqual(taskCandidates(['results', 'ledgers'], 'a/b', 'V8', ['demo']), []);
});

test('targets: what the view asks to open becomes a plan the host can carry out', () => {
	const target = (kind: 'evidence' | 'task' | 'commit' | 'code', value: string) => ({ kind, value, nodeId: 'vibe::x', paper: 'vibe' });
	assert.deepEqual(planOpen(target('commit', '5d341dc')), { kind: 'commit', sha: '5d341dc' });
	assert.deepEqual(planOpen(target('commit', 'not a sha')), { kind: 'text' });
	assert.deepEqual(planOpen(target('evidence', 'c849a4f')), { kind: 'commit', sha: 'c849a4f' });
	assert.deepEqual(planOpen(target('evidence', 'results/synth/b.log')), { kind: 'file', location: { path: ['results', 'synth', 'b.log'] } });
	assert.deepEqual(planOpen(target('code', 'results/p/paper_x/codes/a.py:L3-9')), { kind: 'file', location: { path: ['results', 'p', 'paper_x', 'codes', 'a.py'], line: 3, endLine: 9 } });
	assert.deepEqual(planOpen(target('code', '/abs/a.py')), { kind: 'text' });
	assert.deepEqual(planOpen(target('task', 'V8')), { kind: 'task', paper: 'vibe', taskId: 'V8' });
});

test('targets: the latest row of a node in nodes.jsonl, by physical line', () => {
	const rows = [
		{ node_id: 'p::a', status: 'hypothesis' },
		{ node_id: 'p::b', status: 'hypothesis', summary: 'mentions "p::a" in passing' },
		{ node_id: 'p::a', status: 'solid' },
		{ node_id: 'p::c', predecessors: ['p::a'] },
	];
	const text = rows.map(r => JSON.stringify(r)).join('\n') + '\n' + '{"node_id":"p::a","status":"ret';
	assert.deepEqual(findNodeRow(text, 'p::a'), { line: 2, length: JSON.stringify(rows[2]).length });
	assert.deepEqual(findNodeRow(text, 'p::c'), { line: 3, length: JSON.stringify(rows[3]).length });
	assert.equal(findNodeRow(text, 'p::zzz'), undefined);
	assert.equal(findNodeRow('', 'p::a'), undefined);
	assert.deepEqual(findNodeRow('garbage\r\n{"node_id":"p::a"}\r\n', 'p::a'), { line: 1, length: 18 });
});
