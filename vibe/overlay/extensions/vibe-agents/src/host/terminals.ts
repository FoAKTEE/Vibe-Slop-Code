// SPDX-License-Identifier: MIT

// Terminals and sessions: starts agents in integrated terminals, adopts the ones the user starts by hand and
// tells the registry what the terminals do. Everything that is a decision lives in ../model.
import * as vscode from 'vscode';
import { commandLineOf, matchCommandLine, quietMsOf, type AgentProfile, type CommandLineMatch, type ProfileRegistry } from '../model/profiles.ts';
import type { RegistrySnapshot, SessionRegistry } from '../model/registry.ts';
import { isLive, type Session } from '../model/session.ts';

const STATE_KEY = 'vibeAgents.state';

/**
 * How long shell integration gets to activate once the shell reads a command line. It activates with the first
 * prompt, where it activates at all: some prompts (powerlevel10k) draw over the marks it depends on.
 */
const SHELL_INTEGRATION_GRACE = 1500;
/** How long a shell of which nothing is known gets before the command line is typed into it anyway. */
const UNKNOWN_SHELL_TIMEOUT = 5000;
/** How long a shell may take to draw its prompt before the card tells to look at the terminal. */
const PROMPT_NOTE_DELAY = 4000;
/**
 * Shells whose line editor tells when it reads a command line (it turns on bracketed paste). They are
 * waited for however long they take: some ask a question first (such as whether to update), and typing
 * a command line into that answers it.
 */
const SHELLS_THAT_TELL: ReadonlySet<string> = new Set(['bash', 'zsh', 'fish', 'pwsh', 'gitbash']);
/** How long the terminals of the previous window get to come back after a reload. */
const REATTACH_TIMEOUT = 20_000;
/**
 * How long output is still listened to after the last agent ended: the editor reports an exit
 * before the output that led to it arrived, and that output has the last words of the agent.
 */
const OUTPUT_GRACE = 3000;
/** How long a second press on Stop closes the terminal instead of interrupting once more. */
const STOP_ARMED_TIMEOUT = 10_000;

interface Binding {
	/** Process id of the shell of the terminal: the same before and after a window reload. */
	pid: number | undefined;
}

interface StoredState {
	snapshot: RegistrySnapshot;
	bindings: Record<string, Binding>;
}

export interface AgentTerminalsOptions {
	/** The setting `vibeAgents.adoptCommands`. */
	adoptPattern(): string;
	log: vscode.LogOutputChannel;
}

export class AgentTerminals implements vscode.Disposable {

	private readonly disposables: vscode.Disposable[] = [];
	private readonly terminals = new Map<string, vscode.Terminal>();
	private readonly pids = new Map<string, number | undefined>();
	private readonly executions = new Map<string, vscode.TerminalShellExecution>();
	private readonly stopArmed = new Map<string, ReturnType<typeof setTimeout>>();
	/** Sessions of the previous window that wait for their terminal to come back. */
	private readonly unattached = new Map<string, Binding>();

	/** The raw output of all terminals (proposed API). Not there: output is read per command instead. */
	private readonly onDidWriteData: vscode.Event<vscode.TerminalDataWriteEvent> | undefined;
	private dataListener: vscode.Disposable | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private stopListeningTimer: ReturnType<typeof setTimeout> | undefined;
	private persistTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly onDidChangeStopArmedEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeStopArmed = this.onDidChangeStopArmedEmitter.event;

	private readonly context: vscode.ExtensionContext;
	private readonly registry: SessionRegistry;
	private readonly profiles: ProfileRegistry;
	private readonly options: AgentTerminalsOptions;

	constructor(context: vscode.ExtensionContext, registry: SessionRegistry, profiles: ProfileRegistry, options: AgentTerminalsOptions) {
		this.context = context;
		this.registry = registry;
		this.profiles = profiles;
		this.options = options;
		this.onDidWriteData = writeDataEvent();
		options.log.info(this.onDidWriteData ? 'output: window.onDidWriteTerminalData' : 'output: TerminalShellExecution.read()');

		this.disposables.push(
			this.onDidChangeStopArmedEmitter,
			vscode.window.onDidStartTerminalShellExecution(event => this.onDidStartExecution(event)),
			vscode.window.onDidEndTerminalShellExecution(event => this.onDidEndExecution(event)),
			vscode.window.onDidCloseTerminal(terminal => this.onDidCloseTerminal(terminal)),
			vscode.window.onDidOpenTerminal(terminal => this.attach(terminal)),
			vscode.window.onDidChangeActiveTerminal(() => this.markSeen()),
			vscode.window.onDidChangeWindowState(() => this.markSeen()),
			registry.onDidChange(changes => {
				const isTransition = changes.some(change => change.from !== change.to);
				this.persistSoon(isTransition ? 500 : 15_000);
				if (isTransition) {
					for (const change of changes) {
						if (!change.session || !isLive(change.session)) {
							this.disarmStop(change.id);
						}
					}
					this.updateListening();
					this.markSeen();
				}
			}),
		);
	}

	dispose(): void {
		this.persist();
		this.dataListener?.dispose();
		clearInterval(this.ticker);
		clearTimeout(this.stopListeningTimer);
		clearTimeout(this.persistTimer);
		for (const timer of this.stopArmed.values()) {
			clearTimeout(timer);
		}
		vscode.Disposable.from(...this.disposables).dispose();
	}

	isStopArmed(id: string): boolean {
		return this.stopArmed.has(id);
	}

	/** Whether the terminal of the session is the one the user looks at. */
	isInView(id: string): boolean {
		return vscode.window.state.focused && vscode.window.activeTerminal !== undefined && vscode.window.activeTerminal === this.terminals.get(id);
	}

	//#region Starting

	async start(profile: AgentProfile): Promise<void> {
		const folder = await this.pickFolder();
		if (folder === null) {
			return;
		}
		const session = this.registry.create({
			profileId: profile.id,
			label: profile.label,
			icon: profile.icon,
			command: commandLineOf(profile),
			folder: folder?.name,
			adopted: false,
			quietMs: quietMsOf(profile),
		}, Date.now());
		await this.launch(session, profile, folder);
	}

	/** `undefined`: there is no folder. `null`: the user did not pick one. */
	private async pickFolder(): Promise<vscode.WorkspaceFolder | undefined | null> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (folders.length <= 1) {
			return folders[0];
		}
		return await vscode.window.showWorkspaceFolderPick({ placeHolder: vscode.l10n.t("Folder to start the agent in") }) ?? null;
	}

	private async launch(session: Session, profile: AgentProfile | undefined, folder: vscode.WorkspaceFolder | undefined): Promise<void> {
		const terminal = vscode.window.createTerminal({
			name: session.label,
			cwd: cwdOf(profile, folder),
			env: profile?.env,
			iconPath: new vscode.ThemeIcon(session.icon ?? 'hubot'),
			isTransient: false,
		});
		this.bind(session.id, terminal);
		terminal.show();
		await this.run(session.id, terminal, session.command);
	}

	/**
	 * Runs the command line through shell integration, which reports its exit code, or else types it, but never
	 * before the shell reads a command line: typing into a shell that still asks something at startup answers
	 * that question. The output of the terminal tells when the line editor of the shell is on.
	 */
	private async run(id: string, terminal: vscode.Terminal, commandLine: string): Promise<void> {
		const isOurs = () => this.terminals.get(id) === terminal && !terminal.exitStatus;

		const shellIntegration = terminal.shellIntegration ?? await this.waitUntilReady(id, terminal, isOurs);
		if (!isOurs()) {
			return; // closed or replaced in the meantime
		}

		if (shellIntegration) {
			this.executions.set(id, shellIntegration.executeCommand(commandLine));
		} else {
			this.options.log.info(`${id}: no shell integration (shell: ${terminal.state.shell ?? 'unknown'}), typing the command line`);
			terminal.sendText(commandLine, true);
			this.registry.started(id, Date.now());
		}
	}

	/**
	 * Resolves once a command line can go to the terminal: with its shell integration, or with nothing when
	 * the command line has to be typed (or the terminal is gone, which the caller finds out).
	 */
	private async waitUntilReady(id: string, terminal: vscode.Terminal, isOurs: () => boolean): Promise<vscode.TerminalShellIntegration | undefined> {
		const canSeeOutput = this.onDidWriteData !== undefined;
		const started = Date.now();
		let noted = false;
		while (isOurs() && !terminal.shellIntegration) {
			if (canSeeOutput && this.registry.isPromptReady(id)) {
				// The shell reads a command line. Shell integration is better than typing, and activates about now if it does
				return isShellIntegrationEnabled() ? this.waitForShellIntegration(terminal, SHELL_INTEGRATION_GRACE) : undefined;
			}

			const waited = Date.now() - started;
			const tells = canSeeOutput && SHELLS_THAT_TELL.has(terminal.state.shell ?? '');
			if (!tells && waited >= UNKNOWN_SHELL_TIMEOUT) {
				return undefined; // nothing is known about this shell: typing is all there is
			}
			if (tells && !noted && waited >= PROMPT_NOTE_DELAY) {
				noted = true;
				this.options.log.info(`${id}: ${terminal.state.shell} does not read a command line yet, waiting for it`);
				this.registry.note(id, vscode.l10n.t("Waiting for the shell prompt: look at the terminal"));
			}
			await new Promise(resolve => setTimeout(resolve, 150));
		}
		return terminal.shellIntegration;
	}

	/** Resolves with the shell integration of the terminal, or with nothing when the time is up or the terminal closes. */
	private waitForShellIntegration(terminal: vscode.Terminal, timeout: number | undefined): Promise<vscode.TerminalShellIntegration | undefined> {
		if (terminal.shellIntegration) {
			return Promise.resolve(terminal.shellIntegration);
		}
		return new Promise(resolve => {
			const done = (shellIntegration: vscode.TerminalShellIntegration | undefined) => {
				clearTimeout(timer);
				listeners.dispose();
				resolve(shellIntegration);
			};
			const timer = timeout === undefined ? undefined : setTimeout(() => done(undefined), timeout);
			const listeners = vscode.Disposable.from(
				vscode.window.onDidChangeTerminalShellIntegration(event => event.terminal === terminal && done(event.shellIntegration)),
				vscode.window.onDidCloseTerminal(closed => closed === terminal && done(undefined)),
			);
		});
	}

	//#endregion

	//#region Adopting

	/** Lets the user pick a terminal in which an agent runs already. */
	async adoptPick(): Promise<void> {
		const candidates = vscode.window.terminals.filter(terminal => !terminal.exitStatus && this.sessionOf(terminal) === undefined);
		if (candidates.length === 0) {
			vscode.window.showInformationMessage(vscode.l10n.t("There is no terminal that is not an agent session already."));
			return;
		}
		const picked = await vscode.window.showQuickPick(candidates.map(terminal => ({ label: terminal.name, terminal })), { placeHolder: vscode.l10n.t("Terminal in which an agent runs") });
		if (picked) {
			this.adopt(picked.terminal, { profile: undefined, label: picked.terminal.name }, picked.terminal.name, undefined);
		}
	}

	private adopt(terminal: vscode.Terminal, match: CommandLineMatch, commandLine: string, execution: vscode.TerminalShellExecution | undefined): void {
		const folder = execution?.cwd ? vscode.workspace.getWorkspaceFolder(execution.cwd) : undefined;
		const session = this.registry.create({
			profileId: match.profile?.id,
			label: match.label,
			icon: match.profile?.icon,
			command: commandLine,
			folder: (folder ?? vscode.workspace.workspaceFolders?.[0])?.name,
			adopted: true,
			quietMs: quietMsOf(match.profile),
		}, Date.now());
		this.bind(session.id, terminal);
		if (execution) {
			this.executions.set(session.id, execution);
		}
		this.registry.started(session.id, Date.now());
	}

	//#endregion

	//#region Actions

	focus(id: string): void {
		this.terminals.get(id)?.show(false);
		this.registry.seen(id);
	}

	/** Interrupts the agent. Asked again shortly after, closes its terminal. */
	stop(id: string): void {
		const terminal = this.terminals.get(id);
		if (!terminal) {
			return;
		}
		if (this.stopArmed.has(id)) {
			this.disarmStop(id);
			terminal.dispose();
			return;
		}
		terminal.sendText('\x03', false);
		this.registry.input(id, Date.now());
		this.stopArmed.set(id, setTimeout(() => this.disarmStop(id), STOP_ARMED_TIMEOUT));
		this.onDidChangeStopArmedEmitter.fire();
	}

	private disarmStop(id: string): void {
		const timer = this.stopArmed.get(id);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.stopArmed.delete(id);
			this.onDidChangeStopArmedEmitter.fire();
		}
	}

	/** Starts the agent again: in its terminal when it is over and the shell is back, in a new one otherwise. */
	async restart(id: string): Promise<void> {
		const session = this.registry.get(id);
		if (!session) {
			return;
		}
		const profile = this.profiles.get(session.profileId);
		const commandLine = profile && !session.adopted ? commandLineOf(profile) : session.command;
		const terminal = this.terminals.get(id);
		const canReuse = terminal !== undefined && !terminal.exitStatus && !isLive(session) && terminal.shellIntegration !== undefined;

		this.registry.restarted(id, Date.now(), quietMsOf(profile));
		this.executions.delete(id);
		if (canReuse) {
			terminal.show();
			await this.run(id, terminal, commandLine);
			return;
		}

		if (terminal) {
			this.unbind(id);
			terminal.dispose();
		}
		const restarted = this.registry.get(id);
		if (restarted) {
			const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.name === session.folder) ?? vscode.workspace.workspaceFolders?.[0];
			await this.launch({ ...restarted, command: commandLine }, profile, folder);
		}
	}

	/** Forgets the session. Its terminal stays. */
	dismiss(id: string): void {
		this.unbind(id);
		this.registry.dismiss(id);
	}

	clearEnded(): void {
		for (const session of this.registry.clearEnded()) {
			this.unbind(session.id);
		}
	}

	//#endregion

	//#region Terminal events

	private onDidStartExecution(event: vscode.TerminalShellExecutionStartEvent): void {
		const commandLine = event.execution.commandLine.value;
		let id = this.sessionOf(event.terminal);
		const session = id === undefined ? undefined : this.registry.get(id);

		if (id !== undefined && session) {
			if (session.state === 'starting') {
				this.executions.set(id, event.execution);
				this.registry.started(id, Date.now());
			} else if (!isLive(session)) {
				// An agent is started by hand in the terminal of a session that is over: its next run
				const match = matchCommandLine(this.profiles.profiles, commandLine, this.options.adoptPattern());
				if (!match) {
					return;
				}
				this.registry.restarted(id, Date.now(), quietMsOf(match.profile));
				this.executions.set(id, event.execution);
				this.registry.started(id, Date.now());
			} else {
				return; // something else runs while the agent does, such as in a shell of its own
			}
		} else {
			const match = matchCommandLine(this.profiles.profiles, commandLine, this.options.adoptPattern());
			if (!match) {
				return;
			}
			this.options.log.info(`adopting "${event.terminal.name}": ${match.label}`);
			this.adopt(event.terminal, match, commandLine, event.execution);
			id = this.sessionOf(event.terminal);
		}

		if (id !== undefined && !this.onDidWriteData) {
			this.read(id, event.execution);
		}
	}

	private async read(id: string, execution: vscode.TerminalShellExecution): Promise<void> {
		try {
			for await (const data of execution.read()) {
				if (this.executions.get(id) !== execution) {
					return;
				}
				this.registry.output(id, data, Date.now());
			}
		} catch (error) {
			this.options.log.warn(`${id}: reading the output failed`, error);
		}
	}

	private onDidEndExecution(event: vscode.TerminalShellExecutionEndEvent): void {
		const id = this.sessionOf(event.terminal);
		const session = id === undefined ? undefined : this.registry.get(id);
		if (id === undefined || !session || !isLive(session) || session.state === 'starting') {
			return;
		}
		// After a window reload the execution of the agent is not known: whatever ends while it runs is the agent
		const execution = this.executions.get(id);
		if (execution === undefined || execution === event.execution) {
			this.executions.delete(id);
			this.registry.exited(id, event.exitCode, Date.now());
		}
	}

	private onDidCloseTerminal(terminal: vscode.Terminal): void {
		const id = this.sessionOf(terminal);
		if (id !== undefined) {
			this.unbind(id);
			this.registry.closed(id, Date.now());
		}
	}

	/** Looking at the terminal of a session is seeing what it has to say. */
	private markSeen(): void {
		for (const session of this.registry.sessions) {
			if (session.attention && this.isInView(session.id)) {
				this.registry.seen(session.id);
			}
		}
	}

	//#endregion

	//#region Output and time

	/** Output is only listened to, and the clock only runs, while there is an agent that may still be running. */
	private updateListening(): void {
		const isNeeded = this.registry.sessions.some(isLive);
		if (isNeeded) {
			clearTimeout(this.stopListeningTimer);
			this.stopListeningTimer = undefined;
		}
		if (isNeeded && !this.ticker) {
			this.ticker = setInterval(() => this.registry.tick(Date.now()), 1000);
			this.dataListener = this.onDidWriteData?.(event => {
				const id = this.sessionOf(event.terminal);
				if (id !== undefined) {
					this.registry.output(id, event.data, Date.now());
				}
			});
		} else if (!isNeeded && this.ticker && this.stopListeningTimer === undefined) {
			this.stopListeningTimer = setTimeout(() => {
				this.stopListeningTimer = undefined;
				if (!this.registry.sessions.some(isLive)) {
					clearInterval(this.ticker);
					this.ticker = undefined;
					this.dataListener?.dispose();
					this.dataListener = undefined;
				}
			}, OUTPUT_GRACE);
		}
	}

	//#endregion

	//#region Sessions and terminals

	private sessionOf(terminal: vscode.Terminal): string | undefined {
		for (const [id, candidate] of this.terminals) {
			if (candidate === terminal) {
				return id;
			}
		}
		return undefined;
	}

	private bind(id: string, terminal: vscode.Terminal): void {
		this.terminals.set(id, terminal);
		this.pids.set(id, undefined);
		terminal.processId.then(pid => {
			if (this.terminals.get(id) === terminal) {
				this.pids.set(id, pid);
				this.persistSoon(500);
			}
		});
	}

	private unbind(id: string): void {
		this.terminals.delete(id);
		this.pids.delete(id);
		this.executions.delete(id);
		this.unattached.delete(id);
		this.disarmStop(id);
	}

	//#endregion

	//#region Window reload

	/**
	 * Takes over the sessions of the window before a reload. Their terminals come back one by one: a terminal
	 * is the one of a session when its shell is the same process. What did not come back in time is gone.
	 */
	restore(): void {
		const stored = this.context.workspaceState.get<StoredState>(STATE_KEY);
		const sessions = this.registry.restore(stored?.snapshot, Date.now());
		for (const session of sessions) {
			if (!session.terminalGone) {
				this.unattached.set(session.id, stored?.bindings?.[session.id] ?? { pid: undefined });
			}
		}
		if (sessions.length === 0) {
			return;
		}
		this.options.log.info(`restored ${sessions.length} session(s)`);

		for (const terminal of vscode.window.terminals) {
			this.attach(terminal);
		}
		const timer = setTimeout(() => {
			for (const id of [...this.unattached.keys()]) {
				this.options.log.info(`${id}: its terminal did not come back`);
				this.unattached.delete(id);
				this.registry.closed(id, Date.now());
			}
		}, REATTACH_TIMEOUT);
		this.disposables.push(new vscode.Disposable(() => clearTimeout(timer)));
		this.updateListening();
	}

	private async attach(terminal: vscode.Terminal): Promise<void> {
		if (this.unattached.size === 0) {
			return;
		}
		const pid = await terminal.processId;
		if (pid === undefined || this.sessionOf(terminal) !== undefined) {
			return;
		}
		for (const [id, binding] of this.unattached) {
			if (binding.pid === pid) {
				this.options.log.info(`${id}: attached to "${terminal.name}" again (process ${pid})`);
				this.unattached.delete(id);
				this.terminals.set(id, terminal);
				this.pids.set(id, pid);
				this.markSeen();
				return;
			}
		}
	}

	private persistSoon(delay: number): void {
		if (this.persistTimer === undefined || delay < 1000) {
			clearTimeout(this.persistTimer);
			this.persistTimer = setTimeout(() => this.persist(), delay);
		}
	}

	private persist(): void {
		clearTimeout(this.persistTimer);
		this.persistTimer = undefined;
		const bindings: Record<string, Binding> = {};
		for (const session of this.registry.sessions) {
			bindings[session.id] = this.unattached.get(session.id) ?? { pid: this.pids.get(session.id) };
		}
		const state: StoredState = { snapshot: this.registry.snapshot(), bindings };
		this.context.workspaceState.update(STATE_KEY, state);
	}

	//#endregion
}

function isShellIntegrationEnabled(): boolean {
	return vscode.workspace.getConfiguration('terminal.integrated.shellIntegration').get<boolean>('enabled') !== false;
}

/** The proposed event, where the product allows it: reading the property throws where it does not. */
function writeDataEvent(): vscode.Event<vscode.TerminalDataWriteEvent> | undefined {
	try {
		return vscode.window.onDidWriteTerminalData;
	} catch {
		return undefined;
	}
}

function cwdOf(profile: AgentProfile | undefined, folder: vscode.WorkspaceFolder | undefined): vscode.Uri | string | undefined {
	if (!profile?.cwd) {
		return folder?.uri;
	}
	const folderPath = folder ? (folder.uri.scheme === 'file' ? folder.uri.fsPath : folder.uri.path) : '';
	return profile.cwd.replace(/\$\{workspaceFolder\}/g, folderPath);
}
