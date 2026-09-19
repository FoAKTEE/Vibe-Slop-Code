// SPDX-License-Identifier: MIT

// The wiring: settings, commands, the Sessions view, the badge, the status bar, notifications and what the
// window tells the workspace bar. What terminals do is in ./host/terminals, every decision in ./model.
import * as vscode from 'vscode';
import { ChatGptWebBridge, nodeSystem, type BridgeUi } from './host/chatgptWeb.ts';
import { LauncherController } from './host/launcher/controller.ts';
import { LauncherPanelHost, type PanelUi } from './host/launcher/panelHost.ts';
import { nodeLauncherSystem } from './host/launcher/system.ts';
import { renderPage } from './host/page.ts';
import { AgentTerminals } from './host/terminals.ts';
import { COMMANDS as CHATGPT_WEB_COMMANDS, type BridgeFacts } from './model/chatgptWeb.ts';
import { bridgeFactsOf } from './model/launcher/facts.ts';
import { COMMAND_OPERATIONS, PANEL_COMMANDS, type LauncherInbound, type Layout } from './model/launcher/panel.ts';
import { launcherSettingsOf, type LauncherSettings } from './model/launcher/settings.ts';
import { DEFAULT_ADOPT_PATTERN, ProfileRegistry, parseUserProfiles, type AgentProfile, type ProfileProvider, type Registration, type StatusRow, type StatusRowProvider } from './model/profiles.ts';
import { SessionRegistry, type SessionChange } from './model/registry.ts';
import type { Session } from './model/session.ts';
import { announcementOf, badgeOf, countSessions, orderSessions, statusBarTextOf, summaryTextOf, windowStatusOf } from './model/summary.ts';
import type { HostInbound, HostOutbound } from './protocol.ts';

const SECTION = 'vibeAgents';
const SESSIONS_VIEW = 'vibeAgents.sessions';
const BADGE_VIEW = 'vibeAgents.attention';
const SET_WINDOW_STATUS_COMMAND = '_workbench.workspaceBar.setWindowStatus';
const CHATGPT_WEB_SECTION = `${SECTION}.chatgptWeb`;
const CHATGPT_WEB_MODEL_KEY = 'vibeAgents.chatgptWeb.model';
const CHATGPT_WEB_VIEW = 'vibeAgents.chatgptWeb';
const CHATGPT_WEB_PANEL = 'vibeAgents.chatgptWeb.panel';

/** What other extensions get from this one: the seam for profiles and status rows that are not its business. */
export interface VibeAgentsApi {
	registerProfileProvider(provider: ProfileProvider): Registration;
	registerStatusRowProvider(provider: StatusRowProvider): Registration;
	/** Tells that what a provider provides changed. */
	refresh(): void;
}

export function activate(context: vscode.ExtensionContext): VibeAgentsApi {
	const controller = new Controller(context);
	context.subscriptions.push(controller);
	controller.start();
	return {
		registerProfileProvider: provider => controller.profiles.registerProvider(provider),
		registerStatusRowProvider: provider => controller.profiles.registerStatusRowProvider(provider),
		refresh: () => controller.profiles.refresh(),
	};
}

export function deactivate(): void { }

function nonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return text;
}

class Controller implements vscode.Disposable {

	readonly profiles = new ProfileRegistry();
	private readonly registry = new SessionRegistry();
	private readonly terminals: AgentTerminals;
	private readonly log: vscode.LogOutputChannel;
	private readonly statusBar: vscode.StatusBarItem;
	private readonly badgeView: vscode.TreeView<never>;
	private readonly disposables: vscode.Disposable[] = [];

	private view: vscode.WebviewView | undefined;
	private isViewReady = false;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private announcements: string[] = [];
	private rows: StatusRow[] = [];
	private lastWindowStatus = 'undefined';
	/** Sessions with a notification that is still on screen. */
	private readonly notified = new Set<string>();

	private launcher: LauncherPanelHost | undefined;
	private launcherPanel: vscode.WebviewPanel | undefined;

	private readonly context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this.log = vscode.window.createOutputChannel('Vibe Agents', { log: true });
		this.terminals = new AgentTerminals(context, this.registry, this.profiles, {
			adoptPattern: () => vscode.workspace.getConfiguration(SECTION).get<string>('adoptCommands') ?? DEFAULT_ADOPT_PATTERN,
			log: this.log,
		});
		this.statusBar = vscode.window.createStatusBarItem('vibeAgents.status', vscode.StatusBarAlignment.Left, 0);
		this.statusBar.name = vscode.l10n.t("Agents");
		this.statusBar.command = `${SESSIONS_VIEW}.focus`;

		// A webview view has no badge before it was shown once. A tree view does: this one is never
		// shown and carries the badge of the view container from the start.
		this.badgeView = vscode.window.createTreeView<never>(BADGE_VIEW, { treeDataProvider: { getChildren: () => [], getTreeItem: item => item } });

		this.disposables.push(this.log, this.terminals, this.statusBar, this.badgeView);
	}

	start(): void {
		this.loadProfiles();
		const chatGptWeb = this.createChatGptWeb();
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(`${SECTION}.profiles`)) {
					this.loadProfiles();
				}
				if (event.affectsConfiguration(CHATGPT_WEB_SECTION)) {
					chatGptWeb.configurationChanged();
				}
			}),
			this.profiles.onDidChange(() => this.refreshSoon(true)),
			this.registry.onDidChange(changes => this.onDidChangeSessions(changes)),
			this.terminals.onDidChangeStopArmed(() => this.refreshSoon(false)),
			vscode.window.registerWebviewViewProvider(SESSIONS_VIEW, { resolveWebviewView: view => this.resolveView(view) }),
			vscode.commands.registerCommand('vibeAgents.newAgent', (profileId?: unknown) => this.newAgent(typeof profileId === 'string' ? profileId : undefined)),
			vscode.commands.registerCommand('vibeAgents.adoptTerminal', () => this.terminals.adoptPick()),
			vscode.commands.registerCommand('vibeAgents.clearFinished', () => this.terminals.clearEnded()),
			vscode.commands.registerCommand('vibeAgents.focusNext', () => this.focusNext()),
		);

		this.terminals.restore();
		this.refresh(true);
	}

	dispose(): void {
		clearTimeout(this.refreshTimer);
		this.reportWindowStatus(undefined);
		vscode.Disposable.from(...this.disposables).dispose();
	}

	//#region Profiles

	private loadProfiles(): void {
		const { profiles, problems } = parseUserProfiles(vscode.workspace.getConfiguration(SECTION).get('profiles'));
		for (const problem of problems) {
			this.log.warn(`${SECTION}.profiles: ${problem}`);
		}
		this.profiles.setUserProfiles(profiles);
	}

	private async newAgent(profileId: string | undefined): Promise<void> {
		let profile: AgentProfile | undefined = this.profiles.get(profileId);
		if (!profile) {
			const picked = await vscode.window.showQuickPick(
				this.profiles.profiles.map(candidate => ({ label: `$(${candidate.icon ?? 'hubot'}) ${candidate.label}`, description: candidate.command, profile: candidate })),
				{ placeHolder: vscode.l10n.t("Agent to start in a new terminal") });
			profile = picked?.profile;
		}
		// The provider of a profile has a say: it may ask something first, and it may refuse, which it tells itself
		const prepared = profile && await this.prepare(profile, undefined);
		if (prepared) {
			await this.terminals.start(prepared);
		}
	}

	private async prepare(profile: AgentProfile, restartOf: string | undefined): Promise<AgentProfile | undefined> {
		try {
			return await this.profiles.prepareLaunch(profile, restartOf);
		} catch (error) {
			this.log.error(`${profile.id}: not started, its provider failed`, error);
			return undefined;
		}
	}

	private async restart(id: string): Promise<void> {
		const session = this.registry.get(id);
		const profile = this.profiles.get(session?.profileId);
		const prepared = session && profile ? await this.prepare(profile, session.command) : profile;
		if (session && (prepared || !profile)) {
			await this.terminals.restart(id, prepared);
		}
	}

	/**
	 * ChatGPT Web through Codex: a profile and a status row of this window, see ./host/chatgptWeb. What is asked
	 * here is `vscode.env.remoteName`, the remote of the window: this extension runs in the local extension host
	 * of a remote window too (extensionKind ui), and the terminals it starts there run on the remote host.
	 */
	private createChatGptWeb(): ChatGptWebBridge {
		const settings = () => vscode.workspace.getConfiguration(CHATGPT_WEB_SECTION);
		const launcher = this.createLauncher();
		let shownState: string | undefined;
		const look = launcher && (async (fresh: boolean): Promise<BridgeFacts> => {
			if (fresh) {
				await launcher.controller.refresh('interval');
			}
			return bridgeFactsOf(launcher.controller.snapshot.facts);
		});
		const ui: BridgeUi = {
			remoteName: vscode.env.remoteName,
			isEnabled: () => settings().get<boolean>('enabled') !== false,
			codexConfigPath: () => settings().get<string>('codexConfigPath'),
			storedModel: () => this.context.globalState.get<string>(CHATGPT_WEB_MODEL_KEY),
			storeModel: slug => this.context.globalState.update(CHATGPT_WEB_MODEL_KEY, slug),
			pickModel: items => vscode.window.showQuickPick(
				items.map(item => ({ label: item.label, description: item.current ? vscode.l10n.t("{0} (current)", item.slug) : item.slug, detail: item.description, slug: item.slug })),
				{ title: vscode.l10n.t("ChatGPT Web Model"), placeHolder: vscode.l10n.t("The model fixes the effort. Which ones there are depends on the ChatGPT plan."), matchOnDescription: true },
			).then(picked => picked?.slug),
			notify: (severity, message, buttons) => (severity === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(message, ...buttons),
			openExternal: url => { vscode.env.openExternal(vscode.Uri.parse(url)); },
			executeCommand: command => { vscode.commands.executeCommand(command); },
			log: message => this.log.info(message),
		};
		const bridge = new ChatGptWebBridge(ui, nodeSystem(), () => this.profiles.refresh(), look);
		if (launcher) {
			// What the panel does changes what the row says: the row follows, without a look of its own
			this.disposables.push(launcher.controller.onDidChange(() => {
				const state = launcher.controller.snapshot.view.bridge;
				if (state !== shownState) {
					shownState = state;
					bridge.factsChanged();
				}
			}));
		}
		this.disposables.push(
			new vscode.Disposable(() => bridge.dispose()),
			this.profiles.registerProvider(bridge),
			this.profiles.registerStatusRowProvider(bridge),
			vscode.window.onDidChangeWindowState(state => {
				if (state.focused) {
					bridge.windowFocused();
					launcher?.host.windowFocused();
				}
			}),
			vscode.commands.registerCommand(CHATGPT_WEB_COMMANDS.selectModel, () => bridge.selectModel()),
			vscode.commands.registerCommand(CHATGPT_WEB_COMMANDS.openProjectPage, () => bridge.openProjectPage()),
			vscode.commands.registerCommand(CHATGPT_WEB_COMMANDS.recheck, () => bridge.recheck()),
		);
		return bridge;
	}

	/**
	 * The ChatGPT Web panel: the launcher as the engine, Vibe as its interface, see ./host/launcher. Local windows
	 * only, as the profile. Every program it runs is named by a machine setting, and where they resolve to is
	 * written to the log once, by the name of the file only: a window under test shows there that it runs stand-ins.
	 */
	private createLauncher(): { controller: LauncherController; host: LauncherPanelHost } | undefined {
		const configuration = () => vscode.workspace.getConfiguration(CHATGPT_WEB_SECTION);
		const isEnabled = () => configuration().get<boolean>('enabled') !== false;
		const off = () => { vscode.window.showInformationMessage(vscode.env.remoteName === undefined ? vscode.l10n.t("ChatGPT Web is turned off (vibeAgents.chatgptWeb.enabled).") : vscode.l10n.t("ChatGPT Web is offered in local windows only: the launcher and its port are on this machine.")); };
		const commands = [PANEL_COMMANDS.openPanel, PANEL_COMMANDS.refresh, ...Object.keys(COMMAND_OPERATIONS)];
		if (vscode.env.remoteName !== undefined) {
			this.disposables.push(...commands.map(command => vscode.commands.registerCommand(command, off)));
			return undefined;
		}

		const keys: (keyof LauncherSettings)[] = ['runtimePath', 'launcherBundleId', 'launcherAppPath', 'openCommand', 'osascriptCommand', 'pgrepCommand', 'codexCommand', 'codexConfigPath'];
		const settings = () => launcherSettingsOf(Object.fromEntries(keys.map(key => [key, configuration().get<string>(key)])));
		const basename = (path: string | undefined) => path === undefined ? '(default)' : path.split(/[\\/]/).pop();
		const seams = settings();
		this.log.info(`chatgpt-web seams: runtime=${basename(seams.runtimePath)} open=${basename(seams.openCommand)} osascript=${basename(seams.osascriptCommand)} pgrep=${basename(seams.pgrepCommand)} codex=${basename(seams.codexCommand)} bundle=${seams.launcherBundleId} app=${basename(seams.launcherAppPath)} codexConfig=${basename(seams.codexConfigPath)}`);

		const system = nodeLauncherSystem(settings);
		const controller = new LauncherController(system, {
			settings,
			openExternal: url => { vscode.env.openExternal(vscode.Uri.parse(url)); },
			selectedModel: () => this.context.globalState.get<string>(CHATGPT_WEB_MODEL_KEY),
		});
		const ui: PanelUi = {
			confirm: async request => {
				// The first button is the one Enter presses: where there is a way that keeps the machine working, it is that one
				const chosen = await vscode.window.showWarningMessage(request.title, { modal: true, detail: request.detail }, ...[request.alternative, request.button].filter(label => label !== undefined));
				return chosen === request.button ? 'go' : chosen !== undefined && chosen === request.alternative ? 'alternative' : undefined;
			},
			openPanel: () => this.showLauncherPanel(),
			log: message => this.log.info(message),
		};
		const host = new LauncherPanelHost(controller, ui, system.timers);
		this.launcher = host;

		const run = (command: string) => async () => {
			if (!isEnabled()) {
				off();
				return;
			}
			const outcome = await host.run(COMMAND_OPERATIONS[command]);
			// Where no view of ChatGPT Web shows how it ended, a notification does
			if (!host.isShowing && outcome.message) {
				(outcome.status === 'ok' || outcome.status === 'cancelled' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(outcome.message);
			}
		};
		this.disposables.push(
			new vscode.Disposable(() => { host.dispose(); controller.dispose(); }),
			vscode.window.registerWebviewViewProvider(CHATGPT_WEB_VIEW, { resolveWebviewView: view => this.resolveLauncherView(view) }),
			vscode.window.registerWebviewPanelSerializer(CHATGPT_WEB_PANEL, { deserializeWebviewPanel: async panel => this.adoptLauncherPanel(panel) }),
			vscode.commands.registerCommand(PANEL_COMMANDS.openPanel, () => isEnabled() ? host.openPanel() : off()),
			vscode.commands.registerCommand(PANEL_COMMANDS.refresh, () => isEnabled() ? host.refresh(true) : off()),
			...Object.keys(COMMAND_OPERATIONS).map(command => vscode.commands.registerCommand(command, run(command))),
		);
		return { controller, host };
	}

	private launcherPage(webview: vscode.Webview, layout: Layout): string {
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		webview.options = { enableScripts: true, localResourceRoots: [media] };
		const asset = (name: string): string => webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
		return renderPage({ cspSource: webview.cspSource, nonce: nonce(), styleUri: [asset('sessions.css'), asset('launcher.css')], scriptUri: asset('launcher.js'), title: vscode.l10n.t("ChatGPT Web"), data: { layout } });
	}

	private resolveLauncherView(view: vscode.WebviewView): void {
		const host = this.launcher;
		if (!host) {
			return;
		}
		const attached = host.attach({ layout: 'compact', post: (message: LauncherInbound) => { view.webview.postMessage(message); } }, view.visible);
		const listeners = vscode.Disposable.from(
			view.webview.onDidReceiveMessage(message => attached.onMessage(message)),
			view.onDidChangeVisibility(() => attached.setVisible(view.visible)),
			view.onDidDispose(() => {
				listeners.dispose();
				attached.dispose();
			}),
		);
		view.webview.html = this.launcherPage(view.webview, 'compact');
	}

	private showLauncherPanel(): void {
		if (this.launcherPanel) {
			this.launcherPanel.reveal();
			return;
		}
		this.adoptLauncherPanel(vscode.window.createWebviewPanel(CHATGPT_WEB_PANEL, vscode.l10n.t("ChatGPT Web"), vscode.ViewColumn.Active, { enableScripts: true }));
	}

	/** A panel that was just created, or one the workbench brings back after a reload: its webview kept which screen it showed. */
	private adoptLauncherPanel(panel: vscode.WebviewPanel): void {
		const host = this.launcher;
		if (!host || this.launcherPanel) {
			panel.dispose(); // one panel per window
			return;
		}
		this.launcherPanel = panel;
		const attached = host.attach({ layout: 'panel', post: (message: LauncherInbound) => { panel.webview.postMessage(message); } }, panel.visible);
		const listeners = vscode.Disposable.from(
			panel.webview.onDidReceiveMessage(message => attached.onMessage(message)),
			panel.onDidChangeViewState(() => attached.setVisible(panel.visible)),
			panel.onDidDispose(() => {
				listeners.dispose();
				attached.dispose();
				this.launcherPanel = undefined;
			}),
		);
		panel.webview.html = this.launcherPage(panel.webview, 'panel');
	}

	//#endregion

	//#region Sessions

	private onDidChangeSessions(changes: readonly SessionChange[]): void {
		for (const change of changes) {
			if (change.session && change.from !== undefined && change.from !== change.to) {
				this.announcements.push(announcementOf(change.session));
				this.notify(change.session);
			}
		}
		this.refreshSoon(false);
	}

	/** The session the user is asked to look at next: what needs them first. */
	private focusNext(): void {
		const next = orderSessions(this.registry.sessions).find(session => !session.terminalGone);
		if (next) {
			this.terminals.focus(next.id);
		}
	}

	private notify(session: Session): void {
		if (session.state !== 'waiting' && session.state !== 'finished' && session.state !== 'failed') {
			return;
		}
		const mode = vscode.workspace.getConfiguration(SECTION).get<string>('notify') ?? 'attention';
		if (mode === 'off' || (mode !== 'all' && this.terminals.isInView(session.id)) || this.notified.has(session.id)) {
			return;
		}

		const name = session.folder ? vscode.l10n.t("{0} in {1}", session.label, session.folder) : session.label;
		const focus = vscode.l10n.t("Focus");
		const message = session.state === 'waiting' ? vscode.l10n.t("{0} is waiting for you.", name)
			: session.state === 'finished' ? vscode.l10n.t("{0} finished.", name)
				: session.exitCode === undefined ? vscode.l10n.t("{0} failed.", name) : vscode.l10n.t("{0} failed with exit code {1}.", name, session.exitCode);
		const show = session.state === 'failed' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;

		// One notification per session at a time: an agent that goes back and forth does not pile them up
		this.notified.add(session.id);
		show(message, ...(session.terminalGone ? [] : [focus])).then(choice => {
			this.notified.delete(session.id);
			if (choice === focus) {
				this.terminals.focus(session.id);
			}
		}, () => this.notified.delete(session.id));
	}

	//#endregion

	//#region Showing

	/** Output changes sessions many times a second: what shows them follows at its own pace. */
	private refreshSoon(withRows: boolean): void {
		if (withRows) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.refreshTimer ??= setTimeout(() => {
			this.refreshTimer = undefined;
			this.refresh(withRows);
		}, 120);
	}

	private async refresh(withRows: boolean): Promise<void> {
		if (withRows) {
			this.rows = await this.profiles.statusRows();
		}

		const sessions = orderSessions(this.registry.sessions);
		const counts = countSessions(sessions);

		const text = statusBarTextOf(counts);
		if (text === undefined) {
			this.statusBar.hide();
		} else {
			this.statusBar.text = text;
			this.statusBar.tooltip = badgeOf(counts)?.tooltip ?? summaryTextOf(counts);
			this.statusBar.backgroundColor = counts.attention > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
			this.statusBar.show();
		}

		this.badgeView.badge = badgeOf(counts);
		this.reportWindowStatus(windowStatusOf(counts));

		if (this.view && this.isViewReady) {
			const message: HostInbound = {
				type: 'state',
				sessions: sessions.map(session => ({ session, stopArmed: this.terminals.isStopArmed(session.id) })),
				profiles: this.profiles.profiles.map(profile => ({ id: profile.id, label: profile.label, icon: profile.icon })),
				rows: this.rows,
				summary: summaryTextOf(counts),
				now: Date.now(),
				announcement: this.announcements.length > 0 ? this.announcements.join('. ') : undefined,
			};
			this.announcements = [];
			this.view.webview.postMessage(message);
		} else {
			this.announcements = this.announcements.slice(-3);
		}
	}

	/** The tab of this window in the workspace bar shows what its agents do, which is what counts while the window is hidden. */
	private reportWindowStatus(status: ReturnType<typeof windowStatusOf>): void {
		const serialized = JSON.stringify(status);
		if (serialized === this.lastWindowStatus) {
			return;
		}
		this.lastWindowStatus = serialized;
		vscode.commands.executeCommand(SET_WINDOW_STATUS_COMMAND, status).then(undefined, () => {
			// a workbench without workspace bar
		});
	}

	private resolveView(view: vscode.WebviewView): void {
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		const webview = view.webview;
		webview.options = { enableScripts: true, localResourceRoots: [media] };

		this.view = view;
		this.isViewReady = false;
		this.profiles.setRowsVisible(view.visible);
		const asset = (name: string): string => webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
		const listeners = vscode.Disposable.from(
			webview.onDidReceiveMessage((message: HostOutbound) => this.onMessage(message)),
			view.onDidChangeVisibility(() => {
				this.profiles.setRowsVisible(view.visible);
				if (view.visible) {
					this.refreshSoon(true);
				}
			}),
			view.onDidDispose(() => {
				listeners.dispose();
				if (this.view === view) {
					this.view = undefined;
					this.isViewReady = false;
					this.profiles.setRowsVisible(false);
				}
			}),
		);
		webview.html = renderPage({ cspSource: webview.cspSource, nonce: nonce(), styleUri: asset('sessions.css'), scriptUri: asset('sessions.js'), title: vscode.l10n.t("Sessions") });
	}

	private onMessage(message: HostOutbound): void {
		switch (message.type) {
			case 'ready':
				this.isViewReady = true;
				this.refresh(true);
				break;
			case 'start':
				this.newAgent(message.profileId);
				break;
			case 'adopt':
				this.terminals.adoptPick();
				break;
			case 'clear':
				this.terminals.clearEnded();
				break;
			case 'session':
				this.onSessionAction(message.action, message.id);
				break;
			case 'row': {
				const row = this.rows.find(candidate => candidate.id === message.id);
				const action = message.secondary === undefined ? row?.action : row?.secondaryActions?.[message.secondary];
				if (action) {
					vscode.commands.executeCommand(action.command, ...(action.args ?? []));
				}
				break;
			}
		}
	}

	private onSessionAction(action: string, id: string): void {
		switch (action) {
			case 'focus': this.terminals.focus(id); break;
			case 'stop': this.terminals.stop(id); break;
			case 'restart': this.restart(id); break;
			case 'dismiss': this.terminals.dismiss(id); break;
		}
	}

	//#endregion
}
