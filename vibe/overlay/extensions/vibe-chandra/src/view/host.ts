// SPDX-License-Identifier: MIT

import type { Hypergraph } from '../model/types.ts';

/** Something the user asked to open in the editor; the host decides how to resolve it to a resource. */
export interface OpenTarget {
	kind: 'evidence' | 'task' | 'commit' | 'code';
	value: string;
	nodeId: string;
	paper: string;
}

export type HostInbound =
	| { type: 'graph'; graph: Hypergraph }
	| { type: 'focus'; id: string };

export type HostOutbound =
	| { type: 'ready' }
	| { type: 'open'; target: OpenTarget };

/**
 * The view's only connection to the outside world. Inside the editor it is backed by the webview
 * messaging API, in the browser harness by a stub.
 */
export interface Host {
	onData(callback: (message: HostInbound) => void): void;
	post(message: HostOutbound): void;
}

interface WebviewApi {
	postMessage(message: unknown): void;
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
	};
}
