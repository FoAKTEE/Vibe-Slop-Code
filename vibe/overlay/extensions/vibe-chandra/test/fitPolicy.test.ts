// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { foldLedgers } from '../src/model/fold.ts';
import { visibleSubgraph } from '../src/model/derived.ts';
import { layoutGraph } from '../src/view/layout.ts';
import {
	FAR_LABEL_SIZE, FAR_SCALE, LEGIBLE_SCALE, LEGIBLE_TEXT_PX, SUB_TEXT_SIZE, TINY_SCALE, WHOLE_SCALE, countOverflow, pickAnchors, placeView,
	type AnchorCandidate, type FitInput, type Placement,
} from '../src/view/fitPolicy.ts';
import { fixtureInput } from './helpers.ts';

type Box = FitInput['bounds'];

const INSETS = { top: 50, right: 18, bottom: 48, left: 18 };
const PANEL = { width: 1100, height: 1100 };
const WIDE: Box = { x: 0, y: 0, w: 2400, h: 600 };
const node = (x: number, y: number): Box => ({ x, y, w: 188, h: 44 });

function place(patch: Partial<FitInput>): Placement {
	return placeView({ bounds: WIDE, viewport: PANEL, insets: INSETS, anchors: [], wholeFloor: WHOLE_SCALE, floor: LEGIBLE_SCALE, maxScale: 1.1, ...patch });
}

const near = (actual: number, expected: number, message: string): void => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} vs ${expected}`);

/** Where a box of the graph lands on screen. */
function onScreen(box: Box, at: Placement): { left: number; top: number; right: number; bottom: number } {
	return { left: box.x * at.scale + at.tx, top: box.y * at.scale + at.ty, right: (box.x + box.w) * at.scale + at.tx, bottom: (box.y + box.h) * at.scale + at.ty };
}

test('fit policy: both scales are derived from the label metrics, not guessed', () => {
	assert.equal(LEGIBLE_SCALE, LEGIBLE_TEXT_PX / FAR_LABEL_SIZE);
	assert.ok(LEGIBLE_SCALE * FAR_LABEL_SIZE >= 11, 'a label at the floor is at least 11 px on screen');
	assert.equal(WHOLE_SCALE, SUB_TEXT_SIZE * FAR_SCALE / FAR_LABEL_SIZE);
	near(WHOLE_SCALE * FAR_LABEL_SIZE, 8.4, 'a graph shown whole keeps its labels as tall as the status row at the level-of-detail switch');
	assert.ok(TINY_SCALE < WHOLE_SCALE && WHOLE_SCALE < LEGIBLE_SCALE && LEGIBLE_SCALE < FAR_SCALE, 'never tiles, and the far label is the one on screen');
	// The style sheet draws the texts at the sizes the scales are derived from.
	const css = readFileSync(join(import.meta.dirname, '..', 'media', 'graph.css'), 'utf8');
	const fontSize = (rule: string): number => Number(new RegExp(`${rule.replace(/[.]/g, '\\.')} \\{[^}]*font-size: ([\\d.]+)px`).exec(css)?.[1]);
	assert.deepEqual([fontSize('.vc-root.vc-far .vc-label-far'), fontSize('.vc-badges'), fontSize('.vc-result-side')], [FAR_LABEL_SIZE, SUB_TEXT_SIZE, LEGIBLE_TEXT_PX]);
});

test('fit policy: a graph that reads as a whole is fitted whole and centred', () => {
	const small: Box = { x: 0, y: 0, w: 1400, h: 300 };
	const at = place({ bounds: small, anchors: [node(1100, 100)] });
	const scale = (1100 - 36) / 1400;
	assert.deepEqual([at.scale, at.whole], [scale, true]);
	near(at.tx, 18, 'spans the free width');
	near(at.ty, 50 + (1002 - 300 * scale) / 2, 'centred in the free height');
	// Between the two scales the whole still wins: all of a small graph beats its last pixels of label size.
	const smallish = place({ bounds: { x: 0, y: 0, w: 1800, h: 400 }, anchors: [node(1500, 100)] });
	assert.deepEqual([smallish.scale, smallish.whole], [1064 / 1800, true]);
	assert.ok(smallish.scale < LEGIBLE_SCALE && smallish.scale >= WHOLE_SCALE);
	assert.equal(place({ bounds: { x: 0, y: 0, w: 1900, h: 400 }, anchors: [node(1500, 100)] }).scale, LEGIBLE_SCALE, 'a little wider and it opens at the floor');
	// Never magnified beyond maxScale; the spare room is shared evenly on both axes.
	const tiny = place({ bounds: { x: 40, y: 20, w: 400, h: 100 } });
	assert.equal(tiny.scale, 1.1);
	const box = onScreen({ x: 40, y: 20, w: 400, h: 100 }, tiny);
	near(box.left - 18, 1100 - 18 - box.right, 'centred across');
	near(box.top - 50, 1100 - 48 - box.bottom, 'centred along');
});

test('fit policy: a graph too wide to read opens at the floor, on the frontier', () => {
	const ready = node(1500, 300);
	const at = place({ anchors: [ready] });
	assert.equal(at.scale, LEGIBLE_SCALE);
	assert.equal(at.whole, false);
	const box = onScreen(ready, at);
	near((box.left + box.right) / 2, 18 + 1064 / 2, 'the ready node sits in the middle of the free width');
	// The graph is shorter than the panel: that axis is centred as before.
	const graph = onScreen(WIDE, at);
	near(graph.top - 50, 1100 - 48 - graph.bottom, 'centred on the axis that fits');
	assert.ok(graph.left < 0 && graph.right > 1100, 'and it runs off both sides');
});

test('fit policy: no empty margin beyond the graph, on either axis', () => {
	const first = onScreen(WIDE, place({ anchors: [node(28, 300)] }));
	near(first.left, 18, 'anchored on the first layer: the graph starts at the left inset');
	const last = onScreen(WIDE, place({ anchors: [node(2184, 300)] }));
	near(last.right, 1100 - 18, 'anchored on the last layer: the graph ends at the right inset');

	const tall: Box = { x: 0, y: 0, w: 600, h: 4000 };
	const top = onScreen(tall, place({ bounds: tall, anchors: [node(200, 28)] }));
	near(top.top, 50, 'top-down: the graph starts under the toolbar');
	const bottom = onScreen(tall, place({ bounds: tall, anchors: [node(200, 3928)] }));
	near(bottom.bottom, 1100 - 48, 'top-down: the graph ends above the legend');

	const huge: Box = { x: 0, y: 0, w: 9000, h: 7000 };
	const corner = onScreen(huge, place({ bounds: huge, anchors: [node(8784, 6928)] }));
	near(corner.right, 1100 - 18, 'both axes clamp at once');
	near(corner.bottom, 1100 - 48, 'both axes clamp at once');
});

test('fit policy: several anchors are shown together while they fit, the first ones win', () => {
	const a = node(1000, 100), b = node(1600, 400);
	const both = place({ anchors: [a, b] });
	const union = onScreen({ x: 1000, y: 100, w: 788, h: 344 }, both);
	near((union.left + union.right) / 2, 18 + 1064 / 2, 'centred on the union');
	for (const box of [onScreen(a, both), onScreen(b, both)]) {
		assert.ok(box.left >= 18 && box.right <= 1100 - 18 && box.top >= 50 && box.bottom <= 1100 - 48, 'both anchors inside the free area');
	}
	// A third anchor a whole graph away cannot join; it does not drag the view off the first two.
	assert.deepEqual(place({ anchors: [a, b, node(28, 300)] }), both);
	assert.notDeepEqual(place({ anchors: [node(28, 300), a, b] }), both);
	// Without any anchor the middle of the graph is as good a place as any.
	const middle = onScreen(WIDE, place({}));
	near(middle.left - 18, 1100 - 18 - middle.right, 'centred without anchors');
});

test('fit policy: anchors are the ready nodes, else the unfinished ones, else the newest layer', () => {
	const candidate = (x: number, y: number, layer: number, ready: boolean, open: boolean): AnchorCandidate => ({ box: node(x, y), layer, ready, open });
	const solidRoot = candidate(28, 100, 0, false, false);
	const readyLow = candidate(300, 200, 1, true, true), readyHigh = candidate(300, 100, 1, true, true);
	const blocked = candidate(600, 100, 2, false, true);
	const lastA = candidate(900, 300, 3, false, false), lastB = candidate(900, 100, 3, false, false);

	assert.deepEqual(pickAnchors([blocked, readyLow, solidRoot, readyHigh]), [readyHigh.box, readyLow.box], 'ready nodes, in layout order');
	assert.deepEqual(pickAnchors([{ ...readyLow, ready: false }, blocked, solidRoot]), [readyLow.box, blocked.box], 'no frontier: whatever is not solid yet');
	assert.deepEqual(pickAnchors([lastA, solidRoot, lastB].map(c => ({ ...c, open: false }))), [lastB.box, lastA.box], 'all solid: the right-most layer');
	assert.deepEqual(pickAnchors([]), []);
});

test('fit policy: the chrome is reserved, whatever its height', () => {
	for (const insets of [INSETS, { top: 50, right: 18, bottom: 96, left: 18 }, { top: 82, right: 358, bottom: 560, left: 18 }]) {
		const small: Box = { x: 0, y: 0, w: 900, h: 700 };
		const whole = place({ bounds: small, insets, wholeFloor: 0 });
		const box = onScreen(small, whole);
		assert.ok(whole.whole, 'fitted whole');
		assert.ok(box.top >= insets.top - 1e-6 && box.bottom <= 1100 - insets.bottom + 1e-6, 'nothing under the toolbar or the legend');
		assert.ok(box.left >= insets.left - 1e-6 && box.right <= 1100 - insets.right + 1e-6, 'nothing under the detail panel');

		const tall: Box = { x: 0, y: 0, w: 600, h: 4000 };
		near(onScreen(tall, place({ bounds: tall, insets, anchors: [node(200, 3928)] })).bottom, 1100 - insets.bottom, 'the last row clears the legend at the floor too');
	}
	// A two-row legend costs scale where the height binds.
	const high: Box = { x: 0, y: 0, w: 500, h: 1200 };
	assert.ok(place({ bounds: high, insets: { ...INSETS, bottom: 96 } }).scale < place({ bounds: high }).scale);
});

test('fit policy: without a floor everything is fitted (the Fit control, the narrow view)', () => {
	const at = place({ wholeFloor: 0, anchors: [node(1500, 300)] });
	assert.equal(at.scale, 1064 / 2400);
	assert.equal(at.whole, true);
	const graph = onScreen(WIDE, at);
	near(graph.left, 18, 'spans the free width');
	near(graph.right, 1100 - 18, 'spans the free width');
});

test('fit policy: deterministic and free of side effects', () => {
	const input: FitInput = { bounds: WIDE, viewport: PANEL, insets: INSETS, anchors: [node(1500, 300), node(1700, 100)], wholeFloor: WHOLE_SCALE, floor: LEGIBLE_SCALE, maxScale: 1.1 };
	const frozen = structuredClone(input);
	const first = placeView(input);
	assert.deepEqual(placeView(input), first);
	assert.deepEqual(placeView(structuredClone(input)), first);
	assert.deepEqual(input, frozen);
	for (const value of [first.scale, first.tx, first.ty]) {
		assert.ok(Number.isFinite(value));
	}
	// A surface without a size yet (a hidden webview) still yields finite numbers.
	const hidden = placeView({ ...input, viewport: { width: 0, height: 0 } });
	assert.ok([hidden.scale, hidden.tx, hidden.ty].every(Number.isFinite));
});

test('fit policy: overflow counts the nodes cut off on each side', () => {
	const boxes = [node(0, 300), node(300, 300), node(1200, 300), node(2000, 300), node(2200, 300), node(1200, -400), node(1200, 1800), node(1300, 2200)];
	// Scale 1, the view shows graph x 1000..2100 and y 0..1100.
	const at = { scale: 1, tx: -1000, ty: 0 };
	assert.deepEqual(countOverflow(boxes, at, PANEL, { top: 0, right: 0, bottom: 0, left: 0 }), { left: 2, right: 1, top: 1, bottom: 2 });
	// An open detail panel hides what lies under it.
	assert.deepEqual(countOverflow(boxes, at, PANEL, { top: 0, right: 340, bottom: 0, left: 0 }), { left: 2, right: 2, top: 1, bottom: 2 });
	assert.deepEqual(countOverflow(boxes, place({ bounds: { x: 0, y: -400, w: 2400, h: 2700 }, wholeFloor: 0 }), PANEL, INSETS),
		{ left: 0, right: 0, top: 0, bottom: 0 }, 'nothing is cut off when everything is fitted');
});

test('fit policy: the two-paper graph opens readable on its frontier in an editor panel', () => {
	const graph = foldLedgers([fixtureInput('self'), fixtureInput('vibe')]);
	const layout = layoutGraph(visibleSubgraph(graph, { showInactive: false }), { direction: 'lr' });
	const byId = new Map(graph.nodes.map(n => [n.id, n]));
	const frontier = new Set(graph.frontier);
	const anchors = pickAnchors(layout.nodes.map(box => ({ box, layer: box.layer, ready: frontier.has(box.id), open: byId.get(box.id)!.status !== 'solid' })));
	assert.ok(anchors.length > 0 && anchors.length === layout.nodes.filter(n => frontier.has(n.id)).length, 'the fixture has a frontier');

	const viewport = { width: 790, height: 775 };
	const bounds = { x: 0, y: 0, w: layout.width, h: layout.height };
	assert.ok(place({ bounds, viewport, anchors, wholeFloor: 0 }).scale * FAR_LABEL_SIZE < 7, 'fitted whole, its labels are unreadable');
	const at = place({ bounds, viewport, anchors });
	assert.ok(at.scale * FAR_LABEL_SIZE >= LEGIBLE_TEXT_PX);
	const first = onScreen(anchors[0], at);
	assert.ok(first.left >= 18 && first.right <= 790 - 18 && first.top >= 50 && first.bottom <= 775 - 48, 'the first ready node is inside the free area');
	const overflow = countOverflow(layout.nodes, at, viewport, { top: 0, right: 0, bottom: 0, left: 0 });
	assert.ok(overflow.left + overflow.right > 0, 'and the view says that there is more');
});
