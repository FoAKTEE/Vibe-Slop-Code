// SPDX-License-Identifier: MIT

import type { GraphIndex, Route } from '../model/derived.ts';
import type { GraphNode, RevisionInfo, TrialInfo } from '../model/types.ts';
import { clear, el, icon } from './dom.ts';
import { glyphIcon, ringIcon } from './glyphs.ts';
import type { OpenTarget } from './host.ts';

export interface PanelContext {
	index: GraphIndex;
	frontier: Set<string>;
	/** The strongly connected component the node belongs to, when it sits on a cycle. */
	cycleOf(id: string): string[] | undefined;
	route?: Route;
	onFocus(id: string): void;
	onOpen(target: OpenTarget): void;
	onClose(): void;
}

const shortTime = (timestamp: string | undefined): string => timestamp ? timestamp.slice(0, 16).replace('T', ' ') : '';

function section(title: string, note?: string): HTMLElement {
	return el('h3', '', title, note ? el('small', '', note) : null);
}

function nodeChip(node: GraphNode | undefined, id: string, ctx: PanelContext): HTMLElement {
	const chip = el('button', `vc-node-chip vc-s-${node?.ghost ? 'ghost vc-ghost' : node?.status ?? 'unknown'}`,
		glyphIcon(node?.status ?? 'unknown', node?.ghost ?? true), el('span', '', node?.label ?? id));
	chip.title = node ? `${id}\n${node.ghost ? 'ghost (no ledger row)' : node.status}${node.summary ? `\n${node.summary}` : ''}` : id;
	chip.addEventListener('click', () => ctx.onFocus(id));
	return chip;
}

function chips(ids: readonly string[], ctx: PanelContext, arrows = false): HTMLElement {
	const box = el('div', 'vc-chips');
	ids.forEach((id, i) => {
		if (arrows && i > 0) {
			box.append(el('span', 'vc-step', '→'));
		}
		box.append(nodeChip(ctx.index.byId.get(id), id, ctx));
	});
	return box;
}

function link(text: string, target: OpenTarget, ctx: PanelContext, mono = true): HTMLElement {
	const button = el('button', `vc-link${mono ? ' vc-mono' : ''}`, text);
	button.title = `Open ${target.kind}`;
	button.addEventListener('click', () => ctx.onOpen(target));
	return button;
}

function trialItem(trial: TrialInfo): HTMLElement {
	const item = el('li', '',
		el('div', 'vc-row',
			el('span', `vc-pill vc-pill-${trial.outcome}`, trial.outcome),
			trial.seq !== undefined ? el('span', 'vc-muted', `#${trial.seq}`) : null,
			trial.stage ? el('span', 'vc-muted', trial.stage) : null,
			el('span', 'vc-when', shortTime(trial.timestamp))));
	const line = (label: string, text: string | undefined): void => {
		if (text) {
			item.append(el('p', 'vc-trial-text', el('b', '', `${label} `), text));
		}
	};
	if (trial.changeSummary) {
		item.append(el('p', 'vc-trial-text', trial.changeSummary));
	}
	if (trial.metric?.name) {
		item.append(el('p', 'vc-trial-text vc-mono vc-muted', `${trial.metric.name} = ${String(trial.metric.value)} (threshold ${String(trial.metric.threshold)})`));
	}
	line('Root cause', trial.rootCause);
	line('Fix hypothesis', trial.fixHypothesis);
	line('Observed', trial.observed);
	return item;
}

function revisionItem(revision: RevisionInfo, target: (commit: string) => OpenTarget, ctx: PanelContext): HTMLElement {
	const item = el('li', '',
		el('div', 'vc-row',
			el('span', `vc-pill vc-s-${revision.status}`, glyphIcon(revision.status), revision.status),
			revision.seq !== undefined ? el('span', 'vc-muted', `#${revision.seq}`) : null,
			revision.gitCommit ? link(revision.gitCommit, target(revision.gitCommit), ctx) : null,
			revision.actorRole ? el('span', 'vc-muted', revision.actorRole) : null,
			el('span', 'vc-when', shortTime(revision.timestamp))));
	if (revision.supersedes) {
		item.append(el('p', 'vc-trial-text vc-muted', `supersedes row ${revision.supersedes.slice(0, 10)}`));
	}
	if (revision.supersededBy) {
		item.append(el('p', 'vc-trial-text vc-muted', `superseded by row ${revision.supersededBy.slice(0, 10)}`));
	}
	if (revision.summary && revision.seq !== 1) {
		item.append(el('p', 'vc-trial-text', revision.summary));
	}
	return item;
}

/** The side panel for the focused node: what it is, what it rests on, what was tried, how it evolved. */
export function renderPanel(container: HTMLElement, node: GraphNode, ctx: PanelContext): void {
	clear(container);
	const target = (kind: OpenTarget['kind'], value: string): OpenTarget => ({ kind, value, nodeId: node.id, paper: node.paper });
	const close = el('button', 'vc-button', icon('M4 4l8 8M12 4l-8 8'));
	close.title = 'Close (Esc)';
	close.setAttribute('aria-label', 'Close details');
	close.addEventListener('click', () => ctx.onClose());
	container.append(el('div', 'vc-panel-head', el('div', 'vc-panel-title', el('h2', '', node.label), el('code', '', node.id)), close));

	const body = el('div', 'vc-panel-body');
	container.append(body);
	const cycle = ctx.cycleOf(node.id);
	const stats = node.trialStats;
	body.append(el('div', 'vc-pills',
		el('span', `vc-pill vc-s-${node.ghost ? 'ghost' : node.status}`, glyphIcon(node.status, node.ghost), node.ghost ? 'ghost · no ledger row' : node.status),
		ctx.frontier.has(node.id) ? el('span', 'vc-pill vc-pill-frontier', ringIcon('vc-ring'), 'ready') : null,
		cycle ? el('span', 'vc-pill vc-pill-loop', cycle.length > 1 ? `on a cycle of ${cycle.length}` : 'self-loop') : null,
		stats.failStreak > 0 ? el('span', 'vc-pill vc-pill-fail', `failing ×${stats.failStreak}`) : null,
		node.conceptAdvance ? el('span', 'vc-pill', '\u25b3 concept advance') : null,
		node.riskTier ? el('span', 'vc-pill', node.riskTier) : null));
	if (node.summary) {
		body.append(el('p', 'vc-summary', node.summary));
	} else if (node.ghost) {
		body.append(el('p', 'vc-summary vc-muted', 'Referenced by other rows, but no loaded knowledge ledger defines it.'));
	}

	const facts = el('dl', 'vc-kv');
	const fact = (label: string, value: Node | string | undefined | null): void => {
		if (value) {
			facts.append(el('dt', '', label), el('dd', '', value));
		}
	};
	fact('Task', node.taskId ? link(node.taskId, target('task', node.taskId), ctx) : null);
	fact('Evidence', node.evidence ? link(node.evidence, target('evidence', node.evidence), ctx) : null);
	fact('Commit', node.gitCommit ? link(node.gitCommit, target('commit', node.gitCommit), ctx) : null);
	fact('Paper', node.paper);
	fact('Domain', node.domain);
	fact('Updated', shortTime(node.timestamp));
	fact('Equations', node.equationLabels?.join(', '));
	if (node.codeBlockRefs?.length) {
		const refs = el('div');
		node.codeBlockRefs.forEach(ref => refs.append(el('div', '', link(ref, target('code', ref), ctx))));
		fact('Code', refs);
	}
	fact('Anchor', node.paperAnchor);
	body.append(facts);

	if (ctx.route) {
		const hops = ctx.route.path.length - 1;
		body.append(section('Route', `${hops} hop${hops === 1 ? '' : 's'}${ctx.route.reversed ? ' · dependency runs the other way' : ''}`), chips(ctx.route.path, ctx, true));
	}

	const predecessors = ctx.index.predecessors.get(node.id) ?? [];
	const successors = ctx.index.successors.get(node.id) ?? [];
	body.append(section('Predecessors', predecessors.length > 1 ? `${predecessors.length} · AND-join` : String(predecessors.length)));
	body.append(predecessors.length ? chips(predecessors, ctx) : el('div', 'vc-muted', 'none — a root of the workflow'));
	body.append(section('Successors', String(successors.length)));
	body.append(successors.length ? chips(successors, ctx) : el('div', 'vc-muted', 'none — nothing depends on this yet'));

	body.append(section('Trials', stats.total ? `${stats.total} · ${stats.pass} pass · ${stats.failed} failed` : '0'));
	if (node.trials.length) {
		const list = el('ul', 'vc-list');
		[...node.trials].reverse().forEach(trial => list.append(trialItem(trial)));
		body.append(list);
	} else {
		body.append(el('div', 'vc-muted', 'no trials recorded under this node'));
	}

	if (node.claims.length || node.results.length) {
		body.append(section('Claims & results', `${node.claims.length + node.results.length}`));
		const list = el('ul', 'vc-list');
		for (const claim of node.claims) {
			list.append(el('li', '', el('div', 'vc-row', el('span', 'vc-pill', `${claim.kind} · ${claim.status}`), el('span', 'vc-mono vc-muted', claim.id)), el('p', 'vc-trial-text', claim.statement)));
		}
		for (const result of node.results) {
			list.append(el('li', '', el('div', 'vc-row', el('span', 'vc-pill', `result · ${result.status}`), el('span', 'vc-mono vc-muted', result.id)), el('p', 'vc-trial-text', result.name)));
		}
		body.append(list);
	}

	if (node.revisions.length) {
		body.append(section('Revision history', String(node.revisions.length)));
		const list = el('ul', 'vc-list');
		[...node.revisions].reverse().forEach(revision => list.append(revisionItem(revision, commit => target('commit', commit), ctx)));
		body.append(list);
	}
	if (node.notes) {
		body.append(section('Notes'), el('p', 'vc-summary', node.notes));
	}
}
