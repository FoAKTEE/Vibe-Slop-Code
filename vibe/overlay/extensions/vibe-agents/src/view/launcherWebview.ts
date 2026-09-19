// SPDX-License-Identifier: MIT

// Entry point of the webview bundle of ChatGPT Web (media/launcher.js): mounts the panel or the compact view, which
// one the page says, on the messaging API of its host.
import type { LauncherInbound, LauncherOutbound } from '../model/launcher/panel.ts';
import { mountLauncher, type LauncherViewHost } from './launcherView.ts';

interface WebviewApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

const acquire = (globalThis as { acquireVsCodeApi?: () => WebviewApi }).acquireVsCodeApi;
const root = document.getElementById('vibe-agents');
if (typeof acquire === 'function' && root) {
	const api = acquire();
	const host: LauncherViewHost = {
		onData: callback => window.addEventListener('message', event => callback(event.data as LauncherInbound)),
		post: (message: LauncherOutbound) => api.postMessage(message),
		// What is kept over hiding the view and over reloading the window: which screen shows
		getState: () => {
			const state = api.getState();
			return typeof state === 'object' && state !== null ? state as { screen?: unknown } : {};
		},
		setState: state => api.setState(state),
	};
	mountLauncher(root, root.dataset.layout === 'panel' ? 'panel' : 'compact', host);
}
