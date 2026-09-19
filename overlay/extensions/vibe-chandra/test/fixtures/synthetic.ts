// SPDX-License-Identifier: MIT

import type { LedgerInput, LedgerRow } from '../../src/model/types.ts';

/** Small deterministic PRNG (mulberry32) so fixtures are identical on every run and in every engine. */
export function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS = ['lemma', 'bound', 'kernel', 'solver', 'mesh', 'gauge', 'flux', 'norm', 'trace', 'limit', 'basis', 'scheme', 'proof', 'check', 'fit', 'model'];

/**
 * A staged workflow of `n` nodes as raw ledger rows: mostly forward dependencies with 0-4 predecessors,
 * a handful of repair loops, promotions as extra rows, and trials with failures. Early stages are solid,
 * late stages are future, so the frontier sits in the middle like in a running mission.
 */
export function stressInput(n: number, seed: number): LedgerInput {
	const rand = prng(seed);
	const pick = (k: number): number => Math.floor(rand() * k);
	const perStage = Math.max(6, Math.round(Math.sqrt(n) * 0.9));
	const stages = Math.ceil(n / perStage);
	const id = (i: number): string => `stress::n${String(i).padStart(3, '0')}-${WORDS[i % WORDS.length]}`;
	const preds: number[][] = [];
	const succs: number[][] = Array.from({ length: n }, () => []);
	for (let i = 0; i < n; i++) {
		const stage = Math.floor(i / perStage);
		const mine: number[] = [];
		if (stage > 0) {
			const r = rand();
			const want = r < 0.08 ? 0 : r < 0.38 ? 1 : r < 0.68 ? 2 : r < 0.86 ? 3 : r < 0.96 ? 4 : 5;
			for (let k = 0; k < want; k++) {
				const back = rand() < 0.8 ? 1 : rand() < 0.7 ? 2 : 3 + pick(3);
				const fromStage = Math.max(0, stage - back);
				const lo = fromStage * perStage;
				const p = lo + pick(Math.min(perStage, n - lo));
				if (p < i && !mine.includes(p)) {
					mine.push(p);
				}
			}
		}
		preds.push(mine);
		for (const p of mine) {
			succs[p].push(i);
		}
	}
	// Repair loops: close a forward path of length 2-3 back onto its start.
	for (let c = 0; c < Math.max(2, Math.floor(n / 80)); c++) {
		let at = pick(n);
		const start = at;
		for (let hop = 0; hop < 2 + pick(2) && succs[at].length; hop++) {
			at = succs[at][pick(succs[at].length)];
		}
		if (at !== start && !preds[start].includes(at)) {
			preds[start].push(at);
		}
	}

	const knowledge: LedgerRow[] = [];
	const error: LedgerRow[] = [];
	let clock = 0;
	const stamp = (): string => new Date(Date.UTC(2026, 0, 1) + (clock++) * 60_000).toISOString();
	for (let i = 0; i < n; i++) {
		const progress = Math.floor(i / perStage) / stages;
		const r = rand();
		const status = progress < 0.4 ? 'solid'
			: progress < 0.55 ? (r < 0.5 ? 'solid' : r < 0.8 ? 'preliminary' : 'hypothesis')
				: progress < 0.75 ? (r < 0.15 ? 'blocking' : r < 0.6 ? 'hypothesis' : 'preliminary')
					: (r < 0.8 ? 'future' : 'hypothesis');
		const ladder = status === 'solid' ? ['hypothesis', 'preliminary', 'solid'] : status === 'preliminary' ? ['hypothesis', 'preliminary'] : [status];
		ladder.forEach((st, seq) => {
			const row: LedgerRow = {
				paper: 'stress', node_id: id(i), task_id: `T${i}`, domain: ['symbolic', 'numerical', 'proof', 'software'][i % 4], status: st,
				summary: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7 + 3) % WORDS.length]} step ${i}`, predecessors: preds[i].map(id),
				timestamp: stamp(), git_commit: (0x1000000 + i * 97 + seq).toString(16).slice(-7), node_seq: seq + 1, row_hash: `k${i}-${seq}`,
			};
			if (st === 'solid') {
				row.evidence = `results/stress/evidence/n${i}.log`;
			}
			knowledge.push(row);
		});
		const attempts = status === 'future' ? 0 : pick(4);
		for (let k = 0; k < attempts; k++) {
			const last = k === attempts - 1;
			const outcome = last && (status === 'solid' || rand() < 0.4) ? 'pass' : ['fail', 'fail', 'crash', 'partial'][pick(4)];
			const row: LedgerRow = {
				paper: 'stress', task_id: `T${i}`, iteration: k + 1, stage: 'implementation', domain: 'software', change_type: 'structural',
				change_summary: `attempt ${k + 1}`, node_id: id(i), metric: { name: 'residual', value: outcome === 'pass' ? 0 : 1, threshold: 0, pass: outcome === 'pass' },
				pass_fail: outcome, wall_clock_seconds: 1 + pick(90), timestamp: stamp(), git_commit: 'abc1234', node_seq: k + 1, row_hash: `t${i}-${k}`,
			};
			if (outcome !== 'pass') {
				Object.assign(row, { expected: 'residual below threshold', observed: 'residual 1.0', root_cause: `cause ${k + 1} for node ${i}`, fix_hypothesis: `restructure step ${i}`, failure_mode: 'logic_error' });
			}
			error.push(row);
		}
	}
	return { knowledge, error, claim: [], result: [] };
}
