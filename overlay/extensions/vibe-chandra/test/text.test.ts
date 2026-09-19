// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateWidth, fit, wrapTwo } from '../src/view/text.ts';

test('fit: text that fits is untouched, longer text keeps its head and tail', () => {
	assert.equal(fit('docs-index', 150, 12), 'docs-index');
	const fitted = fit('orchestrator-test-discovery-with-a-very-long-tail', 150, 12);
	assert.ok(fitted.includes('…') && fitted.startsWith('orchestrator') && fitted.endsWith('tail'), fitted);
	assert.ok(estimateWidth(fitted, 12) <= 150);
	assert.ok(fit('x'.repeat(400), 10, 12).length <= 3, 'degenerate widths still terminate');
});

test('wrapTwo: breaks after a separator, at most two lines, each within the width', () => {
	assert.deepEqual(wrapTwo('meta-skills', 154, 14.5), ['meta-skills']);
	assert.deepEqual(wrapTwo('kb-registry-candidate-binding', 154, 14.5), ['kb-registry-', 'candidate-binding']);
	const long = wrapTwo('a-very-long-identifier-that-cannot-possibly-fit-on-two-lines-of-a-card', 154, 14.5);
	assert.equal(long.length, 2);
	for (const line of [...long, ...wrapTwo('unbreakableidentifierwithoutanyseparatorwhatsoever', 154, 14.5)]) {
		assert.ok(estimateWidth(line, 14.5) <= 154, line);
	}
});
