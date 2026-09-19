// SPDX-License-Identifier: MIT

// The one place operations on the engine go through. ONE runs at a time, the others wait in a queue and can be
// taken out of it; an operation that is already waiting or running is not added again. Before anything that is no
// probe runs, the three free probes run, so that what is decided is decided on what is true now: its preconditions,
// and whether it has to ask first. Afterwards what it may have changed is looked at again, and where the engine
// takes a while to come up or to go, the free probes run again after a few delays. NOTHING is tried again by itself.
//
// Everything the editor shows comes from `snapshot`, and changes are announced by `onDidChange`. The machine is
// behind `LauncherSystem`, time included, so all of this runs in a test. Nothing in here imports the editor.
import { launcherAppPaths, parseLauncherRoute, resolveCodexConfigPath, type ProbeFailure } from '../../model/chatgptWeb.ts';
import { ActivityLog, type ActivityEntry, type ActivityOutcome } from '../../model/launcher/activity.ts';
import { daemonPortOf, emptyFacts, failed, isRouteActive, isRouteInstalled, type LauncherFacts, type ProbeFailed } from '../../model/launcher/facts.ts';
import { OPERATIONS, argvOf, checkPreconditions, confirmationOf, isAbortable, isOperationId, operationOf, type Confirmation, type Operation, type OperationId, type ProbeId } from '../../model/launcher/operations.ts';
import {
	CODEX_MODELS_ARGV, parseCancelledTurns, parseCliError, parseCodexModels, parseDoctor, parseEngineHealth, parseRouteChange, parseRouteStatus, parseSubagentsChange, parseSubagentsStatus,
	parseVersion, runtimeArgv, runtimeCandidates, runtimeCommandOf, type RuntimeCommandId, type Unparseable,
} from '../../model/launcher/runtime.ts';
import type { LauncherSettings } from '../../model/launcher/settings.ts';
import { deriveViewState, type LauncherViewState } from '../../model/launcher/state.ts';
import type { LauncherSystem, RunResult } from './system.ts';

export interface ControllerOptions {
	settings: () => LauncherSettings;
	/** Opens a page in the browser of the user. Without it a link is refused. */
	openExternal?: (url: string) => void;
	/** The model sessions start on. */
	selectedModel?: () => string | undefined;
	activityCapacity?: number;
}

export interface OperationOutcome {
	/** 0: it never waited in the queue. */
	ticket: number;
	operation: OperationId;
	/** `needs-confirmation`: nothing ran. Ask with `confirmation`, then request it again as confirmed. */
	status: ActivityOutcome | 'needs-confirmation';
	/** What to tell the user. Sanitized: it may hold the first line of what the runtime said about its failure. */
	message: string;
	confirmation: Confirmation | undefined;
	/** Hand-offs: the step to take in the window that was shown. */
	hint: string | undefined;
}

export interface Ticket {
	ticket: number;
	done: Promise<OperationOutcome>;
}

export interface LauncherSnapshot {
	facts: LauncherFacts;
	view: LauncherViewState;
	running: { ticket: number; operation: OperationId | 'refresh'; startedAt: number } | undefined;
	queued: { ticket: number; operation: OperationId | 'refresh' }[];
	activity: readonly ActivityEntry[];
	lastOutcome: OperationOutcome | undefined;
}

type Scope = 'interval' | 'open' | 'settle';

interface Job {
	ticket: number;
	key: string;
	operation: OperationId | undefined;
	scope: Scope | undefined;
	confirmed: boolean;
	abort: AbortController;
	done: Promise<OperationOutcome>;
	resolve(outcome: OperationOutcome): void;
}

interface Executed {
	status: ActivityOutcome;
	message: string;
	exitCode: number | undefined;
	note: string | undefined;
	/** Nothing was run: there is nothing to write down. */
	skipped?: boolean;
}

const FREE_PROBES: readonly ProbeId[] = OPERATIONS.filter(operation => operation.cadence === 'interval').map(operation => operation.id as ProbeId);
const OPEN_PROBES: readonly ProbeId[] = ['probe.runtime', 'probe.engine', 'probe.codexRoute', 'probe.routeStatus', 'probe.health', 'probe.subagents'];
/** How long after the quit event the launcher is looked for again: it drains its daemon before it exits. */
const QUIT_POLL_MS: readonly number[] = [500, 1000, 2000, 4000, 8000];
/** On top of the deadline of a program: the machine below may never answer at all. */
const WATCHDOG_GRACE_MS = 3000;

export class LauncherController {

	private facts: LauncherFacts;
	private runtimePath: string | undefined;
	private readonly log: ActivityLog;
	private readonly queue: Job[] = [];
	private current: { job: Job; startedAt: number } | undefined;
	private lastOutcome: OperationOutcome | undefined;
	private lastState: string | undefined;
	private tickets = 0;
	private cached: LauncherSnapshot | undefined;
	private disposed = false;
	private readonly settleTimers = new Set<unknown>();
	private readonly listeners = new Set<() => void>();

	private readonly system: LauncherSystem;
	private readonly options: ControllerOptions;

	constructor(system: LauncherSystem, options: ControllerOptions) {
		this.system = system;
		this.options = options;
		this.facts = emptyFacts(system.platform);
		this.log = new ActivityLog(options.activityCapacity);
	}

	dispose(): void {
		this.disposed = true;
		for (const handle of this.settleTimers) {
			this.system.clock.clearTimeout(handle);
		}
		this.settleTimers.clear();
		for (const job of this.queue.splice(0)) {
			job.resolve(this.outcomeOf(job, 'cancelled', 'Cancelled.'));
		}
		if (this.current) {
			this.current.job.abort.abort();
			this.current.job.resolve(this.outcomeOf(this.current.job, 'cancelled', 'Cancelled.')); // whatever the machine still answers is ignored
		}
		this.listeners.clear();
	}

	//#region What the editor gets

	get snapshot(): LauncherSnapshot {
		this.cached ??= Object.freeze({
			facts: this.facts,
			view: deriveViewState({ facts: this.facts, activity: this.log.entries, selectedModel: this.options.selectedModel?.(), now: this.system.clock.now() }),
			running: this.current ? { ticket: this.current.job.ticket, operation: this.current.job.operation ?? 'refresh' as const, startedAt: this.current.startedAt } : undefined,
			queued: this.queue.map(job => ({ ticket: job.ticket, operation: job.operation ?? 'refresh' as const })),
			activity: this.log.entries,
			lastOutcome: this.lastOutcome,
		});
		return this.cached;
	}

	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	}

	private changed(): void {
		this.cached = undefined;
		for (const listener of [...this.listeners]) {
			listener();
		}
	}

	//#endregion

	//#region The queue

	/**
	 * Looks again. `interval`: the three free probes, as often as the status row looks. `open`: the panel opened, or
	 * the user asks: the runtime is asked as well, which starts a program, so never on a timer.
	 */
	refresh(scope: 'interval' | 'open'): Promise<void> {
		return this.enqueue(undefined, scope, false).done.then(() => undefined);
	}

	/** `confirmed`: the user was asked with the text of `confirmationOf`, and went ahead. */
	request(id: OperationId, options: { confirmed?: boolean } = {}): Ticket {
		if (!isOperationId(id)) {
			const outcome: OperationOutcome = { ticket: 0, operation: id, status: 'refused', message: 'There is no such operation.', confirmation: undefined, hint: undefined };
			return { ticket: 0, done: Promise.resolve(outcome) };
		}
		const confirmation = options.confirmed ? undefined : confirmationOf(operationOf(id), this.facts);
		if (confirmation) {
			return { ticket: 0, done: Promise.resolve({ ticket: 0, operation: id, status: 'needs-confirmation', message: confirmation.text, confirmation, hint: undefined }) };
		}
		return this.enqueue(id, undefined, options.confirmed === true);
	}

	/** Takes an operation out of the queue, or ends one that only reads. False: it writes, and is left to finish. */
	cancel(ticket: number): boolean {
		const index = this.queue.findIndex(job => job.ticket === ticket);
		if (index >= 0) {
			const [job] = this.queue.splice(index, 1);
			if (job.operation) {
				this.log.record({ at: this.system.clock.now(), operation: job.operation, outcome: 'cancelled', durationMs: 0, note: 'taken out of the queue' });
			}
			job.resolve(this.outcomeOf(job, 'cancelled', 'Cancelled before it started.'));
			this.changed();
			return true;
		}
		const running = this.current?.job;
		if (running?.ticket === ticket && (running.operation === undefined || isAbortable(running.operation))) {
			running.abort.abort();
			return true;
		}
		return false;
	}

	private enqueue(operation: OperationId | undefined, scope: Scope | undefined, confirmed: boolean): Ticket {
		const key = operation ?? `refresh:${scope}`;
		const existing = this.disposed ? undefined : this.current?.job.key === key ? this.current.job : this.queue.find(job => job.key === key);
		if (existing) {
			existing.confirmed ||= confirmed && existing !== this.current?.job;
			return { ticket: existing.ticket, done: existing.done };
		}
		let resolve: (outcome: OperationOutcome) => void = () => { };
		const done = new Promise<OperationOutcome>(settle => { resolve = settle; });
		const job: Job = { ticket: ++this.tickets, key, operation, scope, confirmed, abort: new AbortController(), done, resolve };
		if (this.disposed) {
			resolve(this.outcomeOf(job, 'cancelled', 'Cancelled.'));
			return { ticket: job.ticket, done };
		}
		this.queue.push(job);
		this.changed();
		void this.pump();
		return { ticket: job.ticket, done };
	}

	private async pump(): Promise<void> {
		const job = this.current || this.disposed ? undefined : this.queue.shift();
		if (!job) {
			return;
		}
		this.current = { job, startedAt: this.system.clock.now() };
		this.changed();
		let outcome: OperationOutcome;
		try {
			outcome = job.operation ? await this.runOperation(job, operationOf(job.operation)) : await this.runRefresh(job);
		} catch {
			outcome = this.outcomeOf(job, 'failed', 'It failed inside Vibe. Nothing is tried again by itself.');
		}
		this.current = undefined;
		if (job.operation) {
			this.lastOutcome = outcome;
		}
		job.resolve(outcome);
		this.changed();
		void this.pump();
	}

	private outcomeOf(job: Job, status: OperationOutcome['status'], message: string, more: Partial<OperationOutcome> = {}): OperationOutcome {
		return { ticket: job.ticket, operation: job.operation ?? 'probe.health', status, message, confirmation: undefined, hint: undefined, ...more };
	}

	//#endregion

	//#region Probes

	private async runRefresh(job: Job): Promise<OperationOutcome> {
		const probes = job.scope === 'open' ? OPEN_PROBES : FREE_PROBES;
		const wasRouted = isRouteActive(this.facts);
		for (const probe of probes) {
			if (job.abort.signal.aborted || this.disposed) {
				return this.outcomeOf(job, 'cancelled', 'Cancelled.');
			}
			await this.probe(probe, job.abort.signal, job.scope === 'open');
		}
		// The launcher connects the route by itself when it starts, and another window may pause it: the journal is asked
		// again when, and only when, the config of Codex shows a change. That is an event, not a timer
		if (job.scope !== 'open' && wasRouted !== isRouteActive(this.facts) && this.facts.runtime.found) {
			await this.probe('probe.routeStatus', job.abort.signal, true);
		}
		this.noteStateChange();
		return this.outcomeOf(job, 'ok', '');
	}

	/** One entry when what the free probes see turns into another state: they run too often to be written down one by one. */
	private noteStateChange(): void {
		const state = deriveViewState({ facts: this.facts, activity: [], selectedModel: undefined, now: 0 }).bridge;
		if (state !== this.lastState) {
			this.lastState = state;
			this.log.record({ at: this.system.clock.now(), operation: 'probe.health', outcome: 'ok', durationMs: 0, note: `state: ${state}` });
		}
	}

	private async probe(id: ProbeId, signal: AbortSignal, written: boolean): Promise<Executed> {
		if (this.disposed) {
			return { status: 'cancelled', message: 'Cancelled.', exitCode: undefined, note: undefined };
		}
		const startedAt = this.system.clock.now();
		const operation = operationOf(id);
		const executed = await this.lookAt(id, operation, signal);
		if (written && !executed.skipped && (id === 'probe.runtime' || id === 'probe.routeStatus' || id === 'probe.subagents')) {
			const argv = argvOf(operation, { bundleId: this.options.settings().launcherBundleId });
			this.log.record({ at: startedAt, operation: id, program: this.runtimePath === undefined ? undefined : argv?.program, args: argv?.args, outcome: executed.status, durationMs: this.system.clock.now() - startedAt, exitCode: executed.exitCode, note: executed.note });
		}
		this.changed();
		return executed;
	}

	private async lookAt(id: ProbeId, operation: Operation, signal: AbortSignal): Promise<Executed> {
		const settings = this.options.settings();
		switch (id) {
			case 'probe.engine': {
				const paths = settings.launcherAppPath ? [settings.launcherAppPath] : launcherAppPaths(this.system.homedir);
				const appInstalled = this.system.platform === 'darwin' ? (await Promise.all(paths.map(path => this.system.exists(path)))).some(Boolean) : undefined;
				const launcherRunning = await this.guard(this.system.isLauncherRunning(), operation.timeoutMs, undefined);
				this.facts = { ...this.facts, appInstalled, launcherRunning };
				return done(`launcher: ${launcherRunning ? 'running' : launcherRunning === false ? 'not running' : 'not known'}`);
			}
			case 'probe.codexRoute': {
				// The text of the config lives for this one expression: only the route is kept of it
				const configPath = resolveCodexConfigPath(settings.codexConfigPath, this.system.env, this.system.homedir);
				this.facts = { ...this.facts, configRoute: parseLauncherRoute(await this.system.readFile(configPath).catch(() => '')) };
				return done(`route of Codex: ${this.facts.configRoute.kind}`);
			}
			case 'probe.health': {
				const port = daemonPortOf(this.facts);
				const answer = port === undefined ? undefined : await this.guard<{ body: string } | { error: ProbeFailure }>(this.system.fetchHealth(port), operation.timeoutMs, { error: 'timeout' });
				const health = answer && 'body' in answer ? parseEngineHealth(answer.body) : undefined;
				this.facts = { ...this.facts, health, healthError: health || !answer ? undefined : 'error' in answer ? answer.error : 'not-the-daemon' };
				return done(`daemon: ${health ? 'answers' : 'does not answer'}`);
			}
			case 'probe.runtime': return this.findRuntime(operation, signal);
			case 'probe.routeStatus': {
				const answer = await this.askRuntime('route-status', operation.timeoutMs, signal, parseRouteStatus);
				const before = this.facts.route;
				this.facts = { ...this.facts, route: answer.value };
				if (before?.kind === 'route-status' && answer.value.kind === 'route-status' && before.installed !== answer.value.installed) {
					// Another installation than the one that was asked about: what the doctor, Codex and the runtime said is about the old one
					this.facts = { ...this.facts, doctor: undefined, doctorAt: undefined, models: undefined, modelsAt: undefined, subagents: undefined };
				}
				return answer.value.kind === 'failed' ? answer.executed : { ...answer.executed, note: `route: ${!answer.value.installed ? 'not installed' : answer.value.active ? 'installed, connected' : 'installed, paused'}${answer.value.errors.length ? `, ${answer.value.errors.length} inconsistent` : ''}` };
			}
			case 'probe.subagents': {
				if (isRouteInstalled(this.facts) === false) {
					this.facts = { ...this.facts, subagents: undefined }; // nothing is installed: there is nothing to ask about
					return { ...done('not asked: nothing is installed'), skipped: true };
				}
				const answer = await this.askRuntime('subagents-status', operation.timeoutMs, signal, parseSubagentsStatus);
				this.facts = { ...this.facts, subagents: answer.value };
				return answer.value.kind === 'failed' ? answer.executed : { ...answer.executed, note: `protocol: ${answer.value.protocol}` };
			}
		}
	}

	/** Where the command of the runtime is. Its path stays in here: it is below the home of the user. */
	private async findRuntime(operation: Operation, signal: AbortSignal): Promise<Executed> {
		const setting = this.options.settings().runtimePath;
		const candidates = runtimeCandidates({
			setting, homedir: this.system.homedir, platform: this.system.platform, arch: this.system.arch, pathEnv: this.system.env.PATH,
			versionNames: setting ? undefined : await this.system.listRuntimeVersions(), // a named runtime: the real directory is not even listed
		});
		this.runtimePath = undefined;
		for (const candidate of candidates) {
			if (await this.system.exists(candidate.path)) {
				this.runtimePath = candidate.path;
				this.facts = { ...this.facts, runtime: { found: true, source: candidate.source, version: candidate.version } };
				const answer = await this.askRuntime('version', operation.timeoutMs, signal, parseVersion);
				if (answer.value.kind === 'version') {
					this.facts = { ...this.facts, runtime: { found: true, source: candidate.source, version: answer.value.version } };
				}
				return { ...answer.executed, note: answer.value.kind === 'version' ? `runtime ${answer.value.version}` : undefined };
			}
		}
		this.facts = { ...this.facts, runtime: { found: false, source: undefined, version: undefined } };
		return { status: 'failed', message: 'The runtime of the launcher was not found.', exitCode: undefined, note: 'runtime: not found' };
	}

	//#endregion

	//#region Operations

	private async runOperation(job: Job, operation: Operation): Promise<OperationOutcome> {
		const signal = job.abort.signal;
		if (operation.preconditions.includes('runtime') && this.runtimePath === undefined) {
			await this.probe('probe.runtime', signal, true);
		}
		if (operation.kind === 'probe') {
			const executed = await this.probe(operation.id as ProbeId, signal, true);
			return this.outcomeOf(job, executed.status, executed.message);
		}

		// What is decided is decided on what is true now
		for (const probe of FREE_PROBES) {
			await this.probe(probe, signal, false);
		}
		const startedAt = this.system.clock.now();
		const argv = argvOf(operation, { bundleId: this.options.settings().launcherBundleId });
		const checked = checkPreconditions(operation, this.facts);
		if (!checked.ok) {
			this.log.record({ at: startedAt, operation: operation.id, outcome: 'refused', durationMs: 0, note: 'a precondition does not hold' });
			return this.outcomeOf(job, 'refused', checked.reason);
		}
		const confirmation = job.confirmed ? undefined : confirmationOf(operation, this.facts);
		if (confirmation) {
			return this.outcomeOf(job, 'needs-confirmation', confirmation.text, { confirmation }); // the launcher closed in the meantime: this would start it
		}

		const executed = await this.execute(operation, signal);
		if (this.disposed) {
			return this.outcomeOf(job, 'cancelled', 'Cancelled.');
		}
		for (const probe of operation.reprobe) {
			await this.probe(probe, signal, probe === 'probe.routeStatus' || probe === 'probe.subagents');
		}
		const verified = this.verify(operation, executed);
		this.log.record({ at: startedAt, operation: operation.id, program: argv?.program, args: argv?.args, outcome: verified.status, durationMs: this.system.clock.now() - startedAt, exitCode: verified.exitCode, note: verified.note });
		this.noteStateChange();
		this.settleAfter(operation);
		return this.outcomeOf(job, verified.status, verified.message, { hint: verified.status === 'ok' ? operation.hint : undefined });
	}

	private async execute(operation: Operation, signal: AbortSignal): Promise<Executed> {
		const seam = operation.seam;
		switch (seam.via) {
			case 'runtime': return this.executeRuntime(seam.command, operation.timeoutMs, signal);
			case 'codex': {
				const result = await this.guard(this.system.run(this.options.settings().codexCommand, CODEX_MODELS_ARGV, { timeoutMs: operation.timeoutMs, signal }), operation.timeoutMs, { kind: 'timeout' });
				const value = result.kind === 'exit' && result.code === 0 ? orFailed(parseCodexModels(result.stdout)) : failedOf(result);
				this.facts = { ...this.facts, models: value, modelsAt: this.system.clock.now() };
				return value.kind === 'failed' ? executedOf(result, value) : { status: 'ok', message: `Codex lists ${value.web.length} ChatGPT Web ${value.web.length === 1 ? 'model' : 'models'}.`, exitCode: 0, note: `models: ${value.web.length} ChatGPT Web, ${value.otherCount} other` };
			}
			case 'open': {
				const result = await this.guard(this.system.openLauncher({ hidden: seam.hidden }), operation.timeoutMs, { kind: 'timeout' });
				return result.kind === 'exit' && result.code === 0
					? { status: 'ok', message: seam.hidden ? 'The launcher is starting without its window.' : 'The window of the launcher is shown.', exitCode: 0, note: undefined }
					: executedOf(result, failedOf(result, false));
			}
			case 'quit': return this.quit(operation);
			case 'external': {
				if (!this.options.openExternal) {
					return { status: 'refused', message: 'Pages cannot be opened from here.', exitCode: undefined, note: undefined };
				}
				this.options.openExternal(seam.url);
				return { status: 'ok', message: '', exitCode: undefined, note: undefined };
			}
			case 'running':
			case 'facts': return { status: 'refused', message: 'That is a probe.', exitCode: undefined, note: undefined };
		}
	}

	private async executeRuntime(command: RuntimeCommandId, timeoutMs: number, signal: AbortSignal): Promise<Executed> {
		switch (command) {
			case 'doctor': {
				const answer = await this.askRuntime(command, timeoutMs, signal, parseDoctor, [0, 1]); // 1: the report says it is not healthy
				this.facts = { ...this.facts, doctor: answer.value, doctorAt: this.system.clock.now() };
				if (answer.value.kind === 'failed') {
					return answer.executed;
				}
				const errors = answer.value.checks.filter(check => check.status === 'error').length;
				return { status: 'ok', message: answer.value.ok ? 'The doctor found the runtime healthy.' : `The doctor found ${errors} ${errors === 1 ? 'problem' : 'problems'}.`, exitCode: answer.executed.exitCode, note: `doctor: ${answer.value.ok ? 'healthy' : 'needs attention'}, ${answer.value.checks.length} checks, ${errors} errors` };
			}
			case 'route-connect':
			case 'route-disconnect': {
				const answer = await this.askRuntime(command, timeoutMs, signal, parseRouteChange);
				return answer.value.kind === 'failed' ? answer.executed : { ...answer.executed, note: `route: ${answer.value.changed ? 'changed' : 'unchanged'}, ${answer.value.active ? 'connected' : 'paused'}` };
			}
			case 'cancel-turns': {
				const answer = await this.askRuntime(command, timeoutMs, signal, parseCancelledTurns);
				return answer.value.kind === 'failed' ? answer.executed : { ...answer.executed, message: `Cancelled ${answer.value.http} HTTP and ${answer.value.browser} browser ${answer.value.browser === 1 ? 'turn' : 'turns'}.`, note: `cancelled: ${answer.value.http} HTTP, ${answer.value.browser} browser` };
			}
			case 'subagents-compatibility-v1':
			case 'subagents-native': {
				const answer = await this.askRuntime(command, timeoutMs, signal, parseSubagentsChange);
				return answer.value.kind === 'failed' ? answer.executed : { ...answer.executed, message: 'The protocol is set. Restart Codex AND the launcher, then start a new task.', note: `protocol: ${answer.value.protocol}` };
			}
			case 'version':
			case 'help':
			case 'route-status':
			case 'subagents-status': return { status: 'refused', message: 'That is a probe.', exitCode: undefined, note: undefined };
		}
	}

	/** What an operation claims is checked against what was looked at afterwards. */
	private verify(operation: Operation, executed: Executed): Executed {
		if (executed.status !== 'ok' || (operation.id !== 'bridge.connect' && operation.id !== 'bridge.pause')) {
			return executed;
		}
		const route = this.facts.route;
		const expected = operation.id === 'bridge.connect';
		if (route?.kind !== 'route-status') {
			return { ...executed, status: 'failed', message: 'The runtime answered, but the route could not be read back afterwards. Refresh to see where Codex is routed. Nothing is tried again by itself.' };
		}
		if (route.active !== expected || isRouteActive(this.facts) !== expected) {
			return { ...executed, status: 'failed', message: `The runtime answered, but the route of Codex is still ${expected ? 'not connected' : 'connected'}. Nothing is tried again by itself.` };
		}
		if (route.errors.length > 0) {
			return { ...executed, status: 'failed', message: `The route of Codex is inconsistent: ${route.errors.join('; ')}` };
		}
		return { ...executed, message: expected ? 'The bridge is connected: all Codex traffic goes through the launcher. Restart Codex.' : 'The bridge is paused: Codex is on its previous route. Restart Codex.' };
	}

	/** The launcher answers the quit event before it is gone: whether it went is seen in the process list, not in an exit code. */
	private async quit(operation: Operation): Promise<Executed> {
		const result = await this.guard(this.system.quitLauncher(), operation.timeoutMs, { kind: 'timeout' });
		if (result.kind === 'spawn' || result.kind === 'timeout') {
			return executedOf(result, failedOf(result, false));
		}
		const exitCode = result.kind === 'exit' ? result.code : undefined;
		for (const wait of QUIT_POLL_MS) {
			await new Promise<void>(resolve => { this.system.clock.setTimeout(resolve, wait); });
			const running = await this.guard(this.system.isLauncherRunning(), 5000, undefined);
			if (running === false) {
				return { status: 'ok', message: 'The launcher quit, and its daemon with it.', exitCode, note: 'launcher: not running' };
			}
			if (running === undefined) {
				break;
			}
		}
		return { status: 'failed', message: 'The launcher is still running. It refuses to quit while one of its own operations runs, and then shows its window with the reason. It is never killed.', exitCode, note: 'launcher: still running' };
	}

	private settleAfter(operation: Operation): void {
		if (operation.settleMs.length === 0) {
			return; // what was scheduled by an earlier operation still runs
		}
		for (const handle of this.settleTimers) {
			this.system.clock.clearTimeout(handle);
		}
		this.settleTimers.clear();
		for (const ms of operation.settleMs) {
			const handle = this.system.clock.setTimeout(() => {
				this.settleTimers.delete(handle);
				if (!this.disposed) {
					this.enqueue(undefined, 'settle', false);
				}
			}, ms);
			this.settleTimers.add(handle);
		}
	}

	//#endregion

	//#region Running the runtime

	private async askRuntime<T extends { kind: string }>(command: RuntimeCommandId, timeoutMs: number, signal: AbortSignal, parse: (stdout: string) => T | Unparseable, accepted: readonly number[] = [0]): Promise<{ value: T | ProbeFailed; executed: Executed }> {
		const args = runtimeArgv(command);
		if (this.runtimePath === undefined || runtimeCommandOf(args) === undefined) {
			const value = failed('no-runtime');
			return { value, executed: { status: 'failed', message: 'The runtime of the launcher was not found.', exitCode: undefined, note: 'runtime: not found' } };
		}
		const result = await this.guard(this.system.run(this.runtimePath, args, { timeoutMs, signal }), timeoutMs, { kind: 'timeout' });
		const parsed = result.kind === 'exit' && accepted.includes(result.code) ? parse(result.stdout) : undefined;
		if (parsed && parsed.kind !== 'unparseable') {
			return { value: parsed as T, executed: { status: 'ok', message: '', exitCode: result.kind === 'exit' ? result.code : undefined, note: undefined } };
		}
		const value = parsed ? failed('unparseable', (parsed as Unparseable).firstLine) : failedOf(result);
		return { value, executed: executedOf(result, value) };
	}

	/** The machine below may never answer: after the deadline and a grace, the answer is `late`. With the clock of the system, so a test decides when. */
	private guard<T>(answer: Promise<T>, timeoutMs: number, late: T): Promise<T> {
		return new Promise(resolve => {
			const handle = this.system.clock.setTimeout(() => resolve(late), timeoutMs + WATCHDOG_GRACE_MS);
			answer.then(value => value, () => late).then(value => {
				this.system.clock.clearTimeout(handle);
				resolve(value);
			});
		});
	}

	//#endregion
}

function done(note: string): Executed {
	return { status: 'ok', message: '', exitCode: undefined, note };
}

function orFailed<T extends { kind: string }>(parsed: T | Unparseable): T | ProbeFailed {
	return parsed.kind === 'unparseable' ? failed('unparseable', (parsed as Unparseable).firstLine) : parsed as T;
}

/** `runtime`: what it wrote about its failure is the documented one-line message, which is kept, sanitized. */
function failedOf(result: RunResult, runtime = true): ProbeFailed {
	switch (result.kind) {
		case 'exit': return failed('exit', runtime ? parseCliError(result.stderr) : '', result.code);
		case 'timeout': return failed('timeout');
		case 'overflow': return failed('overflow');
		case 'cancelled': return failed('cancelled');
		case 'spawn': return failed('spawn', result.code !== undefined && /^[A-Z_]{2,20}$/.test(result.code) ? result.code : '');
		case 'signal': return failed('exit', 'ended from outside');
	}
}

function executedOf(result: RunResult, value: ProbeFailed): Executed {
	const exitCode = result.kind === 'exit' ? result.code : undefined;
	switch (value.reason) {
		case 'timeout': return { status: 'timeout', message: 'No answer in time. Nothing is tried again by itself.', exitCode, note: undefined };
		case 'cancelled': return { status: 'cancelled', message: 'Cancelled.', exitCode, note: undefined };
		case 'unparseable': return { status: 'unparseable', message: 'The answer did not have the documented shape, and was not used.', exitCode, note: undefined };
		case 'overflow': return { status: 'failed', message: 'The answer was too large and was not read.', exitCode, note: 'answer too large' };
		case 'spawn': return { status: 'failed', message: `The command could not be started${value.message ? ` (${value.message})` : ''}.`, exitCode, note: value.message ? `not started: ${value.message}` : 'not started' };
		case 'no-runtime': return { status: 'failed', message: 'The runtime of the launcher was not found.', exitCode, note: 'runtime: not found' };
		case 'exit': return { status: 'failed', message: value.message || `The command failed${exitCode === undefined ? '' : ` with exit code ${exitCode}`}.`, exitCode, note: undefined };
	}
}
