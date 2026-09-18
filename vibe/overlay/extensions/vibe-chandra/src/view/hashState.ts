// SPDX-License-Identifier: MIT

export type Reach = 'both' | 'upstream' | 'downstream';

/** Everything about the view that is worth sharing or restoring; mirrored into `location.hash`. */
export interface ViewState {
	focus?: string;
	reach: Reach;
	/** Route probe between two nodes, in the order they were picked. */
	route?: [string, string];
	/** Status lens: when non-empty, only these statuses stay lit. */
	lens: string[];
	direction: 'lr' | 'td';
	showInactive: boolean;
}

export const DEFAULT_STATE: ViewState = Object.freeze({ reach: 'both', lens: [], direction: 'lr', showInactive: false }) as ViewState;

// `:` is legal in a fragment and ids are `paper::slug`, so keep it readable; `~` separates list items.
function encode(value: string): string {
	return encodeURIComponent(value).replace(/%3A/gi, ':').replace(/~/g, '%7E');
}

function decode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * `#focus=<id>&reach=upstream`, `#focus=<a>&route=<a>~<b>`, `#lens=solid~blocking`, `#dir=td`, `#inactive=1`.
 * `defaultDirection` is the direction the host configured: only a departure from it is written down.
 */
export function formatHash(state: ViewState, defaultDirection: ViewState['direction'] = 'lr'): string {
	const parts: string[] = [];
	if (state.focus !== undefined) {
		parts.push(`focus=${encode(state.focus)}`);
		if (state.reach !== 'both') {
			parts.push(`reach=${state.reach}`);
		}
	}
	if (state.route) {
		parts.push(`route=${state.route.map(encode).join('~')}`);
	}
	if (state.lens.length) {
		parts.push(`lens=${state.lens.map(encode).join('~')}`);
	}
	if (state.direction !== defaultDirection) {
		parts.push(`dir=${state.direction}`);
	}
	if (state.showInactive) {
		parts.push('inactive=1');
	}
	return parts.length ? `#${parts.join('&')}` : '';
}

export function parseHash(hash: string, defaultDirection: ViewState['direction'] = 'lr'): ViewState {
	const state: ViewState = { ...DEFAULT_STATE, lens: [], direction: defaultDirection };
	const text = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
	let reach: Reach = 'both';
	for (const part of text.split('&')) {
		const at = part.indexOf('=');
		if (at <= 0) {
			continue;
		}
		const key = part.slice(0, at);
		const raw = part.slice(at + 1);
		if (raw === '') {
			continue;
		}
		if (key === 'focus') {
			state.focus = decode(raw);
		} else if (key === 'reach' && (raw === 'upstream' || raw === 'downstream')) {
			reach = raw;
		} else if (key === 'route') {
			const ends = raw.split('~').map(decode);
			if (ends.length === 2 && ends[0] !== '' && ends[1] !== '') {
				state.route = [ends[0], ends[1]];
			}
		} else if (key === 'lens') {
			state.lens = raw.split('~').map(decode).filter(x => x !== '');
		} else if (key === 'dir' && (raw === 'td' || raw === 'lr')) {
			state.direction = raw;
		} else if (key === 'inactive' && raw === '1') {
			state.showInactive = true;
		}
	}
	if (state.focus !== undefined) {
		state.reach = reach;
	}
	return state;
}
