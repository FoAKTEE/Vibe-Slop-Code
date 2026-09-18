// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STATE, formatHash, parseHash, type ViewState } from '../src/view/hashState.ts';

const state = (patch: Partial<ViewState>): ViewState => ({ ...DEFAULT_STATE, ...patch });

test('hash state: the documented forms', () => {
	assert.equal(formatHash(state({ focus: 'self::docs-index', reach: 'upstream' })), '#focus=self::docs-index&reach=upstream');
	assert.equal(formatHash(state({ focus: 'a', route: ['a', 'b'] })), '#focus=a&route=a~b');
	assert.equal(formatHash(DEFAULT_STATE), '');
	assert.deepEqual(parseHash('#focus=self::docs-index&reach=upstream'), state({ focus: 'self::docs-index', reach: 'upstream' }));
	assert.deepEqual(parseHash('focus=x'), state({ focus: 'x' }), 'the leading # is optional');
});

test('hash state round-trips every field, including hostile ids', () => {
	const cases: ViewState[] = [
		DEFAULT_STATE,
		state({ focus: 'self::kb-memory-preservation' }),
		state({ focus: 'p::a', reach: 'downstream' }),
		state({ focus: 'p::a', route: ['p::a', '_shared::lemma'] }),
		state({ lens: ['solid', 'blocking'], direction: 'td', showInactive: true }),
		state({ focus: 'we~ird & id=1 #%+', route: ['we~ird & id=1 #%+', 'ünï::cødé 漢字'], lens: ['ghost'] }),
	];
	for (const s of cases) {
		assert.deepEqual(parseHash(formatHash(s)), s, formatHash(s));
	}
});

test('hash state: defaults are omitted, so an untouched view keeps a clean URL', () => {
	assert.equal(formatHash(state({ focus: 'x', reach: 'both', direction: 'lr', lens: [] })), '#focus=x');
});

test('hash state: malformed input never throws and unknown keys are ignored', () => {
	for (const hash of ['', '#', '#&&&', '#focus', '#focus=', '#reach=sideways', '#route=onlyone', '#route=~', '#dir=diagonal', '#%E0%A4%A', '#focus=%', '#zzz=1&focus=ok']) {
		assert.doesNotThrow(() => parseHash(hash), hash);
	}
	assert.deepEqual(parseHash('#reach=sideways&dir=diagonal&route=onlyone'), DEFAULT_STATE);
	assert.deepEqual(parseHash('#zzz=1&focus=ok'), state({ focus: 'ok' }));
	assert.deepEqual(parseHash('#focus=%'), state({ focus: '%' }));
});

test('hash state: reach without a focus is meaningless and dropped', () => {
	assert.deepEqual(parseHash('#reach=upstream'), DEFAULT_STATE);
});
