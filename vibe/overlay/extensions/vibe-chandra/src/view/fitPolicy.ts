// SPDX-License-Identifier: MIT

// Pure geometry: no DOM in here, the tests run it as it is.

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Insets {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

export interface Size {
	width: number;
	height: number;
}

/** Screen position of graph point (x, y): `(x * scale + tx, y * scale + ty)`. */
export interface ViewTransform {
	scale: number;
	tx: number;
	ty: number;
}

export interface Placement extends ViewTransform {
	/** True when all of `bounds` is on screen; false when the view opened at `floor` on its anchors. */
	whole: boolean;
}

export interface FitInput {
	/** What is being framed, in graph coordinates: the whole graph, a focused reach, a route corridor. */
	bounds: Box;
	/** The drawing surface, in CSS pixels. */
	viewport: Size;
	/** Room kept free for the chrome: toolbar, legend, detail panel. */
	insets: Insets;
	/** Where to land when `bounds` is not shown whole, most important first. */
	anchors: readonly Box[];
	/** `bounds` is shown whole while that keeps the scale at or above this; 0 shows it whole at any scale. */
	wholeFloor: number;
	/** The scale the view opens at otherwise, on its anchors. */
	floor: number;
	/** Never magnify beyond this. */
	maxScale: number;
}

export interface AnchorCandidate {
	box: Box;
	layer: number;
	/** On the frontier: not solid yet, every predecessor solid. */
	ready: boolean;
	/** Work remains: an active node that is not solid. */
	open: boolean;
}

export interface Overflow {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/** Level of detail, by scale: below `FAR_SCALE` one larger label replaces the two text rows, below `TINY_SCALE` cards are status tiles. */
export const FAR_SCALE = 0.8;
export const TINY_SCALE = 0.3;
/** Font sizes in graph units, as graph.css draws them: the larger far label (`.vc-label-far`) and the status row (`.vc-sub`). */
export const FAR_LABEL_SIZE = 14.5;
export const SUB_TEXT_SIZE = 10.5;
/** The smallest text the view's own chrome uses (search result details, the detail panel's ids and dates), in CSS pixels. */
export const LEGIBLE_TEXT_PX = 11;
/**
 * The legibility floor, where a view opens that cannot show everything: the scale at which a node label is
 * `LEGIBLE_TEXT_PX` tall on screen. It lies below `FAR_SCALE`, so that label is the far one: 11 / 14.5 = 0.7586.
 */
export const LEGIBLE_SCALE = LEGIBLE_TEXT_PX / FAR_LABEL_SIZE;
/**
 * A graph is still shown whole while its labels stay as tall as the smallest text the level of detail puts on
 * screen anyway, the status row just before it gives way at `FAR_SCALE`: 10.5 * 0.8 = 8.4 px, a scale of 0.5793.
 * Seeing all of a small graph is worth more than its last pixels of label size; below this nothing reads.
 */
export const WHOLE_SCALE = SUB_TEXT_SIZE * FAR_SCALE / FAR_LABEL_SIZE;

export const MIN_SCALE = 0.04;
/** Screen pixels kept between an anchor and the edge of the free area when deciding what fits. */
const ANCHOR_MARGIN = 24;

function union(a: Box, b: Box): Box {
	const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
	return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * One axis at scale `k`: a graph that fits is centred in the free room; a larger one is centred on `target`
 * and then clamped, so that no empty margin shows beyond either end of the graph.
 */
function along(start: number, extent: number, target: number, k: number, inset: number, room: number): number {
	if (extent * k <= room) {
		return inset + (room - extent * k) / 2 - start * k;
	}
	const centred = inset + room / 2 - target * k;
	return Math.min(inset - start * k, Math.max(inset + room - (start + extent) * k, centred));
}

/**
 * Where a view opens. `bounds` is fitted whole and centred when that keeps the labels readable (the scale
 * stays at or above `wholeFloor`). Otherwise the view opens at `floor` on its anchors: as many of them as fit
 * together, the first ones first. Pure: no DOM, no clocks; the same input gives the same placement.
 */
export function placeView(input: FitInput): Placement {
	const { bounds, insets, anchors } = input;
	const roomW = Math.max(40, input.viewport.width - insets.left - insets.right);
	const roomH = Math.max(40, input.viewport.height - insets.top - insets.bottom);
	const fitted = Math.max(MIN_SCALE, Math.min(input.maxScale, roomW / Math.max(1, bounds.w), roomH / Math.max(1, bounds.h)));
	const open = Math.min(input.maxScale, input.floor);
	// Whole while that reads, and also when opening at the floor would not be any larger.
	const whole = fitted >= Math.min(input.wholeFloor, open);
	const k = whole ? fitted : open;
	let target = anchors.length ? anchors[0] : bounds;
	for (const anchor of anchors) {
		const both = union(target, anchor);
		if (both.w * k + 2 * ANCHOR_MARGIN <= roomW && both.h * k + 2 * ANCHOR_MARGIN <= roomH) {
			target = both;
		}
	}
	return {
		scale: k,
		tx: along(bounds.x, bounds.w, target.x + target.w / 2, k, insets.left, roomW),
		ty: along(bounds.y, bounds.h, target.y + target.h / 2, k, insets.top, roomH),
		whole,
	};
}

/**
 * What a graph too large to read should open on: the ready nodes, else the nodes that are not solid yet,
 * else the last layer (the newest work). In layout order, so that the choice does not depend on the input's.
 */
export function pickAnchors(candidates: readonly AnchorCandidate[]): Box[] {
	const newest = candidates.reduce((layer, c) => Math.max(layer, c.layer), 0);
	const groups = [candidates.filter(c => c.ready), candidates.filter(c => c.open), candidates.filter(c => c.layer === newest)];
	const chosen = groups.find(group => group.length > 0) ?? [];
	return chosen.sort((a, b) => a.layer - b.layer || a.box.y - b.box.y || a.box.x - b.box.x).map(c => c.box);
}

/** How many boxes are cut off on each side: those whose centre lies beyond that edge of the surface minus `insets`. */
export function countOverflow(boxes: Iterable<Box>, view: ViewTransform, viewport: Size, insets: Insets): Overflow {
	const overflow: Overflow = { left: 0, right: 0, top: 0, bottom: 0 };
	for (const box of boxes) {
		const cx = (box.x + box.w / 2) * view.scale + view.tx, cy = (box.y + box.h / 2) * view.scale + view.ty;
		overflow.left += cx < insets.left ? 1 : 0;
		overflow.right += cx > viewport.width - insets.right ? 1 : 0;
		overflow.top += cy < insets.top ? 1 : 0;
		overflow.bottom += cy > viewport.height - insets.bottom ? 1 : 0;
	}
	return overflow;
}
