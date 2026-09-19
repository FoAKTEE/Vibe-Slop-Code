// SPDX-License-Identifier: MIT

// One agent session: plain data and the state machine that moves it. A session is a value, every event
// gives a new one (or the very same object when nothing changed, which is how callers detect change).
import type { Activity } from './activity.ts';
import { isMeaningfulLine } from './signals.ts';

/**
 * starting -> working <-> waiting -> finished (exit 0) | failed (exit != 0) | closed (the terminal went away)
 *
 * `waiting` means the turn of the agent is over and it needs the user.
 */
export type SessionState = 'starting' | 'working' | 'waiting' | 'finished' | 'failed' | 'closed';

const STATES: readonly SessionState[] = ['starting', 'working', 'waiting', 'finished', 'failed', 'closed'];

export interface Session {
	readonly id: string;
	readonly profileId: string | undefined;
	readonly label: string;
	readonly icon: string | undefined;
	/** The command line that runs the agent. */
	readonly command: string;
	/** Name of the workspace folder the agent runs in. */
	readonly folder: string | undefined;
	/** The terminal was the user's: the agent was started by hand. */
	readonly adopted: boolean;

	readonly state: SessionState;
	readonly createdAt: number;
	/** When the agent began to run in its current run. */
	readonly startedAt: number | undefined;
	/** When `state` was entered. */
	readonly stateSince: number;
	readonly endedAt: number | undefined;
	readonly exitCode: number | undefined;

	/** The title the agent gave its terminal. */
	readonly title: string | undefined;
	/** The last line of output that says something. */
	readonly lastLine: string | undefined;

	/** Something happened that the user did not look at yet: set on the way to waiting, finished and failed. */
	readonly attention: boolean;
	/** The terminal of the session is gone: there is nothing to focus or to stop. */
	readonly terminalGone: boolean;
	/** How often the agent was started in this session. */
	readonly runs: number;
}

export interface SessionInit {
	id: string;
	profileId: string | undefined;
	label: string;
	icon?: string;
	command: string;
	folder: string | undefined;
	adopted: boolean;
}

export type SessionEvent =
	/** The command began to execute. */
	| { type: 'started'; at: number }
	| { type: 'activity'; activity: Activity; at: number }
	/** The agent exited. No exit code: the shell did not report one. */
	| { type: 'exited'; exitCode: number | undefined; at: number }
	/** The terminal went away. */
	| { type: 'closed'; at: number }
	/** The user looked at the terminal of the session. */
	| { type: 'seen' }
	/** The agent is started again in this session. */
	| { type: 'restarted'; at: number }
	| { type: 'line'; text: string }
	/** The text of a desktop notification: what the agent wants the user to know. */
	| { type: 'notified'; text: string; at: number }
	| { type: 'title'; text: string };

const MAX_LINE = 240;

export function createSession(init: SessionInit, now: number): Session {
	return {
		id: init.id,
		profileId: init.profileId,
		label: init.label,
		icon: init.icon,
		command: init.command,
		folder: init.folder,
		adopted: init.adopted,
		state: 'starting',
		createdAt: now,
		startedAt: undefined,
		stateSince: now,
		endedAt: undefined,
		exitCode: undefined,
		title: undefined,
		lastLine: undefined,
		attention: false,
		terminalGone: false,
		runs: 1,
	};
}

/** Whether the agent may still be running. */
export function isLive(session: Session): boolean {
	return session.state === 'starting' || session.state === 'working' || session.state === 'waiting';
}

export function needsAttention(session: Session): boolean {
	return session.attention;
}

export function reduce(session: Session, event: SessionEvent): Session {
	switch (event.type) {
		case 'started':
			return session.state === 'starting' ? { ...session, state: 'working', startedAt: event.at, stateSince: event.at } : session;

		case 'activity': {
			if (!isLive(session) || session.state === event.activity) {
				return session;
			}
			return {
				...session,
				state: event.activity,
				startedAt: session.startedAt ?? event.at,
				stateSince: event.at,
				attention: event.activity === 'waiting',
			};
		}

		case 'exited':
			if (!isLive(session)) {
				return session;
			}
			return {
				...session,
				state: event.exitCode === undefined || event.exitCode === 0 ? 'finished' : 'failed',
				exitCode: event.exitCode,
				startedAt: session.startedAt ?? event.at,
				stateSince: event.at,
				endedAt: event.at,
				attention: true,
			};

		case 'closed':
			if (session.terminalGone) {
				return session;
			}
			return isLive(session)
				? { ...session, state: 'closed', stateSince: event.at, endedAt: event.at, attention: false, terminalGone: true }
				: { ...session, terminalGone: true };

		case 'seen':
			return session.attention ? { ...session, attention: false } : session;

		case 'restarted':
			return {
				...session,
				state: 'starting',
				startedAt: undefined,
				stateSince: event.at,
				endedAt: undefined,
				exitCode: undefined,
				title: undefined,
				lastLine: undefined,
				attention: false,
				terminalGone: false,
				runs: session.runs + 1,
			};

		case 'line': {
			const lastLine = cleanLine(event.text);
			return lastLine === undefined || lastLine === session.lastLine ? session : { ...session, lastLine };
		}

		case 'notified': {
			const lastLine = cleanLine(event.text);
			return lastLine === undefined || lastLine === session.lastLine ? session : { ...session, lastLine };
		}

		case 'title': {
			const title = event.text.replace(/\s+/g, ' ').trim().slice(0, MAX_LINE) || undefined;
			return title === session.title ? session : { ...session, title };
		}
	}
}

/**
 * One line for the card: the frame a full screen program draws around its text is cut off, white space is
 * collapsed. Lines that say nothing give `undefined`.
 */
export function cleanLine(text: string): string | undefined {
	if (!isMeaningfulLine(text)) {
		return undefined;
	}
	const line = text
		.replace(/[\x00-\x1f\x7f]/g, ' ')
		.replace(/^[\s\u2500-\u259f]+|[\s\u2500-\u259f]+$/g, '')
		.replace(/\s+/g, ' ');
	return truncate(line, MAX_LINE) || undefined;
}

function truncate(text: string, length: number): string {
	if (text.length <= length) {
		return text;
	}
	const isSplitPair = /[\ud800-\udbff]/.test(text[length - 1]);
	return text.slice(0, isSplitPair ? length - 1 : length);
}

export interface Elapsed {
	/** Time in the current state. For a session that ended: time since then. */
	inState: number;
	/** How long the agent ran, or runs. */
	total: number;
}

export function elapsed(session: Session, now: number): Elapsed {
	const end = session.endedAt ?? now;
	return {
		inState: Math.max(0, now - session.stateSince),
		total: session.startedAt === undefined ? 0 : Math.max(0, end - session.startedAt),
	};
}

/** `42s`, `3m 5s`, `2h 10m`: two units at most, no zero unit. */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) {
		return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
	}
	if (minutes > 0) {
		return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
	}
	return `${seconds}s`;
}

/** A session from storage. Anything that is not a session as this version writes it gives `undefined`. */
export function restoreSession(value: unknown): Session | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const optional = <T>(key: string, type: 'string' | 'number'): T | undefined | null => raw[key] === undefined || raw[key] === null ? undefined : typeof raw[key] === type ? raw[key] as T : null;

	const profileId = optional<string>('profileId', 'string');
	const icon = optional<string>('icon', 'string');
	const folder = optional<string>('folder', 'string');
	const startedAt = optional<number>('startedAt', 'number');
	const endedAt = optional<number>('endedAt', 'number');
	const exitCode = optional<number>('exitCode', 'number');
	const title = optional<string>('title', 'string');
	const lastLine = optional<string>('lastLine', 'string');
	if (
		typeof raw.id !== 'string' || typeof raw.label !== 'string' || typeof raw.command !== 'string' ||
		typeof raw.adopted !== 'boolean' || typeof raw.attention !== 'boolean' || typeof raw.terminalGone !== 'boolean' ||
		typeof raw.createdAt !== 'number' || typeof raw.stateSince !== 'number' || typeof raw.runs !== 'number' ||
		typeof raw.state !== 'string' || !STATES.includes(raw.state as SessionState) ||
		[profileId, icon, folder, startedAt, endedAt, exitCode, title, lastLine].includes(null)
	) {
		return undefined;
	}

	return {
		id: raw.id,
		profileId: profileId ?? undefined,
		label: raw.label,
		icon: icon ?? undefined,
		command: raw.command,
		folder: folder ?? undefined,
		adopted: raw.adopted,
		state: raw.state as SessionState,
		createdAt: raw.createdAt,
		startedAt: startedAt ?? undefined,
		stateSince: raw.stateSince,
		endedAt: endedAt ?? undefined,
		exitCode: exitCode ?? undefined,
		title: title ?? undefined,
		lastLine: lastLine ?? undefined,
		attention: raw.attention,
		terminalGone: raw.terminalGone,
		runs: raw.runs,
	};
}
