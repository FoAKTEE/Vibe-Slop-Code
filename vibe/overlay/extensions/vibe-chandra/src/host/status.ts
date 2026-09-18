// SPDX-License-Identifier: MIT

import type { Hypergraph } from '../model/types.ts';

export interface Summary {
	solid: number;
	/** Active nodes with a ledger row: what the workflow consists of right now. */
	total: number;
	/** The frontier: not solid yet, every predecessor solid. */
	ready: number;
	/** Nodes on screen (active ones and ghosts) whose latest trials failed: what the view's `failing` lens lights. */
	failing: number;
	papers: string[];
	ghosts: number;
	inactive: number;
	cycles: number;
}

export function summarize(graph: Hypergraph): Summary {
	const active = graph.nodes.filter(n => n.active && !n.ghost);
	return {
		solid: active.filter(n => n.status === 'solid').length,
		total: active.length,
		ready: graph.frontier.length,
		failing: graph.nodes.filter(n => (n.active || n.ghost) && n.trialStats.failStreak > 0).length,
		papers: [...graph.papers],
		ghosts: graph.nodes.filter(n => n.ghost).length,
		inactive: graph.nodes.filter(n => !n.active && !n.ghost).length,
		cycles: graph.cycles.sccs.length,
	};
}

const SEP = ' \u00b7 ';

export function statusBarText(summary: Summary): string {
	return `Chandra: ${summary.solid}/${summary.total}${SEP}${summary.ready} ready${SEP}${summary.failing} failing`;
}

export function statusBarTooltip(summary: Summary): string {
	const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
	const papers = summary.papers.length === 0 ? 'no paper' : `${summary.papers.length === 1 ? 'paper' : 'papers'} ${summary.papers.join(' + ')}`;
	const extras = [
		summary.ghosts ? plural(summary.ghosts, 'ghost') : '',
		summary.inactive ? `${summary.inactive} inactive` : '',
		summary.cycles ? plural(summary.cycles, 'cycle') : '',
	].filter(Boolean);
	return [
		`Chandra workflow graph${SEP}${papers}`,
		`${summary.solid} of ${plural(summary.total, 'node')} solid${SEP}${summary.ready} ready to work${SEP}${summary.failing} failing`,
		...(extras.length ? [extras.join(SEP)] : []),
		'Click to open the graph',
	].join('\n');
}
