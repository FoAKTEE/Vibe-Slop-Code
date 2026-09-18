// SPDX-License-Identifier: MIT

import { svg } from './dom.ts';

/**
 * Status glyphs, drawn as shapes around (0,0) within a 12px box so that status never rests on colour alone:
 * solid = filled disc, preliminary = half disc, hypothesis = ring, blocking = cross, future = square,
 * retired = struck ring, amended = tilde, ghost/unknown = dashed ring.
 */
export function glyphParts(status: string, ghost: boolean): SVGElement[] {
	if (ghost) {
		return [svg('circle', { r: 4.2, class: 'vc-gs', 'stroke-dasharray': '2.2 2.2' })];
	}
	switch (status) {
		case 'solid':
			return [svg('circle', { r: 4.8, class: 'vc-gf' })];
		case 'preliminary':
			return [svg('circle', { r: 4.2, class: 'vc-gs' }), svg('path', { d: 'M0 -4.2A4.2 4.2 0 0 0 0 4.2Z', class: 'vc-gf' })];
		case 'hypothesis':
			return [svg('circle', { r: 4.2, class: 'vc-gs' })];
		case 'blocking':
			return [svg('path', { d: 'M-3.8 -3.8L3.8 3.8M3.8 -3.8L-3.8 3.8', class: 'vc-gs', 'stroke-width': 2.2 })];
		case 'future':
			return [svg('rect', { x: -3.9, y: -3.9, width: 7.8, height: 7.8, rx: 1, class: 'vc-gs', 'stroke-dasharray': '1.6 2.3' })];
		case 'retired':
			return [svg('circle', { r: 4.2, class: 'vc-gs' }), svg('path', { d: 'M-3 3L3 -3', class: 'vc-gs' })];
		case 'amended':
			return [svg('path', { d: 'M-4.5 1C-3 -2.5 -1.2 -2.5 0 0S3 2.5 4.5 -1', class: 'vc-gs' })];
		default:
			return [svg('circle', { r: 4.2, class: 'vc-gs', 'stroke-dasharray': '2.2 2.2' })];
	}
}

/** A glyph as a standalone inline icon for HTML contexts (legend, chips, search results). */
export function glyphIcon(status: string, ghost = false): SVGSVGElement {
	return svg('svg', { viewBox: '-6 -6 12 12', class: `vc-icon vc-s-${ghost ? 'ghost' : status}`, 'aria-hidden': 'true' }, ...glyphParts(status, ghost));
}

/** The frontier marker: the same ring that surrounds ready nodes on the canvas. */
export function ringIcon(className: string): SVGSVGElement {
	return svg('svg', { viewBox: '-6 -6 12 12', class: 'vc-icon', 'aria-hidden': 'true' },
		svg('rect', { x: -5, y: -3.5, width: 10, height: 7, rx: 2, class: className }));
}
