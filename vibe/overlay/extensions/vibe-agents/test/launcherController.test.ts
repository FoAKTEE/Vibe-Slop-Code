// SPDX-License-Identifier: MIT

// The controller on a machine that is made up: what it runs is written down, what it gets back is scripted, and the
// clock only moves when a test moves it. Nothing in here starts a program or opens a socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OperationOutcome } from '../src/host/launcher/controller.ts';
import type { RunResult } from '../src/host/launcher/system.ts';
import { TOKEN, exit, machine, type Machine } from './fakes/machine.ts';

const programs = (m: Machine) => m.calls.filter(call => /^(runtime|codex|open|osascript)/.test(call));
const brief = (outcome: OperationOutcome) => [outcome.operation, outcome.status];

test('the panel opens: the runtime is found and asked once; the timer asks nothing that starts a program', async t => {
	const m = machine(t);
	let changes = 0;
	m.controller.onDidChange(() => changes++);
	assert.equal(m.controller.snapshot.view.bridge, 'not-set-up', 'before anything was looked at: nothing is known');

	await m.controller.refresh('open');
	assert.deepEqual(m.calls, ['list versions', 'runtime --version', 'pgrep', 'read /Users/someone/.codex/config.toml', 'runtime route status', 'GET /healthz :17841', 'runtime subagents status']);
	const snapshot = m.controller.snapshot;
	assert.deepEqual([snapshot.view.bridge, snapshot.facts.runtime, snapshot.running, snapshot.queued], ['ready-browser-only', { found: true, source: 'versions', version: '5.0.8' }, undefined, []]);
	assert.deepEqual(snapshot.activity.map(entry => [entry.operation, entry.command, entry.outcome, entry.note]), [
		['probe.runtime', 'codex-chatgpt-web --version', 'ok', 'runtime 5.0.8'],
		['probe.routeStatus', 'codex-chatgpt-web route status', 'ok', 'route: installed, connected'],
		['probe.subagents', 'codex-chatgpt-web subagents status', 'ok', 'protocol: compatibility-v1'],
		['probe.health', undefined, 'ok', 'state: ready-browser-only'],
	]);
	assert.ok(changes > 0 && Object.isFrozen(snapshot) && m.controller.snapshot === snapshot, 'one snapshot until something changes');

	m.calls.length = 0;
	await m.controller.refresh('interval');
	await m.controller.refresh('interval');
	assert.deepEqual(m.calls, ['pgrep', 'read /Users/someone/.codex/config.toml', 'GET /healthz :17841', 'pgrep', 'read /Users/someone/.codex/config.toml', 'GET /healthz :17841']);
	assert.equal(m.controller.snapshot.activity.length, 4, 'and it writes nothing down while nothing changes');

	m.world.daemon = false;
	m.world.running = false;
	await m.controller.refresh('interval');
	assert.deepEqual([m.controller.snapshot.view.bridge, m.controller.snapshot.view.attention?.id, m.controller.snapshot.activity.at(-1)?.note], ['route-dead', 'state', 'state: route-dead']);
});

test('not set up: no port is known, so no port is asked; what is not installed is not asked about', async t => {
	const m = machine(t);
	Object.assign(m.world, { installed: false, active: false, daemon: false });
	await m.controller.refresh('open');
	assert.deepEqual(m.calls, ['list versions', 'runtime --version', 'pgrep', 'read /Users/someone/.codex/config.toml', 'runtime route status']);
	assert.equal(m.controller.snapshot.view.bridge, 'not-set-up');
});

test('one at a time: what is requested meanwhile waits in the queue, in order; the same request is not added twice', async t => {
	const m = machine(t);
	await m.controller.refresh('open');
	m.calls.length = 0;

	let finishDoctor: (result: RunResult) => void = () => { };
	m.script.set('doctor --json', () => new Promise(resolve => { finishDoctor = resolve; }));
	const doctor = m.controller.request('doctor.run');
	const again = m.controller.request('doctor.run');
	const pause = m.controller.request('bridge.pause', { confirmed: true });
	const models = m.controller.request('models.refresh');
	await m.settle();

	assert.deepEqual([again.ticket, again.done], [doctor.ticket, doctor.done]);
	assert.deepEqual([m.controller.snapshot.running?.operation, m.controller.snapshot.queued.map(job => job.operation)], ['doctor.run', ['bridge.pause', 'models.refresh']]);
	assert.deepEqual(programs(m), ['runtime doctor --json'], 'nothing else started');

	finishDoctor(exit({ ok: false, checks: [{ id: 'proxy', status: 'error', message: 'Responses proxy is not reachable' }] }, 1));
	assert.deepEqual([brief(await doctor.done), brief(await pause.done), brief(await models.done)], [['doctor.run', 'ok'], ['bridge.pause', 'ok'], ['models.refresh', 'refused']]);
	assert.deepEqual(programs(m), ['runtime doctor --json', 'runtime route disconnect', 'runtime route status'], 'the catalog is not asked for through a paused route');
	assert.equal(m.mostAtOnce, 1);
	assert.match((await doctor.done).message, /found 1 problem/);
	assert.deepEqual([m.controller.snapshot.running, m.controller.snapshot.queued, m.controller.snapshot.lastOutcome?.operation], [undefined, [], 'models.refresh']);
});

test('confirmation: what has a consequence does not run until it was asked about, and says what to ask', async t => {
	const m = machine(t);
	await m.controller.refresh('open');
	m.calls.length = 0;
	const before = m.controller.snapshot.activity.length;

	const asked = await m.controller.request('bridge.pause').done;
	assert.deepEqual([asked.status, asked.ticket, asked.confirmation?.button], ['needs-confirmation', 0, 'Pause Bridge']);
	assert.match(asked.confirmation?.text ?? '', /Restores the previous route of Codex/);
	assert.deepEqual([m.calls, m.controller.snapshot.activity.length], [[], before], 'nothing ran, nothing was looked at, nothing was written down');

	// a hand-off only shows a window -- unless that starts the engine
	assert.deepEqual(brief(await m.controller.request('handoff.installModels').done), ['handoff.installModels', 'ok']);
	assert.equal(m.controller.snapshot.lastOutcome?.hint, 'Setup > 3 Install into Codex > Install models (Reinstall when it ran before), then fully quit and reopen Codex');
	m.world.running = false;
	m.world.daemon = false;
	await m.controller.refresh('interval');
	const starts = await m.controller.request('handoff.smokeTest').done;
	assert.deepEqual([starts.status, /^This starts the launcher.*ONE real message/s.test(starts.message)], ['needs-confirmation', true]);

	// the launcher closed after the panel last looked: the fresh look finds out, and it still asks
	m.world.running = true;
	await m.controller.refresh('interval');
	m.world.running = false;
	m.calls.length = 0;
	assert.deepEqual(brief(await m.controller.request('engine.showWindow').done), ['engine.showWindow', 'needs-confirmation']);
	assert.deepEqual(programs(m), []);
	assert.deepEqual(brief(await m.controller.request('engine.showWindow', { confirmed: true }).done), ['engine.showWindow', 'ok']);
	assert.deepEqual(programs(m), ['open']);
});

test('preconditions are decided on a fresh look, and a refusal runs nothing', async t => {
	const m = machine(t);
	m.world.active = false;
	await m.controller.refresh('open');
	assert.equal(m.controller.snapshot.view.bridge, 'paused');

	m.world.daemon = false; // the launcher quit after the panel last looked
	m.calls.length = 0;
	const refused = await m.controller.request('bridge.connect', { confirmed: true }).done;
	assert.deepEqual([refused.status, /a port nobody listens on/.test(refused.message), programs(m)], ['refused', true, []]);
	assert.deepEqual(m.controller.snapshot.activity.at(-1), { seq: m.controller.snapshot.activity.at(-1)!.seq, at: 1_000_000, operation: 'bridge.connect', command: undefined, outcome: 'refused', durationMs: 0, exitCode: undefined, note: 'a precondition does not hold' });

	m.world.daemon = true;
	const connected = await m.controller.request('bridge.connect', { confirmed: true }).done;
	assert.deepEqual([connected.status, connected.message], ['ok', 'The bridge is connected: all Codex traffic goes through the launcher. Restart Codex.']);
	assert.deepEqual(m.calls.slice(-4), ['runtime route connect', 'runtime route status', 'read /Users/someone/.codex/config.toml', 'GET /healthz :17841'], 'and what it changed is looked at again');
	assert.equal(m.controller.snapshot.view.bridge, 'ready-browser-only');

	assert.deepEqual(brief(await m.controller.request('engine.kill' as never).done), ['engine.kill', 'refused']);
	assert.deepEqual(brief(await m.controller.request('turns.cancel', { confirmed: true }).done), ['turns.cancel', 'refused']);
	m.world.turns = 2;
	const cancelled = await m.controller.request('turns.cancel', { confirmed: true }).done;
	assert.deepEqual([cancelled.status, cancelled.message, m.controller.snapshot.facts.health?.activeBrowserTurns], ['ok', 'Cancelled 1 HTTP and 1 browser turn.', 0]);
});

test('what the runtime claims is checked: a route that did not change is a failure, and nothing is tried again', async t => {
	const m = machine(t);
	await m.controller.refresh('open');
	m.script.set('route disconnect', () => exit({ changed: true, active: false })); // says so, and changes nothing
	m.calls.length = 0;
	const outcome = await m.controller.request('bridge.pause', { confirmed: true }).done;
	assert.deepEqual([outcome.status, outcome.message], ['failed', 'The runtime answered, but the route of Codex is still connected. Nothing is tried again by itself.']);
	assert.equal(m.calls.filter(call => call === 'runtime route disconnect').length, 1);
});

test('a machine that never answers: the deadline is the clock of the controller, and the queue goes on', async t => {
	const m = machine(t);
	await m.controller.refresh('open');
	m.script.set('route disconnect', () => new Promise(() => { }));
	const pause = m.controller.request('bridge.pause', { confirmed: true });
	const doctor = m.controller.request('doctor.run');
	await m.advance(17_999);
	assert.equal(m.controller.snapshot.running?.operation, 'bridge.pause');
	assert.equal(m.controller.cancel(pause.ticket), false, 'what writes the config of Codex is not ended half way');
	await m.advance(1);
	assert.deepEqual([brief(await pause.done), brief(await doctor.done)], [['bridge.pause', 'timeout'], ['doctor.run', 'ok']]);
	assert.equal(m.calls.filter(call => call === 'runtime route disconnect').length, 1, 'never again by itself');
	assert.deepEqual(m.controller.snapshot.activity.filter(entry => entry.operation === 'bridge.pause').map(entry => [entry.outcome, entry.durationMs]), [['timeout', 18_000]]);
});

test('cancel: out of the queue before it starts; what only reads is ended; the rest of the queue runs', async t => {
	const m = machine(t);
	await m.controller.refresh('open');
	m.calls.length = 0;
	let aborted = false;
	m.script.set('doctor --json', () => new Promise(resolve => {
		const wait = setInterval(() => {
			if (aborted) {
				clearInterval(wait);
				resolve({ kind: 'cancelled' });
			}
		}, 1);
	}));
	const run = m.system.run;
	m.system.run = (exe, args, options) => { options.signal?.addEventListener('abort', () => { aborted = true; }); return run(exe, args, options); };

	const doctor = m.controller.request('doctor.run');
	const native = m.controller.request('subagents.useNative', { confirmed: true });
	const models = m.controller.request('models.refresh');
	await m.settle();
	assert.equal(m.controller.cancel(native.ticket), true);
	assert.deepEqual(brief(await native.done), ['subagents.useNative', 'cancelled']);
	assert.equal(m.controller.cancel(doctor.ticket), true);
	assert.deepEqual([brief(await doctor.done), brief(await models.done)], [['doctor.run', 'cancelled'], ['models.refresh', 'ok']]);
	assert.deepEqual(programs(m), ['runtime doctor --json', 'codex debug models'], 'the one that was taken out never started');
	assert.equal(m.controller.cancel(9999), false);
	assert.deepEqual(m.controller.snapshot.activity.filter(entry => entry.outcome === 'cancelled').map(entry => [entry.operation, entry.note]), [['subagents.useNative', 'taken out of the queue'], ['doctor.run', undefined]]);
});

test('the engine takes a while: after it was started the free probes run again, and the journal once the route shows', async t => {
	const m = machine(t);
	Object.assign(m.world, { running: false, daemon: false, active: false });
	await m.controller.refresh('open');
	assert.equal(m.controller.snapshot.view.bridge, 'paused');
	m.calls.length = 0;

	assert.deepEqual(brief(await m.controller.request('engine.startHidden').done), ['engine.startHidden', 'needs-confirmation']);
	const started = await m.controller.request('engine.startHidden', { confirmed: true }).done;
	assert.deepEqual([started.status, started.message, programs(m)], ['ok', 'The launcher is starting without its window.', ['open hidden']]);

	m.calls.length = 0;
	await m.advance(2000);
	assert.deepEqual(m.calls, ['pgrep', 'read /Users/someone/.codex/config.toml', 'GET /healthz :17841']);
	Object.assign(m.world, { daemon: true, active: true }); // the launcher connected the route by itself
	await m.advance(4000);
	assert.deepEqual(m.calls.slice(3), ['pgrep', 'read /Users/someone/.codex/config.toml', 'GET /healthz :17841', 'runtime route status']);
	assert.equal(m.controller.snapshot.view.bridge, 'ready-browser-only');
	await m.advance(60_000);
	assert.equal(m.calls.filter(call => call === 'pgrep').length, 3, 'three looks, then it is the business of the timer again');
	assert.equal(m.calls.filter(call => call === 'runtime route status').length, 1);

	assert.deepEqual(brief(await m.controller.request('engine.startHidden', { confirmed: true }).done), ['engine.startHidden', 'refused'], 'running already');
});

test('quit: the quit event, never a signal; whether it went is seen in the process list', async t => {
	const m = machine(t);
	await m.controller.refresh('open');
	m.calls.length = 0;
	const asked = await m.controller.request('engine.quit').done;
	assert.deepEqual([asked.status, asked.confirmation?.suggestFirst], ['needs-confirmation', { id: 'bridge.pause', label: 'Pause Bridge' }]);

	m.world.quitAfterPolls = 3; // one look before it, then it is gone at the second look after the event
	const quit = m.controller.request('engine.quit', { confirmed: true });
	await m.advance(500);
	assert.equal(m.controller.snapshot.running?.operation, 'engine.quit');
	await m.advance(1000);
	const outcome = await quit.done;
	assert.deepEqual([outcome.status, outcome.message], ['ok', 'The launcher quit, and its daemon with it.'], 'the exit code of osascript (-128: the launcher answers before it is gone) does not decide');
	assert.deepEqual(programs(m), ['osascript quit']);
	assert.equal(m.controller.snapshot.view.bridge, 'route-dead', 'and the route is still there: that is what the confirmation said');

	const stubborn = machine(t);
	await stubborn.controller.refresh('open');
	const refused = stubborn.controller.request('engine.quit', { confirmed: true });
	await stubborn.advance(20_000);
	assert.deepEqual([(await refused.done).status, /still running.*never killed/s.test((await refused.done).message), stubborn.calls.filter(call => /kill/.test(call))], ['failed', true, []]);
});

test('links open in the browser of the user, and only the four of the catalogue', async t => {
	const m = machine(t);
	assert.deepEqual(brief(await m.controller.request('link.tunnels').done), ['link.tunnels', 'ok']);
	assert.deepEqual(m.opened, ['https://platform.openai.com/settings/organization/tunnels']);
	const without = machine(t, { openExternal: false });
	assert.deepEqual(brief(await without.controller.request('link.project').done), ['link.project', 'refused']);
});

test('not macOS: the engine is not started or stopped from here, the bridge still is', async t => {
	const m = machine(t, { platform: 'linux' });
	m.world.running = undefined;
	await m.controller.refresh('open');
	assert.deepEqual(brief(await m.controller.request('engine.startHidden', { confirmed: true }).done), ['engine.startHidden', 'refused']);
	assert.deepEqual(brief(await m.controller.request('bridge.pause', { confirmed: true }).done), ['bridge.pause', 'ok']);
});

test('nothing a program wrote reaches the log, and only one sanitized line reaches the panel', async t => {
	const m = machine(t);
	await m.controller.refresh('open');
	const nasty = `codex-chatgpt-web: EACCES: permission denied, open '/Users/someone/.codex-chatgpt-web/config.json' (Bearer ${TOKEN})\n    at readFileSync (/Users/someone/.codex-chatgpt-web/versions/5.0.8-darwin-arm64/app/cli.js:1:1)\nUSER PROMPT: secret\n`;
	m.script.set('doctor --json', () => exit('{"ok": tr', 134, nasty));
	m.script.set('route status', () => exit(`warn /Users/someone/.codex-chatgpt-web/runtime\ntoken ${TOKEN}\nUSER PROMPT: secret\n`));
	m.script.set('subagents status', () => ({ kind: 'overflow' }));
	m.script.set('debug models', () => exit('', 1, `stream error: error sending request for url (http://127.0.0.1:17841/v1/models?key=${TOKEN})`));

	const doctor = await m.controller.request('doctor.run').done;
	assert.deepEqual([doctor.status, doctor.message], ['failed', 'EACCES: permission denied, open \'~/.codex-chatgpt-web/config.json\' (Bearer [redacted])']);
	assert.deepEqual(brief(await m.controller.request('probe.routeStatus').done), ['probe.routeStatus', 'unparseable']);
	assert.deepEqual(brief(await m.controller.request('probe.subagents').done), ['probe.subagents', 'failed']);
	assert.deepEqual(brief(await m.controller.request('models.refresh').done), ['models.refresh', 'failed']);

	const snapshot = m.controller.snapshot;
	assert.ok(!/\/Users\/|someone|AbCdEf|PROMPT|secret|cli\.js/.test(JSON.stringify(snapshot.activity)), JSON.stringify(snapshot.activity));
	assert.ok(!/\/Users\/|AbCdEf|PROMPT|secret|cli\.js/.test(JSON.stringify([snapshot.view, snapshot.facts, snapshot.lastOutcome])), 'not even the path of the runtime');
	assert.deepEqual(snapshot.activity.slice(-4).map(entry => [entry.operation, entry.outcome, entry.exitCode, entry.note]), [
		['doctor.run', 'failed', 134, undefined], ['probe.routeStatus', 'unparseable', 0, undefined], ['probe.subagents', 'failed', undefined, 'answer too large'], ['models.refresh', 'failed', 1, undefined],
	]);
});

test('another installation than the one that was asked about: what the doctor, Codex and the runtime said about the old one is dropped', async t => {
	const m = machine(t);
	await m.controller.refresh('open');
	await m.controller.request('doctor.run').done;
	await m.controller.request('models.refresh').done;
	assert.deepEqual([m.controller.snapshot.facts.doctor?.kind, m.controller.snapshot.facts.models?.kind, m.controller.snapshot.facts.subagents?.kind], ['doctor', 'models', 'subagents-status']);

	Object.assign(m.world, { installed: false, active: false, daemon: false }); // Remove Codex integration ran, in the launcher
	await m.controller.refresh('open');
	const facts = m.controller.snapshot.facts;
	assert.deepEqual([m.controller.snapshot.view.bridge, facts.doctor, facts.doctorAt, facts.models, facts.subagents], ['not-set-up', undefined, undefined, undefined, undefined]);
});

test('disposed: what waits is cancelled, timers are gone, and nothing more starts', async t => {
	const m = machine(t);
	await m.controller.refresh('open');
	m.script.set('doctor --json', () => new Promise(() => { }));
	const doctor = m.controller.request('doctor.run');
	const models = m.controller.request('models.refresh');
	await m.settle();
	m.calls.length = 0;
	m.controller.dispose();
	assert.deepEqual(brief(await models.done), ['models.refresh', 'cancelled']);
	assert.deepEqual(brief(await m.controller.request('doctor.run').done), ['doctor.run', 'cancelled']);
	await m.advance(120_000);
	assert.deepEqual(m.calls, []);
	void doctor;
});
