// SPDX-License-Identifier: MIT

// ChatGPT Web through Codex, as the window sees it: one profile, one status row, and the look at the bridge that
// both depend on. The look reads ONE key of the config of Codex (the top-level `openai_base_url`) and does ONE
// unauthenticated `GET /healthz` on loopback; on macOS it also asks whether the launcher app is there and whether
// it runs. It never opens the state directory of the launcher, its browser profile or its tokens, never calls
// `/v1/*` or `/admin/*`, never writes anything, and never starts Codex: a terminal does. Every decision and every
// word is in ../model/chatgptWeb. What the editor does is behind `BridgeUi`, so that all of this runs in a test.
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import {
	CHATGPT_WEB_PROFILE_ID, CHATGPT_WEB_PROJECT_URL, COMMANDS, HEALTH_TIMEOUT_MS, LAUNCHER_APP_NAME, PROBE_INTERVAL_MS, ProbeSchedule, actionOf, chatGptWebLaunchProfile,
	chatGptWebProfile, isReadyState, isTerminalSlug, launcherAppPaths, parseHealth, parseLauncherRoute, presentBridge, resolveCodexConfigPath, rowOfBridge, slugOfCommandLine, terminalModels,
	type BridgeAction, type BridgeFacts, type BridgeHealth, type BridgePresentation, type IntervalTimers, type ProbeFailure,
} from '../model/chatgptWeb.ts';
import type { AgentProfile, LaunchRequest, ProfileProvider, StatusRow, StatusRowProvider } from '../model/profiles.ts';

export interface ModelPickItem {
	slug: string;
	label: string;
	description: string;
	/** The one that starts when nothing else is chosen. */
	current: boolean;
}

/** What the editor does for the bridge. */
export interface BridgeUi {
	/**
	 * The remote of the WINDOW, not of the extension host: this extension also runs in the local extension host
	 * of a remote window, where the terminals it starts still run on the remote host.
	 */
	readonly remoteName: string | undefined;
	/** The setting `vibeAgents.chatgptWeb.enabled`. */
	isEnabled(): boolean;
	/** The setting `vibeAgents.chatgptWeb.codexConfigPath`. */
	codexConfigPath(): string | undefined;
	storedModel(): string | undefined;
	storeModel(slug: string): PromiseLike<void>;
	pickModel(items: ModelPickItem[]): PromiseLike<string | undefined>;
	/** A notification that is not modal. Resolves with the button that was chosen. */
	notify(severity: 'info' | 'warning', message: string, buttons: string[]): PromiseLike<string | undefined>;
	openExternal(url: string): void;
	/** Runs a command of the editor: the panel and the window of the launcher are behind commands. */
	executeCommand(command: string): void;
	log(message: string): void;
}

/** What the machine does for the bridge. */
export interface BridgeSystem {
	platform: string;
	homedir: string;
	env: Record<string, string | undefined>;
	healthTimeoutMs: number;
	timers: IntervalTimers;
	readFile(path: string): Promise<string>;
	exists(path: string): Promise<boolean>;
	/** Runs a program without a shell. The error of an exit code that is not 0 carries it as `code`. */
	execFile(file: string, args: string[], callback: (error: (Error & { code?: number | string | null }) | null) => void): void;
}

export function nodeSystem(): BridgeSystem {
	return {
		platform: process.platform,
		homedir: os.homedir(),
		env: process.env,
		healthTimeoutMs: HEALTH_TIMEOUT_MS,
		timers: { setInterval: (callback, ms) => setInterval(callback, ms), clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>) },
		readFile: path => fs.promises.readFile(path, 'utf8'),
		exists: path => fs.promises.stat(path).then(() => true, () => false),
		execFile: (file, args, callback) => { childProcess.execFile(file, args, { timeout: 5000 }, error => callback(error)); },
	};
}

/** The most that is read of an answer: the one of the daemon is a few hundred bytes. */
const MAX_HEALTH_BYTES = 64 * 1024;

/** One `GET /healthz` on loopback: its body, as text. One deadline bounds connecting, the headers and the body. */
export function fetchHealthBody(port: number, timeoutMs: number): Promise<{ body: string } | { error: ProbeFailure }> {
	return new Promise(resolve => {
		let settled = false;
		const settle = (outcome: { body: string } | { error: ProbeFailure }) => {
			if (!settled) {
				settled = true;
				clearTimeout(deadline);
				resolve(outcome);
				request.destroy();
			}
		};
		// agent: false: no pooled socket outlives the probe
		const request = http.get({ host: '127.0.0.1', port, path: '/healthz', agent: false, headers: { accept: 'application/json' } }, response => {
			const chunks: Buffer[] = [];
			let size = 0;
			response.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_HEALTH_BYTES) {
					settle({ error: 'not-the-daemon' });
				} else {
					chunks.push(chunk);
				}
			});
			response.on('error', () => settle({ error: 'unreachable' }));
			response.on('end', () => settle(response.statusCode === 200 ? { body: Buffer.concat(chunks).toString('utf8') } : { error: 'not-the-daemon' }));
		});
		const deadline = setTimeout(() => settle({ error: 'timeout' }), timeoutMs);
		request.on('error', () => settle({ error: 'unreachable' }));
	});
}

/** The same, as what the status row knows of the daemon. */
export async function probeHealth(port: number, timeoutMs: number): Promise<{ health: BridgeHealth } | { error: ProbeFailure }> {
	const answer = await fetchHealthBody(port, timeoutMs);
	if ('error' in answer) {
		return answer;
	}
	const health = parseHealth(answer.body);
	return health ? { health } : { error: 'not-the-daemon' };
}

export class ChatGptWebBridge implements ProfileProvider, StatusRowProvider {

	readonly id = CHATGPT_WEB_PROFILE_ID;

	private readonly schedule: ProbeSchedule;
	private shown: BridgePresentation | undefined;
	private running: Promise<BridgePresentation> | undefined;
	private enabled: boolean;
	private rowsVisible = false;
	private isRefusalShown = false;
	private disposed = false;

	private readonly ui: BridgeUi;
	private readonly system: BridgeSystem;
	private readonly onDidChange: () => void;
	private readonly lookElsewhere: ((fresh: boolean) => Promise<BridgeFacts>) | undefined;

	/**
	 * `onDidChange`: the profile or the row changed. `look`: where a window has the controller of the ChatGPT Web
	 * panel, the facts are the ones it gathers, through the programs its settings name: one look for both, and one story.
	 * `fresh`: look now. Not so: what is known already.
	 */
	constructor(ui: BridgeUi, system: BridgeSystem, onDidChange: () => void, look?: (fresh: boolean) => Promise<BridgeFacts>) {
		this.ui = ui;
		this.system = system;
		this.onDidChange = onDidChange;
		this.lookElsewhere = look;
		this.enabled = ui.isEnabled();
		this.schedule = new ProbeSchedule(() => { this.check().catch(() => ui.log('chatgpt-web: the look at the bridge failed')); }, PROBE_INTERVAL_MS, system.timers);
	}

	dispose(): void {
		this.disposed = true;
		this.schedule.dispose();
	}

	/**
	 * Local windows only. The launcher and its loopback port are on this machine, and a terminal of a remote
	 * window runs on the remote host, where `codex` reads another config and 127.0.0.1 is another machine.
	 */
	private get isActive(): boolean {
		return this.enabled && this.ui.remoteName === undefined && !this.disposed;
	}

	private get canOpenLauncher(): boolean {
		return this.system.platform === 'darwin';
	}

	//#region What the view gets

	provideProfiles(): readonly AgentProfile[] {
		if (!this.isActive) {
			return [];
		}
		const stored = this.ui.storedModel();
		return [chatGptWebProfile(isTerminalSlug(stored) ? stored : undefined)];
	}

	provideStatusRows(): readonly StatusRow[] {
		return this.isActive && this.shown ? [rowOfBridge(this.shown)] : [];
	}

	setVisible(visible: boolean): void {
		this.rowsVisible = visible;
		this.schedule.setVisible(visible && this.isActive);
	}

	/** The window has the focus again: the user may come back from the launcher. */
	windowFocused(): void {
		this.schedule.poke();
	}

	/** A setting of the bridge changed. */
	configurationChanged(): void {
		this.enabled = this.ui.isEnabled();
		if (!this.isActive) {
			this.shown = undefined;
		}
		this.schedule.setVisible(this.rowsVisible && this.isActive);
		this.schedule.poke();
		this.onDidChange();
	}

	//#endregion

	//#region The look at the bridge

	/** Looks now. Looks that overlap are one. */
	check(): Promise<BridgePresentation> {
		this.running ??= this.look().finally(() => { this.running = undefined; });
		return this.running;
	}

	private async look(): Promise<BridgePresentation> {
		return this.show(presentBridge(await this.facts(), { canOpenLauncher: this.canOpenLauncher }));
	}

	/** The facts changed where they are gathered (the panel did something): the row follows, without a look of its own. */
	async factsChanged(): Promise<void> {
		if (this.isActive && this.lookElsewhere && !this.running) {
			this.show(presentBridge(await this.lookElsewhere(false), { canOpenLauncher: this.canOpenLauncher }));
		}
	}

	private show(presentation: BridgePresentation): BridgePresentation {
		if (this.isActive && JSON.stringify(presentation) !== JSON.stringify(this.shown)) {
			if (presentation.state !== this.shown?.state) {
				this.ui.log(`chatgpt-web: ${presentation.state}`);
			}
			this.shown = presentation;
			this.onDidChange();
		}
		return presentation;
	}

	private async facts(): Promise<BridgeFacts> {
		if (this.lookElsewhere) {
			return this.lookElsewhere(true);
		}
		const appInstalled = this.system.platform === 'darwin'
			? (await Promise.all(launcherAppPaths(this.system.homedir).map(path => this.system.exists(path)))).some(Boolean)
			: undefined;

		// The text of the config lives for this one expression: only the route is kept of it
		const configPath = resolveCodexConfigPath(this.ui.codexConfigPath(), this.system.env, this.system.homedir);
		const route = parseLauncherRoute(await this.system.readFile(configPath).catch(() => ''));

		if (route.kind === 'launcher') {
			return { appInstalled, route, ...await probeHealth(route.port, this.system.healthTimeoutMs) };
		}
		// No route: all that is left to tell apart is whether the launcher is open
		return { appInstalled, route, launcherRunning: appInstalled ? await this.isLauncherRunning() : undefined };
	}

	private isLauncherRunning(): Promise<boolean | undefined> {
		return new Promise(resolve => this.system.execFile('/usr/bin/pgrep', ['-f', `${LAUNCHER_APP_NAME}.app/Contents/MacOS/`], error => resolve(!error ? true : error.code === 1 ? false : undefined)));
	}

	//#endregion

	//#region Starting

	/**
	 * Before a session starts: the bridge is looked at, and unless it is ready nothing starts. A bridge that is
	 * not ready would only leave a terminal that reconnects for ever, and with the route in place that is true
	 * of every run of Codex, which the message then says.
	 */
	async prepareLaunch(request: LaunchRequest): Promise<AgentProfile | undefined> {
		if (!this.isActive) {
			this.ui.notify('info', this.ui.remoteName === undefined
				? 'ChatGPT Web is turned off (vibeAgents.chatgptWeb.enabled).'
				: 'ChatGPT Web starts in a local window only: the launcher and its port are on this machine, and the terminals of this window run on the remote host.', []);
			return undefined;
		}

		const presentation = await this.check();
		if (!isReadyState(presentation.state)) {
			this.refuse(presentation);
			return undefined;
		}

		const stored = this.ui.storedModel();
		const slug = (request.restartOf === undefined ? undefined : slugOfCommandLine(request.restartOf)) ?? (isTerminalSlug(stored) ? stored : await this.selectModel());
		return slug === undefined ? undefined : chatGptWebLaunchProfile(slug);
	}

	private refuse(presentation: BridgePresentation): void {
		if (this.isRefusalShown) {
			return; // it is still on screen
		}
		this.isRefusalShown = true;
		const action = presentation.action;
		const button = action ? actionOf(action).label : undefined;
		this.ui.notify(presentation.severity === 'warning' ? 'warning' : 'info', presentation.message, button ? [button] : []).then(chosen => {
			this.isRefusalShown = false;
			if (action && chosen === button) {
				this.run(action);
			}
		}, () => { this.isRefusalShown = false; });
	}

	/** Asks which model sessions start on from now on. */
	async selectModel(): Promise<string | undefined> {
		const stored = this.ui.storedModel();
		const slug = await this.ui.pickModel(terminalModels().map(model => ({ slug: model.slug, label: model.label, description: model.description, current: model.slug === stored })));
		if (!isTerminalSlug(slug)) {
			return undefined;
		}
		if (slug !== stored) {
			await this.ui.storeModel(slug);
			this.onDidChange();
		}
		return slug;
	}

	//#endregion

	//#region Actions

	private run(action: BridgeAction): void {
		switch (action) {
			case 'open-panel': this.ui.executeCommand(COMMANDS.openPanel); break;
			case 'show-launcher': this.ui.executeCommand(COMMANDS.showLauncher); break;
			case 'project-page': this.openProjectPage(); break;
			case 'recheck': this.recheck(); break;
		}
	}

	openProjectPage(): void {
		this.ui.openExternal(CHATGPT_WEB_PROJECT_URL);
	}

	/** The user asks: looks now, whether the row shows or not. */
	async recheck(): Promise<void> {
		if (this.isActive) {
			await this.check();
		}
	}

	//#endregion
}
