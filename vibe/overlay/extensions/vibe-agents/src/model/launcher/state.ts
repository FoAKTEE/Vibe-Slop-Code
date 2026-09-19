// SPDX-License-Identifier: MIT

// What the ChatGPT Web panel shows, from the observable facts alone: the screens of the launcher as far as its
// seams reach (Overview, Setup, Models, Bridge, Engine) and Subagents, the full-harness guide, Doctor and Activity.
// Every item has its text, its severity and the operations that make sense on it now. What only the launcher knows
// is said to be so, and what only the launcher can do is a hand-off that names the step there.
//
// One state asks for attention: Codex is routed to the launcher and the launcher does not answer, so EVERY run of
// Codex on the machine fails. Everything else is quiet, as in the status row, whose words the overview reuses.
import { CHATGPT_WEB_MODELS, DEFAULT_MODEL_SLUG, LAUNCHER_APP_NAME, labelOfSlug, presentBridge, type BridgeState } from '../chatgptWeb.ts';
import type { ActivityEntry } from './activity.ts';
import { activeTurnsOf, bridgeFactsOf, isRouteActive, isRouteInstalled, type LauncherFacts, type ProbeFailed } from './facts.ts';
import { operationOf, resolveOperation, type OperationId, type ResolvedOperation } from './operations.ts';
import type { DoctorCheck } from './runtime.ts';

/** `warning` is the one state that asks for attention. `error`: something that was asked for failed. */
export type Severity = 'ok' | 'info' | 'warning' | 'error' | 'off';
/** `handoff`: to do, in the launcher. `unknown`: only the launcher knows. */
export type StepState = 'done' | 'todo' | 'unknown' | 'handoff';
export type ScreenId = 'overview' | 'setup' | 'models' | 'bridge' | 'engine' | 'subagents' | 'mcp' | 'doctor' | 'activity';

export interface ViewItem {
	id: string;
	label: string;
	/** The state, in a few words. */
	text: string;
	/** The whole story. */
	detail: string | undefined;
	severity: Severity;
	/** Steps of a checklist only. */
	step: StepState | undefined;
	/** Entries of the activity log only: when. */
	at: number | undefined;
	operations: ResolvedOperation[];
}

export interface ViewScreen {
	id: ScreenId;
	title: string;
	summary: string;
	severity: Severity;
	items: ViewItem[];
}

/** `paused`: models are installed and Codex is on its previous route. Only the journal of the bridge tells, so the status row cannot. */
export type PanelState = BridgeState | 'paused';

export interface LauncherViewState {
	bridge: PanelState;
	/** As the status row says it. */
	headline: string;
	attention: ViewItem | undefined;
	screens: ViewScreen[];
}

export interface ViewInput {
	facts: LauncherFacts;
	activity: readonly ActivityEntry[];
	/** The model sessions start on. */
	selectedModel: string | undefined;
	now: number;
}

const LAUNCHER_ONLY = 'known to the launcher only';
const MAX_BROWSER_TURNS = 5;
const MAX_ACTIVITY_ITEMS = 50;
const SEPARATOR = ' \u00b7 ';

export function deriveViewState(input: ViewInput): LauncherViewState {
	const { facts } = input;
	const presentation = presentBridge(bridgeFactsOf(facts), { canOpenLauncher: facts.platform === 'darwin' });
	const item = (id: string, label: string, text: string, severity: Severity, operations: OperationId[] = [], detail?: string, step?: StepState): ViewItem => ({
		id, label, text, detail, severity, step, at: undefined, operations: operations.map(operation => resolveOperation(operation, facts)),
	});
	const screen = (id: ScreenId, title: string, summary: string, items: ViewItem[]): ViewScreen => ({
		id, title, summary, items, severity: items.some(candidate => candidate.severity === 'warning') ? 'warning' : items.some(candidate => candidate.severity === 'error') ? 'error' : 'off',
	});
	const failure = (failed: ProbeFailed): string => {
		switch (failed.reason) {
			case 'no-runtime': return 'the runtime of the launcher was not found';
			case 'spawn': return 'the command could not be started';
			case 'timeout': return 'no answer in time';
			case 'overflow': return 'the answer was too large and was not read';
			case 'cancelled': return 'cancelled';
			case 'exit': return [`the command failed${failed.exitCode === undefined ? '' : ` (exit code ${failed.exitCode})`}`, failed.message].filter(Boolean).join(': ');
			case 'unparseable': return ['the answer did not have the documented shape', failed.message].filter(Boolean).join(': ');
		}
	};
	const ago = (at: number | undefined): string => {
		const minutes = at === undefined ? 0 : Math.max(0, Math.floor((input.now - at) / 60_000));
		return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
	};

	const health = facts.health;
	const routed = isRouteActive(facts);
	const installed = isRouteInstalled(facts);
	const state: PanelState = (presentation.state === 'not-set-up' || presentation.state === 'launcher-closed') && installed === true ? 'paused' : presentation.state;
	const stateDetail = state !== 'paused' ? presentation.detail : facts.launcherRunning === false ? 'bridge paused, launcher not running' : 'bridge paused';
	const stateMessage = state !== 'paused' ? presentation.message : 'The bridge is paused: Codex uses its previous route and does not list the ChatGPT Web models. Connect Bridge routes ALL Codex traffic on this machine to the launcher again.';
	const route = facts.route;
	const turns = activeTurnsOf(facts);
	const doctor = facts.doctor?.kind === 'doctor' ? facts.doctor : undefined;
	const doctorFailed = facts.doctor?.kind === 'failed' ? facts.doctor : undefined;
	const checkOf = (id: string): DoctorCheck | undefined => doctor?.checks.find(check => check.id === id);

	//#region Overview

	const stateOperations: Record<PanelState, OperationId[]> = {
		'not-installed': ['link.project'],
		'not-set-up': ['handoff.installModels'],
		'launcher-closed': ['handoff.installModels', 'engine.startHidden'],
		'route-dead': ['bridge.pause', 'engine.startHidden', 'engine.showWindow'],
		'foreign-route': ['handoff.installModels'],
		'paused': facts.launcherRunning === false ? ['bridge.connect', 'engine.startHidden'] : ['bridge.connect'],
		'draining': [],
		'busy': ['turns.cancel'],
		'ready-browser-only': [],
		'ready-full': [],
	};
	const stateItem = item('state', presentation.label, stateDetail, presentation.severity, stateOperations[state], state === 'route-dead'
		? `${stateMessage} Pause Bridge restores the previous route of Codex without the launcher.`
		: stateMessage);

	const versions = [facts.runtime.version ? `runtime ${facts.runtime.version}` : undefined, health?.version ? `daemon ${health.version}` : undefined].filter(Boolean).join(SEPARATOR);
	const versionsDiffer = facts.runtime.version !== undefined && health?.version !== undefined && facts.runtime.version !== health.version;
	const overview = screen('overview', 'Overview', `${presentation.label} ${stateDetail}`, [
		stateItem,
		item('mode', 'Mode', !health ? 'not known while the daemon does not answer' : health.mode === 'full' ? 'full harness' : health.mode === 'browser-only' ? 'browser-only' : health.mode, 'off', [],
			!health ? undefined : health.mode === 'full' ? 'ChatGPT calls the tools of Codex in the folder of the session, through MCP.' : 'Prompt in, text out: ChatGPT has no local tools.'),
		item('turns', 'Turns', !health ? 'none known' : `${health.activeBrowserTurns}/${MAX_BROWSER_TURNS} browser${SEPARATOR}${health.activeHttpTurns} HTTP`, turns > 0 ? 'info' : 'off', turns > 0 ? ['turns.cancel'] : [],
			'The launcher runs at most 5 browser turns at once. Turns started close together have triggered account limits: one at a time is the safe pace.'),
		item('catalog', 'Codex', !health ? 'not known while the daemon does not answer' : health.catalogVerified ? 'sees the ChatGPT Web models' : 'restart Codex once', !health || health.catalogVerified ? 'off' : 'info', [],
			!health ? undefined : health.catalogVerified ? `Codex fetched its model catalog through the daemon (${health.catalogRequests} ${health.catalogRequests === 1 ? 'request' : 'requests'} since the daemon started).`
				: 'Codex did not fetch its model catalog through the daemon yet. Fully quit Codex, including its background process, then reopen it.'),
		item('versions', 'Versions', versions || 'not known', versionsDiffer ? 'info' : 'off', [], versionsDiffer ? 'The daemon and the installed runtime differ: the launcher updates the runtime when it starts.' : undefined),
		item('notice', 'Unofficial', 'browser automation of your own ChatGPT account', 'off', ['link.project'],
			'codex-chatgpt-web is independent software, not affiliated with or endorsed by OpenAI. It automates your ChatGPT web session, can break when the page changes, and must not be used to evade usage limits. The terms and the message allowance of ChatGPT apply. Vibe operates the launcher you installed; it contains none of it.'),
	]);

	//#endregion

	//#region Setup

	const browserHost = checkOf('browser-host');
	const signIn: [StepState, string, string] = browserHost?.status === 'ok' ? ['done', 'signed in', `The doctor reached the ChatGPT page of the launcher ${ago(facts.doctorAt)}.`]
		: browserHost?.status === 'error' ? ['handoff', 'the launcher browser is not reachable or not signed in', browserHost.detail ?? browserHost.message]
			: installed ? ['unknown', LAUNCHER_ONLY, 'Install models ran, so ChatGPT was signed in then. Whether it still is, only the launcher knows: Run Doctor asks it.']
				: ['handoff', 'in the launcher', 'Whether ChatGPT is signed in is known to the launcher only.'];
	const smoke: [StepState, string, string] = installed ? ['done', 'passed before Install models', 'Install models of the launcher only runs after a passed smoke test.']
		: ['handoff', 'in the launcher', 'Whether the smoke test passed is known to the launcher only.'];
	const install: [StepState, string, string] = installed ? ['done', routed ? 'installed, bridge connected' : 'installed, bridge paused', 'The journal of the bridge holds the route, and the previous route of Codex.']
		: installed === false ? ['handoff', 'not installed', 'Codex has no launcher route, and the bridge has no journal.']
			: ['handoff', 'not installed, as far as the config of Codex tells', 'The config of Codex has no launcher route. Whether the bridge is only paused is known once the runtime was asked.'];
	const restart: [StepState, string, string] = !health ? ['unknown', 'not known while the daemon does not answer', 'The daemon counts the model catalog requests of Codex.']
		: health.catalogVerified ? ['done', 'Codex sees the models', 'Codex fetched its model catalog through the daemon.']
			: ['todo', 'fully quit and reopen Codex', 'Fully quit Codex, including its background process, then reopen it to refresh the model picker. Signing out and back in, or only closing the window, is not a restart. Keep the launcher running.'];

	const setup = screen('setup', 'Setup', 'Three checks in the launcher make ChatGPT Web available in the model picker of Codex.', [
		item('step.launcher', `Install the ${LAUNCHER_APP_NAME} launcher`, facts.appInstalled === false ? 'not installed' : facts.appInstalled ? 'installed' : 'not known on this platform', 'off',
			facts.appInstalled === false ? ['link.project'] : [], undefined, facts.appInstalled === false ? 'todo' : facts.appInstalled ? 'done' : 'unknown'),
		item('step.signIn', '1 Sign in to ChatGPT', signIn[1], 'off', signIn[0] === 'done' ? [] : ['handoff.signIn'], signIn[2], signIn[0]),
		item('step.smokeTest', '2 Run the browser smoke test', smoke[1], 'off', smoke[0] === 'done' ? [] : ['handoff.smokeTest'], smoke[2], smoke[0]),
		item('step.installModels', '3 Install models into Codex', install[1], 'off', ['handoff.installModels'], install[2], install[0]),
		item('step.restartCodex', '4 Restart Codex', restart[1], restart[0] === 'todo' ? 'info' : 'off', [], restart[2], restart[0]),
	]);

	//#endregion

	//#region Models

	const selected = input.selectedModel ?? DEFAULT_MODEL_SLUG;
	const catalog = facts.models?.kind === 'models' ? facts.models : undefined;
	const catalogFailed = facts.models?.kind === 'failed' ? facts.models : undefined;
	const modelItems = catalog
		? catalog.web.map(row => item(`model.${row.slug}`, labelOfSlug(row.slug), [row.effort ? `${row.effort} effort` : undefined, row.contextWindow ? `${Math.round(row.contextWindow / 1000)}k context` : undefined, row.slug === selected ? 'starts by default' : undefined].filter(Boolean).join(SEPARATOR) || row.slug, 'off'))
		: CHATGPT_WEB_MODELS.map(model => item(`model.${model.slug}`, model.label, [model.description, model.slug === selected ? 'Starts by default.' : undefined].filter(Boolean).join(' '), 'off'));
	const models = screen('models', 'Models', 'The slug is the whole choice: it fixes the model and the effort.', [
		item('models.catalog', 'Catalog', catalog ? `${catalog.web.length} ChatGPT Web ${catalog.web.length === 1 ? 'model' : 'models'} offered to this account${SEPARATOR}asked ${ago(facts.modelsAt)}` : catalogFailed ? `not read: ${failure(catalogFailed)}` : 'every model of the bridge; which of them your account has depends on its plan',
			catalogFailed ? 'error' : 'off', ['models.refresh'], catalog && catalog.web.length === 0 ? 'Codex lists no ChatGPT Web model: Install models did not run, or Codex was not restarted since.' : undefined),
		...modelItems,
	]);

	//#endregion

	//#region Bridge

	const routeErrors = route?.kind === 'route-status' ? route.errors : [];
	const routeText = route?.kind === 'failed' ? `not read: ${failure(route)}`
		: facts.configRoute.kind === 'foreign' ? 'Codex is routed elsewhere'
			: routed ? 'connected: all Codex traffic goes through the launcher'
				: installed ? 'paused: Codex uses its previous route'
					: installed === false ? 'not installed' : 'no launcher route in the config of Codex';
	const bridge = screen('bridge', 'Bridge', 'The route of Codex: one key of its config, owned by one program at a time.', [
		item('route', 'Route', routeText, state === 'route-dead' ? 'warning' : route?.kind === 'failed' || routeErrors.length > 0 ? 'error' : 'off', ['bridge.connect', 'bridge.pause', 'probe.routeStatus'],
			routeErrors.length > 0 ? `The config of Codex no longer matches the journal of the bridge: ${routeErrors.join('; ')}` : state === 'route-dead' ? stateItem.detail : undefined),
		item('daemon', 'Daemon', health ? `answers${SEPARATOR}${health.acceptingTurns ? 'accepts turns' : 'draining: setup, update or shutdown in progress'}` : facts.healthError === 'not-the-daemon' ? 'something else answers on its port' : 'does not answer', 'off', []),
		item('turns', 'Active turns', health ? `${health.activeBrowserTurns}/${MAX_BROWSER_TURNS} browser${SEPARATOR}${health.activeHttpTurns} HTTP` : 'none known', turns > 0 ? 'info' : 'off', ['turns.cancel']),
		item('remove', 'Remove Codex integration', 'in the launcher', 'off', ['handoff.removeIntegration'], operationOf('handoff.removeIntegration').consequence),
	]);

	//#endregion

	//#region Engine

	const engine = screen('engine', 'Engine', `The ${LAUNCHER_APP_NAME} launcher owns the ChatGPT page, the sign-in and the daemon. Vibe starts, shows and quits it.`, [
		item('app', 'Launcher app', facts.appInstalled === false ? 'not installed' : facts.appInstalled ? 'installed' : 'not known on this platform', 'off', facts.appInstalled === false ? ['link.project'] : []),
		item('process', 'Process', facts.launcherRunning ? 'running' : facts.launcherRunning === false ? 'not running' : 'not known', state === 'route-dead' ? 'warning' : 'off', ['engine.startHidden', 'engine.showWindow', 'engine.quit'],
			'A hidden launcher shows a tray icon. It refuses to quit while one of its own operations runs, and then shows its window.'),
		item('runtime', 'Runtime', facts.runtime.found ? [facts.runtime.version ?? 'version not known', facts.runtime.source === 'setting' ? 'named by the setting' : facts.runtime.source === 'path' ? 'found on PATH' : 'installed by the launcher'].join(SEPARATOR) : 'not found', 'off', [],
			facts.runtime.found ? undefined : 'The launcher installs its runtime when it first starts. The setting vibeAgents.chatgptWeb.runtimePath names one that is somewhere else.'),
		item('daemon', 'Daemon', health ? [health.version ?? 'version not known', health.uptimeSeconds === undefined ? undefined : `up ${formatDuration(health.uptimeSeconds)}`].filter(Boolean).join(SEPARATOR) : 'does not answer', 'off'),
		item('settings.launchAtLogin', 'Launch at login', LAUNCHER_ONLY, 'off', ['handoff.launchAtLogin']),
		item('settings.interactionMode', 'ChatGPT interaction', LAUNCHER_ONLY, 'off', ['handoff.interactionMode']),
		item('settings.biggerContext', 'Bigger Context (experimental)', LAUNCHER_ONLY, 'off', ['handoff.biggerContext']),
		item('settings.skillsAsFiles', 'Skills as files (experimental)', LAUNCHER_ONLY, 'off', ['handoff.skillsAsFiles']),
		item('settings.zeroRiskPro', 'Zero Risk Pro model', LAUNCHER_ONLY, 'off', ['handoff.zeroRiskPro']),
	]);

	//#endregion

	//#region Subagents

	const protocol = facts.subagents;
	const subagents = screen('subagents', 'Subagents', 'How Codex runs subagents on ChatGPT Web models.', [
		item('protocol', 'Protocol', protocol?.kind === 'subagents-status' ? `${protocol.protocol === 'compatibility-v1' ? 'Compatibility V1' : protocol.protocol === 'native' ? 'Native' : protocol.protocol}${SEPARATOR}${protocol.active ? 'active' : protocol.installed ? 'installed, bridge paused' : 'not installed'}`
			: protocol ? `not read: ${failure(protocol)}` : 'not asked yet', protocol?.kind === 'failed' && protocol.reason !== 'exit' ? 'error' : 'off', ['subagents.useCompatibility', 'subagents.useNative', 'probe.subagents'],
			'Compatibility V1 is the default of the bridge: it sets multi_agent=true, multi_agent_v2=false and agents.max_depth>=2 in the config of Codex. Native is for advanced use.'),
	]);

	//#endregion

	//#region Full harness (MCP)

	const harnessChecks = (doctor?.checks ?? []).filter(check => /^(?:tunnel-|connector$|tools$)/.test(check.id));
	const mcp = screen('mcp', 'Full Harness (MCP)', 'Optional. In full harness mode ChatGPT calls the tools of Codex through an MCP connector over an OpenAI Tunnel.', [
		item('mcp.mode', 'Mode', !health ? 'not known while the daemon does not answer' : health.mode === 'full' ? 'full harness' : 'browser-only: no local tools', 'off', [], operationOf('handoff.mcpConnect').consequence),
		item('mcp.tunnel', '1 Create a tunnel and an API key', 'on platform.openai.com', 'off', ['link.tunnels', 'link.apiKeys'], 'The key needs Tunnels Read+Use and is not an Admin key. It is entered in the launcher only: Vibe never asks for it.', health?.mode === 'full' ? 'done' : 'todo'),
		item('mcp.connect', '2 Connect the local harness', 'in the launcher', 'off', ['handoff.mcpConnect'], 'The launcher stores the key privately and runs its setup in full mode.', health?.mode === 'full' ? 'done' : 'handoff'),
		item('mcp.connector', '3 Attach the ChatGPT connector', 'connector "Codex Native2" (Zero Risk: "Codex Zero Risk")', 'off', ['link.connectors', 'handoff.verifyConnector'],
			'In ChatGPT: Developer Mode, a connector with exactly this name on the tunnel, Allow all actions. The sandbox and the approvals of Codex still apply. Local checks cannot prove that it is attached.', 'unknown'),
		...harnessChecks.map(check => item(`mcp.check.${check.id}`, check.id, check.message, check.status === 'error' ? 'error' : check.status === 'warning' ? 'info' : 'off', [], check.detail)),
	]);

	//#endregion

	//#region Doctor

	const doctorScreen = screen('doctor', 'Doctor', 'The checks of the runtime. It looks at the live ChatGPT page, so it runs on a click only.', [
		item('doctor.summary', 'Result', doctor ? `${doctor.ok ? 'healthy' : 'needs attention'}${doctor.partial ? ' (incomplete report)' : ''}${SEPARATOR}${ago(facts.doctorAt)}` : doctorFailed ? `did not run: ${failure(doctorFailed)}` : 'not run yet',
			doctor ? (doctor.ok ? 'ok' : 'error') : doctorFailed ? 'error' : 'off', ['doctor.run'], operationOf('doctor.run').consequence),
		...(doctor?.checks ?? []).map(check => item(`doctor.check.${check.id}`, check.id, check.message, check.status === 'ok' ? 'ok' : check.status === 'error' ? 'error' : 'info', [], check.detail)),
	]);

	//#endregion

	//#region Activity

	const activity = screen('activity', 'Activity', 'What Vibe did to the engine. Command lines are shown by their documented words; nothing a program answered is kept.', [
		...[...input.activity].reverse().slice(0, MAX_ACTIVITY_ITEMS).map((entry): ViewItem => ({
			...item(`activity.${entry.seq}`, entry.operation === 'unknown' ? 'Unknown' : operationOf(entry.operation).label,
				[entry.outcome, `${entry.durationMs} ms`, entry.exitCode === undefined ? undefined : `exit code ${entry.exitCode}`].filter(Boolean).join(SEPARATOR),
				entry.outcome === 'ok' || entry.outcome === 'cancelled' || entry.outcome === 'refused' ? 'off' : 'error', [], [entry.command, entry.note].filter(Boolean).join(SEPARATOR) || undefined),
			at: entry.at,
		})),
		item('activity.launcher', 'Log of the launcher', 'in the launcher', 'off', ['handoff.exportLog'], operationOf('handoff.exportLog').consequence),
	]);

	//#endregion

	return {
		bridge: state,
		headline: `${presentation.label} ${stateDetail}`,
		attention: state === 'route-dead' ? stateItem : undefined,
		screens: [overview, setup, models, bridge, engine, subagents, mcp, doctorScreen, activity],
	};
}

function formatDuration(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	return minutes < 1 ? `${seconds} s` : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
