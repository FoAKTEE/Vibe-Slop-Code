// SPDX-License-Identifier: MIT

// The icons of the view: stroke paths on a 16x16 grid, drawn with the text colour they sit in. A webview has
// no access to the icon font of the workbench, and the view shows state by shape as well as by colour.
import type { StatusRow, StatusRowAction } from '../model/profiles.ts';
import type { SessionState } from '../model/session.ts';
import type { SessionAction } from '../protocol.ts';
import type { GlyphName } from './cardModel.ts';
import { svg } from './dom.ts';

const PROFILE: Record<GlyphName, string[]> = {
	sparkle: ['M8 1.8l1.7 4.5L14.2 8l-4.5 1.7L8 14.2l-1.7-4.5L1.8 8l4.5-1.7z'],
	code: ['M5.8 4.2L2 8l3.8 3.8M10.2 4.2L14 8l-3.8 3.8'],
	robot: ['M3.5 6.5h9v6.5h-9z', 'M8 6.5V4.2', 'M8 4.2a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8z', 'M6.2 9.3v1.2M9.8 9.3v1.2', 'M1.8 9v2.2M14.2 9v2.2'],
	terminal: ['M2 3.5h12v9H2z', 'M4.5 6.5l2 1.75-2 1.75M8.2 10.2h3'],
	beaker: ['M6 2.5h4M6.8 2.5v4L3.2 13a.6.6 0 0 0 .5.9h8.6a.6.6 0 0 0 .5-.9L9.2 6.5v-4', 'M5 10.2h6'],
	eye: ['M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8z', 'M8 9.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z'],
	globe: ['M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z', 'M2 8h12', 'M8 2c-2 1.8-2.6 4-2.6 6s.6 4.2 2.6 6c2-1.8 2.6-4 2.6-6S10 3.8 8 2z'],
	rocket: ['M9.5 10.5l-4-4C6.5 3.5 9.5 2 13.8 2.2 14 6.5 12.5 9.5 9.5 10.5z', 'M5.5 6.5L3 7l-1 2 2.5.3M9.5 10.5L9 13l-2 1-.3-2.5', 'M10.8 6.3a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'],
};

const ACTION: Record<SessionAction | 'kill', string[]> = {
	focus: PROFILE.terminal,
	stop: ['M4.5 4.5h7v7h-7z'],
	kill: ['M3 4.5h10M6.2 4.5V3h3.6v1.5M4.2 4.5l.6 8.5h6.4l.6-8.5M6.8 6.8v4M9.2 6.8v4'],
	restart: ['M12.6 8a4.6 4.6 0 1 1-1.5-3.4', 'M11.5 1.8v3h-3'],
	dismiss: ['M4 4l8 8M12 4l-8 8'],
};

const TOOLBAR = {
	add: ['M8 3v10M3 8h10'],
	chevron: ['M4.5 6.2L8 9.8l3.5-3.6'],
	adopt: ['M6.3 9.7l3.4-3.4', 'M7.2 4.8l1-1a2.8 2.8 0 0 1 4 4l-1 1', 'M8.8 11.2l-1 1a2.8 2.8 0 0 1-4-4l1-1'],
	clear: ['M2.5 4.5h8M2.5 8h5.5M2.5 11.5h3.5', 'M10 9.5l3.5 3.5M13.5 9.5L10 13'],
} as const;

/** The shape of a state: ring, arc, bell, check, cross, struck ring. */
const STATE: Record<SessionState, string[]> = {
	starting: ['M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z'],
	working: ['M8 2.5a5.5 5.5 0 1 1-5.5 5.5'],
	waiting: ['M8 2a3.8 3.8 0 0 0-3.8 3.8c0 3.2-1.4 4.5-1.4 4.5h10.4s-1.4-1.3-1.4-4.5A3.8 3.8 0 0 0 8 2z', 'M6.5 12.5a1.6 1.6 0 0 0 3 0'],
	finished: ['M3 8.5l3.2 3.2L13 4.8'],
	failed: ['M4 4l8 8M12 4l-8 8'],
	closed: ['M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z', 'M4.2 11.8l7.6-7.6'],
};

/** The shape of a status row: check, warning triangle, ring. */
const ROW_STATE: Record<StatusRow['state'], string[]> = {
	ok: ['M3 8.5l3.2 3.2L13 4.8'],
	warning: ['M8 2.2L14.4 13.4H1.6z', 'M8 6.4v3.4', 'M8 11.5v.2'],
	off: ['M8 12.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z'],
};

const ROW_ACTION: Record<NonNullable<StatusRowAction['icon']>, string[]> = {
	refresh: ['M12.6 8a4.6 4.6 0 1 1-1.5-3.4', 'M11.5 1.8v3h-3'],
};

function icon(paths: readonly string[], className: string): SVGSVGElement {
	return svg('svg', { viewBox: '0 0 16 16', class: `va-icon ${className}`, 'aria-hidden': 'true', focusable: 'false' }, ...paths.map(d => svg('path', { d })));
}

export function profileGlyph(name: GlyphName): SVGSVGElement {
	return icon(PROFILE[name], 'va-icon-profile');
}

export function actionGlyph(action: SessionAction | 'kill'): SVGSVGElement {
	return icon(ACTION[action], 'va-icon-action');
}

export function toolbarGlyph(name: keyof typeof TOOLBAR): SVGSVGElement {
	return icon(TOOLBAR[name], 'va-icon-action');
}

export function stateGlyph(state: SessionState): SVGSVGElement {
	return icon(STATE[state], `va-icon-state va-icon-${state}`);
}

export function rowStateGlyph(state: StatusRow['state']): SVGSVGElement {
	return icon(ROW_STATE[state], `va-icon-row va-icon-row-${state}`);
}

export function rowActionGlyph(name: NonNullable<StatusRowAction['icon']>): SVGSVGElement {
	return icon(ROW_ACTION[name], 'va-icon-action');
}
