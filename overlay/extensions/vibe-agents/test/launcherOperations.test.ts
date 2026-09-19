// SPDX-License-Identifier: MIT

// The catalogue of what the panel can do: what each operation runs, exactly; what it says before it runs; when it
// asks first; and when it is not offered. Nothing in here runs anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPERATIONS, argvOf, checkPreconditions, confirmationOf, isAbortable, operationOf, resolveOperation, type OperationId } from '../src/model/launcher/operations.ts';
import { emptyFacts, type LauncherFacts } from '../src/model/launcher/facts.ts';
import { runtimeCommandOf, type EngineHealth, type RouteStatus } from '../src/model/launcher/runtime.ts';

const BUNDLE = 'dev.codexwebgpt.launcher';
const HEALTH: EngineHealth = { mode: 'browser-only', acceptingTurns: true, activeBrowserTurns: 0, version: '5.0.8', activeHttpTurns: 0, catalogRequests: 1, catalogVerified: true, uptimeSeconds: 60 };
const ROUTE: RouteStatus = { kind: 'route-status', installed: true, active: true, port: 17841, errors: [], extra: {} };

function facts(patch: Partial<LauncherFacts> = {}): LauncherFacts {
	return { ...emptyFacts('darwin'), appInstalled: true, launcherRunning: true, configRoute: { kind: 'launcher', port: 17841 }, health: HEALTH, runtime: { found: true, source: 'versions', version: '5.0.8' }, route: ROUTE, ...patch };
}

test('every operation runs exactly this, and nothing else exists', () => {
	const seams = Object.fromEntries(OPERATIONS.map(operation => {
		const argv = argvOf(operation, { bundleId: BUNDLE });
		return [operation.id, argv ? [argv.program, ...argv.args].join(' ') : operation.seam.via === 'external' ? operation.seam.url : `(${operation.seam.via}: ${'what' in operation.seam ? operation.seam.what : ''})`];
	}));
	assert.deepEqual(seams, {
		'probe.engine': 'pgrep -f Codex Web GPT.app/Contents/MacOS/',
		'probe.codexRoute': '(facts: codex-route)',
		'probe.health': '(facts: health)',
		'probe.runtime': 'runtime --version',
		'probe.routeStatus': 'runtime route status',
		'probe.subagents': 'runtime subagents status',
		'models.refresh': 'codex debug models',
		'doctor.run': 'runtime doctor --json',
		'bridge.connect': 'runtime route connect',
		'bridge.pause': 'runtime route disconnect',
		'turns.cancel': 'runtime service cancel-turns',
		'engine.startHidden': `open -g -j -b ${BUNDLE} --args --hidden`,
		'engine.showWindow': `open -b ${BUNDLE}`,
		'engine.quit': `osascript -e tell application id "${BUNDLE}" to quit`,
		'subagents.useCompatibility': 'runtime subagents compatibility-v1',
		'subagents.useNative': 'runtime subagents native',
		'link.project': 'https://github.com/miuuyy/codex-chatgpt-web',
		'link.tunnels': 'https://platform.openai.com/settings/organization/tunnels',
		'link.apiKeys': 'https://platform.openai.com/settings/organization/api-keys',
		'link.connectors': 'https://chatgpt.com/#settings/Plugins',
		'handoff.signIn': `open -b ${BUNDLE}`,
		'handoff.smokeTest': `open -b ${BUNDLE}`,
		'handoff.installModels': `open -b ${BUNDLE}`,
		'handoff.mcpConnect': `open -b ${BUNDLE}`,
		'handoff.verifyConnector': `open -b ${BUNDLE}`,
		'handoff.interactionMode': `open -b ${BUNDLE}`,
		'handoff.biggerContext': `open -b ${BUNDLE}`,
		'handoff.skillsAsFiles': `open -b ${BUNDLE}`,
		'handoff.zeroRiskPro': `open -b ${BUNDLE}`,
		'handoff.launchAtLogin': `open -b ${BUNDLE}`,
		'handoff.removeIntegration': `open -b ${BUNDLE}`,
		'handoff.exportLog': `open -b ${BUNDLE}`,
	});

	// what runs the runtime is on its allow-list; what sets up, signs in, serves or removes is not even expressible
	for (const operation of OPERATIONS) {
		const argv = argvOf(operation, { bundleId: BUNDLE });
		if (argv?.program === 'runtime') {
			assert.notEqual(runtimeCommandOf(argv.args), undefined, operation.id);
		}
	}
	assert.ok(!JSON.stringify(OPERATIONS.map(operation => argvOf(operation, { bundleId: BUNDLE }))).match(/setup|login|uninstall|serve|tunnel|"exec"|kill/));
	assert.throws(() => argvOf(operationOf('engine.quit'), { bundleId: 'x" & do shell script "id' }), /bundle id/);
});

test('kinds: probes run by themselves only where that is free of consequence; hand-offs carry their step', () => {
	const byKind = (kind: string) => OPERATIONS.filter(operation => operation.kind === kind).map(operation => operation.id);
	assert.deepEqual(byKind('probe'), ['probe.engine', 'probe.codexRoute', 'probe.health', 'probe.runtime', 'probe.routeStatus', 'probe.subagents']);
	assert.deepEqual(OPERATIONS.filter(operation => operation.cadence === 'interval').map(operation => operation.id), ['probe.engine', 'probe.codexRoute', 'probe.health'], 'only what reads a process list, one key and one loopback GET repeats');
	assert.deepEqual(OPERATIONS.filter(operation => operation.cadence === 'open').map(operation => operation.id), ['probe.runtime', 'probe.routeStatus', 'probe.subagents'], 'the runtime is asked when the panel opens and on Refresh, never on a timer');
	assert.ok(OPERATIONS.filter(operation => operation.kind !== 'probe').every(operation => operation.cadence === 'click'));

	assert.deepEqual(Object.fromEntries(OPERATIONS.filter(operation => operation.kind === 'handoff').map(operation => [operation.id, operation.hint])), {
		'handoff.signIn': 'Setup > 1 Sign in to ChatGPT > Open sign in (or Browser > Use passkey)',
		'handoff.smokeTest': 'Setup > 2 Run browser smoke test > Run smoke test',
		'handoff.installModels': 'Setup > 3 Install into Codex > Install models (Reinstall when it ran before), then fully quit and reopen Codex',
		'handoff.mcpConnect': 'MCP > 2 Connect the local harness > Tunnel ID and API key > Connect harness',
		'handoff.verifyConnector': 'MCP > 3 Attach the ChatGPT connector > Verify runtime',
		'handoff.interactionMode': 'Settings > General > ChatGPT interaction (With Automation or Zero Risk)',
		'handoff.biggerContext': 'Settings > General > Bigger Context (experimental)',
		'handoff.skillsAsFiles': 'Settings > General > Skills as files (experimental)',
		'handoff.zeroRiskPro': 'Setup > Install into Codex > Zero Risk model profiles > Pro',
		'handoff.launchAtLogin': 'Settings > General > Launch at login',
		'handoff.removeIntegration': 'Settings > Diagnostics > Remove Codex integration',
		'handoff.exportLog': 'Activity > Export safe log',
	});
	assert.ok(OPERATIONS.every(operation => operation.kind === 'handoff' ? (operation.why ?? '').length > 40 : operation.hint === undefined && operation.why === undefined), 'a hand-off says why the step is there and not here');
	assert.deepEqual(OPERATIONS.filter(operation => isAbortable(operation.id)).map(operation => operation.id), ['probe.engine', 'probe.codexRoute', 'probe.health', 'probe.runtime', 'probe.routeStatus', 'probe.subagents', 'models.refresh', 'doctor.run'], 'only what reads can be ended half way');
});

test('confirmation: what changes Codex, the engine or a running turn always asks; what opens the launcher asks when that starts it', () => {
	assert.deepEqual(Object.fromEntries(OPERATIONS.filter(operation => operation.confirm !== 'never').map(operation => [operation.id, operation.confirm])), {
		'bridge.connect': 'always', 'bridge.pause': 'always', 'turns.cancel': 'always', 'engine.startHidden': 'always', 'engine.quit': 'always',
		'subagents.useCompatibility': 'always', 'subagents.useNative': 'always',
		'engine.showWindow': 'if-starts-engine',
		...Object.fromEntries(OPERATIONS.filter(operation => operation.kind === 'handoff').map(operation => [operation.id, 'if-starts-engine'])),
	});
	assert.ok(OPERATIONS.filter(operation => operation.kind === 'probe').every(operation => operation.confirm === 'never' && operation.consequence === ''), 'a probe has no consequence');
	assert.ok(OPERATIONS.filter(operation => operation.kind !== 'probe' && operation.seam.via !== 'external').every(operation => operation.consequence.length > 40), 'everything else says what it does');

	const running = facts();
	const stopped = facts({ launcherRunning: false, health: undefined });
	assert.equal(confirmationOf(operationOf('engine.showWindow'), running), undefined);
	assert.equal(confirmationOf(operationOf('handoff.smokeTest'), running), undefined, 'the message is sent by a click in the launcher, not by opening its window');
	assert.match(confirmationOf(operationOf('handoff.smokeTest'), stopped)?.text ?? '', /^This starts the launcher.*ALL Codex traffic.*ONE real message/s);
	assert.match(confirmationOf(operationOf('engine.showWindow'), facts({ launcherRunning: undefined }))?.text ?? '', /^It is not known whether the launcher runs\. If it does not, this starts it, which starts the daemon.*ALL Codex traffic/s, 'not known whether it runs: asks, and says so');
	assert.deepEqual(confirmationOf(operationOf('bridge.connect'), running), { text: operationOf('bridge.connect').consequence, button: 'Connect Bridge', suggestFirst: undefined });
	assert.equal(confirmationOf(operationOf('doctor.run'), running), undefined);
});

test('consequences: the words of the safety table, never softened', () => {
	const said = (id: OperationId) => operationOf(id).consequence;
	assert.match(said('bridge.connect'), /ALL Codex traffic on this machine.*native models included.*launcher must stay running.*every Codex run on this machine fails/s);
	assert.match(said('bridge.pause'), /Restores the previous route of Codex.*journal.*model cache.*ChatGPT Web models disappear.*reconnects the route the next time it starts/s);
	assert.match(said('engine.startHidden'), /starts the daemon.*re-connects the route.*ALL Codex traffic.*tray/s);
	assert.match(said('engine.quit'), /cancels active turns.*stops the daemon.*does NOT restore the route.*every Codex run on this machine fails/s);
	assert.match(said('turns.cancel'), /Aborts the active HTTP stream.*all active turns, up to 5/s);
	assert.match(said('subagents.useNative'), /multi_agent.*max_depth.*journaled.*Restart Codex AND the launcher/s);
	assert.match(said('doctor.run'), /Inspects the live ChatGPT page.*up to 30 s.*No message is sent.*tunnel client/s);
	assert.match(said('models.refresh'), /codex debug models.*No prompt is sent/s);
	assert.match(said('handoff.smokeTest'), /ONE real message on your ChatGPT account/);
	assert.match(said('handoff.installModels'), /ALL Codex traffic.*multi_agent.*Interrupt hook.*journaled.*unofficial browser automation.*not affiliated with or endorsed by OpenAI/s);
	assert.match(said('handoff.mcpConnect'), /tool access to the folder of the Codex session.*file writes and commands.*hostile instructions.*Codex Native2.*Allow all actions/s);
	assert.match(said('handoff.removeIntegration'), /restores the previous model route.*sign-in.*preserved.*Pause Bridge/s);
	assert.match(said('handoff.signIn'), /private profile of the launcher.*Vibe never sees it/s);
	assert.match(said('handoff.interactionMode'), /may conflict with OpenAI terms or account policies.*Zero Risk.*you paste/s);
	assert.match(said('handoff.biggerContext'), /rate limits or temporary cooldowns/);
	assert.equal(operationOf('engine.quit').suggestFirst, 'bridge.pause');
	assert.deepEqual(confirmationOf(operationOf('engine.quit'), facts())?.suggestFirst, { id: 'bridge.pause', label: 'Pause Bridge' }, 'offered while the bridge is connected');
	assert.equal(confirmationOf(operationOf('engine.quit'), facts({ configRoute: { kind: 'absent' }, route: { ...ROUTE, active: false } }))?.suggestFirst, undefined, 'and not when it is paused already');
});

test('preconditions: an operation that cannot work, or would do harm, is not offered, and says why', () => {
	const reason = (id: OperationId, patch: Partial<LauncherFacts>) => {
		const checked = checkPreconditions(operationOf(id), facts(patch));
		return checked.ok ? undefined : checked.reason;
	};
	assert.equal(reason('bridge.connect', {}), 'The bridge is connected already.');
	assert.equal(reason('bridge.connect', { configRoute: { kind: 'absent' }, route: { ...ROUTE, active: false } }), undefined, 'paused, and the daemon answers');
	assert.match(reason('bridge.connect', { configRoute: { kind: 'absent' }, route: { ...ROUTE, active: false }, health: undefined }) ?? '', /daemon of the launcher does not answer.*a port nobody listens on/s);
	assert.match(reason('bridge.connect', { configRoute: { kind: 'absent' }, route: { ...ROUTE, installed: false, active: false, port: undefined } }) ?? '', /Install models did not run/);
	assert.match(reason('bridge.connect', { runtime: { found: false, source: undefined, version: undefined } }) ?? '', /runtime of the launcher was not found/);

	assert.equal(reason('bridge.pause', { launcherRunning: false, health: undefined }), undefined, 'the rescue: works with the launcher closed');
	assert.equal(reason('bridge.pause', { configRoute: { kind: 'absent' }, route: { ...ROUTE, active: false } }), 'The bridge is paused already.');
	assert.equal(reason('bridge.pause', { route: undefined }), undefined, 'the journal was not asked yet, the config of Codex says it is routed');

	assert.equal(reason('engine.startHidden', {}), 'The launcher is running already.');
	assert.equal(reason('engine.startHidden', { launcherRunning: false }), undefined);
	assert.match(reason('engine.startHidden', { launcherRunning: false, appInstalled: false }) ?? '', /not installed/);
	assert.match(reason('engine.startHidden', { launcherRunning: false, platform: 'linux' }) ?? '', /macOS/);
	assert.equal(reason('engine.quit', { launcherRunning: false }), 'The launcher is not running.');
	assert.equal(reason('engine.quit', {}), undefined);

	assert.match(reason('doctor.run', { health: { ...HEALTH, activeBrowserTurns: 1 } }) ?? '', /turn is active/);
	assert.equal(reason('doctor.run', {}), undefined);
	assert.equal(reason('turns.cancel', {}), 'No turn is active.');
	assert.equal(reason('turns.cancel', { health: { ...HEALTH, activeHttpTurns: 1 } }), undefined);
	assert.match(reason('models.refresh', { health: undefined }) ?? '', /through the route/);
	assert.match(reason('models.refresh', { health: { ...HEALTH, acceptingTurns: false } }) ?? '', /through the route/);

	const native = { kind: 'subagents-status' as const, protocol: 'native', installed: true, active: true, extra: {} };
	assert.equal(reason('subagents.useNative', { subagents: native }), 'Codex uses this protocol already.');
	assert.equal(reason('subagents.useCompatibility', { subagents: native }), undefined);
	assert.equal(reason('handoff.installModels', { appInstalled: false }), 'The Codex Web GPT launcher is not installed on this machine.');
	assert.equal(reason('link.project', { appInstalled: false, platform: 'linux' }), undefined);
	assert.match(reason('bridge.pause', { configRoute: { kind: 'foreign' } }) ?? '', /routed elsewhere.*does not write over the route of another program/s);
	assert.match(reason('bridge.connect', { configRoute: { kind: 'foreign' }, route: { ...ROUTE, active: false } }) ?? '', /routed elsewhere/);
});

test('resolved: what a view gets for one operation', () => {
	assert.deepEqual(resolveOperation('bridge.pause', facts()), {
		id: 'bridge.pause', label: 'Pause Bridge', kind: 'native', enabled: true, disabledReason: undefined, confirm: true, consequence: operationOf('bridge.pause').consequence, hint: undefined, why: undefined,
	});
	assert.deepEqual(resolveOperation('handoff.installModels', facts()), {
		id: 'handoff.installModels', label: 'Show Launcher Window', kind: 'handoff', enabled: true, disabledReason: undefined, confirm: false, consequence: operationOf('handoff.installModels').consequence,
		hint: 'Setup > 3 Install into Codex > Install models (Reinstall when it ran before), then fully quit and reopen Codex',
		why: 'The launcher runs its own setup for this, with a checkpoint it can roll back, and it owns the daemon that has to restart.',
	});
	const refused = resolveOperation('engine.quit', facts({ launcherRunning: false }));
	assert.deepEqual([refused.enabled, refused.disabledReason], [false, 'The launcher is not running.']);
	assert.throws(() => operationOf('engine.kill' as OperationId), /unknown operation/);
});
