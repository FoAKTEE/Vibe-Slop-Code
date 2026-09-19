// SPDX-License-Identifier: MIT

import type { HostInbound, HostOutbound } from '../protocol.ts';

export type { FlowDirection, HostInbound, HostOutbound, OpenTarget } from '../protocol.ts';

/**
 * The view's only connection to the outside world. Inside the editor it is backed by the webview
 * messaging API, in the browser harness by a stub.
 */
export interface Host {
	onData(callback: (message: HostInbound) => void): void;
	post(message: HostOutbound): void;
	/** The view state (a `#focus=...` hash) saved by an earlier incarnation of this view, if the host keeps one. */
	loadState?(): string | undefined;
	/** Persists the view state beyond the life of the page (a hidden webview is destroyed, a window reloads). */
	saveState?(hash: string): void;
}

interface WebviewApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

/** A host backed by `acquireVsCodeApi()`; undefined outside a webview. */
export function webviewHost(): Host | undefined {
	const acquire = (globalThis as { acquireVsCodeApi?: () => WebviewApi }).acquireVsCodeApi;
	if (typeof acquire !== 'function') {
		return undefined;
	}
	const api = acquire();
	return {
		onData: callback => window.addEventListener('message', event => callback(event.data as HostInbound)),
		post: message => api.postMessage(message),
		loadState: () => {
			const state = api.getState() as { hash?: unknown } | null | undefined;
			return typeof state?.hash === 'string' ? state.hash : undefined;
		},
		saveState: hash => api.setState({ hash }),
	};
}
