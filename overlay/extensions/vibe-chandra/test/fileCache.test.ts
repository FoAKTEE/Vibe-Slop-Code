// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerFileCache } from '../src/host/fileCache.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const row = (id: string, extra = ''): string => `{"node_id":"${id}","status":"hypothesis"${extra}}\n`;

test('file cache: an append is parsed from where the last read stopped', () => {
	const cache = new LedgerFileCache();
	const first = row('p::a') + row('p::b');
	assert.deepEqual(cache.update('k', bytes(first)), { mode: 'reloaded', parsed: 2 });
	assert.deepEqual(cache.update('k', bytes(first)), { mode: 'unchanged', parsed: 0 });
	assert.deepEqual(cache.update('k', bytes(first + row('p::c'))), { mode: 'appended', parsed: 1 });
	assert.deepEqual(cache.rows('k').map(r => r.node_id), ['p::a', 'p::b', 'p::c']);
});

test('file cache: a torn tail is invisible until its newline lands', () => {
	const cache = new LedgerFileCache();
	const base = row('p::a');
	const next = row('p::b', ',"summary":"caf\u00e9 \u6f22"');
	cache.update('k', bytes(base));
	// Cut the next row at every byte, also in the middle of a multi-byte character.
	const full = bytes(base + next);
	for (let cut = bytes(base).length; cut < full.length; cut++) {
		const result = cache.update('k', full.slice(0, cut));
		assert.equal(result.parsed, 0, `cut at ${cut}`);
		assert.deepEqual(cache.rows('k').map(r => r.node_id), ['p::a'], `cut at ${cut}`);
		assert.equal(cache.problems('k').tornTail, cut > bytes(base).length, `cut at ${cut}`);
	}
	assert.deepEqual(cache.update('k', full), { mode: 'appended', parsed: 1 });
	assert.deepEqual(cache.rows('k').map(r => r.summary ?? null), [null, 'caf\u00e9 \u6f22']);
	assert.equal(cache.problems('k').tornTail, false);
});

test('file cache: a complete line that does not parse is counted, skipped and never retried', () => {
	const cache = new LedgerFileCache();
	cache.update('k', bytes(row('p::a') + '{"node_id": broken\n' + '[1,2]\n' + '\n' + row('p::b')));
	assert.deepEqual(cache.rows('k').map(r => r.node_id), ['p::a', 'p::b']);
	assert.deepEqual(cache.problems('k'), { badLines: 2, tornTail: false });
});

test('file cache: a file that shrank or was rewritten is read again from the start', () => {
	const cache = new LedgerFileCache();
	cache.update('k', bytes(row('p::a') + row('p::b') + row('p::c')));
	assert.deepEqual(cache.update('k', bytes(row('p::a'))), { mode: 'reloaded', parsed: 1 });
	assert.deepEqual(cache.rows('k').map(r => r.node_id), ['p::a']);
	// Same length, different content: the guard over the tail of what was consumed notices.
	assert.deepEqual(cache.update('k', bytes(row('p::z'))), { mode: 'reloaded', parsed: 1 });
	assert.deepEqual(cache.rows('k').map(r => r.node_id), ['p::z']);
	// Rewritten AND longer.
	assert.deepEqual(cache.update('k', bytes(row('p::y') + row('p::x'))), { mode: 'reloaded', parsed: 2 });
	assert.deepEqual(cache.rows('k').map(r => r.node_id), ['p::y', 'p::x']);
});

test('file cache: a vanished file leaves an empty ledger behind, and may come back', () => {
	const cache = new LedgerFileCache();
	cache.update('k', bytes(row('p::a')));
	assert.deepEqual(cache.update('k', undefined), { mode: 'removed', parsed: 0 });
	assert.deepEqual(cache.rows('k'), []);
	assert.equal(cache.has('k'), false);
	assert.deepEqual(cache.update('k', undefined), { mode: 'unchanged', parsed: 0 });
	assert.deepEqual(cache.update('k', bytes(row('p::b'))), { mode: 'reloaded', parsed: 1 });
	assert.deepEqual(cache.update('empty', bytes('')), { mode: 'reloaded', parsed: 0 });
	assert.equal(cache.has('empty'), true);
});

test('file cache: incremental parsing agrees with a fresh parse, whatever the chunking', () => {
	const lines = Array.from({ length: 40 }, (_, i) => i % 7 === 3 ? 'not json\n' : row(`p::n${i}`, `,"summary":"s${i} \u00b7 \u2192"`));
	const whole = bytes(lines.join(''));
	const fresh = new LedgerFileCache();
	fresh.update('k', whole);
	for (const step of [1, 7, 64, 1000]) {
		const cache = new LedgerFileCache();
		for (let end = 0; end < whole.length; end += step) {
			cache.update('k', whole.slice(0, end));
		}
		cache.update('k', whole);
		assert.deepEqual(cache.rows('k'), fresh.rows('k'), `step ${step}`);
		assert.deepEqual(cache.problems('k'), fresh.problems('k'), `step ${step}`);
	}
});
