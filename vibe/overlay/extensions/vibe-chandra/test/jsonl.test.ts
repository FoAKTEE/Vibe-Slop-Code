// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonl } from '../src/model/jsonl.ts';

test('parseJsonl: complete lines, blank lines and CRLF are tolerated', () => {
	const r = parseJsonl('\n{"a":1}\r\n\n   \n{"a":2}\n');
	assert.deepEqual(r.rows, [{ a: 1 }, { a: 2 }]);
	assert.deepEqual(r.bad, []);
	assert.equal(r.tornTail, false);
});

test('parseJsonl: a torn final line (no newline) is dropped and reported, never thrown', () => {
	const r = parseJsonl('{"a":1}\n{"a":2}\n{"a":3, "b": "unfini');
	assert.deepEqual(r.rows, [{ a: 1 }, { a: 2 }]);
	assert.equal(r.tornTail, true);
	assert.equal(r.bad.length, 1);
	assert.equal(r.bad[0].line, 3);
	assert.equal(r.bad[0].reason, 'torn-tail');
});

test('parseJsonl: a final line without newline is torn even when it parses (the writer appends row + newline in one write)', () => {
	const r = parseJsonl('{"a":1}\n{"a":2}');
	assert.deepEqual(r.rows, [{ a: 1 }]);
	assert.equal(r.tornTail, true);
});

test('parseJsonl: a newline-terminated final line that does not parse is a torn tail', () => {
	const r = parseJsonl('{"a":1}\n{"a":\n');
	assert.deepEqual(r.rows, [{ a: 1 }]);
	assert.equal(r.tornTail, true);
	assert.equal(r.bad[0].reason, 'torn-tail');
});

test('parseJsonl: malformed interior lines are reported with their line number and skipped', () => {
	const r = parseJsonl('{"a":1}\nnot json\n42\n[1,2]\nnull\n{"a":2}\n');
	assert.deepEqual(r.rows, [{ a: 1 }, { a: 2 }]);
	assert.equal(r.tornTail, false);
	assert.deepEqual(r.bad.map(b => [b.line, b.reason]), [
		[2, 'invalid-json'], [3, 'not-an-object'], [4, 'not-an-object'], [5, 'not-an-object'],
	]);
});

test('parseJsonl: empty and garbage input never throw', () => {
	assert.deepEqual(parseJsonl('').rows, []);
	assert.deepEqual(parseJsonl('\n\n').rows, []);
	assert.doesNotThrow(() => parseJsonl(String.fromCharCode(0, 0xffff) + '{{{{\n}}}}\n\\'));
	assert.doesNotThrow(() => parseJsonl(undefined as unknown as string));
});

test('parseJsonl: bad-line text is truncated so a report stays small', () => {
	const r = parseJsonl('x'.repeat(5000) + '\n{"a":1}\n');
	assert.ok(r.bad[0].text.length <= 200);
});
