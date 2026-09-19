// SPDX-License-Identifier: MIT

// ChatGPT Web through Codex (github.com/miuuyy/codex-chatgpt-web): what is known about the bridge, as decisions
// and as text. Its launcher, "Codex Web GPT", keeps the built-in provider of Codex and points the top-level
// `openai_base_url` of Codex's own config at a daemon on loopback that drives the ChatGPT tab of the user. The
// models are slugs, and a slug fixes the effort. Nothing in here reads a file or opens a socket: see ../host.
import type { AgentProfile, StatusRow } from './profiles.ts';

export const CHATGPT_WEB_PROFILE_ID = 'chatgpt-web';
export const CHATGPT_WEB_PROFILE_LABEL = 'ChatGPT Web (via Codex)';
export const CHATGPT_WEB_PROJECT_URL = 'https://github.com/miuuyy/codex-chatgpt-web';
export const LAUNCHER_BUNDLE_ID = 'dev.codexwebgpt.launcher';
export const LAUNCHER_APP_NAME = 'Codex Web GPT';

/** Where macOS has the app of the launcher. Only whether one of them exists is asked. */
export function launcherAppPaths(homedir: string): string[] {
	return [`/Applications/${LAUNCHER_APP_NAME}.app`, `${homedir}/Applications/${LAUNCHER_APP_NAME}.app`];
}
export const DEFAULT_CODEX_CONFIG_PATH = '~/.codex/config.toml';
export const DEFAULT_MODEL_SLUG = 'chatgpt-web/high';
export const HEALTH_TIMEOUT_MS = 1500;
export const PROBE_INTERVAL_MS = 30_000;
/** The launcher closes no more tabs than this at once. */
const MAX_BROWSER_TURNS = 5;

const SLUG_PREFIX = 'chatgpt-web/';
const SEPARATOR = ' \u00b7 ';

export const COMMANDS = {
	selectModel: 'vibeAgents.chatgptWeb.selectModel',
	openLauncher: 'vibeAgents.chatgptWeb.openLauncher',
	openProjectPage: 'vibeAgents.chatgptWeb.openProjectPage',
	recheck: 'vibeAgents.chatgptWeb.recheck',
} as const;

//#region Models

export interface ChatGptWebModel {
	slug: string;
	/** What a session of it is called. */
	label: string;
	/** The effort the slug fixes, and the plan that has it. */
	description: string;
	/** Whether an agent in a terminal can run on it. The manual ones have every prompt pasted by hand in the launcher. */
	terminal: boolean;
}

function model(route: string, name: string, description: string, terminal = true): ChatGptWebModel {
	return { slug: `${SLUG_PREFIX}${route}`, label: `ChatGPT Web${SEPARATOR}${name}`, description, terminal };
}

/** The routes of the bridge. Which of them an account has depends on its plan: the launcher rejects the others. */
export const CHATGPT_WEB_MODELS: readonly ChatGptWebModel[] = Object.freeze([
	model('light', 'Instant', 'Low effort, the fastest. Paid plans.'),
	model('medium', 'Medium', 'Medium effort. Paid plans.'),
	model('high', 'High', 'High effort. Paid plans.'),
	model('extra-high', 'Extra High', 'Extra high effort. Accounts that offer it.'),
	model('pro', 'Pro', 'ChatGPT Pro. Accounts that offer it.'),
	model('luna', 'Luna', 'Free and Go plans.'),
	model('think', 'Think', 'Free and Go plans.'),
	model('zero-risk', 'Zero Risk', 'Every prompt is pasted by hand in the launcher.', false),
	model('zero-risk-pro', 'Zero Risk Pro', 'Every prompt is pasted by hand in the launcher.', false),
]);

export function terminalModels(): ChatGptWebModel[] {
	return CHATGPT_WEB_MODELS.filter(candidate => candidate.terminal);
}

export function isTerminalSlug(slug: string | undefined): slug is string {
	return terminalModels().some(candidate => candidate.slug === slug);
}

export function labelOfSlug(slug: string): string {
	return CHATGPT_WEB_MODELS.find(candidate => candidate.slug === slug)?.label ?? `ChatGPT Web${SEPARATOR}${slug.slice(SLUG_PREFIX.length)}`;
}

/** The ChatGPT Web model a command line asks Codex for. */
export function slugOfCommandLine(commandLine: string): string | undefined {
	const words = commandLine.trim().split(/\s+/);
	for (let i = 0; i < words.length; i++) {
		const value = /^(?:-m|--model)$/.test(words[i]) ? words[i + 1] : /^--model=(?<value>.*)$/.exec(words[i])?.groups?.value;
		if (value !== undefined) {
			return /^chatgpt-web\/[A-Za-z0-9._-]+$/.test(value) ? value : undefined;
		}
		if (/["']/.test(words[i])) {
			return undefined; // quoted text follows: what is in it is no option
		}
	}
	return undefined;
}

const MATCH_COMMAND = '^codex\\s(?:.*\\s)?(?:-m\\s+|--model[\\s=])chatgpt-web/';

/**
 * The profile as it is listed. The slug is the whole choice: it fixes the model and the effort, so there is no
 * effort flag, and the route is in the config of Codex, so there is no environment. It names a ChatGPT Web model
 * even before one was chosen: whatever starts it unprepared never runs Codex on a native model by accident.
 */
export function chatGptWebProfile(slug: string | undefined): AgentProfile {
	return { id: CHATGPT_WEB_PROFILE_ID, label: CHATGPT_WEB_PROFILE_LABEL, command: 'codex', args: ['-m', slug ?? DEFAULT_MODEL_SLUG], icon: 'globe', matchCommand: MATCH_COMMAND };
}

/** The profile as it starts: its session is called after the model. */
export function chatGptWebLaunchProfile(slug: string): AgentProfile {
	return { ...chatGptWebProfile(slug), label: labelOfSlug(slug) };
}

//#endregion

//#region Route

export type LauncherRoute =
	| { kind: 'absent' }
	/** The route Install models of the launcher writes. */
	| { kind: 'launcher'; port: number }
	/** Codex is routed somewhere else. Where is nobody's business: nothing of the value is kept. */
	| { kind: 'foreign' };

const TABLE_HEADER = /^\[\[?\s*[A-Za-z0-9_\-."' \t]+\]\]?\s*(?:#.*)?$/;
const ROUTE_KEY = /^(?:openai_base_url|"openai_base_url"|'openai_base_url')\s*=\s*(?<rest>.*)$/;
const ONE_LINE_STRING = /^(?:"(?<basic>[^"\\]*)"|'(?<literal>[^']*)')\s*(?:#.*)?$/;
const LAUNCHER_URL = /^http:\/\/(?:127\.0\.0\.1|localhost):(?<port>[0-9]{1,5})\/v1\/?$/;

/**
 * The route of Codex: the top-level `openai_base_url` of its config, which is what is before the first table.
 * Only that key is looked at, line by line, and nothing of any line is kept. The daemon of the launcher listens
 * on 127.0.0.1, so only `http://127.0.0.1:<port>/v1` (or `localhost`) is its route.
 */
export function parseLauncherRoute(configText: string): LauncherRoute {
	let multiLine: string | undefined;
	for (const raw of configText.split(/\r?\n/)) {
		const line = raw.trim();
		if (multiLine !== undefined) {
			if (line.includes(multiLine)) {
				multiLine = undefined;
			}
			continue;
		}
		if (TABLE_HEADER.test(line)) {
			break;
		}

		const rest = ROUTE_KEY.exec(line)?.groups?.rest;
		if (rest !== undefined) {
			const text = ONE_LINE_STRING.exec(rest)?.groups;
			const port = Number(LAUNCHER_URL.exec(text?.basic ?? text?.literal ?? '')?.groups?.port ?? 0);
			return port >= 1 && port <= 65535 ? { kind: 'launcher', port } : { kind: 'foreign' };
		}

		// The text of a multi-line string of another key is no key and no table
		const opened = /^[^=#]+=\s*(?<quotes>"""|''')(?<after>.*)$/.exec(line)?.groups;
		if (opened && !opened.after.includes(opened.quotes)) {
			multiLine = opened.quotes;
		}
	}
	return { kind: 'absent' };
}

/** The config file of Codex: the one of the setting, and where that is the default, the one Codex itself reads. */
export function resolveCodexConfigPath(setting: string | undefined, env: Record<string, string | undefined>, homedir: string): string {
	const chosen = setting?.trim();
	const codexHome = env.CODEX_HOME?.trim();
	const path = chosen && chosen !== DEFAULT_CODEX_CONFIG_PATH ? chosen : codexHome ? `${codexHome.replace(/\/+$/, '')}/config.toml` : DEFAULT_CODEX_CONFIG_PATH;
	return path === '~' || path.startsWith('~/') ? `${homedir}${path.slice(1)}` : path;
}

//#endregion

//#region Health

/** What `GET /healthz` of the daemon tells. It knows nothing about the sign-in: only the launcher does. */
export interface BridgeHealth {
	/** `browser-only`: prompt in, text out. `full`: ChatGPT calls the tools of Codex. */
	mode: string;
	/** Not so while the launcher sets up, updates or shuts down. */
	acceptingTurns: boolean;
	activeBrowserTurns: number;
	version: string | undefined;
}

export type ProbeFailure = 'unreachable' | 'timeout' | 'not-the-daemon';

export function parseHealth(body: string): BridgeHealth | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	const health = parsed as Record<string, unknown>;
	if (health.status !== 'ok' || health.service !== 'codex-chatgpt-web') {
		return undefined;
	}
	const turns = Number(health.active_browser_turns ?? 0);
	return {
		mode: typeof health.mode === 'string' ? health.mode.slice(0, 40) : 'unknown',
		acceptingTurns: health.accepting_turns === true,
		activeBrowserTurns: Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : 0,
		version: typeof health.version === 'string' ? health.version.slice(0, 40) : undefined,
	};
}

//#endregion

//#region States

export type BridgeState =
	| 'not-installed'
	/** The launcher is there, Install models did not run: Codex has no route. */
	| 'not-set-up'
	/** As before, and the launcher is not open either. */
	| 'launcher-closed'
	/** Codex is routed to the launcher and the launcher does not answer: every run of Codex fails, not only these. */
	| 'route-dead'
	| 'foreign-route'
	| 'draining'
	| 'busy'
	| 'ready-browser-only'
	| 'ready-full';

export interface BridgeFacts {
	/** Not set: not known on this platform. */
	appInstalled: boolean | undefined;
	/** Not set: not known, or not asked. */
	launcherRunning?: boolean;
	route: LauncherRoute;
	/** The answer of the daemon on the port of the route. */
	health?: BridgeHealth;
	/** Why there is none. */
	error?: ProbeFailure;
}

export function classifyBridge(facts: BridgeFacts): BridgeState {
	if (facts.route.kind === 'launcher') {
		if (!facts.health) {
			return 'route-dead';
		}
		if (!facts.health.acceptingTurns) {
			return 'draining';
		}
		// One conversation at a time: turns started close together have triggered account limits
		if (facts.health.activeBrowserTurns >= 1) {
			return 'busy';
		}
		return facts.health.mode === 'full' ? 'ready-full' : 'ready-browser-only';
	}
	if (facts.appInstalled === false) {
		return 'not-installed';
	}
	if (facts.route.kind === 'foreign') {
		return 'foreign-route';
	}
	return facts.launcherRunning === false ? 'launcher-closed' : 'not-set-up';
}

export function isReadyState(state: BridgeState): boolean {
	return state === 'ready-browser-only' || state === 'ready-full';
}

export type BridgeAction = 'open-launcher' | 'project-page' | 'recheck';

export interface BridgePresentation {
	state: BridgeState;
	/** The row, as `label detail`. */
	label: string;
	detail: string;
	/** Only a dead route asks for attention: it breaks every run of Codex. Ready is quiet. */
	severity: StatusRow['state'];
	/** The whole story with the next step: the tooltip of the row, and what is said when an agent cannot start. */
	message: string;
	action: BridgeAction | undefined;
}

const INSTALL_MODELS = `Open the ${LAUNCHER_APP_NAME} launcher and run Install models, then restart Codex.`;

function modeTextOf(health: BridgeHealth | undefined): string {
	return health?.mode === 'full' ? 'full harness' : 'browser-only';
}

export function presentBridge(facts: BridgeFacts, options: { canOpenLauncher: boolean } = { canOpenLauncher: true }): BridgePresentation {
	const state = classifyBridge(facts);
	const port = facts.route.kind === 'launcher' ? facts.route.port : 0;
	const turns = facts.health?.activeBrowserTurns ?? 0;
	const launcher: BridgeAction = options.canOpenLauncher && facts.appInstalled !== false ? 'open-launcher' : 'project-page';
	const present = (detail: string, severity: StatusRow['state'], action: BridgeAction | undefined, message: string): BridgePresentation => ({ state, label: 'ChatGPT Web', detail, severity, message, action });

	switch (state) {
		case 'not-installed':
			return present('not installed', 'off', 'project-page', `ChatGPT Web is not installed: ${LAUNCHER_APP_NAME}, the launcher of codex-chatgpt-web, is not on this machine. The project page tells how to get it.`);
		case 'not-set-up':
			return present('models not installed', 'off', launcher, `ChatGPT Web is not set up: Codex has no launcher route (the top-level openai_base_url is absent). ${INSTALL_MODELS}`);
		case 'launcher-closed':
			return present('launcher not running', 'off', launcher, `The ${LAUNCHER_APP_NAME} launcher is not running, and Codex has no launcher route. ${INSTALL_MODELS}`);
		case 'route-dead':
			return present('launcher not running: every Codex run fails', 'warning', launcher, facts.error === 'not-the-daemon'
				? `Codex is routed to 127.0.0.1:${port}, which did not answer as the codex-chatgpt-web daemon. Until the ${LAUNCHER_APP_NAME} launcher runs there, every Codex run on this machine fails, not only ChatGPT Web. Open the launcher, or run its Remove Codex integration.`
				: `Codex is routed to 127.0.0.1:${port} but the ${LAUNCHER_APP_NAME} launcher is not running. Until it is started, every Codex run on this machine fails, not only ChatGPT Web. Open the launcher, or run its Remove Codex integration.`);
		case 'foreign-route':
			return present('Codex is routed elsewhere', 'off', launcher, `The top-level openai_base_url of the config of Codex is not the launcher's http://127.0.0.1:<port>/v1 route, and only one program can own it. ${INSTALL_MODELS}`);
		case 'draining':
			return present('launcher busy with setup or an update', 'off', 'recheck', `The ${LAUNCHER_APP_NAME} launcher is draining (setup, update or shutdown in progress). Wait for it to finish, then start again.`);
		case 'busy':
			return present(['busy', `${turns}/${MAX_BROWSER_TURNS} turns`, modeTextOf(facts.health)].join(SEPARATOR), 'ok', 'recheck', `ChatGPT Web is busy: ${turns} browser ${turns === 1 ? 'turn' : 'turns'} already active. Turns started close together have triggered account limits: wait for the running turn to finish.`);
		case 'ready-browser-only':
			return present(`ready${SEPARATOR}browser-only`, 'ok', undefined, 'ChatGPT Web is ready in browser-only mode: prompt in, text out, no local tools. Whether ChatGPT is signed in is known to the launcher only.');
		case 'ready-full':
			return present(`ready${SEPARATOR}full harness`, 'ok', undefined, 'ChatGPT Web is ready in full harness mode: ChatGPT calls the tools of Codex in the folder of the session. Whether ChatGPT is signed in and its connector attached is known to the launcher only (Run doctor).');
	}
}

const ACTIONS: Record<BridgeAction, { label: string; command: string }> = {
	'open-launcher': { label: 'Open Launcher', command: COMMANDS.openLauncher },
	'project-page': { label: 'Project Page', command: COMMANDS.openProjectPage },
	'recheck': { label: 'Re-check', command: COMMANDS.recheck },
};

export function actionOf(action: BridgeAction): { label: string; command: string } {
	return { ...ACTIONS[action] };
}

/** The row of the Sessions view. */
export function rowOfBridge(presentation: BridgePresentation): StatusRow {
	return {
		id: CHATGPT_WEB_PROFILE_ID,
		label: presentation.label,
		detail: presentation.detail,
		tooltip: presentation.message,
		state: presentation.severity,
		action: presentation.action ? actionOf(presentation.action) : undefined,
		secondaryActions: presentation.action === 'recheck' ? undefined : [{ ...actionOf('recheck'), icon: 'refresh' }],
	};
}

//#endregion

//#region Probe schedule

export interface IntervalTimers {
	setInterval(callback: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

/** When the bridge is asked by itself: once when its row shows, then at an interval while it does, never while it is hidden. */
export class ProbeSchedule {

	private visible = false;
	private disposed = false;
	private handle: unknown;

	private readonly probe: () => void;
	private readonly intervalMs: number;
	private readonly timers: IntervalTimers;

	constructor(probe: () => void, intervalMs: number, timers: IntervalTimers) {
		this.probe = probe;
		this.intervalMs = intervalMs;
		this.timers = timers;
	}

	get isVisible(): boolean {
		return this.visible;
	}

	setVisible(visible: boolean): void {
		if (this.disposed || visible === this.visible) {
			return;
		}
		this.visible = visible;
		this.restart();
	}

	/** Something may have changed the answer, such as the window getting the focus back: asks now, while the row shows. */
	poke(): void {
		if (!this.disposed && this.visible) {
			this.restart();
		}
	}

	dispose(): void {
		this.disposed = true;
		this.visible = false;
		this.stop();
	}

	private restart(): void {
		this.stop();
		if (this.visible) {
			this.handle = this.timers.setInterval(() => this.probe(), this.intervalMs);
			this.probe();
		}
	}

	private stop(): void {
		if (this.handle !== undefined) {
			this.timers.clearInterval(this.handle);
			this.handle = undefined;
		}
	}
}

//#endregion
