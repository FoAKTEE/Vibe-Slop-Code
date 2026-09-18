// SPDX-License-Identifier: MIT

import { downstream, indexGraph, routeBetween, upstream, visibleSubgraph, type GraphIndex, type Route } from '../model/derived.ts';
import { NODE_STATUSES, type GraphNode, type Hypergraph } from '../model/types.ts';
import { clear, el, icon, svg } from './dom.ts';
import { FAR_SCALE, LEGIBLE_SCALE, TINY_SCALE, WHOLE_SCALE, countOverflow, pickAnchors, placeView, type Overflow } from './fitPolicy.ts';
import { glyphIcon, ringIcon } from './glyphs.ts';
import { formatHash, parseHash, type Reach, type ViewState } from './hashState.ts';
import type { FlowDirection, Host } from './host.ts';
import { layoutGraph } from './layout.ts';
import { PanZoom, type Box, type Insets } from './panZoom.ts';
import { renderPanel } from './panel.ts';
import { renderScene, type Scene } from './render.ts';

export interface GraphView {
	setGraph(graph: Hypergraph): void;
	focus(id: string): void;
	dispose(): void;
}

const EMPTY_GRAPH: Hypergraph = { papers: [], nodes: [], hyperedges: [], cycles: { cyclic: false, sccs: [], feedbackEdges: [] }, frontier: [], statusCounts: {}, warnings: [] };
const PANEL_WIDTH = 340;
/** The share of a narrow view's height that the detail panel takes (graph.css: `.vc-narrow .vc-panel`). */
const PANEL_SHARE = 0.46;
/** Below this width the view is an overview beside the node tree: compact chrome, always fitted whole. */
const NARROW_WIDTH = 680;
/** Kept free between the toolbar or the legend and a fitted graph. */
const CHROME_GAP = 8;
const MAX_RESULTS = 12;

const SIDES = ['left', 'right', 'top', 'bottom'] as const;
const SIDE_TEXT: Record<typeof SIDES[number], [prefix: string, suffix: string, where: string]> = {
	left: ['\u2190 ', ' more', 'to the left'], right: ['', ' more \u2192', 'to the right'], top: ['\u2191 ', ' more', 'above'], bottom: ['\u2193 ', ' more', 'below'],
};

const KEYS: [string, string][] = [
	['/', 'search nodes, Enter jumps'], ['click', 'focus a node: light its upstream and downstream reach'], ['U  D', 'restrict the reach to upstream / downstream'],
	['R', 'route probe: pick a second node'], ['← → ↑ ↓', 'walk to a neighbour'], ['+  \u2212  0', 'zoom in / out / fit everything; 0 again: back to the readable view'], ['T', 'left-to-right or top-down'],
	['I', 'show retired and amended nodes'], ['F', 'presentation: hide the chrome and fit'], ['Esc', 'step back: route, focus, lens'],
];

export interface MountOptions {
	/** The flow direction of a view that carries no saved state; the host's configuration. */
	direction?: FlowDirection;
}

/** Mounts the interactive workflow graph into `root`. The view talks to the outside only through `host`. */
export function mount(root: HTMLElement, host: Host, options: MountOptions = {}): GraphView {
	return new View(root, host, options.direction ?? 'lr');
}

class View implements GraphView {
	private readonly root: HTMLElement;
	private readonly host: Host;
	private readonly surface: SVGSVGElement;
	private readonly viewport: SVGGElement;
	private readonly panZoom: PanZoom;
	private readonly search: HTMLInputElement;
	private readonly results: HTMLElement;
	private readonly stats: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly legend: HTMLElement;
	private readonly more: Record<typeof SIDES[number], HTMLButtonElement>;
	private readonly banner: HTMLElement;
	private readonly panel: HTMLElement;
	private readonly help: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly directionButton: HTMLButtonElement;
	private readonly resizeObserver: ResizeObserver;
	private readonly onHashChange = (): void => this.restore(parseHash(location.hash, this.defaultDirection));

	private graph: Hypergraph = EMPTY_GRAPH;
	private index: GraphIndex = indexGraph(EMPTY_GRAPH);
	private frontier = new Set<string>();
	private cycles = new Map<string, string[]>();
	private scene: Scene | undefined;
	private defaultDirection: FlowDirection;
	private state: ViewState;
	private route: Route | undefined;
	private picking = false;
	private query = '';
	private matches: GraphNode[] = [];
	private selected = 0;
	private framed = false;
	/** Set by Fit: the user asked for everything, so our own re-framing keeps showing everything. */
	private overview = false;
	/** Set when a graph arrived before the container had a size (a webview that is still hidden). */
	private frameWhenSized = false;

	constructor(root: HTMLElement, host: Host, defaultDirection: FlowDirection) {
		this.root = root;
		this.host = host;
		this.defaultDirection = defaultDirection;
		// A host that keeps state (the editor) wins over the URL: a webview's URL is not the user's to share.
		this.state = parseHash(host.loadState?.() ?? location.hash, defaultDirection);
		root.classList.add('vc-root');
		root.tabIndex = 0;

		this.viewport = svg('g', { class: 'vc-viewport' });
		this.surface = svg('svg', { class: 'vc-svg', role: 'application', 'aria-label': 'Chandra workflow graph' }, this.viewport);
		this.panZoom = new PanZoom(this.surface, this.viewport, k => {
			root.classList.toggle('vc-far', k < FAR_SCALE);
			root.classList.toggle('vc-tiny', k < TINY_SCALE);
			this.renderOverflow();
		});

		this.search = el('input', 'vc-search');
		this.search.type = 'search';
		this.search.placeholder = 'Search nodes  ( / )';
		this.search.spellcheck = false;
		this.search.setAttribute('aria-label', 'Search nodes');
		this.directionButton = this.button('', 'Toggle left-to-right / top-down (T)', () => this.update({ direction: this.state.direction === 'lr' ? 'td' : 'lr' }));
		this.stats = el('span', 'vc-stats');
		this.toolbar = el('div', 'vc-toolbar', this.search,
			this.button(icon('M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4'), 'Fit Everything (0)', () => this.fitEverything()),
			this.button(icon('M3 8h10'), 'Zoom out (\u2212)', () => this.panZoom.zoomBy(1 / 1.3)),
			this.button(icon('M3 8h10M8 3v10'), 'Zoom in (+)', () => this.panZoom.zoomBy(1.3)),
			this.directionButton,
			this.button(icon('M6 6a2 2 0 1 1 3 1.7c-.7.5-1 .9-1 1.8M8 12v.5'), 'Keyboard shortcuts (?)', () => this.help.hidden = !this.help.hidden),
			el('span', 'vc-sep'), this.stats);
		this.results = el('div', 'vc-results');
		this.results.hidden = true;
		this.results.setAttribute('role', 'listbox');
		this.help = el('div', 'vc-help');
		this.help.hidden = true;
		for (const [key, text] of KEYS) {
			this.help.append(el('b', 'vc-key', key), el('span', '', text));
		}
		this.banner = el('div', 'vc-banner');
		this.banner.hidden = true;
		this.banner.setAttribute('role', 'status');
		this.legend = el('div', 'vc-legend');
		const more = (side: typeof SIDES[number]): HTMLButtonElement => {
			const chip = el('button', `vc-more vc-more-${side}`);
			chip.hidden = true;
			chip.addEventListener('click', () => this.panTowards(side));
			return chip;
		};
		this.more = { left: more('left'), right: more('right'), top: more('top'), bottom: more('bottom') };
		this.panel = el('aside', 'vc-panel');
		this.panel.hidden = true;
		this.empty = el('div', 'vc-empty', 'Waiting for the ledgers…');
		root.append(this.surface, this.empty, this.toolbar, this.results, this.help, this.banner, ...SIDES.map(side => this.more[side]), this.legend, this.panel);

		this.surface.addEventListener('click', e => this.onSurfaceClick(e));
		root.addEventListener('keydown', e => this.onKey(e));
		this.search.addEventListener('input', () => this.onSearch());
		this.search.addEventListener('focus', () => this.onSearch());
		this.search.addEventListener('blur', () => setTimeout(() => this.results.hidden = true, 120));
		window.addEventListener('hashchange', this.onHashChange);
		this.resizeObserver = new ResizeObserver(() => {
			root.classList.toggle('vc-narrow', root.clientWidth < NARROW_WIDTH);
			if (this.frameWhenSized && this.surface.clientWidth > 50) {
				this.frame(false);
			}
			this.measureLegend();
			this.renderOverflow();
		});
		this.resizeObserver.observe(root);

		host.onData(message => {
			if (message.type === 'graph') {
				this.setGraph(message.graph);
			} else if (message.type === 'focus') {
				this.focus(message.id);
			} else if (message.type === 'config') {
				this.defaultDirection = message.direction;
				this.update({ direction: message.direction });
			}
		});
		host.post({ type: 'ready' });
	}

	// --- public ----------------------------------------------------------------------------------------

	setGraph(graph: Hypergraph): void {
		// A pan or zoom of the user's survives the rows appended to the papers on screen. Without one the growing
		// graph is framed again, and another set of papers is another picture anyway.
		const keepView = this.framed && this.panZoom.adjusted && graph.papers.join('\n') === this.graph.papers.join('\n');
		this.graph = graph;
		this.index = indexGraph(graph);
		this.frontier = new Set(graph.frontier);
		this.cycles = new Map();
		for (const scc of graph.cycles.sccs) {
			scc.forEach(id => this.cycles.set(id, scc));
		}
		this.relayout(keepView);
	}

	focus(id: string): void {
		const node = this.index.byId.get(id);
		if (node) {
			// A retired or amended node may be hidden; asking for it by name brings the inactive nodes back.
			this.update({ focus: id, route: undefined, showInactive: this.state.showInactive || (!node.active && !this.scene?.placed.has(id)) });
			this.revealNode(id);
		}
	}

	dispose(): void {
		window.removeEventListener('hashchange', this.onHashChange);
		this.resizeObserver.disconnect();
		clear(this.root);
	}

	// --- state -----------------------------------------------------------------------------------------

	private update(patch: Partial<ViewState>): void {
		const before = this.state;
		this.state = { ...before, ...patch };
		if (this.state.focus === undefined) {
			this.state.reach = 'both';
		}
		if (this.state.direction !== before.direction || this.state.showInactive !== before.showInactive) {
			this.relayout(false);
		} else {
			this.refresh();
		}
		const hash = formatHash(this.state, this.defaultDirection);
		if (this.host.saveState) {
			this.host.saveState(hash);
		} else {
			try {
				history.replaceState(null, '', hash || location.pathname + location.search);
			} catch {
				location.hash = hash;
			}
		}
		if (this.state.focus !== undefined && this.state.focus !== before.focus) {
			this.host.post({ type: 'focused', id: this.state.focus });
		} else if (this.state.focus === undefined && before.focus !== undefined && !this.state.route && !this.panZoom.adjusted) {
			// The view was framed on the reach of the node that just lost the focus, and the user never moved it.
			this.frame(true);
		}
	}

	private restore(state: ViewState): void {
		if (formatHash(state, this.defaultDirection) !== formatHash(this.state, this.defaultDirection)) {
			const relayout = state.direction !== this.state.direction || state.showInactive !== this.state.showInactive;
			this.state = state;
			if (relayout) {
				this.relayout(false);
			} else {
				this.refresh();
				this.frame(true);
			}
		}
	}

	private relayout(keepView: boolean): void {
		const sub = visibleSubgraph(this.graph, { showInactive: this.state.showInactive });
		const layout = layoutGraph(sub, { direction: this.state.direction });
		const merged = new Set(sub.nodes.filter(n => !n.ghost).map(n => n.paper)).size > 1;
		this.scene = renderScene(this.viewport, layout, this.index.byId, this.frontier, merged);
		this.empty.hidden = sub.nodes.length > 0;
		this.empty.textContent = 'No knowledge-ledger nodes yet.';
		clear(this.directionButton);
		this.directionButton.append(this.state.direction === 'lr' ? icon('M2 8h11M9.5 4.5L13 8l-3.5 3.5') : icon('M8 2v11M4.5 9.5L8 13l3.5-3.5'));
		const joins = layout.junctions.length;
		const loops = this.graph.cycles.sccs.length;
		this.stats.textContent = [
			this.graph.papers.join(' + ') || 'no paper', `${sub.nodes.length} nodes`, `${layout.edges.length} edges`,
			`${joins} join${joins === 1 ? '' : 's'}`, `${loops} cycle${loops === 1 ? '' : 's'}`,
		].join(' · ');
		this.refresh();
		if (!keepView && sub.nodes.length) {
			this.frame(false);
			this.framed = true;
		}
	}

	/** Re-derives everything that depends on focus, reach, route, lens and the search query. */
	private refresh(): void {
		const scene = this.scene;
		if (!scene) {
			return;
		}
		const state = this.state;
		const focus = state.focus !== undefined && this.index.byId.has(state.focus) ? state.focus : undefined;
		this.route = state.route ? routeBetween(this.index, state.route[0], state.route[1]) ?? undefined : undefined;

		let lit: Set<string> | undefined;
		let up = new Set<string>(), down = new Set<string>();
		const onRoute = new Set<string>(this.route?.path);
		if (state.route) {
			lit = this.route ? new Set(this.route.corridor) : new Set(state.route);
		} else if (focus !== undefined) {
			up = state.reach === 'downstream' ? up : upstream(this.index, focus).add(focus);
			down = state.reach === 'upstream' ? down : downstream(this.index, focus).add(focus);
			lit = new Set([...up, ...down, focus]);
		}
		const routeStep = new Set<string>();
		this.route?.path.forEach((id, i, path) => i && routeStep.add(`${path[i - 1]}\n${id}`));
		const hits = this.query ? new Set(this.matches.map(n => n.id)) : undefined;
		const shown = (id: string): boolean => {
			const node = this.index.byId.get(id);
			return node !== undefined && (!lit || lit.has(id)) && this.passesLens(node) && (!hits || hits.has(id));
		};

		for (const [id, group] of scene.nodes) {
			group.classList.toggle('vc-dim', !shown(id));
			group.classList.toggle('vc-focus', id === focus);
			group.classList.toggle('vc-on-route', onRoute.has(id) && id !== focus);
			group.classList.toggle('vc-hit', hits !== undefined && hits.has(id));
		}
		const edgeLit: boolean[] = [], edgeStrong: boolean[] = [], edgeRoute: boolean[] = [];
		scene.layout.edges.forEach((e, i) => {
			edgeRoute[i] = routeStep.has(`${e.source}\n${e.target}`);
			edgeStrong[i] = !state.route && ((up.has(e.source) && up.has(e.target)) || (down.has(e.source) && down.has(e.target)));
			edgeLit[i] = shown(e.source) && shown(e.target) && (state.route !== undefined || focus === undefined || edgeStrong[i]);
		});
		const junctionState = new Map<string, [boolean, boolean, boolean]>();
		scene.layout.segments.forEach((segment, i) => {
			const flags: [boolean, boolean, boolean] = [segment.edges.some(e => edgeLit[e]), segment.edges.some(e => edgeStrong[e] && edgeLit[e]), segment.edges.some(e => edgeRoute[e])];
			for (const part of [scene.strokes[i], scene.heads[i]]) {
				part?.classList.toggle('vc-dim', !flags[0]);
				part?.classList.toggle('vc-strong', flags[1]);
				part?.classList.toggle('vc-route', flags[2]);
			}
			if (segment.kind === 'stem') {
				junctionState.set(scene.layout.edges[segment.edges[0]].target, flags);
			}
		});
		for (const [target, dot] of scene.junctions) {
			const flags = junctionState.get(target) ?? [true, false, false];
			dot.classList.toggle('vc-dim', !flags[0]);
			dot.classList.toggle('vc-strong', flags[1]);
			dot.classList.toggle('vc-route', flags[2]);
		}

		this.root.classList.toggle('vc-picking', this.picking);
		this.renderBanner();
		this.renderLegend();
		const node = focus !== undefined ? this.index.byId.get(focus) : undefined;
		this.panel.hidden = !node;
		this.root.classList.toggle('vc-detail', node !== undefined);
		if (node) {
			renderPanel(this.panel, node, {
				index: this.index, frontier: this.frontier, cycleOf: id => this.cycles.get(id), route: this.route,
				onFocus: id => this.focus(id), onOpen: target => this.host.post({ type: 'open', target }), onClose: () => this.update({ focus: undefined, route: undefined }),
			});
		}
		this.measureLegend();
		this.renderOverflow();
	}

	private passesLens(node: GraphNode): boolean {
		return this.state.lens.length === 0 || this.state.lens.some(key => this.matchesLens(node, key));
	}

	private matchesLens(node: GraphNode, key: string): boolean {
		switch (key) {
			case 'ghost': return node.ghost;
			case 'ready': return this.frontier.has(node.id);
			case 'cycle': return this.cycles.has(node.id);
			case 'failing': return node.trialStats.failStreak > 0;
			default: return !node.ghost && node.status === key;
		}
	}

	// --- chrome ----------------------------------------------------------------------------------------

	private button(content: Node | string, title: string, action: () => void): HTMLButtonElement {
		const button = el('button', 'vc-button', content);
		button.title = title;
		button.setAttribute('aria-label', title);
		button.addEventListener('click', () => {
			action();
			this.root.focus();
		});
		return button;
	}

	private renderLegend(): void {
		clear(this.legend);
		const laidOut = [...(this.scene?.nodes.keys() ?? [])].map(id => this.index.byId.get(id)!);
		const chip = (key: string, mark: Node, count: number, label: string, title: string): void => {
			const pressed = this.state.lens.includes(key);
			const button = el('button', `vc-chip vc-s-${key}`, mark, el('b', '', String(count)), el('span', '', label));
			button.title = title;
			button.setAttribute('aria-pressed', String(pressed));
			button.addEventListener('click', () => {
				this.update({ lens: pressed ? this.state.lens.filter(k => k !== key) : [...this.state.lens, key] });
				this.root.focus();
			});
			this.legend.append(button);
		};
		for (const status of NODE_STATUSES) {
			const count = laidOut.filter(n => !n.ghost && n.status === status).length;
			if (count) {
				chip(status, glyphIcon(status), count, status, `Lens: only ${status} nodes stay lit`);
			}
		}
		const count = (key: string): number => laidOut.filter(n => this.matchesLens(n, key)).length;
		if (count('ghost')) {
			chip('ghost', glyphIcon('unknown', true), count('ghost'), 'ghost', 'Lens: ids that are referenced but have no ledger row');
		}
		const statusChips = this.legend.childElementCount;
		if (this.scene?.layout.junctions.length) {
			this.legend.append(el('span', 'vc-legend-key', svg('svg', { viewBox: '0 0 22 12', class: 'vc-icon vc-icon-wide' },
				svg('path', { class: 'vc-seg', d: 'M0 2C6 2 5 6 10 6M0 10C6 10 5 6 10 6M10 6H17' }), svg('path', { class: 'vc-arrow', d: 'M22 6L16 3V9Z' }),
				svg('circle', { class: 'vc-junction', cx: 10, cy: 6, r: 2.6 })), 'AND-join'));
		}
		if (count('ready')) {
			chip('ready', ringIcon('vc-ring'), count('ready'), 'ready', 'Lens: the frontier — not solid yet, every predecessor solid');
		}
		if (count('failing')) {
			chip('failing', el('b', 'vc-failing-mark', '\u2715'), count('failing'), 'failing', 'Lens: nodes whose latest trials failed');
		}
		if (this.graph.cycles.cyclic) {
			chip('cycle', svg('svg', { viewBox: '0 0 16 12', class: 'vc-icon' }, svg('path', { class: 'vc-seg vc-seg-loop', d: 'M1 6h14' })), this.graph.cycles.sccs.length,
				this.graph.cycles.sccs.length === 1 ? 'cycle' : 'cycles', 'Lens: nodes on a cycle. Dashed loop-backs are the feedback edges.');
		}
		const hidden = this.graph.nodes.length - laidOut.length;
		if (hidden > 0 || this.state.showInactive) {
			const toggle = el('button', 'vc-chip', el('span', '', this.state.showInactive ? 'hide inactive' : `${hidden} inactive hidden`));
			toggle.title = 'Show or hide retired and amended nodes (I)';
			toggle.setAttribute('aria-pressed', String(this.state.showInactive));
			toggle.addEventListener('click', () => this.update({ showInactive: !this.state.showInactive }));
			this.legend.append(toggle);
		}
		if (statusChips && this.legend.childElementCount > statusChips) {
			this.legend.insertBefore(el('span', 'vc-sep'), this.legend.children[statusChips]);
		}
		this.legend.classList.toggle('vc-lensed', this.state.lens.length > 0);
	}

	private renderBanner(): void {
		clear(this.banner);
		const label = (id: string): HTMLElement => el('b', '', this.index.byId.get(id)?.label ?? id);
		if (this.picking) {
			this.banner.append(...(this.state.focus !== undefined ? ['Route from ', label(this.state.focus), ': click the other node · Esc cancels'] : ['Route probe: click the first node · Esc cancels']));
		} else if (this.state.route) {
			const [a, b] = this.state.route;
			if (this.route) {
				const hops = this.route.path.length - 1;
				this.banner.append('Route ', label(this.route.path[0]), ' → ', label(this.route.path[hops]), ` · ${hops} hop${hops === 1 ? '' : 's'}`);
			} else {
				this.banner.append('No directed route between ', label(a), ' and ', label(b));
			}
		}
		this.banner.hidden = !this.banner.hasChildNodes();
	}

	// --- search ----------------------------------------------------------------------------------------

	private onSearch(): void {
		this.query = this.search.value.trim().toLowerCase();
		const tokens = this.query.split(/\s+/).filter(Boolean);
		const laidOut = this.scene ? [...this.scene.nodes.keys()].map(id => this.index.byId.get(id)!) : [];
		this.matches = tokens.length === 0 ? [] : laidOut
			.map(node => ({ node, text: `${node.id} ${node.taskId ?? ''} ${node.status} ${node.summary}`.toLowerCase() }))
			.filter(x => tokens.every(t => x.text.includes(t)))
			.sort((a, b) => Number(b.node.label.toLowerCase().startsWith(tokens[0])) - Number(a.node.label.toLowerCase().startsWith(tokens[0])) || a.text.indexOf(tokens[0]) - b.text.indexOf(tokens[0]))
			.map(x => x.node);
		this.selected = 0;
		this.renderResults();
		this.refresh();
	}

	private renderResults(): void {
		clear(this.results);
		this.results.hidden = this.query === '';
		if (this.matches.length === 0) {
			this.results.append(el('div', 'vc-none', 'No matching node'));
			return;
		}
		this.matches.slice(0, MAX_RESULTS).forEach((node, i) => {
			const row = el('div', 'vc-result', glyphIcon(node.status, node.ghost),
				el('div', 'vc-result-main', node.label, ' ', el('small', '', node.summary)), el('span', 'vc-result-side', node.taskId ?? node.paper));
			row.setAttribute('role', 'option');
			row.setAttribute('aria-selected', String(i === this.selected));
			row.addEventListener('pointerdown', e => {
				e.preventDefault();
				this.choose(node.id);
			});
			this.results.append(row);
		});
		if (this.matches.length > MAX_RESULTS) {
			this.results.append(el('div', 'vc-none', `${this.matches.length - MAX_RESULTS} more — keep typing`));
		}
	}

	private closeSearch(): void {
		this.search.value = '';
		this.query = '';
		this.matches = [];
		this.results.hidden = true;
		this.root.focus();
	}

	private choose(id: string): void {
		this.closeSearch();
		this.pick(id);
		this.revealNode(id);
	}

	// --- interaction -----------------------------------------------------------------------------------

	/** A node was chosen by click, search or keyboard: it completes a route probe or becomes the focus. */
	private pick(id: string): void {
		if (this.picking && this.state.focus !== undefined && this.state.focus !== id) {
			this.picking = false;
			this.update({ route: [this.state.focus, id] });
			this.frame(true);
		} else {
			this.update({ focus: id, route: undefined });
		}
	}

	private onSurfaceClick(e: MouseEvent): void {
		if (this.panZoom.dragged) {
			return;
		}
		this.help.hidden = true;
		const id = (e.target as Element).closest('.vc-node')?.getAttribute('data-id');
		if (id) {
			this.pick(id);
		} else if (!this.picking) {
			this.update({ focus: undefined, route: undefined });
		}
		this.root.focus({ preventScroll: true });
	}

	private onKey(e: KeyboardEvent): void {
		if (e.target === this.search) {
			this.onSearchKey(e);
			return;
		}
		if (e.metaKey || e.ctrlKey || e.altKey) {
			return;
		}
		const onNode = (e.target as Element).closest?.('.vc-node')?.getAttribute('data-id');
		const reach = (wanted: Reach): void => {
			if (this.state.focus !== undefined) {
				this.update({ reach: this.state.reach === wanted ? 'both' : wanted, route: undefined });
			}
		};
		switch (e.key) {
			case '/': this.search.focus(); break;
			case 'u': case 'U': reach('upstream'); break;
			case 'd': case 'D': reach('downstream'); break;
			case 'r': case 'R':
				this.picking = !this.picking;
				this.refresh();
				break;
			case 'f': case 'F':
				this.root.classList.toggle('vc-presenting');
				this.frame(true);
				break;
			case 't': case 'T': this.update({ direction: this.state.direction === 'lr' ? 'td' : 'lr' }); break;
			case 'i': case 'I': this.update({ showInactive: !this.state.showInactive }); break;
			case '?': this.help.hidden = !this.help.hidden; break;
			case '+': case '=': this.panZoom.zoomBy(1.3); break;
			case '-': case '_': this.panZoom.zoomBy(1 / 1.3); break;
			case '0': this.fitEverything(); break;
			case 'Enter': case ' ':
				if (!onNode) {
					return;
				}
				this.pick(onNode);
				break;
			case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': this.walk(e.key); break;
			case 'Escape': this.stepBack(); break;
			default: return;
		}
		e.preventDefault();
	}

	private onSearchKey(e: KeyboardEvent): void {
		const shown = Math.min(this.matches.length, MAX_RESULTS);
		if (e.key === 'Escape') {
			this.closeSearch();
			this.refresh();
		} else if (e.key === 'Enter' && shown) {
			this.choose(this.matches[this.selected].id);
		} else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shown) {
			this.selected = (this.selected + (e.key === 'ArrowDown' ? 1 : shown - 1)) % shown;
			this.renderResults();
		} else {
			return;
		}
		e.preventDefault();
	}

	/** Esc undoes one thing at a time, innermost first. */
	private stepBack(): void {
		if (!this.help.hidden) {
			this.help.hidden = true;
		} else if (this.picking) {
			this.picking = false;
			this.refresh();
		} else if (this.root.classList.contains('vc-presenting')) {
			this.root.classList.remove('vc-presenting');
			this.frame(true);
		} else if (this.state.route) {
			this.update({ route: undefined });
		} else if (this.state.focus !== undefined) {
			this.update({ focus: undefined });
		} else if (this.state.lens.length) {
			this.update({ lens: [] });
		}
	}

	/** Arrow keys: along the flow to the nearest predecessor or successor, across it to the layer neighbour. */
	private walk(key: string): void {
		const scene = this.scene;
		const from = this.state.focus !== undefined ? scene?.placed.get(this.state.focus) : undefined;
		if (!scene || !from) {
			const first = scene?.layout.nodes[0];
			if (first) {
				this.focus(first.id);
			}
			return;
		}
		const lr = scene.layout.direction === 'lr';
		const along = lr ? (key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0) : (key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0);
		const across = (box: { x: number; y: number }): number => lr ? box.y : box.x;
		let candidates: string[];
		if (along !== 0) {
			candidates = (along < 0 ? this.index.predecessors : this.index.successors).get(from.id) ?? [];
		} else {
			const step = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
			candidates = scene.layout.nodes.filter(n => n.layer === from.layer && Math.sign(across(n) - across(from)) === step).map(n => n.id);
		}
		const best = candidates.map(id => scene.placed.get(id)).filter(box => box !== undefined)
			.sort((a, b) => Math.abs(across(a) - across(from)) - Math.abs(across(b) - across(from)))[0];
		if (best) {
			this.focus(best.id);
		}
	}

	// --- framing ---------------------------------------------------------------------------------------

	/** The part of the surface that lies under the detail panel. */
	private covered(): Insets {
		const open = !this.panel.hidden && !this.root.classList.contains('vc-presenting');
		const narrow = this.root.clientWidth < NARROW_WIDTH;
		return { top: 0, left: 0, right: open && !narrow ? PANEL_WIDTH : 0, bottom: open && narrow ? this.root.clientHeight * PANEL_SHARE : 0 };
	}

	/** The room a framing keeps free: the toolbar and the legend as high as they are right now, and the detail panel. */
	private insets(): Insets {
		if (this.root.classList.contains('vc-presenting')) {
			return { top: 24, right: 24, bottom: 24, left: 24 };
		}
		// The legend wraps in a narrow view and sits above the detail panel there: measured from its top edge down.
		return {
			top: this.toolbar.offsetTop + this.toolbar.offsetHeight + CHROME_GAP, left: 18, right: 18 + this.covered().right,
			bottom: this.root.clientHeight - this.legend.offsetTop + CHROME_GAP,
		};
	}

	/** A legend that wrapped pushes the hint above it one row up (the view writes no styles, only classes). */
	private measureLegend(): void {
		this.root.classList.toggle('vc-legend-tall', this.legend.offsetHeight > 40);
	}

	private boxOf(ids: Iterable<string>): Box | undefined {
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const id of ids) {
			const box = this.scene?.placed.get(id);
			if (box) {
				x0 = Math.min(x0, box.x);
				y0 = Math.min(y0, box.y);
				x1 = Math.max(x1, box.x + box.w);
				y1 = Math.max(y1, box.y + box.h);
			}
		}
		return Number.isFinite(x0) ? { x: x0 - 30, y: y0 - 30, w: x1 - x0 + 60, h: y1 - y0 + 60 } : undefined;
	}

	/**
	 * Frames what matters right now: the route, else the focused reach, else the whole graph. A subject too
	 * large to read as a whole is not shrunk to fit: the view opens at the legibility floor on the start of the
	 * route, on the focused node, or on the frontier instead (`placeView`). Fit lifts that, and so does a narrow
	 * view, which is an overview by design (status tiles beside the node tree).
	 */
	private frame(animate: boolean): void {
		const scene = this.scene;
		this.frameWhenSized = this.surface.clientWidth <= 50;
		if (!scene || this.frameWhenSized) {
			return;
		}
		const focus = this.state.focus;
		const boxes = (ids: readonly string[]): Box[] => ids.map(id => scene.placed.get(id)).filter(box => box !== undefined);
		let bounds: Box | undefined, anchors: Box[];
		if (this.route) {
			bounds = this.boxOf(this.route.corridor);
			anchors = boxes(this.route.path);
		} else if (focus !== undefined && scene.placed.has(focus)) {
			bounds = this.boxOf([focus, ...(this.state.reach === 'downstream' ? [] : upstream(this.index, focus)), ...(this.state.reach === 'upstream' ? [] : downstream(this.index, focus))]);
			anchors = boxes([focus]);
		} else {
			anchors = pickAnchors([...scene.placed.values()].map(box => {
				const node = this.index.byId.get(box.id)!;
				return { box, layer: box.layer, ready: this.frontier.has(box.id), open: node.active && !node.ghost && node.status !== 'solid' };
			}));
		}
		const everything = this.overview || this.root.clientWidth < NARROW_WIDTH || this.root.classList.contains('vc-presenting');
		this.panZoom.place(placeView({
			bounds: bounds ?? { x: 0, y: 0, w: scene.layout.width, h: scene.layout.height }, viewport: this.panZoom.size, insets: this.insets(),
			anchors, wholeFloor: everything ? 0 : WHOLE_SCALE, floor: LEGIBLE_SCALE, maxScale: 1.1,
		}), animate);
		if (!animate) {
			this.panZoom.flush();
		}
	}

	/** Fit means everything. Pressed again on the untouched overview, it returns to the readable view. */
	private fitEverything(): void {
		this.overview = !(this.overview && !this.panZoom.adjusted);
		this.frame(true);
	}

	// --- overflow hints ----------------------------------------------------------------------------------

	/** Says how many nodes lie beyond each edge of the view; a graph opened at the legibility floor rarely shows all of itself. */
	private renderOverflow(): void {
		const scene = this.scene;
		const counts: Overflow | undefined = scene && countOverflow(scene.placed.values(), { scale: this.panZoom.k, tx: this.panZoom.x, ty: this.panZoom.y }, this.panZoom.size, this.covered());
		for (const side of SIDES) {
			const chip = this.more[side];
			const count = counts?.[side] ?? 0;
			const [prefix, suffix, where] = SIDE_TEXT[side];
			const text = `${prefix}${count}${suffix}`;
			if (count && chip.textContent !== text) {
				chip.textContent = text;
				chip.title = `${count} more node${count === 1 ? '' : 's'} ${where}: click to move there`;
				chip.setAttribute('aria-label', chip.title);
			}
			chip.hidden = count === 0;
		}
	}

	private panTowards(side: typeof SIDES[number]): void {
		const { width, height } = this.panZoom.size;
		const insets = this.insets();
		const stepX = 0.7 * (width - insets.left - insets.right), stepY = 0.7 * (height - insets.top - insets.bottom);
		this.panZoom.panBy(side === 'left' ? stepX : side === 'right' ? -stepX : 0, side === 'top' ? stepY : side === 'bottom' ? -stepY : 0);
		this.root.focus();
	}

	private revealNode(id: string): void {
		const box = this.scene?.placed.get(id);
		if (!box) {
			return;
		}
		if (this.panZoom.scale < 0.5) {
			this.panZoom.fit({ x: box.x - 320, y: box.y - 220, w: box.w + 640, h: box.h + 440 }, this.insets(), 1, true);
		} else {
			this.panZoom.reveal({ x: box.x, y: box.y, w: box.w, h: box.h }, this.insets(), true);
		}
	}
}
