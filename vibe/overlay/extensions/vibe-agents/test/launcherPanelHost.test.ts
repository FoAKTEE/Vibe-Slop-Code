// SPDX-License-Identifier: MIT

// The host of the ChatGPT Web webviews on a machine that is made up: what it asks the user, what it runs after the
// answer, when it looks at the engine, and what reaches a webview. Nothing in here starts a program or shows a dialog.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { LauncherPanelHost, type ConfirmRequest, type PanelUi, type Surface } from '../src/host/launcher/panelHost.ts';
import { operationOf } from '../src/model/launcher/operations.ts';
import type { CompactModel, LauncherInbound, PanelModel } from '../src/model/launcher/panel.ts';
import { TOKEN, exit, machine, type Machine } from './fakes/machine.ts';

interface Stage {
	m: Machine;
	host: LauncherPanelHost;
	questions: ConfirmRequest[];
	/** What the user answers, one per question. Runs out: the dialog is dismissed. */
	answers: ('go' | 'alternative' | undefined)[];
	panelsOpened: number;
	tick(): void;
	intervals: number[];
	surface(layout: Surface['layout']): Surface & { messages: LauncherInbound[]; last(): PanelModel | CompactModel | undefined };
}

function stage(t: TestContext): Stage {
	const m = machine(t);
	let tick: () => void = () => { };
	const s: Stage = {
		m, host: undefined!, questions: [], answers: [], panelsOpened: 0, intervals: [],
		tick: () => tick(),
		surface: layout => {
			const messages: LauncherInbound[] = [];
			return { layout, messages, post: message => { messages.push(JSON.parse(JSON.stringify(message)) as LauncherInbound); }, last: () => messages.filter(message => message.type === 'state').at(-1)?.model };
		},
	};
	const ui: PanelUi = {
		confirm: async request => { s.questions.push(request); return s.answers.shift(); },
		openPanel: () => { s.panelsOpened++; },
		log: () => { },
	};
	s.host = new LauncherPanelHost(m.controller, ui, { setInterval: (callback, ms) => { s.intervals.push(ms); tick = callback; return s.intervals.length; }, clearInterval: () => { tick = () => { }; } });
	t.after(() => s.host.dispose());
	return s;
}

const programs = (m: Machine) => m.calls.filter(call => /^(runtime (route (connect|disconnect)|doctor|service|subagents (native|compat))|codex|open|osascript)/.test(call));

test('confirmation: the question is the consequence of the catalogue, word for word; only going ahead runs anything', async t => {
	const s = stage(t);
	await s.host.refresh();
	s.m.calls.length = 0;

	const dismissed = await s.host.run('bridge.pause');
	assert.deepEqual(s.questions, [{ title: 'Pause Bridge?', detail: operationOf('bridge.pause').consequence, button: 'Pause Bridge', alternative: undefined }]);
	assert.deepEqual([dismissed.status, dismissed.message, s.m.calls, s.m.controller.snapshot.activity.filter(entry => entry.operation === 'bridge.pause')], ['cancelled', 'Not confirmed: nothing ran.', [], []], 'nothing ran, nothing was looked at, nothing was written down');

	s.answers = ['go'];
	const paused = await s.host.run('bridge.pause');
	assert.deepEqual([paused.status, programs(s.m), s.questions.length], ['ok', ['runtime route disconnect'], 2]);

	// no question where the catalogue asks none
	assert.equal((await s.host.run('doctor.run')).status, 'ok');
	assert.equal(s.questions.length, 2);
});

test('refusals: a precondition that does not hold says why and asks nothing; an unknown operation is none', async t => {
	const s = stage(t);
	await s.host.refresh();
	s.answers = ['go'];
	const refused = await s.host.run('bridge.connect');
	assert.deepEqual([refused.status, refused.message, programs(s.m)], ['refused', 'The bridge is connected already.', []]);
	assert.equal(s.questions.length, 1, 'it was asked, since it always asks; the fresh look then refused it');
	assert.equal((await s.host.run('engine.kill' as never)).status, 'refused');
});

test('the fresh look changes what there is to confirm: it is asked again, with the new words', async t => {
	const s = stage(t);
	await s.host.refresh();
	s.m.world.running = false; // the launcher closed after the panel last looked
	s.m.world.daemon = false;
	s.answers = ['go'];
	const shown = await s.host.run('engine.showWindow');
	assert.deepEqual([shown.status, s.questions.length, programs(s.m)], ['ok', 1, ['open']]);
	assert.match(s.questions[0].detail, /^This starts the launcher, which starts the daemon.*ALL Codex traffic/s, 'the controller looked first, and the question says what is true now');

	// and when the user does not go ahead the second time, nothing runs
	s.m.world.running = true;
	await s.m.controller.refresh('interval');
	s.m.world.running = false;
	s.m.calls.length = 0;
	s.answers = [undefined];
	assert.deepEqual([(await s.host.run('handoff.smokeTest')).status, programs(s.m)], ['cancelled', []]);
	assert.match(s.questions.at(-1)?.detail ?? '', /This starts the launcher.*ONE real message/s);
});

test('Quit Engine offers Pause Bridge First: that has its own question, and then quitting is asked again', async t => {
	const s = stage(t);
	await s.host.refresh();
	s.m.world.quitAfterPolls = 4;
	s.answers = ['alternative', 'go', 'go'];
	const quit = s.host.run('engine.quit');
	await s.m.advance(20_000);
	assert.equal((await quit).status, 'ok');
	assert.deepEqual(s.questions.map(question => [question.title, question.alternative]), [['Quit Engine?', 'Pause Bridge First'], ['Pause Bridge?', undefined], ['Quit Engine?', undefined]], 'the bridge is paused: there is nothing left to do first');
	assert.deepEqual(programs(s.m), ['runtime route disconnect', 'osascript quit']);
	assert.equal(s.m.controller.snapshot.view.bridge, 'paused', 'and native Codex keeps working');

	// pausing was not confirmed: the engine is not quit either
	const other = stage(t);
	await other.host.refresh();
	other.answers = ['alternative', undefined];
	assert.deepEqual([(await other.host.run('engine.quit')).operation, programs(other.m)], ['bridge.pause', []]);
});

test('one question at a time', async t => {
	const s = stage(t);
	await s.host.refresh();
	let answer: (value: 'go' | undefined) => void = () => { };
	const ui = s.host as unknown as { ui: PanelUi };
	ui.ui.confirm = request => { s.questions.push(request); return new Promise(resolve => { answer = resolve; }); };
	const first = s.host.run('bridge.pause');
	await s.m.settle();
	assert.deepEqual([(await s.host.run('engine.quit')).status, s.questions.length], ['refused', 1]);
	answer(undefined);
	assert.equal((await first).status, 'cancelled');
});

test('cadence: the runtime is asked when a view opens and on Refresh; the free probes every 30 s while one shows, and on focus', async t => {
	const s = stage(t);
	const view = s.surface('compact');
	const attached = s.host.attach(view, false);
	s.host.windowFocused();
	s.tick();
	await s.m.settle();
	assert.deepEqual([s.m.calls, view.messages], [[], []], 'attached and hidden: nothing');

	attached.setVisible(true);
	attached.onMessage({ type: 'ready' });
	await s.m.settle();
	await s.m.settle();
	const opened = ['list versions', 'runtime --version', 'pgrep', 'read /Users/someone/.codex/config.toml', 'runtime route status', 'GET /healthz :17841', 'runtime subagents status'];
	assert.deepEqual([s.m.calls.filter(call => call.startsWith('runtime')).length, s.intervals], [3, [30_000]], 'opened: the runtime is asked, once');
	assert.deepEqual(s.m.calls.slice(-7), opened);
	assert.equal(view.last()?.state, 'ready-browser-only');

	s.m.calls.length = 0;
	s.tick();
	await s.m.settle();
	s.host.windowFocused();
	await s.m.settle();
	assert.deepEqual(s.m.calls, ['pgrep', 'read /Users/someone/.codex/config.toml', 'GET /healthz :17841', 'pgrep', 'read /Users/someone/.codex/config.toml', 'GET /healthz :17841'], 'the timer and the focus: no program of the runtime');

	attached.setVisible(false);
	s.m.calls.length = 0;
	s.tick();
	s.host.windowFocused();
	await s.m.settle();
	assert.deepEqual(s.m.calls, [], 'hidden: nothing');

	// a second view: the panel. Each shows; the timer stops when the last one hides
	const panel = s.surface('panel');
	const panelAttached = s.host.attach(panel, true);
	panelAttached.onMessage({ type: 'ready' });
	await s.m.settle();
	await s.m.settle();
	assert.equal(s.m.calls.filter(call => call === 'runtime route status').length, 1, 'opening the panel asks the runtime again');
	s.m.calls.length = 0;
	panelAttached.onMessage({ type: 'refresh' });
	await s.m.settle();
	await s.m.settle();
	assert.deepEqual(s.m.calls, opened, 'Refresh is the user asking');
	panelAttached.dispose();
	s.m.calls.length = 0;
	s.tick();
	await s.m.settle();
	assert.deepEqual(s.m.calls, []);

	// NOTHING that changes the machine ever ran by itself
	assert.deepEqual([programs(s.m), s.questions], [[], []]);
});

test('a state that asks for attention is shown, and still nothing runs by itself', async t => {
	const s = stage(t);
	const view = s.surface('compact');
	const attached = s.host.attach(view, true);
	attached.onMessage({ type: 'ready' });
	await s.m.settle();
	Object.assign(s.m.world, { running: false, daemon: false });
	s.tick();
	await s.m.settle();
	const model = view.last() as CompactModel;
	assert.deepEqual([model.state, model.attention?.operations.map(operation => operation.id), programs(s.m), s.questions.length], ['route-dead', ['bridge.pause', 'engine.startHidden', 'engine.showWindow'], [], 0]);
	await s.m.advance(600_000);
	assert.deepEqual(programs(s.m), [], 'not the bridge, not the engine: only a click does');
});

test('what a webview sends: an operation goes the way of every button; anything else is dropped', async t => {
	const s = stage(t);
	const panel = s.surface('panel');
	const attached = s.host.attach(panel, true);
	attached.onMessage({ type: 'ready' });
	await s.m.settle();
	await s.m.settle();
	s.m.calls.length = 0;

	for (const hostile of [{ type: 'run', id: 'setup' }, { type: 'run', id: 'bridge.pause; rm -rf' }, { type: 'confirmed', id: 'bridge.pause' }, { type: 'run' }, 'run', null]) {
		attached.onMessage(hostile);
	}
	await s.m.settle();
	assert.deepEqual([s.m.calls, s.questions], [[], []]);

	attached.onMessage({ type: 'run', id: 'bridge.pause', confirmed: true });
	await s.m.settle();
	assert.deepEqual([s.questions.length, programs(s.m)], [1, []], 'a webview cannot confirm: the dialog is asked, and it was dismissed');
	assert.deepEqual((panel.last() as PanelModel).result, { status: 'cancelled', text: 'Pause Bridge: Not confirmed: nothing ran.' });

	// a queued operation is taken out by its ticket
	s.m.script.set('doctor --json', () => new Promise(() => { }));
	attached.onMessage({ type: 'run', id: 'doctor.run' });
	attached.onMessage({ type: 'run', id: 'models.refresh' });
	await s.m.settle();
	const queued = (panel.last() as PanelModel).screens.find(screen => screen.id === 'models')!.items[0].operations[0];
	assert.deepEqual([queued.busy, typeof queued.cancelTicket, (panel.last() as PanelModel).busy?.label], ['queued', 'number', 'Run Doctor']);
	attached.onMessage({ type: 'cancel', ticket: queued.cancelTicket });
	await s.m.settle();
	assert.equal((panel.last() as PanelModel).screens.find(screen => screen.id === 'models')!.items[0].operations[0].busy, undefined);
});

test('Open full panel: the panel is shown, on the screen that was asked for, also when it is created only then', async t => {
	const s = stage(t);
	const view = s.surface('compact');
	const viewAttached = s.host.attach(view, true);
	viewAttached.onMessage({ type: 'ready' });
	viewAttached.onMessage({ type: 'openPanel', screen: 'setup' });
	assert.equal(s.panelsOpened, 1);

	const panel = s.surface('panel');
	const panelAttached = s.host.attach(panel, true);
	assert.equal(panel.messages.length, 0, 'a webview gets nothing before it is ready');
	panelAttached.onMessage({ type: 'ready' });
	assert.deepEqual(panel.messages.map(message => message.type === 'show' ? `show ${message.screen}` : message.type), ['state', 'show setup']);

	s.host.openPanel('doctor');
	assert.deepEqual([s.panelsOpened, panel.messages.at(-1)], [2, { type: 'show', screen: 'doctor' }]);
	s.host.openPanel();
	assert.equal(panel.messages.filter(message => message.type === 'show').length, 2, 'no screen asked for: it stays where it is');
});

test('what reaches a webview holds nothing of the machine and nothing a program wrote; the same state is not sent twice', async t => {
	const s = stage(t);
	const nasty = `codex-chatgpt-web: EACCES: permission denied, open '/Users/someone/.codex-chatgpt-web/config.json' (Bearer ${TOKEN})\n    at readFileSync (/Users/someone/.codex-chatgpt-web/versions/5.0.8-darwin-arm64/app/cli.js:1:1)\nUSER PROMPT: secret\n`;
	s.m.script.set('doctor --json', () => exit('{"ok": tr', 134, nasty));
	s.m.script.set('subagents status', () => exit(`warn /Users/someone/.codex-chatgpt-web/runtime\ntoken ${TOKEN}\nUSER PROMPT: secret\n`));
	const surfaces = [s.surface('panel'), s.surface('compact')];
	for (const surface of surfaces) {
		s.host.attach(surface, true).onMessage({ type: 'ready' });
	}
	await s.m.settle();
	await s.m.settle();
	await s.host.run('doctor.run');
	await s.m.settle();

	for (const surface of surfaces) {
		const serialized = JSON.stringify(surface.messages);
		assert.ok(surface.messages.length > 1 && !/\/Users\/|someone|AbCdEf|PROMPT|secret|cli\.js|stdout|stderr/.test(serialized), serialized.match(/.{80}(\/Users\/|someone|AbCdEf|PROMPT|secret|cli\.js|stdout|stderr).{40}/)?.[0]);
	}
	assert.match((surfaces[0].last() as PanelModel).result?.text ?? '', /^Run Doctor: EACCES: permission denied, open '~\/\.codex-chatgpt-web\/config\.json' \(Bearer \[redacted\]\)$/);

	const before = surfaces[0].messages.length;
	await s.m.controller.refresh('interval');
	await s.m.settle();
	assert.equal(surfaces[0].messages.length, before, 'nothing changed: nothing is sent');
});
