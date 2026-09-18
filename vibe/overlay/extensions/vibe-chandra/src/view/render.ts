// SPDX-License-Identifier: MIT

import type { GraphNode } from '../model/types.ts';
import { clear, svg } from './dom.ts';
import { glyphParts } from './glyphs.ts';
import type { Layout, PlacedNode } from './layout.ts';
import { estimateWidth, fit, wrapTwo } from './text.ts';

export interface Scene {
	layout: Layout;
	placed: Map<string, PlacedNode>;
	nodes: Map<string, SVGGElement>;
	/** Parallel to `layout.segments`: the stroke and, where the segment ends in an arrowhead, the head. */
	strokes: SVGPathElement[];
	heads: (SVGPathElement | undefined)[];
	junctions: Map<string, SVGCircleElement>;
}

const ARROW_LENGTH = 8.5;
const ARROW_HALF = 3.7;

function statusClass(node: GraphNode): string {
	return node.ghost ? 'vc-s-ghost vc-ghost' : `vc-s-${node.status}`;
}

/** `k3 · t4 x3`: knowledge records and trials attached under the node, failures called out. */
function badgeParts(node: GraphNode): { text: string; failing: boolean }[] {
	const parts: { text: string; failing: boolean }[] = [];
	if (node.revisionCount > 1) {
		parts.push({ text: `k${node.revisionCount}`, failing: false });
	}
	if (node.trialStats.total > 0) {
		parts.push({ text: `t${node.trialStats.total}`, failing: false });
	}
	if (node.trialStats.failed > 0) {
		// Bold red while the node is currently failing; a past failure that was fixed stays muted.
		parts.push({ text: `\u2715${node.trialStats.failed}`, failing: node.trialStats.failStreak > 0 });
	}
	if (node.openObligations > 0) {
		parts.push({ text: `!${node.openObligations}`, failing: true });
	}
	return parts;
}

/** The badges spelled out, for the tooltip. */
function attachments(node: GraphNode): string {
	const stats = node.trialStats;
	return [
		node.revisionCount > 1 ? `${node.revisionCount} knowledge records` : '',
		stats.total ? `${stats.total} trial${stats.total === 1 ? '' : 's'} (${stats.failed} failed${stats.failStreak ? ', still failing' : ''})` : '',
		node.openObligations ? `${node.openObligations} open obligation${node.openObligations === 1 ? '' : 's'}` : '',
	].filter(Boolean).join(' · ');
}

function drawNode(node: GraphNode, box: PlacedNode, ready: boolean, showPaper: boolean): SVGGElement {
	const { w, h } = box;
	const tip = [node.id, `${node.ghost ? 'ghost (no ledger row)' : node.status}${ready ? ' · ready' : ''}`, node.summary, attachments(node)].filter(Boolean).join('\n');
	const group = svg('g', {
		class: `vc-node ${statusClass(node)}${ready ? ' vc-frontier' : ''}`, transform: `translate(${box.x} ${box.y})`,
		tabindex: 0, role: 'button', 'aria-label': tip.replace(/\n/g, ', '), 'data-id': node.id,
	}, svg('title', {}, tip));
	group.append(svg('rect', { class: 'vc-halo', x: -3.5, y: -3.5, width: w + 7, height: h + 7, rx: 7 }));
	if (ready) {
		group.append(svg('rect', { class: 'vc-ring', x: -3.5, y: -3.5, width: w + 7, height: h + 7, rx: 7 }));
	}
	group.append(
		svg('rect', { class: 'vc-card', width: w, height: h, rx: 4 }),
		svg('rect', { class: 'vc-bar', x: 0.5, y: 0.5, width: 3.5, height: h - 1, rx: 1.75 }),
		svg('g', { class: 'vc-glyph', transform: 'translate(15 15)' }, ...glyphParts(node.status, node.ghost)),
		svg('text', { class: 'vc-label', x: 26, y: 19 }, fit(node.label, w - 34, 12)),
	);
	// Zoomed out, the two text rows give way to one larger label (wrapped if need be) so that the fitted graph stays readable.
	const lines = wrapTwo(node.label, w - 34, 14.5);
	lines.forEach((line, i) => group.append(svg('text', { class: 'vc-label vc-label-far', x: 26, y: lines.length === 1 ? 27 : 18.5 + i * 17 }, line)));
	if (node.trialStats.failStreak > 0) {
		group.append(svg('circle', { class: 'vc-alert', cx: w - 1, cy: 1, r: 5 }));
	}

	const badges = badgeParts(node);
	const badgeWidth = badges.reduce((sum, b) => sum + estimateWidth(b.text, 10.5) + 5, 0);
	if (badges.length) {
		const text = svg('text', { class: 'vc-badges', x: w - 8, y: 35, 'text-anchor': 'end' });
		badges.forEach((b, i) => text.append(svg('tspan', b.failing ? { class: 'vc-failing' } : {}, (i ? ' ' : '') + b.text)));
		group.append(text);
	}
	const word = node.ghost ? 'no ledger row' : node.status;
	const lead = (showPaper && node.paper ? `${node.paper} · ` : '') + (node.taskId ? `${node.taskId} · ` : '');
	const sub = svg('text', { class: 'vc-sub', x: 10, y: 35 });
	const room = w - 18 - badgeWidth;
	const fittedLead = estimateWidth(lead + word, 10.5) > room ? fit(lead, Math.max(0, room - estimateWidth(word, 10.5)), 10.5) : lead;
	sub.append(fittedLead, svg('tspan', { class: 'vc-word' }, word));
	group.append(sub);
	return group;
}

function arrowHead(tip: { x: number; y: number }, lr: boolean): string {
	return lr
		? `M${tip.x} ${tip.y}L${tip.x - ARROW_LENGTH} ${tip.y - ARROW_HALF}L${tip.x - ARROW_LENGTH} ${tip.y + ARROW_HALF}Z`
		: `M${tip.x} ${tip.y}L${tip.x - ARROW_HALF} ${tip.y - ARROW_LENGTH}L${tip.x + ARROW_HALF} ${tip.y - ARROW_LENGTH}Z`;
}

/** Draws the laid-out graph into `viewport`: edges under junctions under nodes. `showPaper` names each node's paper (merged graphs). */
export function renderScene(viewport: SVGGElement, layout: Layout, byId: Map<string, GraphNode>, frontier: Set<string>, showPaper: boolean): Scene {
	clear(viewport);
	const lr = layout.direction === 'lr';
	const edgeLayer = svg('g', { class: 'vc-edges' });
	const junctionLayer = svg('g', { class: 'vc-junctions' });
	const nodeLayer = svg('g', { class: 'vc-nodes' });
	const scene: Scene = { layout, placed: new Map(), nodes: new Map(), strokes: [], heads: [], junctions: new Map() };

	// Loop-backs last, so that a dashed feedback edge is never buried under ordinary edges.
	const drawOrder = layout.segments.map((_, i) => i).sort((a, b) => Number(layout.segments[a].feedback) - Number(layout.segments[b].feedback) || a - b);
	for (const i of drawOrder) {
		const segment = layout.segments[i];
		const stroke = svg('path', { class: `vc-seg vc-seg-${segment.kind}`, d: segment.d });
		scene.strokes[i] = stroke;
		edgeLayer.append(stroke);
		if (segment.tip) {
			const head = svg('path', { class: `vc-arrow vc-seg-${segment.kind}`, d: arrowHead(segment.tip, lr) });
			scene.heads[i] = head;
			edgeLayer.append(head);
		}
	}
	for (const junction of layout.junctions) {
		const dot = svg('circle', { class: 'vc-junction', cx: junction.x, cy: junction.y, r: 3.4 });
		scene.junctions.set(junction.target, dot);
		junctionLayer.append(dot);
	}
	for (const box of layout.nodes) {
		const node = byId.get(box.id);
		if (node) {
			const group = drawNode(node, box, frontier.has(box.id), showPaper);
			scene.placed.set(box.id, box);
			scene.nodes.set(box.id, group);
			nodeLayer.append(group);
		}
	}
	viewport.append(edgeLayer, junctionLayer, nodeLayer);
	return scene;
}
