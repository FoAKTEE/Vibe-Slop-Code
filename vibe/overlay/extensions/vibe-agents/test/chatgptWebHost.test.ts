// SPDX-License-Identifier: MIT

// The bridge as the extension host runs it, without an editor: a throwaway config file stands in for the one
// of Codex, a server on an ephemeral port for the daemon of the launcher, and a fake for what the editor shows.
// Nothing in here touches the real config of Codex, the real launcher or the real Codex.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChatGptWebBridge, nodeSystem, probeHealth, type BridgeSystem, type BridgeUi, type ModelPickItem } from '../src/host/chatgptWeb.ts';
import { COMMANDS, type BridgeFacts } from '../src/model/chatgptWeb.ts';
import { ProfileRegistry, commandLineOf } from '../src/model/profiles.ts';
import { deadPort, startFakeDaemon, type FakeDaemon } from './fakes/fake-daemon.ts';

const HEALTH = { status: 'ok', service: 'codex-chatgpt-web', version: '5.0.8', mode: 'browser-only', pid: 4242, port: 0, uptime: 12, accepting_turns: true, active_http_turns: 0, active_browser_turns: 0 };

async function fakeDaemon(t: TestContext, body: unknown = HEALTH): Promise<FakeDaemon> {
	const daemon = await startFakeDaemon({ body });
	t.after(() => daemon.close());
	return daemon;
}

interface Harness {
	bridge: ChatGptWebBridge;
	registry: ProfileRegistry;
	configPath: string;
	writeConfig(text: string | undefined): void;
	ui: BridgeUi & { remoteName: string | undefined; enabled: boolean; model: string | undefined; picks: ModelPickItem[][]; answer: string | undefined; notifications: { severity: string; message: string; buttons: string[] }[]; choose: string | undefined; opened: string[]; commands: string[]; logs: string[] };
	system: BridgeSystem & { executed: string[][]; installed: boolean; running: boolean | undefined };
	changes: number;
}

function harness(t: TestContext, options: { platform?: string; remoteName?: string; look?: (fresh: boolean) => Promise<BridgeFacts> } = {}): Harness {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-agents-cgw-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const configPath = path.join(dir, 'config.toml');

	const ui: Harness['ui'] = {
		remoteName: options.remoteName,
		enabled: true,
		model: undefined,
		picks: [],
		answer: undefined,
		notifications: [],
		choose: undefined,
		opened: [],
		commands: [],
		logs: [],
		isEnabled: () => ui.enabled,
		codexConfigPath: () => configPath,
		storedModel: () => ui.model,
		storeModel: async slug => { ui.model = slug; },
		pickModel: async items => {
			ui.picks.push(items);
			return ui.answer;
		},
		notify: async (severity, message, buttons) => {
			ui.notifications.push({ severity, message, buttons });
			return ui.choose;
		},
		openExternal: url => { ui.opened.push(url); },
		executeCommand: command => { ui.commands.push(command); },
		log: message => { ui.logs.push(message); },
	};

	const real = nodeSystem();
	const system: Harness['system'] = {
		...real,
		platform: options.platform ?? 'darwin',
		homedir: dir,
		env: {},
		executed: [],
		installed: true,
		running: true,
		exists: async candidate => system.installed && candidate === '/Applications/Codex Web GPT.app',
		execFile: (file, args, callback) => {
			system.executed.push([file, ...args]);
			const code = system.running === undefined ? 3 : system.running ? 0 : 1;
			callback(file.endsWith('pgrep') && code !== 0 ? Object.assign(new Error('exit'), { code }) : null);
		},
		timers: { setInterval: () => 0, clearInterval: () => { } },
	};

	const registry = new ProfileRegistry();
	const result: Harness = {
		bridge: undefined!,
		registry,
		configPath,
		writeConfig: text => text === undefined ? fs.rmSync(configPath, { force: true }) : fs.writeFileSync(configPath, text),
		ui,
		system,
		changes: 0,
	};
	result.bridge = new ChatGptWebBridge(ui, system, () => { result.changes++; }, options.look);
	t.after(() => result.bridge.dispose());
	registry.registerProvider(result.bridge);
	registry.registerStatusRowProvider(result.bridge);
	return result;
}

const routeTo = (port: number) => `model = "gpt-6-astra"\napi_note = "SECRET-IN-ANOTHER-LINE"\nopenai_base_url = "http://127.0.0.1:${port}/v1"\n\n[features]\nmulti_agent = true\n`;
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

//#region The probe

test('probe: the answer of the daemon, and the three ways there is none', async t => {
	const daemon = await fakeDaemon(t);
	assert.deepEqual(await probeHealth(daemon.port, 1500), { health: { mode: 'browser-only', acceptingTurns: true, activeBrowserTurns: 0, version: '5.0.8' } });
	assert.deepEqual(daemon.requests, ['GET /healthz'], 'one GET, nothing else: no /v1, no /admin');

	daemon.body = '<html>some other server</html>';
	assert.deepEqual(await probeHealth(daemon.port, 1500), { error: 'not-the-daemon' });

	daemon.body = HEALTH;
	daemon.delay = 400;
	const started = Date.now();
	assert.deepEqual(await probeHealth(daemon.port, 60), { error: 'timeout' });
	assert.ok(Date.now() - started < 350, 'the deadline bounds the whole exchange');

	assert.deepEqual(await probeHealth(await deadPort(), 1500), { error: 'unreachable' });
});

//#endregion

//#region States, as the view gets them

test('no route: models are not installed, the row offers the launcher; nothing is probed', async t => {
	const h = harness(t);
	h.writeConfig('model = "gpt-6-astra"\n[model_providers.x]\nopenai_base_url = "http://127.0.0.1:1/v1"\n');
	assert.deepEqual(await h.registry.statusRows(), [], 'nothing is known before the first look');

	const shown = await h.bridge.check();
	assert.equal(shown.state, 'not-set-up');
	const [row] = await h.registry.statusRows();
	assert.deepEqual([row.label, row.detail, row.state, row.action], ['ChatGPT Web', 'models not installed', 'off', { label: 'Open ChatGPT Web Panel', command: COMMANDS.openPanel }]);
	assert.deepEqual(h.system.executed, [['/usr/bin/pgrep', '-f', 'Codex Web GPT.app/Contents/MacOS/']], 'only whether the launcher runs was asked');
	assert.equal(h.changes, 1);

	await h.bridge.check();
	assert.equal(h.changes, 1, 'the same answer again changes nothing');

	h.system.running = false;
	assert.equal((await h.bridge.check()).state, 'launcher-closed');
	h.system.running = undefined;
	assert.equal((await h.bridge.check()).state, 'not-set-up', 'pgrep failed: not known');
	h.system.installed = false;
	assert.equal((await h.bridge.check()).state, 'not-installed');
	h.writeConfig(undefined);
	assert.equal((await h.bridge.check()).state, 'not-installed', 'no config file is no route');
});

test('a route to a dead port: every Codex run fails, and the row says so', async t => {
	const h = harness(t);
	const port = await deadPort();
	h.writeConfig(routeTo(port));
	const shown = await h.bridge.check();
	assert.equal(shown.state, 'route-dead');
	assert.match(shown.message, new RegExp(`Codex is routed to 127\\.0\\.0\\.1:${port} but .* every Codex run on this machine fails`));
	const [row] = await h.registry.statusRows();
	assert.deepEqual([row.detail, row.state, row.action?.label], ['launcher not running: every Codex run fails', 'warning', 'Open ChatGPT Web Panel']);
	assert.deepEqual(row.secondaryActions?.map(action => action.label), ['Show Launcher Window', 'Re-check']);
	assert.deepEqual(h.system.executed, [], 'the process list is not needed for that');
});

test('the daemon answers: ready, quietly; draining and busy are told apart', async t => {
	const h = harness(t);
	const daemon = await fakeDaemon(t);
	h.writeConfig(routeTo(daemon.port));
	assert.equal((await h.bridge.check()).state, 'ready-browser-only');
	const [row] = await h.registry.statusRows();
	assert.deepEqual([row.label, row.detail, row.state, row.action], ['ChatGPT Web', 'ready \u00b7 browser-only', 'ok', undefined]);

	daemon.body = { ...HEALTH, mode: 'full' };
	assert.equal((await h.bridge.check()).state, 'ready-full');
	daemon.body = { ...HEALTH, accepting_turns: false };
	assert.equal((await h.bridge.check()).state, 'draining');
	daemon.body = { ...HEALTH, active_browser_turns: 1 };
	assert.equal((await h.bridge.check()).state, 'busy');
	assert.ok(daemon.requests.every(request => request === 'GET /healthz'));
});

test('a foreign route is told without a word of it; no line of the config reaches a log or a message', async t => {
	const h = harness(t);
	h.writeConfig('api_note = "SECRET-IN-ANOTHER-LINE"\nopenai_base_url = "https://proxy.example.test/v1?key=SECRET-TOKEN"\n');
	assert.equal((await h.bridge.check()).state, 'foreign-route');
	h.ui.model = 'chatgpt-web/high';
	assert.equal(await h.registry.prepareLaunch(h.registry.get('chatgpt-web')!), undefined);
	await settle();

	h.writeConfig(routeTo(await deadPort()));
	await h.bridge.check();
	const said = JSON.stringify([h.ui.logs, h.ui.notifications, await h.registry.statusRows()]);
	assert.ok(!/SECRET|example\.test|proxy|gpt-6-astra|multi_agent/.test(said), said);
	assert.ok(h.ui.logs.some(line => line.includes('foreign-route')) && h.ui.logs.some(line => line.includes('route-dead')), 'the states are logged');
});

test('concurrent looks share one probe', async t => {
	const h = harness(t);
	const daemon = await fakeDaemon(t);
	daemon.delay = 30;
	h.writeConfig(routeTo(daemon.port));
	const [a, b] = await Promise.all([h.bridge.check(), h.bridge.check()]);
	assert.equal(a, b);
	assert.equal(daemon.requests.length, 1);
});

//#endregion

//#region Starting an agent

test('ready: the first start asks for the model, remembers it, and starts exactly `codex -m <slug>`', async t => {
	const h = harness(t);
	const daemon = await fakeDaemon(t);
	h.writeConfig(routeTo(daemon.port));
	const listed = h.registry.get('chatgpt-web');
	assert.deepEqual([listed?.label, listed?.command, listed?.icon], ['ChatGPT Web (via Codex)', 'codex', 'globe']);

	h.ui.answer = 'chatgpt-web/high';
	const prepared = await h.registry.prepareLaunch(listed!);
	assert.deepEqual([prepared?.id, prepared?.label, prepared?.command, prepared?.args, prepared?.env, prepared?.cwd], ['chatgpt-web', 'ChatGPT Web \u00b7 High', 'codex', ['-m', 'chatgpt-web/high'], undefined, undefined]);
	assert.equal(commandLineOf(prepared!), 'codex -m chatgpt-web/high');
	assert.equal(h.ui.model, 'chatgpt-web/high');
	assert.deepEqual(h.ui.picks[0].map(item => item.slug), ['chatgpt-web/light', 'chatgpt-web/medium', 'chatgpt-web/high', 'chatgpt-web/extra-high', 'chatgpt-web/pro', 'chatgpt-web/luna', 'chatgpt-web/think'], 'the manual-paste models are not offered');
	assert.deepEqual(h.ui.notifications, []);

	// the next start does not ask; the probe runs again before it
	const before = daemon.requests.length;
	assert.equal(commandLineOf((await h.registry.prepareLaunch(listed!))!), 'codex -m chatgpt-web/high');
	assert.equal(h.ui.picks.length, 1);
	assert.equal(daemon.requests.length, before + 1);

	// the command changes the model; a session that is started again keeps its own
	h.ui.answer = 'chatgpt-web/pro';
	assert.equal(await h.bridge.selectModel(), 'chatgpt-web/pro');
	assert.deepEqual(h.ui.picks[1].filter(item => item.current).map(item => item.slug), ['chatgpt-web/high']);
	assert.equal(commandLineOf(h.registry.get('chatgpt-web')!), 'codex -m chatgpt-web/pro');
	assert.equal((await h.registry.prepareLaunch(listed!, 'codex -m chatgpt-web/medium'))?.label, 'ChatGPT Web \u00b7 Medium');
	assert.equal(h.ui.model, 'chatgpt-web/pro');

	// a stored value that is no model of a terminal is asked again; leaving the pick starts nothing
	h.ui.model = 'chatgpt-web/zero-risk';
	h.ui.answer = undefined;
	assert.equal(await h.registry.prepareLaunch(listed!), undefined);
	assert.equal(h.ui.picks.length, 3);
	assert.deepEqual(h.ui.notifications, [], 'and says nothing');
	assert.deepEqual(h.system.executed, [], 'nothing was run on the way: starting is the business of the terminal');
});

test('not ready: every state refuses with its next step and its action, and no profile to start', async t => {
	const h = harness(t);
	const daemon = await fakeDaemon(t);
	h.ui.model = 'chatgpt-web/high';
	const refusal = async (prepare: () => void | Promise<void>, message: RegExp) => {
		await prepare();
		h.ui.notifications.length = 0;
		const prepared = await h.registry.prepareLaunch(h.registry.get('chatgpt-web')!);
		await settle();
		assert.equal(h.ui.notifications.length, 1);
		assert.match(h.ui.notifications[0].message, message);
		return [prepared, h.ui.notifications[0].severity, h.ui.notifications[0].buttons];
	};

	assert.deepEqual(await refusal(() => { h.system.installed = false; h.writeConfig('model = "x"\n'); }, /^ChatGPT Web is not installed/), [undefined, 'info', ['Project Page']]);
	assert.deepEqual(await refusal(() => { h.system.installed = true; }, /^ChatGPT Web is not set up: .* run Install models, then restart Codex\.$/), [undefined, 'info', ['Open ChatGPT Web Panel']]);
	assert.deepEqual(await refusal(() => { h.system.running = false; }, /launcher is not running, and Codex has no launcher route/), [undefined, 'info', ['Open ChatGPT Web Panel']]);
	assert.deepEqual(await refusal(() => { h.writeConfig('openai_base_url = "https://elsewhere.test/v1"\n'); }, /only one program can own it/), [undefined, 'info', ['Open ChatGPT Web Panel']]);
	assert.deepEqual(await refusal(async () => { h.writeConfig(routeTo(await deadPort())); }, /every Codex run on this machine fails, not only ChatGPT Web/), [undefined, 'warning', ['Open ChatGPT Web Panel']]);
	assert.deepEqual(await refusal(() => { h.writeConfig(routeTo(daemon.port)); daemon.body = { ...HEALTH, accepting_turns: false }; }, /launcher is draining/), [undefined, 'info', ['Re-check']]);
	assert.deepEqual(await refusal(() => { daemon.body = { ...HEALTH, active_browser_turns: 2 }; }, /^ChatGPT Web is busy: 2 browser turns already active/), [undefined, 'info', ['Re-check']]);
	assert.deepEqual(h.ui.picks, [], 'a bridge that is not ready is not asked which model');
});

test('the action of a refusal runs when it is chosen; a second refusal does not pile up', async t => {
	const h = harness(t);
	h.writeConfig(routeTo(await deadPort()));
	h.ui.model = 'chatgpt-web/high';

	let choose: (button: string | undefined) => void = () => { };
	h.ui.notify = (severity, message, buttons) => {
		h.ui.notifications.push({ severity, message, buttons });
		return new Promise(resolve => { choose = resolve; });
	};
	assert.equal(await h.registry.prepareLaunch(h.registry.get('chatgpt-web')!), undefined, 'the refusal does not wait for the notification');
	assert.equal(await h.registry.prepareLaunch(h.registry.get('chatgpt-web')!), undefined);
	assert.equal(h.ui.notifications.length, 1);

	choose('Open ChatGPT Web Panel');
	await settle();
	assert.deepEqual([h.ui.commands, h.system.executed], [[COMMANDS.openPanel], []], 'the panel is a command of the editor: nothing is run from here');
});

//#endregion

//#region Actions

test('not installed: the row leads to the project page; on another platform the panel is offered all the same', async t => {
	const mac = harness(t);
	mac.bridge.openProjectPage();
	assert.deepEqual(mac.ui.opened, ['https://github.com/miuuyy/codex-chatgpt-web']);

	const linux = harness(t, { platform: 'linux' });
	linux.writeConfig('model = "x"\n');
	const shown = await linux.bridge.check();
	assert.deepEqual([shown.state, shown.action, shown.secondary], ['not-set-up', 'open-panel', []], 'no window of the launcher is offered where macOS cannot show it');
	assert.deepEqual(linux.system.executed, [], 'no process list is asked there');
});

test('with the controller of the panel in the window, the row tells ITS facts, and asks the machine nothing itself', async t => {
	let facts: BridgeFacts = { appInstalled: true, launcherRunning: true, route: { kind: 'absent' }, routeInstalled: true };
	let looks = 0;
	const h = harness(t, { look: async fresh => { looks += fresh ? 1 : 0; return facts; } });
	h.writeConfig(routeTo(await deadPort()));

	assert.equal((await h.bridge.check()).state, 'paused', 'what only the journal of the bridge tells');
	const [row] = await h.registry.statusRows();
	assert.deepEqual([row.detail, row.action?.label, row.secondaryActions?.map(action => action.label)], ['bridge paused', 'Open ChatGPT Web Panel', ['Show Launcher Window', 'Re-check']]);
	facts = { appInstalled: true, route: { kind: 'launcher', port: 17841 }, health: { mode: 'full', acceptingTurns: true, activeBrowserTurns: 0, version: '5.0.8' } };
	assert.equal((await h.bridge.check()).state, 'ready-full');
	assert.deepEqual([looks, h.system.executed], [2, []], 'no file, no process list, no socket of its own');

	// the panel did something: the row follows what is known, without looking again
	facts = { appInstalled: true, launcherRunning: true, route: { kind: 'absent' }, routeInstalled: true };
	await h.bridge.factsChanged();
	assert.deepEqual([(await h.registry.statusRows())[0].detail, looks], ['bridge paused', 2]);
});

//#endregion

//#region Where it is absent

test('a remote window has no profile and no row, and asks nothing: its terminals run on the remote host', async t => {
	const h = harness(t, { remoteName: 'ssh-remote' });
	const daemon = await fakeDaemon(t);
	h.writeConfig(routeTo(daemon.port));
	h.ui.model = 'chatgpt-web/high';

	assert.deepEqual(h.registry.profiles.map(profile => profile.id), ['claude', 'codex']);
	h.registry.setRowsVisible(true);
	h.bridge.windowFocused();
	await h.bridge.recheck();
	await settle();
	assert.deepEqual(await h.registry.statusRows(), []);
	assert.equal(await h.bridge.prepareLaunch({ profile: { id: 'chatgpt-web', label: 'x', command: 'codex' } }), undefined, 'even asked directly it starts nothing');
	assert.deepEqual([daemon.requests, h.system.executed, h.ui.notifications.length], [[], [], 1]);
	assert.match(h.ui.notifications[0].message, /local window/);
});

test('turned off by its setting: the same, until it is turned on again', async t => {
	const h = harness(t);
	const daemon = await fakeDaemon(t);
	h.writeConfig(routeTo(daemon.port));
	h.ui.enabled = false;
	h.bridge.configurationChanged();
	h.registry.setRowsVisible(true);
	await settle();
	assert.deepEqual([h.registry.profiles.map(profile => profile.id), await h.registry.statusRows(), daemon.requests], [['claude', 'codex'], [], []]);

	h.ui.enabled = true;
	h.bridge.configurationChanged();
	await settle();
	await h.bridge.check();
	assert.deepEqual(h.registry.profiles.map(profile => profile.id), ['claude', 'codex', 'chatgpt-web']);
	assert.equal((await h.registry.statusRows())[0]?.detail, 'ready \u00b7 browser-only');
});

//#endregion

//#region Cadence

test('the row is asked about when the view shows and while it does, not while it is hidden', async t => {
	const h = harness(t);
	const daemon = await fakeDaemon(t);
	h.writeConfig(routeTo(daemon.port));
	let tick: () => void = () => { };
	let intervals = 0;
	h.system.timers.setInterval = (callback, ms) => {
		assert.equal(ms, 30_000);
		tick = callback;
		return ++intervals;
	};
	h.system.timers.clearInterval = () => { tick = () => { }; };

	h.bridge.windowFocused();
	await settle();
	assert.equal(daemon.requests.length, 0, 'hidden: focus asks nothing');

	h.registry.setRowsVisible(true);
	await settle();
	assert.equal(daemon.requests.length, 1, 'once on becoming visible');
	tick();
	await settle();
	tick();
	await settle();
	assert.equal(daemon.requests.length, 3, 'and on every tick of the 30 s timer');
	h.bridge.windowFocused();
	await settle();
	assert.equal(daemon.requests.length, 4, 'the window gets the focus back: now');

	h.registry.setRowsVisible(false);
	tick();
	h.bridge.windowFocused();
	await settle();
	assert.equal(daemon.requests.length, 4, 'hidden: nothing');

	await h.bridge.recheck();
	assert.equal(daemon.requests.length, 5, 'Re-check is the user asking: always');
});

//#endregion
