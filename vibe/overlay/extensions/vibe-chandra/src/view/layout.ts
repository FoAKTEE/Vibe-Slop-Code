// SPDX-License-Identifier: MIT

import { analyzeCycles } from '../model/cycles.ts';
import type { EdgeRef, Hyperedge } from '../model/types.ts';

export type Direction = 'lr' | 'td';

export interface LayoutOptions {
	direction: Direction;
	nodeWidth: number;
	nodeHeight: number;
	/** Minimum gap between two layers; grows with the steepest edge that has to cross it. */
	layerGap: number;
	/** Gap between neighbouring node boxes inside a layer. */
	nodeGap: number;
	/** Gap kept around an edge lane that passes through a layer. */
	laneGap: number;
	/** Distance between a join's junction dot and its target. */
	junctionOffset: number;
	padding: number;
	/** Crossing-reduction iterations (one down sweep plus one up sweep each). */
	sweeps: number;
}

export interface LayoutInput {
	nodes: readonly { id: string }[];
	hyperedges: readonly Hyperedge[];
	feedbackEdges: readonly EdgeRef[];
}

export interface PlacedNode {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
	layer: number;
	order: number;
}

export interface PlacedJunction {
	hyperedge: string;
	target: string;
	x: number;
	y: number;
}

export interface LayoutEdge {
	source: string;
	target: string;
	hyperedge: string;
	feedback: boolean;
}

/**
 * One drawn stroke. Strokes are shared: a `trunk` carries every long edge leaving one source, a `stem` is
 * the single arrow from a junction into its target. `edges` lists the dependency edges riding on it.
 */
export interface Segment {
	id: string;
	kind: 'trunk' | 'branch' | 'stem' | 'loop';
	d: string;
	edges: number[];
	arrow: boolean;
	/** Arrowhead tip, present when `arrow` is set. */
	tip?: { x: number; y: number };
	feedback: boolean;
}

export interface Layout {
	direction: Direction;
	width: number;
	height: number;
	nodes: PlacedNode[];
	junctions: PlacedJunction[];
	edges: LayoutEdge[];
	segments: Segment[];
	stats: { layers: number; dummies: number; crossings: number; isolated: number };
}

const ARROW_INSET = 5;
const SELF_LOOP_ROOM = 18;
const REAL = 0, TRUNK = 1, LOOP = 2;

function defaults(direction: Direction): LayoutOptions {
	return direction === 'lr'
		? { direction, nodeWidth: 188, nodeHeight: 44, layerGap: 64, nodeGap: 14, laneGap: 13, junctionOffset: 26, padding: 28, sweeps: 12 }
		: { direction, nodeWidth: 188, nodeHeight: 44, layerGap: 66, nodeGap: 22, laneGap: 12, junctionOffset: 24, padding: 28, sweeps: 12 };
}

const round = (value: number): number => Math.round(value * 10) / 10;

/**
 * Weighted least-squares placement of one layer: positions as close as possible to `desired` while
 * consecutive items keep at least `gap[i]` between item i-1 and item i. Substituting the cumulative gaps
 * turns this into isotonic regression, solved exactly by pool-adjacent-violators in linear time.
 */
function placeWithGaps(desired: number[], weight: number[], gap: number[]): number[] {
	const n = desired.length;
	const offset = new Array<number>(n);
	const sum: number[] = [];
	const total: number[] = [];
	const count: number[] = [];
	let acc = 0;
	for (let i = 0; i < n; i++) {
		acc += i === 0 ? 0 : gap[i];
		offset[i] = acc;
		sum.push((desired[i] - acc) * weight[i]);
		total.push(weight[i]);
		count.push(1);
		while (sum.length > 1 && sum[sum.length - 2] / total[total.length - 2] > sum[sum.length - 1] / total[total.length - 1]) {
			const s = sum.pop()!, t = total.pop()!, c = count.pop()!;
			sum[sum.length - 1] += s;
			total[total.length - 1] += t;
			count[count.length - 1] += c;
		}
	}
	const out = new Array<number>(n);
	let i = 0;
	for (let b = 0; b < sum.length; b++) {
		const z = sum[b] / total[b];
		for (let k = 0; k < count[b]; k++, i++) {
			out[i] = z + offset[i];
		}
	}
	return out;
}

/** Crossings between two adjacent layers: inversions among the link end positions (Fenwick tree). */
function countCrossings(links: [number, number][], order: number[], lowerSize: number): number {
	const sorted = links.map(([a, b]) => [order[a], order[b]]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
	const tree = new Int32Array(lowerSize + 1);
	let crossings = 0;
	for (let i = sorted.length - 1; i >= 0; i--) {
		for (let k = sorted[i][1]; k > 0; k -= k & -k) {
			crossings += tree[k];
		}
		for (let k = sorted[i][1] + 1; k <= lowerSize; k += k & -k) {
			tree[k]++;
		}
	}
	return crossings;
}

/**
 * Layered (Sugiyama-style) layout of a directed hypergraph.
 *
 * 1. cycle-break: the model's feedback edges are reversed for layering (recomputed here if they do not
 *    actually break every cycle);
 * 2. longest-path layering, roots pulled towards their first consumer;
 * 3. long edges become lanes through the layers in between, ONE shared lane per source (a fan-out trunk);
 *    a feedback edge gets its own lane that also reserves a slot beside both of its end nodes;
 * 4. barycenter crossing reduction, best ordering kept;
 * 5. coordinates by alternating weighted least-squares sweeps;
 * 6. routing: all sources of a join meet in one junction dot just before the target and a single arrow
 *    continues into it; feedback edges leave on the output side, loop back and re-enter on the input side.
 *
 * Deterministic: no randomness, no clocks, every sort is stable with explicit tie-breaks.
 */
export function layoutGraph(input: LayoutInput, options: Partial<LayoutOptions> = {}): Layout {
	const o: LayoutOptions = { ...defaults(options.direction ?? 'lr'), ...options };
	const lr = o.direction === 'lr';
	const rankSize = lr ? o.nodeWidth : o.nodeHeight;
	const orderSize = lr ? o.nodeHeight : o.nodeWidth;
	const n = input.nodes.length;
	const ids = input.nodes.map(node => node.id);
	const indexOf = new Map<string, number>();
	ids.forEach((id, i) => indexOf.set(id, i));

	// --- edges ---------------------------------------------------------------------------------------
	interface WorkEdge extends LayoutEdge { s: number; t: number }
	const collect = (feedback: readonly EdgeRef[]): WorkEdge[] => {
		const marked = new Set(feedback.map(e => `${e.source}\n${e.target}`));
		const list: WorkEdge[] = [];
		for (const h of input.hyperedges) {
			const t = indexOf.get(h.target);
			for (const source of t === undefined ? [] : new Set(h.sources)) {
				const s = indexOf.get(source);
				if (s !== undefined) {
					list.push({ source, target: h.target, hyperedge: h.id, feedback: s === t || marked.has(`${source}\n${h.target}`), s, t: t! });
				}
			}
		}
		return list;
	};

	// Topological order of the graph with feedback edges reversed; null when a cycle is left.
	const topological = (list: WorkEdge[]): { order: number[]; out: number[][]; inn: number[][] } | null => {
		const out: number[][] = Array.from({ length: n }, () => []);
		const inn: number[][] = Array.from({ length: n }, () => []);
		for (const e of list) {
			if (e.s !== e.t) {
				const [a, b] = e.feedback ? [e.t, e.s] : [e.s, e.t];
				out[a].push(b);
				inn[b].push(a);
			}
		}
		const pending = inn.map(x => x.length);
		const order: number[] = [];
		for (let v = 0; v < n; v++) {
			if (pending[v] === 0) {
				order.push(v);
			}
		}
		for (let head = 0; head < order.length; head++) {
			for (const w of out[order[head]]) {
				if (--pending[w] === 0) {
					order.push(w);
				}
			}
		}
		return order.length === n ? { order, out, inn } : null;
	};

	let edges = collect(input.feedbackEdges);
	let topo = topological(edges);
	if (!topo) {
		edges = collect(analyzeCycles(ids, input.hyperedges).feedbackEdges);
		topo = topological(edges)!;
	}

	// --- layering ------------------------------------------------------------------------------------
	const layerOf = new Array<number>(n).fill(0);
	for (const v of topo.order) {
		for (const w of topo.out[v]) {
			layerOf[w] = Math.max(layerOf[w], layerOf[v] + 1);
		}
	}
	for (let i = n - 1; i >= 0; i--) {
		const v = topo.order[i];
		if (topo.inn[v].length === 0 && topo.out[v].length > 0) {
			layerOf[v] = Math.min(...topo.out[v].map(w => layerOf[w])) - 1;
		}
	}
	const hasSelfLoop = new Uint8Array(n);
	edges.forEach(e => hasSelfLoop[e.s] |= e.s === e.t ? 1 : 0);
	const isolated: number[] = [];
	for (let v = 0; v < n; v++) {
		if (topo.inn[v].length === 0 && topo.out[v].length === 0 && !hasSelfLoop[v]) {
			isolated.push(v);
		}
	}
	const isIsolated = new Uint8Array(n);
	isolated.forEach(v => isIsolated[v] = 1);

	// --- layered graph with lanes --------------------------------------------------------------------
	const vLayer: number[] = layerOf.slice();
	const vKind: number[] = new Array<number>(n).fill(REAL);
	const vAnchor: number[] = new Array<number>(n).fill(-1);
	const up: number[][] = Array.from({ length: n }, () => []);
	const down: number[][] = Array.from({ length: n }, () => []);
	const linkSeen = new Set<number>();
	const addVertex = (layer: number, kind: number, anchor: number): number => {
		vLayer.push(layer);
		vKind.push(kind);
		vAnchor.push(anchor);
		up.push([]);
		down.push([]);
		return vLayer.length - 1;
	};
	const link = (a: number, b: number): void => {
		const key = a * 1_000_003 + b;
		if (!linkSeen.has(key)) {
			linkSeen.add(key);
			down[a].push(b);
			up[b].push(a);
		}
	};
	// chain[e]: the vertices an edge passes through, from its source up to (not including) its target.
	const chain: number[][] = new Array(edges.length);
	const trunk = new Map<number, number[]>();
	edges.forEach((e, index) => {
		if (e.feedback) {
			return;
		}
		const span = vLayer[e.t] - vLayer[e.s];
		let lane = trunk.get(e.s);
		if (!lane) {
			lane = [];
			trunk.set(e.s, lane);
		}
		while (lane.length < span - 1) {
			const d = addVertex(vLayer[e.s] + lane.length + 1, TRUNK, -1);
			link(lane.length ? lane[lane.length - 1] : e.s, d);
			lane.push(d);
		}
		chain[index] = [e.s, ...lane.slice(0, span - 1)];
		link(chain[index][chain[index].length - 1], e.t);
	});
	edges.forEach((e, index) => {
		if (!e.feedback || e.s === e.t) {
			return;
		}
		// Listed from the target's layer up to the source's layer; both end slots sit beside their node.
		const lane: number[] = [];
		for (let layer = vLayer[e.t]; layer <= vLayer[e.s]; layer++) {
			const d = addVertex(layer, LOOP, layer === vLayer[e.t] ? e.t : layer === vLayer[e.s] ? e.s : -1);
			if (lane.length) {
				link(lane[lane.length - 1], d);
			}
			lane.push(d);
		}
		chain[index] = lane;
	});
	const total = vLayer.length;
	const layerCount = total === 0 ? 0 : Math.max(...vLayer) + 1;

	// --- ordering ------------------------------------------------------------------------------------
	const layers: number[][] = Array.from({ length: layerCount }, () => []);
	const visited = new Uint8Array(total);
	const stack: number[] = [];
	for (let root = 0; root < total; root++) {
		if (visited[root] || (root < n && isIsolated[root]) || vAnchor[root] !== -1) {
			continue;
		}
		stack.push(root);
		while (stack.length) {
			const v = stack.pop()!;
			if (visited[v]) {
				continue;
			}
			visited[v] = 1;
			if (vAnchor[v] === -1) {
				layers[vLayer[v]].push(v);
			}
			for (let k = down[v].length - 1; k >= 0; k--) {
				stack.push(down[v][k]);
			}
		}
	}
	const attached: number[][] = Array.from({ length: total }, () => []);
	for (let v = n; v < total; v++) {
		if (vAnchor[v] !== -1) {
			attached[vAnchor[v]].push(v);
		}
	}
	const order = new Array<number>(total).fill(0);
	const seat = (layer: number): void => {
		const withAttached: number[] = [];
		for (const v of layers[layer]) {
			if (vAnchor[v] === -1) {
				withAttached.push(v, ...attached[v]);
			}
		}
		layers[layer] = withAttached;
		withAttached.forEach((v, i) => order[v] = i);
	};
	for (let layer = 0; layer < layerCount; layer++) {
		seat(layer);
	}
	const linksFrom: [number, number][][] = Array.from({ length: layerCount }, () => []);
	for (let v = 0; v < total; v++) {
		for (const w of down[v]) {
			linksFrom[vLayer[v]].push([v, w]);
		}
	}
	const crossings = (): number => {
		let sum = 0;
		for (let layer = 0; layer + 1 < layerCount; layer++) {
			sum += countCrossings(linksFrom[layer], order, layers[layer + 1].length);
		}
		return sum;
	};
	const reorder = (layer: number, neighbours: number[][]): void => {
		// Vertices without neighbours on the reference side keep their slot; the others are sorted by
		// barycenter into the remaining slots.
		const free = layers[layer].filter(v => vAnchor[v] === -1);
		const movable = free.filter(v => neighbours[v].length > 0);
		const key = new Map<number, number>();
		for (const v of movable) {
			key.set(v, neighbours[v].reduce((sum, w) => sum + order[w], 0) / neighbours[v].length);
		}
		movable.sort((a, b) => key.get(a)! - key.get(b)! || order[a] - order[b]);
		let next = 0;
		layers[layer] = free.map(v => neighbours[v].length > 0 ? movable[next++] : v);
		seat(layer);
	};
	let best = crossings();
	let bestLayers = layers.map(l => l.slice());
	for (let sweep = 0, stale = 0; sweep < o.sweeps && best > 0 && stale < 4; sweep++) {
		for (let layer = 1; layer < layerCount; layer++) {
			reorder(layer, up);
		}
		for (let layer = layerCount - 2; layer >= 0; layer--) {
			reorder(layer, down);
		}
		const now = crossings();
		if (now < best) {
			best = now;
			bestLayers = layers.map(l => l.slice());
			stale = 0;
		} else {
			stale++;
		}
	}
	bestLayers.forEach((l, layer) => {
		layers[layer] = l;
		l.forEach((v, i) => order[v] = i);
	});
	// Transpose: swap neighbours while that removes crossings; it polishes what barycenter sorting leaves behind.
	const pinned = (v: number): boolean => vAnchor[v] !== -1 || attached[v].length > 0;
	const crossingsIfBefore = (u: number, v: number): number => {
		let count = 0;
		for (const side of [up, down]) {
			for (const a of side[u]) {
				for (const b of side[v]) {
					count += order[a] > order[b] ? 1 : 0;
				}
			}
		}
		return count;
	};
	for (let pass = 0, improved = best > 0; improved && pass < 10; pass++) {
		improved = false;
		for (const l of layers) {
			for (let i = 0; i + 1 < l.length; i++) {
				const u = l[i], v = l[i + 1];
				const gain = pinned(u) || pinned(v) ? 0 : crossingsIfBefore(u, v) - crossingsIfBefore(v, u);
				if (gain > 0) {
					l[i] = v;
					l[i + 1] = u;
					order[v] = i;
					order[u] = i + 1;
					best -= gain;
					improved = true;
				}
			}
		}
	}

	// --- coordinates along the order axis --------------------------------------------------------------
	const size = (v: number): number => vKind[v] === REAL ? orderSize : 0;
	const gaps: number[][] = layers.map(l => l.map((v, i) => {
		if (i === 0) {
			return 0;
		}
		const u = l[i - 1];
		const between = vKind[u] === REAL && vKind[v] === REAL ? o.nodeGap : o.laneGap;
		return size(u) / 2 + size(v) / 2 + between + (v < n && hasSelfLoop[v] ? SELF_LOOP_ROOM : 0);
	}));
	const pos = new Array<number>(total).fill(0);
	layers.forEach((l, layer) => {
		let at = 0;
		l.forEach((v, i) => pos[v] = (at += gaps[layer][i]));
		l.forEach(v => pos[v] -= at / 2);
	});
	const linkWeight = (a: number, b: number): number => vKind[a] !== REAL && vKind[b] !== REAL ? 8 : vKind[a] !== REAL || vKind[b] !== REAL ? 2 : 1;
	const settle = (layer: number, useUp: boolean, useDown: boolean): void => {
		const l = layers[layer];
		const desired = new Array<number>(l.length);
		const weight = new Array<number>(l.length);
		l.forEach((v, i) => {
			let sum = 0, w = 0;
			for (const side of [useUp ? up[v] : [], useDown ? down[v] : []]) {
				for (const other of side) {
					const lw = linkWeight(v, other);
					sum += pos[other] * lw;
					w += lw;
				}
			}
			if (vAnchor[v] !== -1 && i > 0) {
				// A loop-back's end slot hugs the node it belongs to.
				desired[i] = desired[i - 1] + gaps[layer][i];
				weight[i] = 1;
			} else {
				desired[i] = w > 0 ? sum / w : pos[v];
				weight[i] = w > 0 ? w : 0.25;
			}
		});
		placeWithGaps(desired, weight, gaps[layer]).forEach((p, i) => pos[l[i]] = p);
	};
	for (let round = 0; round < 4; round++) {
		for (let layer = 1; layer < layerCount; layer++) {
			settle(layer, true, false);
		}
		for (let layer = layerCount - 2; layer >= 0; layer--) {
			settle(layer, false, true);
		}
	}
	for (let round = 0; round < 2; round++) {
		for (let layer = 0; layer < layerCount; layer++) {
			settle(layer, true, true);
		}
	}

	// --- coordinates along the rank axis ---------------------------------------------------------------
	const hasLoops = edges.some(e => e.feedback);
	const rankPadding = o.padding + (hasLoops ? 34 : 0);
	const rankStart = new Array<number>(layerCount).fill(rankPadding);
	for (let layer = 1; layer < layerCount; layer++) {
		let steepest = 0;
		for (const [a, b] of linksFrom[layer - 1]) {
			steepest = Math.max(steepest, Math.abs(pos[a] - pos[b]));
		}
		rankStart[layer] = rankStart[layer - 1] + rankSize + o.layerGap + Math.min(120, 0.15 * steepest);
	}
	let minPos = Infinity, maxPos = -Infinity;
	for (const l of layers) {
		for (const v of l) {
			minPos = Math.min(minPos, pos[v] - size(v) / 2 - (v < n && hasSelfLoop[v] ? SELF_LOOP_ROOM : 0));
			maxPos = Math.max(maxPos, pos[v] + size(v) / 2);
		}
	}
	if (!Number.isFinite(minPos)) {
		minPos = maxPos = 0;
	}
	const shift = o.padding - minPos;
	for (let v = 0; v < total; v++) {
		pos[v] += shift;
	}
	const empty = layers.every(l => l.length === 0);
	const rankExtent = empty ? 0 : rankStart[layerCount - 1] + rankSize + rankPadding;
	const orderExtent = empty ? 0 : maxPos + shift + o.padding;
	let width = lr ? rankExtent : orderExtent;
	let height = lr ? orderExtent : rankExtent;

	const nodes: PlacedNode[] = new Array(n);
	for (let v = 0; v < n; v++) {
		if (isIsolated[v]) {
			continue;
		}
		const r = rankStart[vLayer[v]], p = pos[v] - orderSize / 2;
		nodes[v] = { id: ids[v], x: round(lr ? r : p), y: round(lr ? p : r), w: o.nodeWidth, h: o.nodeHeight, layer: vLayer[v], order: order[v] };
	}
	if (isolated.length) {
		// Nodes without any dependency form a block under the graph instead of stretching layer 0.
		const stepX = o.nodeWidth + 20, stepY = o.nodeHeight + o.laneGap + 3;
		const columns = Math.min(isolated.length, Math.max(4, Math.floor((width - 2 * o.padding + 20) / stepX)));
		const top = height > 0 ? height - o.padding + 26 : o.padding;
		isolated.forEach((v, i) => {
			nodes[v] = {
				id: ids[v], x: o.padding + (i % columns) * stepX, y: top + Math.floor(i / columns) * stepY,
				w: o.nodeWidth, h: o.nodeHeight, layer: 0, order: i,
			};
		});
		width = Math.max(width, 2 * o.padding + columns * stepX - 20);
		height = top + Math.ceil(isolated.length / columns) * stepY - (o.laneGap + 3) + o.padding;
	}

	// --- routing ---------------------------------------------------------------------------------------
	const point = (rank: number, across: number): string => lr ? `${round(rank)} ${round(across)}` : `${round(across)} ${round(rank)}`;
	const xy = (rank: number, across: number): { x: number; y: number } => lr ? { x: round(rank), y: round(across) } : { x: round(across), y: round(rank) };
	const curve = (r0: number, p0: number, r1: number, p1: number): string => {
		const bend = (r1 - r0) / 2;
		return `C${point(r0 + bend, p0)} ${point(r1 - bend, p1)} ${point(r1, p1)}`;
	};
	const uTurn = (rank: number, p0: number, r1: number, p1: number, outward: number): string => {
		const reach = outward * Math.max(26, Math.min(46, Math.abs(p1 - p0) * 0.75));
		return `C${point(rank + reach, p0)} ${point(r1 + reach, p1)} ${point(r1, p1)}`;
	};

	const sourcesOf = new Map<number, number[]>();
	edges.forEach((e, index) => {
		const list = sourcesOf.get(e.t);
		if (list) {
			list.push(index);
		} else {
			sourcesOf.set(e.t, [index]);
		}
	});
	const junctions: PlacedJunction[] = [];
	const junctionRank = new Map<number, number>();
	for (const [t, incoming] of sourcesOf) {
		if (incoming.length > 1) {
			const rank = rankStart[vLayer[t]] - o.junctionOffset;
			junctionRank.set(t, rank);
			junctions.push({ hyperedge: edges[incoming[0]].hyperedge, target: ids[t], ...xy(rank, pos[t]) });
		}
	}

	const segments: Segment[] = [];
	const shared = new Map<number, Segment>();
	// Where an edge ends: at its target's junction, or on the target itself (then it carries the arrow).
	const landing = (t: number): { rank: number; arrow: boolean } =>
		junctionRank.has(t) ? { rank: junctionRank.get(t)!, arrow: false } : { rank: rankStart[vLayer[t]], arrow: true };

	edges.forEach((e, index) => {
		const end = landing(e.t);
		const endRank = end.arrow ? end.rank - ARROW_INSET : end.rank;
		const tip = end.arrow ? { tip: xy(end.rank, pos[e.t]) } : {};
		if (e.s === e.t) {
			// Out of the output side, around the node's near edge, back into its input side.
			const apex = pos[e.s] - orderSize / 2 - SELF_LOOP_ROOM + 4;
			const r0 = rankStart[vLayer[e.s]] + rankSize, p0 = pos[e.s] - orderSize / 2 + 8;
			const d = `M${point(r0, p0)} C${point(r0 + 28, p0)} ${point(r0 + 28, apex)} ${point(r0 - rankSize / 2, apex)}`
				+ ` C${point(endRank - 34, apex)} ${point(endRank - 34, pos[e.t])} ${point(endRank, pos[e.t])}`;
			segments.push({ id: `loop:${index}`, kind: 'loop', d, edges: [index], arrow: end.arrow, ...tip, feedback: true });
			return;
		}
		const lane = chain[index];
		if (e.feedback) {
			const r0 = rankStart[vLayer[e.s]] + rankSize;
			let at = lane.length - 1;
			let d = `M${point(r0, pos[e.s])} ${uTurn(r0, pos[e.s], r0, pos[lane[at]], 1)} L${point(rankStart[vLayer[e.s]], pos[lane[at]])}`;
			for (at--; at >= 0; at--) {
				const next = lane[at], previous = lane[at + 1];
				d += ` ${curve(rankStart[vLayer[previous]], pos[previous], rankStart[vLayer[next]] + rankSize, pos[next])} L${point(rankStart[vLayer[next]], pos[next])}`;
			}
			d += ` ${uTurn(rankStart[vLayer[e.t]], pos[lane[0]], endRank, pos[e.t], -1)}`;
			segments.push({ id: `loop:${index}`, kind: 'loop', d, edges: [index], arrow: end.arrow, ...tip, feedback: true });
			return;
		}
		for (let k = 0; k + 1 < lane.length; k++) {
			const a = lane[k], b = lane[k + 1];
			let segment = shared.get(b);
			if (!segment) {
				const r1 = rankStart[vLayer[b]];
				segment = {
					id: `trunk:${ids[e.s]}:${k}`, kind: 'trunk', arrow: false, feedback: false, edges: [],
					d: `M${point(rankStart[vLayer[a]] + rankSize, pos[a])} ${curve(rankStart[vLayer[a]] + rankSize, pos[a], r1, pos[b])} L${point(r1 + rankSize, pos[b])}`,
				};
				shared.set(b, segment);
				segments.push(segment);
			}
			segment.edges.push(index);
		}
		const last = lane[lane.length - 1];
		const r0 = rankStart[vLayer[last]] + rankSize;
		segments.push({
			id: `branch:${index}`, kind: 'branch', edges: [index], arrow: end.arrow, ...tip, feedback: false,
			d: `M${point(r0, pos[last])} ${curve(r0, pos[last], endRank, pos[e.t])}`,
		});
	});
	for (const [t, incoming] of sourcesOf) {
		if (junctionRank.has(t)) {
			const tipRank = rankStart[vLayer[t]];
			segments.push({
				id: `stem:${ids[t]}`, kind: 'stem', edges: incoming.slice(), arrow: true, tip: xy(tipRank, pos[t]), feedback: false,
				d: `M${point(junctionRank.get(t)!, pos[t])} L${point(tipRank - ARROW_INSET, pos[t])}`,
			});
		}
	}

	return {
		direction: o.direction, width: round(width), height: round(height), nodes, junctions,
		edges: edges.map(e => ({ source: e.source, target: e.target, hyperedge: e.hyperedge, feedback: e.feedback })),
		segments,
		stats: { layers: layerCount, dummies: total - n, crossings: best, isolated: isolated.length },
	};
}
