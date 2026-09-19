// SPDX-License-Identifier: MIT

// All sessions of a window at a glance: counts, the texts of the badge, the status bar and the tab of the
// workspace bar, and the order of the cards.
import type { Session } from './session.ts';

export interface Counts {
	total: number;
	/** Starting or working. */
	working: number;
	waiting: number;
	finished: number;
	failed: number;
	closed: number;
	/** Sessions with something the user did not look at yet. */
	attention: number;
	/** Sessions that are blocked on the user or ended unseen: waiting, looked at or not, and unseen results. */
	needsUser: number;
}

const SEPARATOR = ' \u00b7 ';

export function countSessions(sessions: readonly Session[]): Counts {
	const counts: Counts = { total: sessions.length, working: 0, waiting: 0, finished: 0, failed: 0, closed: 0, attention: 0, needsUser: 0 };
	for (const session of sessions) {
		counts[session.state === 'starting' ? 'working' : session.state]++;
		if (session.attention) {
			counts.attention++;
		}
		if (session.attention || session.state === 'waiting') {
			counts.needsUser++;
		}
	}
	return counts;
}

/** `2 working - 1 waiting`: what is there, what runs first. */
export function summaryTextOf(counts: Counts): string {
	const parts = (['working', 'waiting', 'failed', 'finished'] as const).filter(key => counts[key] > 0).map(key => `${counts[key]} ${key}`);
	if (parts.length === 0) {
		return counts.closed > 0 ? `${counts.closed} closed` : 'No agents';
	}
	return parts.join(SEPARATOR);
}

export function statusBarTextOf(counts: Counts): string | undefined {
	return counts.total === 0 ? undefined : `$(hubot) ${summaryTextOf(counts)}`;
}

/** The badge of the view: how many sessions need the user. */
export function badgeOf(counts: Counts): { value: number; tooltip: string } | undefined {
	if (counts.attention === 0) {
		return undefined;
	}
	const needs = counts.attention === 1 ? '1 agent needs you' : `${counts.attention} agents need you`;
	return { value: counts.attention, tooltip: `${needs}${SEPARATOR}${summaryTextOf(counts)}` };
}

/**
 * What the window tells the workspace bar, where the tabs of windows that are hidden show it. The badge of
 * the view counts news and clears when looked at. A tab answers another question from another window, where
 * is an agent blocked on me: an agent that waits counts there for as long as it waits.
 */
export interface WindowStatus {
	working: number;
	attention: number;
	label: string;
}

export function windowStatusOf(counts: Counts): WindowStatus | undefined {
	if (counts.working === 0 && counts.needsUser === 0) {
		return undefined;
	}
	return { working: counts.working, attention: counts.needsUser, label: summaryTextOf(counts) };
}

function rank(session: Session): number {
	if (session.attention) {
		return 0;
	}
	switch (session.state) {
		case 'waiting': return 1;
		case 'starting':
		case 'working': return 2;
		case 'finished':
		case 'failed': return 3;
		case 'closed': return 4;
	}
}

/** Cards from top to bottom: what needs the user, what waits, what works, what is done; the newest change first. */
export function orderSessions(sessions: readonly Session[]): Session[] {
	return [...sessions].sort((a, b) => rank(a) - rank(b) || b.stateSince - a.stateSince || b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** What a screen reader hears when a session changes its state. */
export function announcementOf(session: Session): string {
	const name = session.folder ? `${session.label} in ${session.folder}` : session.label;
	switch (session.state) {
		case 'starting': return `${name} is starting`;
		case 'working': return `${name} is working`;
		case 'waiting': return `${name} is waiting for you`;
		case 'finished': return `${name} finished`;
		case 'failed': return session.exitCode === undefined ? `${name} failed` : `${name} failed with exit code ${session.exitCode}`;
		case 'closed': return `${name} was closed`;
	}
}
