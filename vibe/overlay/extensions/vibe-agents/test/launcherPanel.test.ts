// SPDX-License-Identifier: MIT

// What the two webviews of ChatGPT Web get, for every scenario of the stand-in runtime: the controller runs on the
// bench (real processes, every seam a stand-in), and what it learns is turned into the panel and the compact layout.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_OPERATIONS, PANEL_COMMANDS, SCREEN_IDS, compactModelOf, panelModelOf, parseOutbound, type CompactModel, type ItemView, type PanelInput, type PanelModel } from '../src/model/launcher/panel.ts';
import { OPERATIONS, operationOf } from '../src/model/launcher/operations.ts';
import { bench, type Bench } from './fakes/bench.ts';

const inputOf = (b: Bench, result?: PanelInput['result']): PanelInput => ({ view: b.controller.snapshot.view, running: b.controller.snapshot.running, queued: b.controller.snapshot.queued, result });
const offered = (item: ItemView | undefined) => item?.operations.map(operation => `${operation.primary ? '*' : ''}${operation.id}${operation.enabled ? '' : '!'}${operation.confirm ? '?' : ''}`);

async function layouts(t: TestContext, scenario: string, options: Parameters<typeof bench>[2] = {}, prepare?: (b: Bench) => Promise<unknown>): Promise<{ panel: PanelModel; compact: CompactModel; b: Bench }> {
	const b = await bench(t, scenario, options);
	await b.controller.refresh('open');
	await prepare?.(b);
	return { panel: panelModelOf(inputOf(b)), compact: compactModelOf(inputOf(b)), b };
}

test('not set up: the compact view names the step to take now, the panel counts the checklist', async t => {
	const { panel, compact } = await layouts(t, 'not-set-up', { daemon: false, routed: false });
	assert.deepEqual([panel.state, panel.headline, panel.severity, panel.busy, panel.result], ['not-set-up', 'ChatGPT Web models not installed', 'off', undefined, undefined]);
	assert.deepEqual(panel.rail.map(entry => [entry.id, entry.title, entry.severity, entry.count]), [
		['overview', 'Overview', 'off', undefined], ['setup', 'Setup', 'off', '3/8'], ['models', 'Models', 'off', undefined], ['bridge', 'Bridge', 'off', undefined], ['engine', 'Engine', 'off', undefined],
		['subagents', 'Subagents', 'off', undefined], ['mcp', 'Full Harness (MCP)', 'off', undefined], ['doctor', 'Doctor', 'off', undefined], ['activity', 'Activity', 'off', '3'],
	]);
	assert.deepEqual(panel.rail.map(entry => entry.id), SCREEN_IDS);
	assert.deepEqual(panel.screens.find(screen => screen.id === 'setup')!.items.map(item => [item.id, item.step, item.next, offered(item)]), [
		['step.launcher', 'done', false, []], ['step.runtime', 'done', false, []], ['step.engine', 'done', false, []],
		['step.signIn', 'handoff', true, ['*handoff.signIn']], ['step.smokeTest', 'handoff', false, ['handoff.smokeTest']], ['step.installModels', 'handoff', false, ['handoff.installModels']],
		['step.connect', 'todo', false, []], ['step.restartCodex', 'unknown', false, []], ['step.fullHarness', 'handoff', false, ['handoff.mcpConnect']],
	], 'one filled button: the step to take now');

	assert.deepEqual([compact.layout, compact.headline, compact.attention, compact.nextStep?.id, offered(compact.nextStep), offered(compact.bridge), offered(compact.engine)],
		['compact', 'ChatGPT Web models not installed', undefined, 'step.signIn', ['*handoff.signIn'], ['bridge.connect!?'], ['engine.showWindow', 'engine.quit?']]);
	assert.deepEqual([compact.nextStep?.operations[0].hint, compact.nextStep?.operations[0].why], ['Setup > 1 Sign in to ChatGPT > Open sign in (or Browser > Use passkey)', 'The ChatGPT page and your sign-in live in the launcher, so this step is taken in its window.']);
	assert.match(compact.bridge.operations[0].disabledReason ?? '', /Install models did not run yet/);
});

test('ready: quiet; the bridge offers Pause, the engine Show and Quit, nothing is filled', async t => {
	const { panel, compact } = await layouts(t, 'ready-browser-only');
	assert.deepEqual([panel.state, panel.severity, panel.rail.find(entry => entry.id === 'setup')?.count, compact.attention, compact.nextStep], ['ready-browser-only', 'ok', '7/8', undefined, undefined]);
	assert.deepEqual([compact.bridge.text, offered(compact.bridge), compact.engine.text, offered(compact.engine)], ['connected: all Codex traffic goes through the launcher', ['bridge.pause?'], 'running', ['engine.showWindow', 'engine.quit?']]);
	assert.ok(panel.screens.flatMap(screen => screen.items).flatMap(item => item.operations).every(operation => !operation.primary));

	// every button that is no probe and no link says what it does, beside it, and a hand-off says where and why
	for (const operation of panel.screens.flatMap(screen => screen.items).flatMap(item => item.operations)) {
		const kind = operationOf(operation.id).kind;
		assert.ok(kind === 'probe' || operation.id.startsWith('link.') || operation.consequence.length > 40, operation.id);
		assert.ok(kind !== 'handoff' || ((operation.hint ?? '').length > 10 && (operation.why ?? '').length > 40), operation.id);
	}
});

test('route installed and launcher closed: the one state that asks for attention, with Pause Bridge as the way out, shown once', async t => {
	const { panel, compact } = await layouts(t, 'route-dead', { daemon: false, launcher: 'stopped' });
	assert.deepEqual([panel.state, panel.severity, panel.rail.filter(entry => entry.severity === 'warning').map(entry => entry.id)], ['route-dead', 'warning', ['overview', 'bridge', 'engine']]);
	assert.deepEqual(offered(panel.screens[0].items[0]), ['*bridge.pause?', 'engine.startHidden?', 'engine.showWindow?']);
	assert.deepEqual([compact.attention?.id, compact.attention?.severity, offered(compact.attention), compact.nextStep, offered(compact.bridge), offered(compact.engine)],
		['state', 'warning', ['*bridge.pause?', 'engine.startHidden?', 'engine.showWindow?'], undefined, [], []], 'the rows below keep their text; what they would offer is offered above');
	assert.match(compact.attention?.detail ?? '', /every Codex run on this machine fails/);
});

test('paused, draining, full harness with doctor warnings', async t => {
	const paused = await layouts(t, 'ready-browser-only', {}, b => b.controller.request('bridge.pause', { confirmed: true }).done);
	assert.deepEqual([paused.panel.state, paused.compact.nextStep?.id, offered(paused.compact.nextStep), offered(paused.compact.bridge)], ['paused', 'step.connect', ['*bridge.connect?'], []]);

	const draining = await layouts(t, 'draining');
	assert.deepEqual([draining.panel.state, draining.panel.headline, draining.compact.nextStep], ['draining', 'ChatGPT Web launcher busy with setup or an update', undefined]);

	const full = await layouts(t, 'doctor-with-warnings', {}, b => b.controller.request('doctor.run').done);
	assert.deepEqual([full.panel.state, full.panel.rail.find(entry => entry.id === 'setup')?.count, full.panel.rail.find(entry => entry.id === 'doctor')?.severity], ['ready-full', '8/8', 'off']);
	assert.deepEqual(full.panel.screens.find(screen => screen.id === 'doctor')!.items.filter(item => item.severity === 'info').map(item => item.id), ['doctor.check.service', 'doctor.check.connector'], 'a warning of the doctor is information');
	assert.equal(full.panel.screens.find(screen => screen.id === 'setup')!.items.find(item => item.id === 'step.signIn')?.step, 'done');
});

test('what runs and what waits shows on its button and at the top; Cancel only where it is allowed', async t => {
	const b = await bench(t, 'slow', { env: { FAKE_CGW_SLOW_MS: '400' } });
	await b.controller.refresh('interval');
	const version = b.controller.request('probe.routeStatus');
	const doctor = b.controller.request('doctor.run');
	const pause = b.controller.request('bridge.pause', { confirmed: true });
	await new Promise(resolve => setTimeout(resolve, 50));

	let panel = panelModelOf(inputOf(b));
	assert.deepEqual([panel.busy?.label, panel.busy?.cancelTicket, panel.busy?.queued], ['Ask for the Route Status', version.ticket, 2], 'what only reads can be ended');
	const button = (model: PanelModel, id: string) => model.screens.flatMap(screen => screen.items).flatMap(item => item.operations).filter(operation => operation.id === id).map(operation => [operation.busy, operation.cancelTicket])[0];
	assert.deepEqual([button(panel, 'doctor.run'), button(panel, 'bridge.pause')], [['queued', doctor.ticket], ['queued', pause.ticket]], 'what waits can be taken out of the queue');
	await version.done;
	b.controller.cancel(doctor.ticket);
	await new Promise(resolve => setTimeout(resolve, 100));
	panel = panelModelOf(inputOf(b));
	assert.deepEqual([panel.busy?.label, panel.busy?.cancelTicket, button(panel, 'bridge.pause')], ['Pause Bridge', undefined, ['running', undefined]], 'what writes the config of Codex is left to finish');
	await pause.done;
});

test('the result line: one quiet sentence, the step of a hand-off with it, and never a question', () => {
	const view = { bridge: 'ready-browser-only', headline: 'h', attention: undefined, screens: [{ id: 'overview', title: 'Overview', summary: '', severity: 'off', items: [{ id: 'state', label: 'ChatGPT Web', text: '', detail: undefined, severity: 'ok', step: undefined, next: false, at: undefined, operations: [] }] }] } as unknown as PanelInput['view'];
	const result = (patch: NonNullable<PanelInput['result']>) => panelModelOf({ view, running: undefined, queued: [], result: patch }).result;
	assert.deepEqual(result({ operation: 'bridge.pause', status: 'ok', message: 'The bridge is paused: Codex is on its previous route. Restart Codex.', hint: undefined }), { status: 'ok', text: 'Pause Bridge: The bridge is paused: Codex is on its previous route. Restart Codex.' });
	assert.deepEqual(result({ operation: 'handoff.signIn', status: 'ok', message: 'The window of the launcher is shown.', hint: 'Setup > 1 Sign in' }), { status: 'ok', text: 'Show Launcher Window: The window of the launcher is shown. In the launcher: Setup > 1 Sign in.' });
	assert.deepEqual(result({ operation: 'link.project', status: 'ok', message: '', hint: undefined }), { status: 'ok', text: 'Open Project Page: Done.' });
	assert.deepEqual(result({ operation: 'engine.quit', status: 'cancelled', message: 'Not confirmed: nothing ran.', hint: undefined }), { status: 'cancelled', text: 'Quit Engine: Not confirmed: nothing ran.' });
	assert.equal(result({ operation: 'engine.quit', status: 'needs-confirmation', message: 'x', hint: undefined }), undefined);
});

test('nothing of this machine and nothing a program wrote is in what a webview gets', async t => {
	for (const scenario of ['crash', 'garbage-output', 'oversized', 'not-set-up']) {
		const b = await bench(t, scenario, scenario === 'not-set-up' ? { daemon: false, routed: false } : {});
		await b.controller.refresh('open');
		const outcome = await b.controller.request('doctor.run').done;
		await b.controller.request('models.refresh').done;
		const result = { operation: outcome.operation, status: outcome.status, message: outcome.message, hint: outcome.hint };
		for (const message of [{ type: 'state', model: panelModelOf(inputOf(b, result)) }, { type: 'state', model: compactModelOf(inputOf(b, result)) }]) {
			const serialized = JSON.stringify(message);
			assert.ok(!serialized.includes(b.dir) && !serialized.includes(import.meta.dirname) && !/\/Users\/|\/private\/|\/var\/folders|AbCdEf|PROMPT|cli\.js|xxxxxxxx|"stdout"|"stderr"/.test(serialized), `${scenario}: ${serialized.match(/.{60}(\/Users\/|\/private\/|AbCdEf|PROMPT|xxxxxxxx).{60}/)?.[0]}`);
		}
	}
});

test('commands: each is one operation of the catalogue; messages of a webview: an operation, a ticket, a screen, and nothing else', () => {
	assert.deepEqual(COMMAND_OPERATIONS, {
		'vibeAgents.chatgptWeb.connectBridge': 'bridge.connect', 'vibeAgents.chatgptWeb.pauseBridge': 'bridge.pause', 'vibeAgents.chatgptWeb.startEngine': 'engine.startHidden', 'vibeAgents.chatgptWeb.showLauncher': 'engine.showWindow',
		'vibeAgents.chatgptWeb.quitEngine': 'engine.quit', 'vibeAgents.chatgptWeb.runDoctor': 'doctor.run', 'vibeAgents.chatgptWeb.cancelTurns': 'turns.cancel',
	});
	assert.ok(Object.values(COMMAND_OPERATIONS).every(id => OPERATIONS.some(operation => operation.id === id)));
	assert.deepEqual(PANEL_COMMANDS, { openPanel: 'vibeAgents.chatgptWeb.openPanel', refresh: 'vibeAgents.chatgptWeb.refresh' });

	assert.deepEqual([parseOutbound({ type: 'ready' }), parseOutbound({ type: 'refresh', extra: 1 }), parseOutbound({ type: 'run', id: 'bridge.pause', confirmed: true }), parseOutbound({ type: 'cancel', ticket: 3 }), parseOutbound({ type: 'openPanel', screen: 'setup' }), parseOutbound({ type: 'openPanel' })],
		[{ type: 'ready' }, { type: 'refresh' }, { type: 'run', id: 'bridge.pause' }, { type: 'cancel', ticket: 3 }, { type: 'openPanel', screen: 'setup' }, { type: 'openPanel', screen: undefined }], 'a webview cannot say that something was confirmed');
	for (const hostile of [undefined, null, 'run', 42, [], {}, { type: 'run' }, { type: 'run', id: 'engine.kill' }, { type: 'run', id: 'setup' }, { type: 'run', id: ['bridge.pause'] }, { type: 'cancel', ticket: '3' }, { type: 'cancel', ticket: -1 }, { type: 'cancel', ticket: 1.5 }, { type: 'openPanel', screen: '../x' }, { type: 'exec', command: 'rm' }, { type: 'confirmed', id: 'bridge.pause' }]) {
		assert.equal(parseOutbound(hostile), undefined, JSON.stringify(hostile));
	}
});
