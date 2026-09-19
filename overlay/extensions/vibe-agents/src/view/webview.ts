// SPDX-License-Identifier: MIT

// Entry point of the webview bundle (media/sessions.js): mounts the view on the messaging API of its host.
import { webviewHost } from './host.ts';
import { mount } from './sessionsView.ts';

const host = webviewHost();
if (host) {
	mount(document.getElementById('vibe-agents') ?? document.body, host);
}
