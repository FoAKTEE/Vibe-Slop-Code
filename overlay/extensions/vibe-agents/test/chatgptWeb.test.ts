// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	CHATGPT_WEB_MODELS, CHATGPT_WEB_PROFILE_ID, DEFAULT_CODEX_CONFIG_PATH, ProbeSchedule, chatGptWebLaunchProfile, chatGptWebProfile, classifyBridge, isReadyState, labelOfSlug, parseHealth,
	parseLauncherRoute, presentBridge, resolveCodexConfigPath, rowOfBridge, slugOfCommandLine, terminalModels, type BridgeFacts, type BridgeState, type LauncherRoute,
} from '../src/model/chatgptWeb.ts';
import { commandLineOf } from '../src/model/profiles.ts';

const LAUNCHER: LauncherRoute = { kind: 'launcher', port: 17841 };
const ABSENT: LauncherRoute = { kind: 'absent' };
const FOREIGN: LauncherRoute = { kind: 'foreign' };

//#region Route

test('route: the top-level openai_base_url, as the launcher writes it', () => {
	const config = [
		'model = "gpt-6-astra"',
		'model_reasoning_effort = "xhigh"',
		'# Managed by codex-chatgpt-web: Responses use the local bridge; Voice stays on ChatGPT.',
		'openai_base_url = "http://127.0.0.1:17841/v1"',
		'experimental_realtime_webrtc_call_base_url = "https://chatgpt.com/backend-api/codex"',
		'',
		'[features]',
		'multi_agent = true',
	].join('\n');
	assert.deepEqual(parseLauncherRoute(config), { kind: 'launcher', port: 17841 });
});

test('route: a key inside a table is not the route of Codex', () => {
	assert.deepEqual(parseLauncherRoute('model = "x"\n[model_providers.mine]\nopenai_base_url = "http://127.0.0.1:17841/v1"\n'), ABSENT);
	assert.deepEqual(parseLauncherRoute('[[hooks]] # a comment\nopenai_base_url = "http://127.0.0.1:17841/v1"\n'), ABSENT);
	assert.deepEqual(parseLauncherRoute('  [ profiles . "web" ]\nopenai_base_url = "http://127.0.0.1:17841/v1"\n'), ABSENT);
	assert.deepEqual(parseLauncherRoute(''), ABSENT);
	assert.deepEqual(parseLauncherRoute('model = "x"\n'), ABSENT);
});

test('route: quoted forms, spacing, comments and line ends', () => {
	const launcher = (line: string, port = 17841) => assert.deepEqual(parseLauncherRoute(line), { kind: 'launcher', port }, line);
	launcher('openai_base_url="http://127.0.0.1:17841/v1"');
	launcher(`openai_base_url = 'http://127.0.0.1:17841/v1'`);
	launcher('\topenai_base_url   =   "http://127.0.0.1:17841/v1"   # the bridge');
	launcher('"openai_base_url" = "http://127.0.0.1:17841/v1"');
	launcher(`'openai_base_url' = "http://127.0.0.1:17841/v1/"`);
	launcher('model = "x"\r\nopenai_base_url = "http://127.0.0.1:9/v1"\r\n[features]\r\n', 9);
	launcher('openai_base_url = "http://localhost:65535/v1"', 65535);
	launcher('# openai_base_url = "https://example.test/v1"\nopenai_base_url = "http://127.0.0.1:17841/v1"');

	assert.deepEqual(parseLauncherRoute('# openai_base_url = "http://127.0.0.1:17841/v1"'), ABSENT, 'commented out');
	assert.deepEqual(parseLauncherRoute('xopenai_base_url = "http://127.0.0.1:17841/v1"'), ABSENT, 'another key');
	assert.deepEqual(parseLauncherRoute('openai_base_url_backup = "http://127.0.0.1:17841/v1"'), ABSENT, 'another key');
	assert.deepEqual(parseLauncherRoute('notes = """\nopenai_base_url = "http://127.0.0.1:17841/v1"\n[features]\n"""\n'), ABSENT, 'text of a multi-line string is no key');
	launcher(`notes = '''\n[features]\n'''\nopenai_base_url = "http://127.0.0.1:17841/v1"`);
	launcher('notes = """one line"""\nopenai_base_url = "http://127.0.0.1:17841/v1"');
});

test('route: anything but the loopback route of the launcher is foreign, and is never echoed', () => {
	const foreign = [
		'openai_base_url = "https://proxy.example.test/v1?key=SECRET-TOKEN"',
		'openai_base_url = "https://127.0.0.1:17841/v1"',
		'openai_base_url = "http://127.0.0.1:17841/v2"',
		'openai_base_url = "http://127.0.0.1/v1"',
		'openai_base_url = "http://127.0.0.1:0/v1"',
		'openai_base_url = "http://127.0.0.1:65536/v1"',
		'openai_base_url = "http://127.0.0.1:17841/v1" trailing',
		'openai_base_url = "http://127.0.0.1.example.test:17841/v1"',
		'openai_base_url = "http://user:SECRET-TOKEN@127.0.0.1:17841/v1"',
		// the daemon listens on 127.0.0.1 only: the IPv6 loopback never reaches it
		'openai_base_url = "http://[::1]:17841/v1"',
		'openai_base_url = """http://127.0.0.1:17841/v1"""',
		'openai_base_url = 17841',
		'openai_base_url = "http://127.0.0.1:17841/v1',
	];
	for (const line of foreign) {
		const route = parseLauncherRoute(`model = "x"\n${line}\n`);
		assert.deepEqual(route, FOREIGN, line);
		assert.ok(!JSON.stringify(route).includes('SECRET'), 'the route keeps nothing of the value');
	}
	const presentation = presentBridge({ appInstalled: true, route: parseLauncherRoute(foreign[0]) });
	assert.ok(!/example|SECRET|proxy/.test(JSON.stringify(presentation)), 'nor does what is shown');
});

test('the config of Codex: the setting, else CODEX_HOME, else ~/.codex', () => {
	assert.equal(DEFAULT_CODEX_CONFIG_PATH, '~/.codex/config.toml');
	assert.equal(resolveCodexConfigPath(undefined, {}, '/Users/u'), '/Users/u/.codex/config.toml');
	assert.equal(resolveCodexConfigPath('~/.codex/config.toml', {}, '/Users/u'), '/Users/u/.codex/config.toml');
	assert.equal(resolveCodexConfigPath('  ', { CODEX_HOME: ' /opt/codex ' }, '/Users/u'), '/opt/codex/config.toml');
	assert.equal(resolveCodexConfigPath('~/.codex/config.toml', { CODEX_HOME: '/opt/codex' }, '/Users/u'), '/opt/codex/config.toml', 'the default follows CODEX_HOME, as Codex does');
	assert.equal(resolveCodexConfigPath('/tmp/fake/config.toml', { CODEX_HOME: '/opt/codex' }, '/Users/u'), '/tmp/fake/config.toml', 'a chosen file wins');
	assert.equal(resolveCodexConfigPath('~/elsewhere/config.toml', {}, '/Users/u'), '/Users/u/elsewhere/config.toml');
});

//#endregion

//#region Health

test('health: only the answer of the daemon counts', () => {
	const body = { status: 'ok', service: 'codex-chatgpt-web', version: '5.0.8', mode: 'browser-only', pid: 1, port: 17841, accepting_turns: true, active_http_turns: 0, active_browser_turns: 2 };
	assert.deepEqual(parseHealth(JSON.stringify(body)), { mode: 'browser-only', acceptingTurns: true, activeBrowserTurns: 2, version: '5.0.8' });
	assert.deepEqual(parseHealth(JSON.stringify({ ...body, mode: 'full', active_browser_turns: undefined, version: 7 })), { mode: 'full', acceptingTurns: true, activeBrowserTurns: 0, version: undefined });
	assert.deepEqual(parseHealth(JSON.stringify({ ...body, accepting_turns: 'yes' }))?.acceptingTurns, false, 'only true accepts');
	assert.equal(parseHealth(JSON.stringify({ ...body, service: 'something-else' })), undefined);
	assert.equal(parseHealth(JSON.stringify({ ...body, status: 'starting' })), undefined);
	assert.equal(parseHealth('<html>It works!</html>'), undefined);
	assert.equal(parseHealth('null'), undefined);
	assert.equal(parseHealth('[]'), undefined);
});

//#endregion

//#region States

const HEALTHY = { mode: 'browser-only', acceptingTurns: true, activeBrowserTurns: 0, version: '5.0.8' };

const CASES: [string, BridgeFacts, BridgeState][] = [
	['no app, no route', { appInstalled: false, route: ABSENT }, 'not-installed'],
	['app, launcher open, Install models never ran (this machine today)', { appInstalled: true, launcherRunning: true, route: ABSENT }, 'not-set-up'],
	['app, nothing known about the process', { appInstalled: true, route: ABSENT }, 'not-set-up'],
	['not macOS: whether the app is there is not known', { appInstalled: undefined, route: ABSENT }, 'not-set-up'],
	['app, launcher closed, no route', { appInstalled: true, launcherRunning: false, route: ABSENT }, 'launcher-closed'],
	['route, nothing listens', { appInstalled: true, route: LAUNCHER, error: 'unreachable' }, 'route-dead'],
	['route, no answer in time', { appInstalled: true, route: LAUNCHER, error: 'timeout' }, 'route-dead'],
	['route, something else answers', { appInstalled: true, route: LAUNCHER, error: 'not-the-daemon' }, 'route-dead'],
	['route, the app was deleted', { appInstalled: false, route: LAUNCHER, error: 'unreachable' }, 'route-dead'],
	['route of another program', { appInstalled: true, launcherRunning: true, route: FOREIGN }, 'foreign-route'],
	['route of another program, no app: installing comes first', { appInstalled: false, route: FOREIGN }, 'not-installed'],
	['draining', { appInstalled: true, route: LAUNCHER, health: { ...HEALTHY, acceptingTurns: false } }, 'draining'],
	['draining wins over busy', { appInstalled: true, route: LAUNCHER, health: { ...HEALTHY, acceptingTurns: false, activeBrowserTurns: 3 } }, 'draining'],
	['a browser turn is active', { appInstalled: true, route: LAUNCHER, health: { ...HEALTHY, activeBrowserTurns: 1 } }, 'busy'],
	['ready, browser-only', { appInstalled: true, route: LAUNCHER, health: HEALTHY }, 'ready-browser-only'],
	['ready, full harness', { appInstalled: true, route: LAUNCHER, health: { ...HEALTHY, mode: 'full' } }, 'ready-full'],
	['ready: the daemon answers, where the app is does not matter', { appInstalled: undefined, route: LAUNCHER, health: HEALTHY }, 'ready-browser-only'],
	['a mode this version does not know has no tools to count on', { appInstalled: true, route: LAUNCHER, health: { ...HEALTHY, mode: 'something-new' } }, 'ready-browser-only'],
];

for (const [name, facts, state] of CASES) {
	test(`state: ${name} -> ${state}`, () => assert.equal(classifyBridge(facts), state));
}

test('every state: row text, severity, action and the next step, which is the one the orchestrator names', () => {
	const shown = (facts: BridgeFacts) => {
		const { state, label, detail, severity, action } = presentBridge(facts);
		return [state, `${label} ${detail}`, severity, action];
	};
	assert.deepEqual([
		shown({ appInstalled: false, route: ABSENT }),
		shown({ appInstalled: true, launcherRunning: true, route: ABSENT }),
		shown({ appInstalled: true, launcherRunning: false, route: ABSENT }),
		shown({ appInstalled: true, route: LAUNCHER, error: 'unreachable' }),
		shown({ appInstalled: true, route: FOREIGN }),
		shown({ appInstalled: true, launcherRunning: true, route: ABSENT, routeInstalled: true }),
		shown({ appInstalled: true, launcherRunning: false, route: ABSENT, routeInstalled: true }),
		shown({ appInstalled: true, route: LAUNCHER, health: { ...HEALTHY, acceptingTurns: false } }),
		shown({ appInstalled: true, route: LAUNCHER, health: { ...HEALTHY, mode: 'full', activeBrowserTurns: 2 } }),
		shown({ appInstalled: true, route: LAUNCHER, health: HEALTHY }),
		shown({ appInstalled: true, route: LAUNCHER, health: { ...HEALTHY, mode: 'full' } }),
	], [
		['not-installed', 'ChatGPT Web not installed', 'off', 'project-page'],
		['not-set-up', 'ChatGPT Web models not installed', 'off', 'open-panel'],
		['launcher-closed', 'ChatGPT Web launcher not running', 'off', 'open-panel'],
		['route-dead', 'ChatGPT Web launcher not running: every Codex run fails', 'warning', 'open-panel'],
		['foreign-route', 'ChatGPT Web Codex is routed elsewhere', 'off', 'open-panel'],
		['paused', 'ChatGPT Web bridge paused', 'off', 'open-panel'],
		['paused', 'ChatGPT Web bridge paused, launcher not running', 'off', 'open-panel'],
		['draining', 'ChatGPT Web launcher busy with setup or an update', 'off', 'recheck'],
		['busy', 'ChatGPT Web busy \u00b7 2/5 turns \u00b7 full harness', 'ok', 'recheck'],
		['ready-browser-only', 'ChatGPT Web ready \u00b7 browser-only', 'ok', undefined],
		['ready-full', 'ChatGPT Web ready \u00b7 full harness', 'ok', undefined],
	]);

	const message = (facts: BridgeFacts) => presentBridge(facts).message;
	assert.match(message({ appInstalled: false, route: ABSENT }), /not installed.*project page/i);
	assert.match(message({ appInstalled: true, route: ABSENT }), /top-level openai_base_url is absent.*open the Codex Web GPT launcher and run Install models, then restart Codex/i);
	assert.match(message({ appInstalled: true, launcherRunning: false, route: ABSENT }), /launcher is not running.*run Install models, then restart Codex/i);
	assert.match(message({ appInstalled: true, route: LAUNCHER, error: 'unreachable' }), /Codex is routed to 127\.0\.0\.1:17841 but the .*launcher is not running.*every Codex run on this machine fails.*pause the bridge in the ChatGPT Web panel.*without the launcher/);
	assert.match(message({ appInstalled: true, route: ABSENT, routeInstalled: true }), /bridge is paused.*previous route.*Connect Bridge.*ALL Codex traffic/);
	assert.match(message({ appInstalled: true, route: LAUNCHER, error: 'not-the-daemon' }), /127\.0\.0\.1:17841.*did not answer as the codex-chatgpt-web daemon.*every Codex run on this machine fails/);
	assert.match(message({ appInstalled: true, route: FOREIGN }), /not the launcher's http:\/\/127\.0\.0\.1:<port>\/v1 route.*only one program can own it.*run Install models, then restart Codex/i);
	assert.match(message({ appInstalled: true, route: LAUNCHER, health: { ...HEALTHY, acceptingTurns: false } }), /draining.*setup, update or shutdown in progress.*wait for it to finish/i);
	assert.match(message({ appInstalled: true, route: LAUNCHER, health: { ...HEALTHY, activeBrowserTurns: 1 } }), /1 browser turn already active.*turns started close together have triggered account limits.*wait for the running turn to finish/i);
	assert.match(message({ appInstalled: true, route: LAUNCHER, health: HEALTHY }), /browser-only.*no local tools/i);
});

test('what is not ready leads to the panel; the window of the launcher is one click further, where macOS can show it', () => {
	const elsewhere = { canOpenLauncher: false };
	const offered = (facts: BridgeFacts, options?: { canOpenLauncher: boolean }) => { const { action, secondary } = presentBridge(facts, options); return [action, secondary]; };
	assert.deepEqual(offered({ appInstalled: true, route: ABSENT }), ['open-panel', ['show-launcher']]);
	assert.deepEqual(offered({ appInstalled: true, route: LAUNCHER, error: 'unreachable' }), ['open-panel', ['show-launcher']]);
	assert.deepEqual(offered({ appInstalled: undefined, route: LAUNCHER, error: 'unreachable' }, elsewhere), ['open-panel', []], 'the bridge is paused from the panel on any platform');
	assert.deepEqual(offered({ appInstalled: false, route: LAUNCHER, error: 'unreachable' }), ['open-panel', []], 'no window of an app that is gone');
	assert.deepEqual(offered({ appInstalled: false, route: ABSENT }), ['project-page', []]);
	assert.deepEqual(offered({ appInstalled: undefined, route: LAUNCHER, health: HEALTHY }, elsewhere), [undefined, []]);
	assert.deepEqual(offered({ appInstalled: true, route: LAUNCHER, health: { ...HEALTHY, acceptingTurns: false } }), ['recheck', []]);
});

test('only the two ready states let an agent start', () => {
	const states: BridgeState[] = ['not-installed', 'not-set-up', 'launcher-closed', 'route-dead', 'foreign-route', 'paused', 'draining', 'busy', 'ready-browser-only', 'ready-full'];
	assert.deepEqual(states.filter(isReadyState), ['ready-browser-only', 'ready-full']);
});

test('the row: one line, the whole story in the tooltip, the action as a command, Re-check beside it', () => {
	assert.deepEqual(rowOfBridge(presentBridge({ appInstalled: true, launcherRunning: true, route: ABSENT })), {
		id: 'chatgpt-web',
		label: 'ChatGPT Web',
		detail: 'models not installed',
		tooltip: presentBridge({ appInstalled: true, launcherRunning: true, route: ABSENT }).message,
		state: 'off',
		action: { label: 'Open ChatGPT Web Panel', command: 'vibeAgents.chatgptWeb.openPanel' },
		secondaryActions: [{ label: 'Show Launcher Window', command: 'vibeAgents.chatgptWeb.showLauncher' }, { label: 'Re-check', command: 'vibeAgents.chatgptWeb.recheck', icon: 'refresh' }],
	});
	assert.deepEqual(rowOfBridge(presentBridge({ appInstalled: false, route: ABSENT })).action, { label: 'Project Page', command: 'vibeAgents.chatgptWeb.openProjectPage' });

	const ready = rowOfBridge(presentBridge({ appInstalled: true, route: LAUNCHER, health: HEALTHY }));
	assert.deepEqual([ready.label, ready.detail, ready.state, ready.action, ready.secondaryActions?.map(action => action.label)], ['ChatGPT Web', 'ready \u00b7 browser-only', 'ok', undefined, ['Re-check']]);

	const busy = rowOfBridge(presentBridge({ appInstalled: true, route: LAUNCHER, health: { ...HEALTHY, activeBrowserTurns: 1 } }));
	assert.deepEqual([busy.action, busy.secondaryActions], [{ label: 'Re-check', command: 'vibeAgents.chatgptWeb.recheck' }, undefined], 'Re-check is there once');
});

//#endregion

//#region Models

test('models: the slugs of the bridge with the names the view shows; manual-paste ones are no agents', () => {
	assert.deepEqual(CHATGPT_WEB_MODELS.map(model => [model.slug, model.label, model.terminal]), [
		['chatgpt-web/light', 'ChatGPT Web \u00b7 Instant', true],
		['chatgpt-web/medium', 'ChatGPT Web \u00b7 Medium', true],
		['chatgpt-web/high', 'ChatGPT Web \u00b7 High', true],
		['chatgpt-web/extra-high', 'ChatGPT Web \u00b7 Extra High', true],
		['chatgpt-web/pro', 'ChatGPT Web \u00b7 Pro', true],
		['chatgpt-web/luna', 'ChatGPT Web \u00b7 Luna', true],
		['chatgpt-web/think', 'ChatGPT Web \u00b7 Think', true],
		['chatgpt-web/zero-risk', 'ChatGPT Web \u00b7 Zero Risk', false],
		['chatgpt-web/zero-risk-pro', 'ChatGPT Web \u00b7 Zero Risk Pro', false],
	]);
	assert.deepEqual(terminalModels().map(model => model.slug.slice('chatgpt-web/'.length)), ['light', 'medium', 'high', 'extra-high', 'pro', 'luna', 'think']);
	assert.ok(CHATGPT_WEB_MODELS.every(model => model.description.length > 0));
	assert.equal(labelOfSlug('chatgpt-web/high'), 'ChatGPT Web \u00b7 High');
	assert.equal(labelOfSlug('chatgpt-web/next-year'), 'ChatGPT Web \u00b7 next-year', 'a slug a later launcher adds');
});

test('models: the slug of a command line', () => {
	assert.equal(slugOfCommandLine('codex -m chatgpt-web/high'), 'chatgpt-web/high');
	assert.equal(slugOfCommandLine('codex --model=chatgpt-web/extra-high --search'), 'chatgpt-web/extra-high');
	assert.equal(slugOfCommandLine('codex exec --model chatgpt-web/pro -'), 'chatgpt-web/pro');
	assert.equal(slugOfCommandLine('codex -m gpt-6-astra'), undefined);
	assert.equal(slugOfCommandLine('codex "about -m chatgpt-web/high"'), undefined, 'a prompt that talks about it');
	assert.equal(slugOfCommandLine('codex'), undefined);
});

test('the profile: codex -m <slug>, and nothing else: no effort flag, no environment', () => {
	const listed = chatGptWebProfile(undefined);
	assert.deepEqual([listed.id, listed.label, listed.command, listed.env], [CHATGPT_WEB_PROFILE_ID, 'ChatGPT Web (via Codex)', 'codex', undefined]);
	assert.equal(commandLineOf(listed), 'codex -m chatgpt-web/high', 'even unprepared it never starts Codex on a native model');

	const high = chatGptWebLaunchProfile('chatgpt-web/high');
	assert.deepEqual(high, { id: 'chatgpt-web', label: 'ChatGPT Web \u00b7 High', command: 'codex', args: ['-m', 'chatgpt-web/high'], icon: 'globe', matchCommand: listed.matchCommand });
	assert.equal(commandLineOf(chatGptWebLaunchProfile('chatgpt-web/extra-high')), 'codex -m chatgpt-web/extra-high');
	assert.ok(!/effort|reasoning/.test(JSON.stringify(high)));

	const pattern = new RegExp(listed.matchCommand ?? '');
	assert.ok(pattern.test('codex -m chatgpt-web/high'));
	assert.ok(pattern.test('codex --search --model=chatgpt-web/pro'));
	assert.ok(!pattern.test('codex -m gpt-6-astra'));
	assert.ok(!pattern.test('codex'));
});

//#endregion

//#region Probe schedule

class FakeTimers {
	now = 0;
	private next = 1;
	private readonly intervals = new Map<number, { callback: () => void; ms: number; due: number }>();

	readonly setInterval = (callback: () => void, ms: number): number => {
		this.intervals.set(this.next, { callback, ms, due: this.now + ms });
		return this.next++;
	};

	readonly clearInterval = (handle: unknown): void => {
		this.intervals.delete(handle as number);
	};

	get active(): number {
		return this.intervals.size;
	}

	advance(ms: number): void {
		const end = this.now + ms;
		for (; ;) {
			const due = [...this.intervals.values()].filter(interval => interval.due <= end).sort((a, b) => a.due - b.due)[0];
			if (!due) {
				break;
			}
			this.now = due.due;
			due.due += due.ms;
			due.callback();
		}
		this.now = end;
	}
}

test('probes: once when the view shows, every 30 s while it does, never while it is hidden', () => {
	const timers = new FakeTimers();
	const probes: number[] = [];
	const schedule = new ProbeSchedule(() => probes.push(timers.now), 30_000, timers);

	timers.advance(120_000);
	assert.deepEqual(probes, [], 'hidden from the start: nothing');

	schedule.setVisible(true);
	schedule.setVisible(true);
	assert.deepEqual(probes, [120_000], 'once on becoming visible');
	timers.advance(95_000);
	assert.deepEqual(probes, [120_000, 150_000, 180_000, 210_000]);

	schedule.setVisible(false);
	assert.equal(timers.active, 0);
	timers.advance(600_000);
	schedule.poke();
	assert.deepEqual(probes.length, 4, 'hidden: no timer, and a poke (window focus, settings) asks nothing');

	schedule.setVisible(true);
	assert.deepEqual(probes.at(-1), 815_000);
	timers.advance(10_000);
	schedule.poke();
	assert.deepEqual(probes.at(-1), 825_000, 'visible: a poke asks now');
	timers.advance(29_000);
	assert.deepEqual(probes.at(-1), 825_000, 'and the next one is 30 s after it');
	timers.advance(1_000);
	assert.deepEqual(probes.at(-1), 855_000);

	schedule.dispose();
	assert.equal(timers.active, 0);
	timers.advance(120_000);
	schedule.setVisible(true);
	assert.equal(probes.length, 7, 'disposed: nothing any more');
});

//#endregion
