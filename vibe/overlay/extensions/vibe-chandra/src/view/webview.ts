// SPDX-License-Identifier: MIT

// Entry point of the webview bundle (media/graph.js): mounts the view on the messaging API of its host.
import { mount } from './graphView.ts';
import { webviewHost } from './host.ts';

const host = webviewHost();
if (host) {
	mount(document.getElementById('vibe-chandra-graph') ?? document.body, host);
}
