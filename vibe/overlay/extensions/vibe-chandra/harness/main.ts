// SPDX-License-Identifier: MIT

import { foldLedgers, parseJsonl, type Hypergraph, type LedgerInput } from '../src/model/index.ts';
import { mount, type Host, type HostInbound } from '../src/view/index.ts';
import { stressInput } from '../test/fixtures/synthetic.ts';
import selfNodes from '../test/fixtures/paper_self/nodes.jsonl';
import selfTrials from '../test/fixtures/paper_self/trials.jsonl';
import selfClaims from '../test/fixtures/paper_self/entries.jsonl';
import vibeNodes from '../test/fixtures/paper_vibe/nodes.jsonl';
import synthNodes from '../test/fixtures/paper_synth/nodes.jsonl';
import synthTrials from '../test/fixtures/paper_synth/trials.jsonl';
import synthClaims from '../test/fixtures/paper_synth/entries.jsonl';
import synthResults from '../test/fixtures/paper_synth/results.jsonl';

function ledgers(knowledge: string, error = '', claim = '', result = ''): LedgerInput {
	return { knowledge: parseJsonl(knowledge).rows, error: parseJsonl(error).rows, claim: parseJsonl(claim).rows, result: parseJsonl(result).rows };
}

const params = new URLSearchParams(location.search);
const self = (): LedgerInput => ledgers(selfNodes, selfTrials, selfClaims);
const vibe = (): LedgerInput => ledgers(vibeNodes);
const cyclic = (): LedgerInput => ledgers(synthNodes, synthTrials, synthClaims, synthResults);

const fixtures: Record<string, () => Hypergraph> = {
	self: () => foldLedgers(self()),
	vibe: () => foldLedgers(vibe()),
	cyclic: () => foldLedgers(cyclic()),
	all: () => foldLedgers([self(), vibe(), cyclic()]),
	stress: () => foldLedgers(stressInput(Number(params.get('n')) || 500, 7)),
	empty: () => foldLedgers({ knowledge: [] }),
};

const root = document.getElementById('graph')!;
const theme = params.get('theme');
if (theme === 'light' || theme === 'dark') {
	root.dataset.theme = theme;
}

// The stub host: answers `ready` with the chosen fixture and logs what the view asks the editor to open.
let deliver: (message: HostInbound) => void = () => { };
const host: Host = {
	onData: callback => deliver = callback,
	post: message => {
		console.log('[view → host]', JSON.stringify(message));
		if (message.type === 'ready') {
			const t0 = performance.now();
			const graph = (fixtures[params.get('fixture') ?? 'self'] ?? fixtures.self)();
			deliver({ type: 'graph', graph });
			console.log(`[harness] ${graph.nodes.length} nodes folded, laid out and drawn in ${(performance.now() - t0).toFixed(1)} ms`);
		}
	},
};
mount(root, host);
root.focus();

// Scripted input for screenshots and smoke checks: ?do=click:<id>,key:r,type:<text>,click:<id> …
const press = (target: Element, key: string): boolean => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
for (const step of (params.get('do') ?? '').split(',').filter(Boolean)) {
	const [verb, ...rest] = step.split(':');
	const value = rest.join(':');
	const input = root.querySelector<HTMLInputElement>('.vc-search')!;
	if (verb === 'click') {
		[...root.querySelectorAll('.vc-node')].find(node => node.getAttribute('data-id') === value)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	} else if (verb === 'key') {
		press(document.activeElement === input ? input : root, value);
	} else if (verb === 'type') {
		input.focus();
		input.value = value;
		input.dispatchEvent(new Event('input'));
	} else if (verb === 'lens') {
		root.querySelector<HTMLElement>(`.vc-chip.vc-s-${value}`)?.click();
	}
}
// Lets `chrome --dump-dom` read back where the scripted input ended up.
document.documentElement.dataset.hash = location.hash;
