// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../src/host/page.ts';

const input = {
	cspSource: 'https://*.vscode-cdn.net', nonce: 'N0nce123', styleUris: ['https://host/media/webview.css', 'https://host/media/graph.css'],
	scriptUri: 'https://host/media/graph.js', direction: 'td' as const, surface: 'panel' as const, title: 'Workflow Graph',
};

test('page: a strict policy, the mount point, the stylesheets and the module script', () => {
	const html = renderPage(input);
	const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1];
	assert.equal(csp, 'default-src \'none\'; style-src https://*.vscode-cdn.net; script-src \'nonce-N0nce123\'; font-src https://*.vscode-cdn.net; img-src https://*.vscode-cdn.net data:');
	assert.ok(!/unsafe/.test(html) && !/<style|style=|onclick=/i.test(html), 'nothing inline');
	assert.match(html, /<body class="vc-surface-panel">\s*<div id="vibe-chandra-graph" data-direction="td"><\/div>/);
	assert.match(html, /<script type="module" nonce="N0nce123" src="https:\/\/host\/media\/graph.js"><\/script>/);
	assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]*)">/g)].map(m => m[1]), input.styleUris);
	assert.ok(/^[\x00-\x7f]*$/.test(html));
});

test('page: everything interpolated is escaped', () => {
	const html = renderPage({ ...input, title: '<b>"x"&', scriptUri: 'https://host/a"b<c>.js', styleUris: ['https://host/s\'"<>.css'], surface: 'view', direction: 'lr' });
	assert.match(html, /<title>&lt;b&gt;&quot;x&quot;&amp;<\/title>/);
	assert.match(html, /src="https:\/\/host\/a&quot;b&lt;c&gt;\.js"/);
	assert.match(html, /href="https:\/\/host\/s'&quot;&lt;&gt;\.css"/);
	assert.match(html, /<body class="vc-surface-view">/);
});
