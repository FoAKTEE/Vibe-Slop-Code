// SPDX-License-Identifier: MIT

// The messages that cross the webview boundary. No DOM and no editor API in here: both sides import it.
import type { StatusRow } from './model/profiles.ts';
import type { Session } from './model/session.ts';

export interface ProfileItem {
	id: string;
	label: string;
	icon: string | undefined;
}

export interface SessionItem {
	session: Session;
	/** Stop was asked for already: asking again closes the terminal. */
	stopArmed: boolean;
}

export type HostInbound = {
	type: 'state';
	/** In the order to show them. */
	sessions: SessionItem[];
	profiles: ProfileItem[];
	rows: StatusRow[];
	summary: string;
	/** The clock of the host, which the timestamps of the sessions are from. */
	now: number;
	/** What happened since the last message, for screen readers. */
	announcement: string | undefined;
};

export type SessionAction = 'focus' | 'stop' | 'restart' | 'dismiss';

export type HostOutbound =
	| { type: 'ready' }
	| { type: 'start'; profileId: string }
	| { type: 'adopt' }
	| { type: 'clear' }
	| { type: 'session'; action: SessionAction; id: string }
	/** The action of a status row, or the one of its secondary actions at the index `secondary`. */
	| { type: 'row'; id: string; secondary?: number };
