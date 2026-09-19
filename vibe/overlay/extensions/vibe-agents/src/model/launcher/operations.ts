// SPDX-License-Identifier: MIT

// Everything the ChatGPT Web panel can do, as data: what it runs, what that does to the machine, whether it asks
// first, when it is offered, and what is looked at again afterwards. Three kinds:
//
//   probe    looks, and changes nothing. Only the three that cost nothing repeat on a timer.
//   native   runs a documented seam of the engine when the user clicks: a command of its runtime, `codex debug
//            models`, or starting, showing and quitting the launcher app.
//   handoff  what exists only behind the window of the launcher (sign-in, smoke test, Install models, the MCP
//            credentials, its settings, Remove integration): its window is shown, with the step to take there.
//
// What is not in here cannot be run. The words of a consequence say what upstream documents, and are never softened.
import { CHATGPT_WEB_PROJECT_URL, LAUNCHER_APP_NAME } from '../chatgptWeb.ts';
import { activeTurnsOf, isRouteActive, isRouteInstalled, type LauncherFacts } from './facts.ts';
import { CODEX_MODELS_ARGV, openArgv, quitArgv, runningArgv, runtimeArgv, type Program, type RuntimeCommandId } from './runtime.ts';

export type OperationId =
	| 'probe.engine' | 'probe.codexRoute' | 'probe.health' | 'probe.runtime' | 'probe.routeStatus' | 'probe.subagents'
	| 'models.refresh' | 'doctor.run' | 'bridge.connect' | 'bridge.pause' | 'turns.cancel'
	| 'engine.startHidden' | 'engine.showWindow' | 'engine.quit' | 'subagents.useCompatibility' | 'subagents.useNative'
	| 'link.project' | 'link.tunnels' | 'link.apiKeys' | 'link.connectors'
	| 'handoff.signIn' | 'handoff.smokeTest' | 'handoff.installModels' | 'handoff.mcpConnect' | 'handoff.verifyConnector' | 'handoff.interactionMode'
	| 'handoff.biggerContext' | 'handoff.skillsAsFiles' | 'handoff.zeroRiskPro' | 'handoff.launchAtLogin' | 'handoff.removeIntegration' | 'handoff.exportLog';

export type ProbeId = Extract<OperationId, `probe.${string}`>;
export type OperationKind = 'probe' | 'native' | 'handoff';

export type Seam =
	| { via: 'runtime'; command: RuntimeCommandId }
	/** `codex debug models`. */
	| { via: 'codex' }
	/** `open`, on the bundle id of the launcher. */
	| { via: 'open'; hidden: boolean }
	/** `osascript`: the quit event. */
	| { via: 'quit' }
	/** Whether the app is there, and `pgrep`. */
	| { via: 'running' }
	/** One key of the config of Codex, or one `GET /healthz` on loopback. */
	| { via: 'facts'; what: 'codex-route' | 'health' }
	/** A page in the browser of the user. */
	| { via: 'external'; url: string };

export type PreconditionId =
	| 'macos' | 'app-installed' | 'engine-stopped' | 'engine-running' | 'runtime' | 'not-foreign' | 'installed' | 'route-paused' | 'route-active' | 'daemon' | 'routed-and-accepting'
	| 'idle' | 'turns' | 'not-native' | 'not-compatibility';

export interface Operation {
	id: OperationId;
	/** The button. */
	label: string;
	kind: OperationKind;
	/** `interval`: also on the timer of the status row. `open`: when the panel opens and on Refresh. `click`: never by itself. */
	cadence: 'interval' | 'open' | 'click';
	seam: Seam;
	confirm: 'never' | 'always' | 'if-starts-engine';
	/** What it does to the machine and to the account. Shown with the button, and asked about where `confirm` says so. */
	consequence: string;
	preconditions: readonly PreconditionId[];
	/** What is looked at again when it is over, whether it worked or not. */
	reprobe: readonly ProbeId[];
	/** The engine takes a while to come up or to go: the free probes run again after each of these. */
	settleMs: readonly number[];
	timeoutMs: number;
	/** Hand-offs: where in the launcher the step is. */
	hint: string | undefined;
	/** What the confirmation offers to do first. */
	suggestFirst: OperationId | undefined;
}

const ALL_TRAFFIC = 'ALL Codex traffic on this machine then goes through the local daemon of the launcher, native models included';
const ENGINE_STARTED = `which starts the daemon and, once models are installed, re-connects the route: ${ALL_TRAFFIC}.`;
const STARTS_ENGINE = `This starts the launcher, ${ENGINE_STARTED}`;
const MAY_START_ENGINE = `It is not known whether the launcher runs. If it does not, this starts it, ${ENGINE_STARTED}`;
const SUBAGENTS = 'Rewrites the multi_agent feature flags and agents.max_depth in the config of Codex (journaled by the bridge). Restart Codex AND the launcher afterwards, then start a new task.';
const ENGINE_PROBES: readonly ProbeId[] = ['probe.engine', 'probe.codexRoute', 'probe.health'];
const ENGINE_SETTLE: readonly number[] = [2000, 6000, 15000];

function probe(id: ProbeId, label: string, cadence: 'interval' | 'open', seam: Seam, timeoutMs: number, preconditions: readonly PreconditionId[] = []): Operation {
	return { id, label, kind: 'probe', cadence, seam, confirm: 'never', consequence: '', preconditions, reprobe: [], settleMs: [], timeoutMs, hint: undefined, suggestFirst: undefined };
}

function native(id: OperationId, label: string, seam: Seam, confirm: Operation['confirm'], consequence: string, preconditions: readonly PreconditionId[], reprobe: readonly ProbeId[], timeoutMs: number, more: Partial<Operation> = {}): Operation {
	return { id, label, kind: 'native', cadence: 'click', seam, confirm, consequence, preconditions, reprobe, settleMs: [], timeoutMs, hint: undefined, suggestFirst: undefined, ...more };
}

function link(id: OperationId, label: string, url: string): Operation {
	return native(id, label, { via: 'external', url }, 'never', '', [], [], 0);
}

function handoff(id: OperationId, hint: string, consequence: string): Operation {
	return { id, label: 'Show Launcher Window', kind: 'handoff', cadence: 'click', seam: { via: 'open', hidden: false }, confirm: 'if-starts-engine', consequence, preconditions: ['macos', 'app-installed'], reprobe: ENGINE_PROBES, settleMs: ENGINE_SETTLE, timeoutMs: 10_000, hint, suggestFirst: undefined };
}

export const OPERATIONS: readonly Operation[] = Object.freeze([
	probe('probe.engine', 'Look for the Launcher', 'interval', { via: 'running' }, 5000),
	probe('probe.codexRoute', 'Read the Route of Codex', 'interval', { via: 'facts', what: 'codex-route' }, 5000),
	probe('probe.health', 'Ask the Daemon', 'interval', { via: 'facts', what: 'health' }, 5000),
	probe('probe.runtime', 'Find the Runtime', 'open', { via: 'runtime', command: 'version' }, 5000),
	probe('probe.routeStatus', 'Ask for the Route Status', 'open', { via: 'runtime', command: 'route-status' }, 15_000, ['runtime']),
	probe('probe.subagents', 'Ask for the Subagent Protocol', 'open', { via: 'runtime', command: 'subagents-status' }, 15_000, ['runtime']),

	native('models.refresh', 'Refresh Models', { via: 'codex' }, 'never',
		'Runs `codex debug models`: Codex fetches its model catalog through the route, with its own sign-in. No prompt is sent and the browser is not involved.',
		['routed-and-accepting'], ['probe.health'], 30_000),
	native('doctor.run', 'Run Doctor', { via: 'runtime', command: 'doctor' }, 'never',
		'Inspects the live ChatGPT page inside the launcher for up to 30 s. No message is sent. In full harness mode it also runs the cleanup of the tunnel client. Not offered while a turn is active.',
		['runtime', 'idle'], ['probe.health'], 75_000),
	native('bridge.connect', 'Connect Bridge', { via: 'runtime', command: 'route-connect' }, 'always',
		'Routes ALL Codex traffic on this machine through the local daemon of the launcher, native models included. It writes the top-level openai_base_url of the config of Codex from the journal of the bridge and clears the model cache of Codex. '
		+ 'The launcher must stay running: when it quits, every Codex run on this machine fails until the bridge is paused or the launcher is reopened. Restart Codex afterwards.',
		['runtime', 'not-foreign', 'installed', 'route-paused', 'daemon'], ['probe.routeStatus', 'probe.codexRoute', 'probe.health'], 15_000),
	native('bridge.pause', 'Pause Bridge', { via: 'runtime', command: 'route-disconnect' }, 'always',
		'Restores the previous route of Codex in its config from the journal of the bridge and clears the model cache of Codex. The ChatGPT Web models disappear from Codex, and native Codex runs work again without the launcher. '
		+ 'Restart Codex afterwards. The launcher reconnects the route the next time it starts.',
		['runtime', 'not-foreign', 'route-active'], ['probe.routeStatus', 'probe.codexRoute', 'probe.health'], 15_000),
	native('turns.cancel', 'Cancel Active Turns', { via: 'runtime', command: 'cancel-turns' }, 'always',
		'Aborts the active HTTP stream and its retained ChatGPT browser turn: all active turns, up to 5, of every Codex session on this machine. The runtime authenticates to its own daemon; Vibe never sees the token.',
		['runtime', 'turns'], ['probe.health'], 15_000),

	native('engine.startHidden', 'Start Engine Hidden', { via: 'open', hidden: true }, 'always',
		`Starts the ${LAUNCHER_APP_NAME} launcher without its window. It starts the daemon and, once models are installed, re-connects the route: ${ALL_TRAFFIC}. `
		+ 'A tray icon appears, and ChatGPT stays signed in inside the launcher. The window stays hidden only after the first-run setup of the launcher was completed.',
		['macos', 'app-installed', 'engine-stopped'], ENGINE_PROBES, 10_000, { settleMs: ENGINE_SETTLE }),
	native('engine.showWindow', 'Show Launcher Window', { via: 'open', hidden: false }, 'if-starts-engine',
		'Brings the window of the launcher to the front. Nothing in the launcher changes.',
		['macos', 'app-installed'], ENGINE_PROBES, 10_000, { settleMs: ENGINE_SETTLE }),
	native('engine.quit', 'Quit Engine', { via: 'quit' }, 'always',
		'Quits the launcher the graceful way: it cancels active turns and stops the daemon. It does NOT restore the route of Codex: while the bridge is connected, every Codex run on this machine fails until the launcher is reopened or the bridge is paused. '
		+ 'Pause the bridge first to keep native Codex working.',
		['macos', 'engine-running'], ENGINE_PROBES, 15_000, { settleMs: ENGINE_SETTLE, suggestFirst: 'bridge.pause' }),

	native('subagents.useCompatibility', 'Use Compatibility V1', { via: 'runtime', command: 'subagents-compatibility-v1' }, 'always', SUBAGENTS, ['runtime', 'installed', 'not-compatibility'], ['probe.subagents'], 15_000),
	native('subagents.useNative', 'Use Native Protocol', { via: 'runtime', command: 'subagents-native' }, 'always', SUBAGENTS, ['runtime', 'installed', 'not-native'], ['probe.subagents'], 15_000),

	link('link.project', 'Open Project Page', CHATGPT_WEB_PROJECT_URL),
	link('link.tunnels', 'Open Tunnels', 'https://platform.openai.com/settings/organization/tunnels'),
	link('link.apiKeys', 'Create API Key', 'https://platform.openai.com/settings/organization/api-keys'),
	link('link.connectors', 'Open ChatGPT Plugins', 'https://chatgpt.com/#settings/Plugins'),

	handoff('handoff.signIn', 'Setup > 1 Sign in to ChatGPT > Open sign in (or Browser > Use passkey)',
		'You sign in to ChatGPT in the browser inside the launcher. The sign-in stays in the private profile of the launcher; Vibe never sees it.'),
	handoff('handoff.smokeTest', 'Setup > 2 Run browser smoke test > Run smoke test',
		'The smoke test of the launcher sends ONE real message on your ChatGPT account (High effort, Temporary Chat) and checks the streamed answer.'),
	handoff('handoff.installModels', 'Setup > 3 Install into Codex > Install models (Reinstall when it ran before), then fully quit and reopen Codex',
		`Install models of the launcher routes Codex to its daemon: ${ALL_TRAFFIC}, and every Codex run fails while the launcher is closed. It also sets multi_agent=true, multi_agent_v2=false and agents.max_depth>=2 and installs a Codex Interrupt hook. `
		+ 'Everything is journaled and restored by Remove Codex integration. This is unofficial browser automation of your own ChatGPT account, not affiliated with or endorsed by OpenAI: it can break when the ChatGPT page changes, and it may conflict with OpenAI terms or account policies.'),
	handoff('handoff.mcpConnect', 'MCP > 2 Connect the local harness > Tunnel ID and API key > Connect harness',
		'Full harness gives ChatGPT tool access to the folder of the Codex session: file writes and commands, through MCP. Repository content can carry hostile instructions, so keep the sandbox and the approvals of Codex strict. '
		+ 'It needs an OpenAI Tunnel, an API key (Tunnels Read+Use, not an Admin key) and the Developer Mode connector "Codex Native2" with Allow all actions. The key is entered in the launcher only.'),
	handoff('handoff.verifyConnector', 'MCP > 3 Attach the ChatGPT connector > Verify runtime',
		'Verify runtime of the launcher runs its doctor and then looks at the ChatGPT page for the connector. Local checks cannot prove that the connector is attached to this tunnel.'),
	handoff('handoff.interactionMode', 'Settings > General > ChatGPT interaction (With Automation or Zero Risk)',
		'With Automation sends prompts and reads the ChatGPT page by itself: browser automation may conflict with OpenAI terms or account policies. Zero Risk never reads or changes ChatGPT: the launcher prepares each prompt and you paste and send it yourself, within 30 s. '
		+ 'Changing it runs the setup of the launcher again; restart Codex afterwards.'),
	handoff('handoff.biggerContext', 'Settings > General > Bigger Context (experimental)',
		'Bigger Context splits large turns over several ChatGPT messages and triples the context limits. Extra requests may increase rate limits or temporary cooldowns. Restart Codex afterwards.'),
	handoff('handoff.skillsAsFiles', 'Settings > General > Skills as files (experimental)',
		'Skills as files uploads the selected Codex skills to ChatGPT as text attachments instead of inline text. It needs With Automation. Restart Codex afterwards.'),
	handoff('handoff.zeroRiskPro', 'Setup > Install into Codex > Zero Risk model profiles > Pro',
		'Adds the Pro-sized Zero Risk model to Codex. Zero Risk cannot verify your subscription or what you select in ChatGPT. Restart Codex afterwards.'),
	handoff('handoff.launchAtLogin', 'Settings > General > Launch at login',
		`With Launch at login the launcher starts hidden when you log in to macOS, and with it the daemon and the route: ${ALL_TRAFFIC}.`),
	handoff('handoff.removeIntegration', 'Settings > Diagnostics > Remove Codex integration',
		'Remove Codex integration of the launcher removes the ChatGPT Web models from Codex, restores the previous model route and removes the private runtime of the bridge. The ChatGPT sign-in of the launcher is preserved. Restart Codex once afterwards. '
		+ 'When the launcher cannot be opened, Pause Bridge restores the route without it.'),
	handoff('handoff.exportLog', 'Activity > Export safe log',
		'The log of the launcher stays in the launcher: it can hold prompts and answers, and Vibe never reads it. Its Export safe log writes a copy without them.'),
]);

const BY_ID: ReadonlyMap<string, Operation> = new Map(OPERATIONS.map(operation => [operation.id, operation]));

export function operationOf(id: OperationId): Operation {
	const operation = BY_ID.get(id);
	if (!operation) {
		throw new Error(`unknown operation: ${String(id).slice(0, 40)}`);
	}
	return operation;
}

export function isOperationId(value: unknown): value is OperationId {
	return typeof value === 'string' && BY_ID.has(value);
}

/** The program an operation runs and its arguments, exactly. Not set: it runs none (a read, a loopback GET, a link). */
export function argvOf(operation: Operation, settings: { bundleId: string }): { program: Program; args: string[] } | undefined {
	switch (operation.seam.via) {
		case 'runtime': return { program: 'runtime', args: runtimeArgv(operation.seam.command) };
		case 'codex': return { program: 'codex', args: [...CODEX_MODELS_ARGV] };
		case 'open': return { program: 'open', args: openArgv(settings.bundleId, { hidden: operation.seam.hidden }) };
		case 'quit': return { program: 'osascript', args: quitArgv(settings.bundleId) };
		case 'running': return { program: 'pgrep', args: runningArgv() };
		case 'facts':
		case 'external': return undefined;
	}
}

//#region When it is offered

const RUNTIME_MISSING = 'The runtime of the launcher was not found: the launcher installs it when it first starts. The setting vibeAgents.chatgptWeb.runtimePath names one that is somewhere else.';

function unmet(precondition: PreconditionId, facts: LauncherFacts): string | undefined {
	const routed = isRouteActive(facts) || (facts.route?.kind === 'route-status' && facts.route.active);
	const protocol = facts.subagents?.kind === 'subagents-status' ? facts.subagents.protocol : undefined;
	switch (precondition) {
		case 'macos': return facts.platform === 'darwin' ? undefined : 'Starting, showing and quitting the launcher is done through macOS: on this platform, use the launcher itself.';
		case 'app-installed': return facts.appInstalled !== false ? undefined : `The ${LAUNCHER_APP_NAME} launcher is not installed on this machine.`;
		case 'engine-stopped': return facts.launcherRunning !== true ? undefined : 'The launcher is running already.';
		case 'engine-running': return facts.launcherRunning !== false ? undefined : 'The launcher is not running.';
		case 'runtime': return facts.runtime.found ? undefined : RUNTIME_MISSING;
		case 'not-foreign': return facts.configRoute.kind !== 'foreign' ? undefined : 'Codex is routed elsewhere, and only one program can own its route. Vibe does not write over the route of another program: settle it there, or with Reinstall in the launcher.';
		case 'installed': {
			const installed = isRouteInstalled(facts);
			return installed ? undefined : installed === false ? 'Install models did not run yet: there is no route to connect. That step is done in the launcher.' : 'It is not known yet whether Install models ran: refresh first.';
		}
		case 'route-paused': return routed ? 'The bridge is connected already.' : undefined;
		case 'route-active': return routed ? undefined : 'The bridge is paused already.';
		case 'daemon': return facts.health ? undefined : 'The daemon of the launcher does not answer: start the engine first. Connecting now would route every Codex run to a port nobody listens on.';
		case 'routed-and-accepting': return isRouteActive(facts) && facts.health?.acceptingTurns ? undefined : 'Codex fetches its model catalog through the route: the bridge must be connected and the daemon must answer.';
		case 'idle': return activeTurnsOf(facts) === 0 ? undefined : 'A ChatGPT Web turn is active: wait for it to finish, or cancel it.';
		case 'turns': return activeTurnsOf(facts) > 0 ? undefined : 'No turn is active.';
		case 'not-native': return protocol === 'native' ? 'Codex uses this protocol already.' : undefined;
		case 'not-compatibility': return protocol === 'compatibility-v1' ? 'Codex uses this protocol already.' : undefined;
	}
}

export function checkPreconditions(operation: Operation, facts: LauncherFacts): { ok: true } | { ok: false; reason: string } {
	for (const precondition of operation.preconditions) {
		const reason = unmet(precondition, facts);
		if (reason !== undefined) {
			return { ok: false, reason };
		}
	}
	return { ok: true };
}

//#endregion

//#region What it asks first

export interface Confirmation {
	/** The whole consequence. It is the text of the dialog, not a tooltip. */
	text: string;
	/** The button that goes ahead. */
	button: string;
	/** Offered as the other way to go ahead: what keeps the machine working. */
	suggestFirst: { id: OperationId; label: string } | undefined;
}

/** What is asked before the operation runs. Not set: it runs on the click. */
export function confirmationOf(operation: Operation, facts: LauncherFacts): Confirmation | undefined {
	const startsEngine = operation.confirm === 'if-starts-engine' && facts.launcherRunning !== true;
	if (operation.confirm !== 'always' && !startsEngine) {
		return undefined;
	}
	const first = operation.suggestFirst === undefined ? undefined : operationOf(operation.suggestFirst);
	return {
		text: startsEngine ? `${facts.launcherRunning === false ? STARTS_ENGINE : MAY_START_ENGINE} ${operation.consequence}` : operation.consequence,
		button: operation.label,
		suggestFirst: first && checkPreconditions(first, facts).ok ? { id: first.id, label: first.label } : undefined,
	};
}

//#endregion

/** One operation as a view gets it. */
export interface ResolvedOperation {
	id: OperationId;
	label: string;
	kind: OperationKind;
	enabled: boolean;
	disabledReason: string | undefined;
	/** It asks first, with `confirmationOf`. */
	confirm: boolean;
	consequence: string;
	hint: string | undefined;
}

export function resolveOperation(id: OperationId, facts: LauncherFacts): ResolvedOperation {
	const operation = operationOf(id);
	const checked = checkPreconditions(operation, facts);
	return {
		id, label: operation.label, kind: operation.kind, enabled: checked.ok, disabledReason: checked.ok ? undefined : checked.reason,
		confirm: confirmationOf(operation, facts) !== undefined, consequence: operation.consequence, hint: operation.hint,
	};
}
