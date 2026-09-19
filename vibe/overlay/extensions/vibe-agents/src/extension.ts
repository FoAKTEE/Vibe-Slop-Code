// SPDX-License-Identifier: MIT

// The wiring: settings, commands, the Sessions view, the badge, the status bar, notifications and what the
// window tells the workspace bar. What terminals do is in ./host/terminals, every decision in ./model.
import * as vscode from 'vscode';
import { renderPage } from './host/page.ts';
import { AgentTerminals } from './host/terminals.ts';
import { DEFAULT_ADOPT_PATTERN, ProfileRegistry, parseUserProfiles, type AgentProfile, type ProfileProvider, type Registration, type StatusRow, type StatusRowProvider } from './model/profiles.ts';
import { SessionRegistry, type SessionChange } from './model/registry.ts';
import type { Session } from './model/session.ts';
import { announcementOf, badgeOf, countSessions, orderSessions, statusBarTextOf, summaryTextOf, windowStatusOf } from './model/summary.ts';
import type { HostInbound, HostOutbound } from './protocol.ts';

const SECTION = 'vibeAgents';
const SESSIONS_VIEW = 'vibeAgents.sessions';
const BADGE_VIEW = 'vibeAgents.attention';
const SET_WINDOW_STATUS_COMMAND = '_workbench.workspaceBar.setWindowStatus';

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
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(`${SECTION}.profiles`)) {
					this.loadProfiles();
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
		if (profile) {
			await this.terminals.start(profile);
		}
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
		const asset = (name: string): string => webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
		const listeners = vscode.Disposable.from(
			webview.onDidReceiveMessage((message: HostOutbound) => this.onMessage(message)),
			view.onDidChangeVisibility(() => {
				if (view.visible) {
					this.refreshSoon(true);
				}
			}),
			view.onDidDispose(() => {
				listeners.dispose();
				if (this.view === view) {
					this.view = undefined;
					this.isViewReady = false;
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
				const action = this.rows.find(row => row.id === message.id)?.action;
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
			case 'restart': this.terminals.restart(id); break;
			case 'dismiss': this.terminals.dismiss(id); break;
		}
	}

	//#endregion
}
