// SPDX-License-Identifier: MIT

import type { HostInbound, HostOutbound } from '../protocol.ts';
import type { ViewHost } from './sessionsView.ts';

interface WebviewApi {
	postMessage(message: unknown): void;
}

/** A host backed by `acquireVsCodeApi()`; undefined outside a webview. */
export function webviewHost(): ViewHost | undefined {
	const acquire = (globalThis as { acquireVsCodeApi?: () => WebviewApi }).acquireVsCodeApi;
	if (typeof acquire !== 'function') {
		return undefined;
	}
	const api = acquire();
	return {
		onData: callback => window.addEventListener('message', event => callback(event.data as HostInbound)),
		post: (message: HostOutbound) => api.postMessage(message),
	};
}
