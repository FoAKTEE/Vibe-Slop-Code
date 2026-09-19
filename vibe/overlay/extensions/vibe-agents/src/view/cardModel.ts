// SPDX-License-Identifier: MIT

// What a card says, as text: everything the view shows about a session that is not layout. No DOM in here.
import { elapsed, formatDuration, isLive, type Session, type SessionState } from '../model/session.ts';
import type { SessionAction, SessionItem } from '../protocol.ts';

export interface CardModel {
	id: string;
	state: SessionState;
	attention: boolean;
	glyph: GlyphName;
	label: string;
	/** The text of the state pill. */
	pill: string;
	/** Second line: the folder and what the agent is about. */
	detail: string;
	detailTooltip: string;
	/** The time that ticks. */
	time: string;
	timeTooltip: string;
	lastLine: string | undefined;
	ariaLabel: string;
	actions: SessionAction[];
	stopArmed: boolean;
}

const SEPARATOR = ' \u00b7 ';

const PILL: Record<SessionState, string> = {
	starting: 'Starting',
	working: 'Working',
	waiting: 'Waiting',
	finished: 'Finished',
	failed: 'Failed',
	closed: 'Closed',
};

/** The glyphs the view can draw for a profile. Product icons it does not know fall back to the robot. */
const GLYPHS = ['sparkle', 'code', 'robot', 'terminal', 'beaker', 'eye', 'globe', 'rocket'] as const;
export type GlyphName = typeof GLYPHS[number];

export function glyphNameOf(icon: string | undefined): GlyphName {
	return (GLYPHS as readonly string[]).includes(icon ?? '') ? icon as GlyphName : 'robot';
}

export function actionsOf(session: Session): SessionAction[] {
	const actions: SessionAction[] = [];
	if (!session.terminalGone) {
		actions.push('focus');
	}
	if (isLive(session)) {
		actions.push('stop');
	}
	actions.push('restart', 'dismiss');
	return actions;
}

function ago(ms: number): string {
	return ms < 5000 ? 'now' : `${formatDuration(ms).split(' ')[0]} ago`;
}

/** The text that changes every second: time in the state while the agent runs, since when it is over afterwards. */
export function timeTextOf(session: Session, now: number): string {
	const { inState } = elapsed(session, now);
	return isLive(session) ? formatDuration(inState) : ago(inState);
}

function timeTooltipOf(session: Session, now: number): string {
	const { inState, total } = elapsed(session, now);
	const since = inState < 5000 ? 'just now' : `${formatDuration(inState).split(' ')[0]} ago`;
	switch (session.state) {
		case 'starting': return `Starting for ${formatDuration(inState)}`;
		case 'working': return `Working for ${formatDuration(inState)}`;
		case 'waiting': return `Waiting for you for ${formatDuration(inState)}`;
		case 'finished': return `Finished ${since}, ran ${formatDuration(total)}`;
		case 'failed': return `Failed ${since}${session.exitCode === undefined ? '' : ` with exit code ${session.exitCode}`}, ran ${formatDuration(total)}`;
		case 'closed': return `Closed ${since}`;
	}
}

/**
 * A command line for a narrow card: words that are absolute paths are shown by their name. What a
 * program is called tells more than where it is installed, and the tooltip has the whole line.
 */
export function compactCommand(command: string): string {
	return command.split(' ').map(word => /^\/[^\s'"=]*[^\s'"=/]$/.test(word) ? word.slice(word.lastIndexOf('/') + 1) : word).join(' ');
}

export function cardModelOf(item: SessionItem, now: number): CardModel {
	const session = item.session;
	// What the agent calls its terminal tells what it is about, unless it only repeats the name of the agent
	const title = session.title !== undefined && session.title.trim().toLowerCase() !== session.label.trim().toLowerCase() ? session.title : undefined;
	const detail = [session.folder, title ?? compactCommand(session.command)].filter(Boolean).join(SEPARATOR);
	const tooltip = timeTooltipOf(session, now);
	return {
		id: session.id,
		state: session.state,
		attention: session.attention,
		glyph: glyphNameOf(session.icon),
		label: session.label,
		pill: session.state === 'failed' && session.exitCode !== undefined ? `${PILL.failed} (${session.exitCode})` : PILL[session.state],
		detail,
		detailTooltip: [session.folder, title ?? session.command].filter(Boolean).join(SEPARATOR),
		time: timeTextOf(session, now),
		timeTooltip: tooltip,
		lastLine: session.lastLine,
		ariaLabel: `${[session.label, session.folder].filter(Boolean).join(', ')}, ${tooltip[0].toLowerCase()}${tooltip.slice(1)}${session.lastLine ? `. ${session.lastLine}` : ''}`,
		actions: actionsOf(session),
		stopArmed: item.stopArmed,
	};
}
