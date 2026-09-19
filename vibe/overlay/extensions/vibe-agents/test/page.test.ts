// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../src/host/page.ts';

const INPUT = { cspSource: 'https://file+.vscode-resource.test', nonce: 'N0nce', styleUri: 'https://x/media/sessions.css', scriptUri: 'https://x/media/sessions.js', title: 'Sessions' };

test('the page runs under a strict policy: nothing inline, the script by nonce, styles from the extension only', () => {
	const html = renderPage(INPUT);
	const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? '';
	assert.deepEqual(csp.split('; '), [
		`default-src 'none'`,
		'style-src https://file+.vscode-resource.test',
		`script-src 'nonce-N0nce'`,
	]);
	assert.ok(!/unsafe-inline|unsafe-eval/.test(html));
	assert.ok(!/\sstyle=/.test(html), 'no style attribute');
	assert.ok(!/<style/.test(html), 'no style element');
	assert.equal(html.match(/<script/g)?.length, 1);
	assert.ok(html.includes('<script type="module" nonce="N0nce" src="https://x/media/sessions.js"></script>'));
	assert.ok(html.includes('<link rel="stylesheet" href="https://x/media/sessions.css">'));
	assert.ok(html.includes('<div id="vibe-agents"></div>'));
});

test('what goes into the page is escaped', () => {
	const html = renderPage({ ...INPUT, title: '<b>"T"</b>', scriptUri: 'https://x/a.js?x="y"&z' });
	assert.ok(html.includes('<title>&lt;b&gt;&quot;T&quot;&lt;/b&gt;</title>'));
	assert.ok(html.includes('src="https://x/a.js?x=&quot;y&quot;&amp;z"'));
});
