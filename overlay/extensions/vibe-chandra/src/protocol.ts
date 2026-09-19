// SPDX-License-Identifier: MIT

// The messages that cross the webview boundary. No DOM and no editor API in here: both sides import it.
import type { Hypergraph } from './model/types.ts';

/** Something the user asked to open in the editor; the host decides how to resolve it to a resource. */
export interface OpenTarget {
	kind: 'evidence' | 'task' | 'commit' | 'code';
	value: string;
	nodeId: string;
	paper: string;
}

export type FlowDirection = 'lr' | 'td';

export type HostInbound =
	| { type: 'graph'; graph: Hypergraph }
	| { type: 'focus'; id: string }
	| { type: 'config'; direction: FlowDirection };

export type HostOutbound =
	| { type: 'ready' }
	| { type: 'open'; target: OpenTarget }
	| { type: 'focused'; id: string };
