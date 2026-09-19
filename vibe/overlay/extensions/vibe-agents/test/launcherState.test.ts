// SPDX-License-Identifier: MIT

// What the panel shows, for every state the engine can be observed in. The facts are made up here: nothing is run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityLog } from '../src/model/launcher/activity.ts';
import { emptyFacts, failed, type LauncherFacts } from '../src/model/launcher/facts.ts';
import { parseDoctor, type DoctorReport, type EngineHealth, type RouteStatus } from '../src/model/launcher/runtime.ts';
import { deriveViewState, type LauncherViewState, type ScreenId, type ViewItem } from '../src/model/launcher/state.ts';

const NOW = 1_000_000_000;
const HEALTH: EngineHealth = { mode: 'browser-only', acceptingTurns: true, activeBrowserTurns: 0, version: '5.0.8', activeHttpTurns: 0, catalogRequests: 2, catalogVerified: true, uptimeSeconds: 3700 };
const ROUTE: RouteStatus = { kind: 'route-status', installed: true, active: true, port: 17841, errors: [], extra: {} };
const RUNTIME = { found: true, source: 'versions' as const, version: '5.0.8' };
const doctorOf = (report: object) => parseDoctor(JSON.stringify(report)) as DoctorReport;

const base: LauncherFacts = { ...emptyFacts('darwin'), appInstalled: true, launcherRunning: true, runtime: RUNTIME };
const SCENARIOS = {
	notInstalled: { ...emptyFacts('darwin'), appInstalled: false },
	/** The machine this was written on: the launcher is open, Install models never ran. */
	notSetUp: {
		...base, route: { ...ROUTE, installed: false, active: false, port: undefined }, subagents: failed('exit', 'Configuration is missing: ~/.codex-chatgpt-web/config.json. Run codex-chatgpt-web setup first.', 1),
		doctor: doctorOf({ ok: false, checks: [{ id: 'config', status: 'error', message: 'Configuration is invalid', detail: 'Configuration is missing: /Users/someone/.codex-chatgpt-web/config.json. Run codex-chatgpt-web setup first.' }] }), doctorAt: NOW - 120_000,
	},
	launcherClosed: { ...base, launcherRunning: false, route: { ...ROUTE, installed: false, active: false, port: undefined } },
	readyBrowserOnly: { ...base, configRoute: { kind: 'launcher', port: 17841 }, health: HEALTH, route: ROUTE, subagents: { kind: 'subagents-status', protocol: 'compatibility-v1', installed: true, active: true, extra: {} } },
	readyFull: {
		...base, configRoute: { kind: 'launcher', port: 17841 }, health: { ...HEALTH, mode: 'full' }, route: ROUTE, doctorAt: NOW - 30_000,
		doctor: doctorOf({
			ok: true, mode: 'full', checks: [
				{ id: 'config', status: 'ok', message: 'Configuration is valid' }, { id: 'browser-host', status: 'ok', message: 'Embedded launcher browser is authenticated and reachable (pid 1)' },
				{ id: 'service', status: 'warning', message: 'A leftover launchd service is installed' }, { id: 'tunnel-runtime', status: 'ok', message: 'Tunnel runtime reports healthy and ready' },
				{ id: 'connector', status: 'warning', message: 'Local checks cannot prove that ChatGPT connector "Codex Native2" is attached to this tunnel' },
			],
		}),
	},
	routeDead: { ...base, launcherRunning: false, configRoute: { kind: 'launcher', port: 17841 }, healthError: 'unreachable', route: ROUTE },
	draining: { ...base, configRoute: { kind: 'launcher', port: 17841 }, health: { ...HEALTH, acceptingTurns: false }, route: ROUTE },
	busy: { ...base, configRoute: { kind: 'launcher', port: 17841 }, health: { ...HEALTH, activeBrowserTurns: 1, activeHttpTurns: 1 }, route: ROUTE },
	paused: { ...base, health: HEALTH, route: { ...ROUTE, active: false } },
	pausedClosed: { ...base, launcherRunning: false, route: { ...ROUTE, active: false } },
	foreign: { ...base, configRoute: { kind: 'foreign' }, route: { ...ROUTE, errors: ['Codex openai_base_url no longer matches this installation'] } },
	noRuntime: { ...base, configRoute: { kind: 'launcher', port: 17841 }, health: HEALTH, runtime: { found: false, source: undefined, version: undefined } },
	restartCodex: { ...base, configRoute: { kind: 'launcher', port: 17841 }, health: { ...HEALTH, catalogRequests: 0, catalogVerified: false }, route: ROUTE },
	brokenRuntime: { ...base, configRoute: { kind: 'launcher', port: 17841 }, health: HEALTH, route: failed('unparseable', 'Segmentation fault in ~/.codex-chatgpt-web'), subagents: failed('timeout'), doctor: failed('exit', 'panic', 134), models: failed('overflow') },
	linux: { ...base, platform: 'linux', appInstalled: undefined, launcherRunning: undefined, configRoute: { kind: 'launcher', port: 17841 }, health: HEALTH, route: ROUTE },
} satisfies Record<string, LauncherFacts>;

type Scenario = keyof typeof SCENARIOS;
const view = (scenario: Scenario): LauncherViewState => deriveViewState({ facts: SCENARIOS[scenario], activity: [], selectedModel: undefined, now: NOW });
const itemOf = (state: LauncherViewState, screen: ScreenId, id: string): ViewItem => {
	const found = state.screens.find(candidate => candidate.id === screen)?.items.find(candidate => candidate.id === id);
	assert.ok(found, `${screen}/${id}`);
	return found;
};
const offered = (item: ViewItem) => item.operations.filter(operation => operation.enabled).map(operation => operation.confirm ? `${operation.id}?` : operation.id);
const stepsOf = (state: LauncherViewState) => state.screens.find(screen => screen.id === 'setup')!.items.map(item => item.step);

test('the screens, in the order of the launcher, then what Vibe adds', () => {
	const state = view('readyBrowserOnly');
	assert.deepEqual(state.screens.map(screen => [screen.id, screen.title]), [
		['overview', 'Overview'], ['setup', 'Setup'], ['models', 'Models'], ['bridge', 'Bridge'], ['engine', 'Engine'], ['subagents', 'Subagents'], ['mcp', 'Full Harness (MCP)'], ['doctor', 'Doctor'], ['activity', 'Activity'],
	]);
	const ids = state.screens.flatMap(screen => screen.items.map(item => `${screen.id}/${item.id}`));
	assert.equal(new Set(ids).size, ids.length, 'an item is found by its screen and its id');
});

test('every state: what it is called, and which one asks for attention', () => {
	assert.deepEqual(Object.fromEntries((Object.keys(SCENARIOS) as Scenario[]).map(scenario => [scenario, [view(scenario).bridge, view(scenario).headline, view(scenario).attention?.id]])), {
		notInstalled: ['not-installed', 'ChatGPT Web not installed', undefined],
		notSetUp: ['not-set-up', 'ChatGPT Web models not installed', undefined],
		launcherClosed: ['launcher-closed', 'ChatGPT Web launcher not running', undefined],
		readyBrowserOnly: ['ready-browser-only', 'ChatGPT Web ready \u00b7 browser-only', undefined],
		readyFull: ['ready-full', 'ChatGPT Web ready \u00b7 full harness', undefined],
		routeDead: ['route-dead', 'ChatGPT Web launcher not running: every Codex run fails', 'state'],
		draining: ['draining', 'ChatGPT Web launcher busy with setup or an update', undefined],
		busy: ['busy', 'ChatGPT Web busy \u00b7 1/5 turns \u00b7 browser-only', undefined],
		paused: ['paused', 'ChatGPT Web bridge paused', undefined],
		pausedClosed: ['paused', 'ChatGPT Web bridge paused, launcher not running', undefined],
		foreign: ['foreign-route', 'ChatGPT Web Codex is routed elsewhere', undefined],
		noRuntime: ['ready-browser-only', 'ChatGPT Web ready \u00b7 browser-only', undefined],
		restartCodex: ['ready-browser-only', 'ChatGPT Web ready \u00b7 browser-only', undefined],
		brokenRuntime: ['ready-browser-only', 'ChatGPT Web ready \u00b7 browser-only', undefined],
		linux: ['ready-browser-only', 'ChatGPT Web ready \u00b7 browser-only', undefined],
	});

	// `warning` is that one state and nothing else, wherever it shows
	for (const scenario of Object.keys(SCENARIOS) as Scenario[]) {
		const warnings = view(scenario).screens.flatMap(screen => screen.items.filter(item => item.severity === 'warning').map(item => `${screen.id}/${item.id}`));
		assert.deepEqual(warnings, scenario === 'routeDead' ? ['overview/state', 'bridge/route', 'engine/process'] : [], scenario);
		assert.deepEqual(view(scenario).screens.filter(screen => screen.severity === 'warning').map(screen => screen.id), scenario === 'routeDead' ? ['overview', 'bridge', 'engine'] : [], scenario);
	}
});

test('route installed and launcher closed: every Codex run fails, and the way out is native', () => {
	const state = view('routeDead');
	const attention = state.attention!;
	assert.equal(attention.severity, 'warning');
	assert.match(attention.detail ?? '', /Codex is routed to 127\.0\.0\.1:17841 but the Codex Web GPT launcher is not running\. Until it is started, every Codex run on this machine fails, not only ChatGPT Web\..*pause the bridge.*restores the previous route of Codex without the launcher\.$/);
	assert.deepEqual(offered(attention), ['bridge.pause?', 'engine.startHidden?', 'engine.showWindow?'], 'each asks first: the first rewrites the config of Codex, the others start the engine');
	assert.deepEqual(offered(itemOf(state, 'bridge', 'route')), ['bridge.pause?']);
	assert.deepEqual(offered(itemOf(state, 'doctor', 'doctor.summary')), ['doctor.run'], 'the doctor runs without the launcher, and says what is missing');
	assert.deepEqual(offered(itemOf(state, 'models', 'models.catalog')), [], 'Codex cannot fetch a catalog through a dead route');
	assert.deepEqual(stepsOf(state), ['done', 'done', 'todo', 'unknown', 'done', 'done', 'done', 'unknown', 'handoff']);
	assert.deepEqual(state.screens.find(screen => screen.id === 'setup')!.items.filter(item => item.next).map(item => [item.id, offered(item)]), [['step.engine', ['engine.startHidden?']]]);
});

test('setup: a checklist from nothing to ready; every row has its state and at most one next action, and one row is the step to take now', () => {
	const rows = (scenario: Scenario) => view(scenario).screens.find(screen => screen.id === 'setup')!.items;
	assert.deepEqual(rows('readyBrowserOnly').map(item => item.id), ['step.launcher', 'step.runtime', 'step.engine', 'step.signIn', 'step.smokeTest', 'step.installModels', 'step.connect', 'step.restartCodex', 'step.fullHarness']);
	assert.deepEqual(Object.fromEntries((['notInstalled', 'notSetUp', 'launcherClosed', 'readyBrowserOnly', 'readyFull', 'paused', 'restartCodex', 'foreign', 'linux'] as Scenario[]).map(scenario => [scenario, [stepsOf(view(scenario)).join(' '), rows(scenario).filter(item => item.next).map(item => item.id).join()]])), {
		notInstalled: ['todo todo unknown handoff handoff handoff todo unknown handoff', 'step.launcher'],
		notSetUp: ['done done done handoff handoff handoff todo unknown handoff', 'step.signIn'],
		launcherClosed: ['done done todo handoff handoff handoff todo unknown handoff', 'step.engine'],
		readyBrowserOnly: ['done done done unknown done done done done handoff', ''],
		readyFull: ['done done done done done done done done done', ''],
		paused: ['done done done unknown done done todo done handoff', 'step.connect'],
		restartCodex: ['done done done unknown done done done todo handoff', 'step.restartCodex'],
		foreign: ['done done done unknown done done todo unknown handoff', 'step.connect'],
		linux: ['unknown done unknown unknown done done done done handoff', ''],
	}, 'what only the launcher knows does not hold the list up, and what is optional is never the next step');
	for (const scenario of Object.keys(SCENARIOS) as Scenario[]) {
		assert.ok(rows(scenario).every(item => item.operations.length <= 1 && (item.step !== 'done' || item.operations.length === 0)), `${scenario}: one next action, none when done`);
	}

	const notSetUp = view('notSetUp');
	assert.deepEqual(itemOf(notSetUp, 'setup', 'step.signIn').operations.map(operation => [operation.id, operation.kind, operation.enabled, operation.confirm, operation.hint, operation.why]), [
		['handoff.signIn', 'handoff', true, false, 'Setup > 1 Sign in to ChatGPT > Open sign in (or Browser > Use passkey)', 'The ChatGPT page and your sign-in live in the launcher, so this step is taken in its window.'],
	]);
	assert.deepEqual(itemOf(notSetUp, 'setup', 'step.smokeTest').operations.map(operation => [operation.id, operation.hint, /ONE real message/.test(operation.consequence)]), [['handoff.smokeTest', 'Setup > 2 Run browser smoke test > Run smoke test', true]]);
	assert.deepEqual(itemOf(notSetUp, 'setup', 'step.installModels').operations.map(operation => [operation.id, operation.hint, /ALL Codex traffic/.test(operation.consequence)]), [['handoff.installModels', 'Setup > 3 Install into Codex > Install models (Reinstall when it ran before), then fully quit and reopen Codex', true]]);
	assert.deepEqual(offered(itemOf(notSetUp, 'overview', 'state')), ['handoff.signIn'], 'the overview offers the step the checklist names');
	assert.deepEqual(offered(itemOf(view('launcherClosed'), 'overview', 'state')), ['engine.startHidden?'], 'starting the engine asks first');
	assert.deepEqual(offered(itemOf(view('foreign'), 'overview', 'state')), ['handoff.installModels']);

	// what only the launcher knows is asked natively, by the doctor
	assert.deepEqual([itemOf(view('readyBrowserOnly'), 'setup', 'step.signIn').text, offered(itemOf(view('readyBrowserOnly'), 'setup', 'step.signIn'))], ['known to the launcher only', ['doctor.run']]);
	assert.match(itemOf(view('readyFull'), 'setup', 'step.signIn').detail ?? '', /The doctor reached the ChatGPT page of the launcher just now/);
	const later = deriveViewState({ facts: SCENARIOS.readyFull, activity: [], selectedModel: undefined, now: NOW + 3_600_000 });
	assert.deepEqual([itemOf(later, 'setup', 'step.signIn').step, offered(itemOf(later, 'setup', 'step.signIn'))], ['unknown', ['doctor.run']], 'a sign-in expires: what the doctor saw an hour ago is not known now');
	assert.deepEqual([itemOf(view('restartCodex'), 'setup', 'step.restartCodex').text, itemOf(view('restartCodex'), 'overview', 'catalog').text], ['fully quit and reopen Codex', 'restart Codex once']);
	assert.deepEqual([offered(itemOf(view('paused'), 'setup', 'step.connect')), itemOf(view('foreign'), 'setup', 'step.connect').operations.map(operation => operation.enabled)], [['bridge.connect?'], [false]]);
	assert.deepEqual(itemOf(view('readyBrowserOnly'), 'bridge', 'reinstall').operations.map(operation => operation.id), ['handoff.installModels'], 'Reinstall stays reachable, where the route is');

	const notInstalled = view('notInstalled');
	assert.deepEqual(offered(itemOf(notInstalled, 'setup', 'step.launcher')), ['link.project']);
	assert.deepEqual(itemOf(notInstalled, 'setup', 'step.installModels').operations.map(operation => [operation.enabled, operation.disabledReason]), [[false, 'The Codex Web GPT launcher is not installed on this machine.']]);
	assert.match(itemOf(view('readyBrowserOnly'), 'overview', 'notice').detail ?? '', /not affiliated with or endorsed by OpenAI.*terms of OpenAI and the policy of your workspace apply.*Prompts reach OpenAI even in Temporary Chat/s);
});

test('bridge and engine: what is offered follows the state', () => {
	const operations = (scenario: Scenario) => [itemOf(view(scenario), 'bridge', 'route'), itemOf(view(scenario), 'engine', 'process'), itemOf(view(scenario), 'bridge', 'turns')].map(item => item.operations.map(operation => `${operation.id}${operation.enabled ? '' : '!'}${operation.confirm ? '?' : ''}`));
	assert.deepEqual(operations('readyBrowserOnly'), [['bridge.pause?'], ['engine.showWindow', 'engine.quit?'], []], 'one direction at a time, and only what the state of the engine allows');
	assert.deepEqual(operations('paused'), [['bridge.connect?'], ['engine.showWindow', 'engine.quit?'], []]);
	assert.deepEqual(operations('pausedClosed'), [['bridge.connect!?'], ['engine.startHidden?', 'engine.showWindow?'], []], 'no daemon: connecting would route Codex to a dead port, and the button says so');
	assert.deepEqual(operations('busy'), [['bridge.pause?'], ['engine.showWindow', 'engine.quit?'], ['turns.cancel?']]);
	assert.deepEqual(operations('noRuntime'), [['bridge.pause!?'], ['engine.showWindow', 'engine.quit?'], []]);
	assert.deepEqual(operations('linux'), [['bridge.pause?'], ['engine.startHidden!?', 'engine.showWindow!?', 'engine.quit!?'], []], 'the app is started and stopped through macOS only');
	assert.deepEqual(operations('foreign')[0], ['bridge.connect!?'], 'the route of another program is not written over');
	assert.match(itemOf(view('pausedClosed'), 'bridge', 'route').operations[0].disabledReason ?? '', /a port nobody listens on/);

	assert.deepEqual(offered(itemOf(view('paused'), 'overview', 'state')), ['bridge.connect?']);
	assert.deepEqual(itemOf(view('pausedClosed'), 'overview', 'state').operations.map(operation => [operation.id, operation.enabled]), [['bridge.connect', false], ['engine.startHidden', true]]);
	assert.deepEqual(offered(itemOf(view('busy'), 'doctor', 'doctor.summary')), [], 'not while a turn is active');

	const foreign = itemOf(view('foreign'), 'bridge', 'route');
	assert.deepEqual([foreign.text, foreign.severity, foreign.detail], ['Codex is routed elsewhere', 'error', 'The config of Codex no longer matches the journal of the bridge: Codex openai_base_url no longer matches this installation']);
	assert.deepEqual(itemOf(view('readyBrowserOnly'), 'engine', 'runtime').text, '5.0.8 \u00b7 installed by the launcher');
	assert.deepEqual(itemOf(view('readyBrowserOnly'), 'engine', 'daemon').text, '5.0.8 \u00b7 up 1 h 1 min');
	assert.deepEqual(itemOf(view('readyBrowserOnly'), 'engine', 'settings.biggerContext').operations.map(operation => [operation.id, operation.hint]), [['handoff.biggerContext', 'Settings > General > Bigger Context (experimental)']]);
	assert.deepEqual(itemOf(view('readyBrowserOnly'), 'bridge', 'remove').operations.map(operation => [operation.id, operation.hint]), [['handoff.removeIntegration', 'Settings > Diagnostics > Remove Codex integration']]);
});

test('doctor, full harness, subagents, models: what was asked is shown, what failed says how', () => {
	const full = view('readyFull');
	assert.deepEqual(full.screens.find(screen => screen.id === 'doctor')!.items.map(item => [item.id, item.text, item.severity]), [
		['doctor.summary', 'healthy \u00b7 just now', 'ok'],
		['doctor.check.config', 'Configuration is valid', 'ok'],
		['doctor.check.browser-host', 'Embedded launcher browser is authenticated and reachable (pid 1)', 'ok'],
		['doctor.check.service', 'A leftover launchd service is installed', 'info'],
		['doctor.check.tunnel-runtime', 'Tunnel runtime reports healthy and ready', 'ok'],
		['doctor.check.connector', 'Local checks cannot prove that ChatGPT connector "Codex Native2" is attached to this tunnel', 'info'],
	], 'a warning of the doctor is information: it does not ask for attention');
	assert.deepEqual(full.screens.find(screen => screen.id === 'mcp')!.items.map(item => [item.id, item.step, item.operations.map(operation => operation.id)]), [
		['mcp.mode', undefined, []], ['mcp.tunnel', 'done', ['link.tunnels', 'link.apiKeys']], ['mcp.connect', 'done', ['handoff.mcpConnect']], ['mcp.connector', 'unknown', ['link.connectors', 'handoff.verifyConnector']],
		['mcp.check.tunnel-runtime', undefined, []], ['mcp.check.connector', undefined, []],
	]);
	assert.match(itemOf(full, 'mcp', 'mcp.mode').detail ?? '', /tool access to the folder of the Codex session/);
	assert.deepEqual(view('readyBrowserOnly').screens.find(screen => screen.id === 'mcp')!.items.map(item => item.step), [undefined, 'todo', 'handoff', 'unknown']);

	const notSetUp = view('notSetUp');
	assert.deepEqual([itemOf(notSetUp, 'doctor', 'doctor.summary').text, itemOf(notSetUp, 'doctor', 'doctor.check.config').detail], ['needs attention \u00b7 2 min ago', 'Configuration is missing: ~/.codex-chatgpt-web/config.json. Run codex-chatgpt-web setup first.']);
	assert.deepEqual([itemOf(notSetUp, 'subagents', 'protocol').text, itemOf(notSetUp, 'subagents', 'protocol').severity], ['not read: the command failed (exit code 1): Configuration is missing: ~/.codex-chatgpt-web/config.json. Run codex-chatgpt-web setup first.', 'off']);
	assert.deepEqual(offered(itemOf(notSetUp, 'subagents', 'protocol')), []);

	const ready = view('readyBrowserOnly');
	assert.equal(itemOf(ready, 'subagents', 'protocol').text, 'Compatibility V1 \u00b7 active');
	assert.deepEqual(offered(itemOf(ready, 'subagents', 'protocol')), ['subagents.useNative?']);

	const broken = view('brokenRuntime');
	assert.deepEqual([itemOf(broken, 'bridge', 'route').text, itemOf(broken, 'subagents', 'protocol').text, itemOf(broken, 'doctor', 'doctor.summary').text, itemOf(broken, 'models', 'models.catalog').text], [
		'not read: the answer did not have the documented shape: Segmentation fault in ~/.codex-chatgpt-web', 'not read: no answer in time', 'did not run: the command failed (exit code 134): panic', 'not read: the answer was too large and was not read',
	]);
	assert.deepEqual(broken.screens.filter(screen => screen.severity === 'error').map(screen => screen.id), ['models', 'bridge', 'subagents', 'doctor']);
});

test('models: the static list until Codex was asked, then what the account really has; the default is marked', () => {
	const before = deriveViewState({ facts: SCENARIOS.readyBrowserOnly, activity: [], selectedModel: 'chatgpt-web/pro', now: NOW }).screens.find(screen => screen.id === 'models')!;
	assert.deepEqual(before.items.map(item => item.id), ['models.catalog', 'model.chatgpt-web/light', 'model.chatgpt-web/medium', 'model.chatgpt-web/high', 'model.chatgpt-web/extra-high', 'model.chatgpt-web/pro', 'model.chatgpt-web/luna', 'model.chatgpt-web/think', 'model.chatgpt-web/zero-risk', 'model.chatgpt-web/zero-risk-pro']);
	assert.deepEqual(before.items.filter(item => /Starts by default/.test(item.text)).map(item => item.id), ['model.chatgpt-web/pro']);
	assert.deepEqual(before.items[0].operations.map(operation => [operation.id, operation.enabled, operation.confirm]), [['models.refresh', true, false]]);

	const facts: LauncherFacts = { ...SCENARIOS.readyBrowserOnly, modelsAt: NOW - 600_000, models: { kind: 'models', otherCount: 3, web: [{ slug: 'chatgpt-web/high', name: 'ChatGPT Web - High', effort: 'high', contextWindow: 90000 }, { slug: 'chatgpt-web/new-one', name: undefined, effort: undefined, contextWindow: undefined }] } };
	const after = deriveViewState({ facts, activity: [], selectedModel: undefined, now: NOW }).screens.find(screen => screen.id === 'models')!;
	assert.deepEqual(after.items.map(item => [item.id, item.label, item.text]), [
		['models.catalog', 'Catalog', '2 ChatGPT Web models offered to this account \u00b7 asked 10 min ago'],
		['model.chatgpt-web/high', 'ChatGPT Web \u00b7 High', 'high effort \u00b7 90k context \u00b7 starts by default'],
		['model.chatgpt-web/new-one', 'ChatGPT Web \u00b7 new-one', 'chatgpt-web/new-one'],
	]);
});

test('activity: the newest first, with its time, and the log of the launcher stays a hand-off', () => {
	const log = new ActivityLog();
	log.record({ at: NOW - 5000, operation: 'probe.routeStatus', program: 'runtime', args: ['route', 'status'], outcome: 'ok', durationMs: 40, exitCode: 0, note: 'route: installed, connected' });
	log.record({ at: NOW - 1000, operation: 'bridge.pause', program: 'runtime', args: ['route', 'disconnect'], outcome: 'timeout', durationMs: 15000 });
	const screen = deriveViewState({ facts: SCENARIOS.readyBrowserOnly, activity: log.entries, selectedModel: undefined, now: NOW }).screens.find(candidate => candidate.id === 'activity')!;
	assert.deepEqual(screen.items.map(item => [item.id, item.label, item.text, item.detail, item.severity, item.at]), [
		['activity.2', 'Pause Bridge', 'timeout \u00b7 15000 ms', 'codex-chatgpt-web route disconnect', 'error', NOW - 1000],
		['activity.1', 'Ask for the Route Status', 'ok \u00b7 40 ms \u00b7 exit code 0', 'codex-chatgpt-web route status \u00b7 route: installed, connected', 'off', NOW - 5000],
		['activity.launcher', 'Log of the launcher', 'in the launcher', undefined, 'off', undefined],
	]);
	assert.deepEqual(screen.items[2].operations.map(operation => [operation.id, operation.hint]), [['handoff.exportLog', 'Activity > Export safe log']]);
});
