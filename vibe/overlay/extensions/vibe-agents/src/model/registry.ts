// SPDX-License-Identifier: MIT

// The sessions of a window: each one with the parser and the activity tracker that read its terminal. This is
// the whole behaviour of the extension without an editor: the host only tells what terminals do and what
// time it is, and shows what changed.
import { ActivityTracker, DEFAULT_ACTIVITY_OPTIONS } from './activity.ts';
import { createSession, isLive, reduce, restoreSession, type Session, type SessionEvent, type SessionInit, type SessionState } from './session.ts';
import { isMeaningfulLine, SignalParser } from './signals.ts';

export interface SessionChange {
	readonly id: string;
	/** Not set: the session is new. */
	readonly from: SessionState | undefined;
	/** Not set: the session is gone. */
	readonly to: SessionState | undefined;
	readonly session: Session | undefined;
}

export interface RegistryInit extends Omit<SessionInit, 'id'> {
	/** See `ActivityOptions.quietMs`. */
	quietMs: number;
}

interface Entry {
	session: Session;
	quietMs: number;
	parser: SignalParser;
	tracker: ActivityTracker | undefined;
	/** Known from a previous window: the agent was interactive. */
	interactive: boolean;
	/** Before the command runs: the line editor of the shell is on, it reads a command line. */
	promptReady: boolean;
	/**
	 * The exit was reported, the prompt of the shell was not seen yet: output that still arrives is the
	 * last of the agent. The editor reports an exit before the output that led to it made its way here.
	 */
	draining: boolean;
}

interface SerializedEntry {
	session: Session;
	quietMs: number;
	interactive: boolean;
}

export interface RegistrySnapshot {
	version: number;
	sessions: SerializedEntry[];
}

const SNAPSHOT_VERSION = 1;

export class SessionRegistry {

	private readonly entries = new Map<string, Entry>();
	private readonly listeners = new Set<(changes: readonly SessionChange[]) => void>();
	private nextId = 1;

	get sessions(): Session[] {
		return [...this.entries.values()].map(entry => entry.session);
	}

	get(id: string): Session | undefined {
		return this.entries.get(id)?.session;
	}

	onDidChange(listener: (changes: readonly SessionChange[]) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	//#region Life cycle

	create(init: RegistryInit, now: number): Session {
		let id: string;
		do {
			id = `a${this.nextId++}`;
		} while (this.entries.has(id));

		const session = createSession({ ...init, id }, now);
		this.entries.set(id, { session, quietMs: init.quietMs, parser: new SignalParser(), tracker: undefined, interactive: false, promptReady: false, draining: false });
		this.fire([{ id, from: undefined, to: session.state, session }]);
		return session;
	}

	/** The command of the session began to execute. */
	started(id: string, now: number): void {
		this.apply(id, { type: 'started', at: now }, now);
	}

	exited(id: string, exitCode: number | undefined, now: number): void {
		const entry = this.entries.get(id);
		if (entry && isLive(entry.session)) {
			entry.draining = true; // its last output may still be on its way
		}
		this.apply(id, { type: 'exited', exitCode, at: now }, now);
	}

	/** The terminal of the session went away. */
	closed(id: string, now: number): void {
		this.apply(id, { type: 'closed', at: now }, now);
	}

	seen(id: string): void {
		this.apply(id, { type: 'seen' }, 0);
	}

	/** The agent is started again: the session forgets its previous run. */
	restarted(id: string, now: number, quietMs?: number): void {
		const entry = this.entries.get(id);
		if (entry) {
			entry.parser = new SignalParser();
			entry.tracker = undefined;
			entry.interactive = false;
			entry.promptReady = false;
			entry.draining = false;
			entry.quietMs = quietMs ?? entry.quietMs;
			this.apply(id, { type: 'restarted', at: now }, now);
		}
	}

	/**
	 * Whether the shell of a session that did not start yet reads a command line: its line editor turned on
	 * bracketed paste, the last thing zsh, fish and bash do before they read. A shell that asks something
	 * at startup did not: what is typed then answers the question.
	 */
	isPromptReady(id: string): boolean {
		const entry = this.entries.get(id);
		return entry !== undefined && entry.session.state === 'starting' && entry.promptReady;
	}

	/** Something the host has to say about the session, shown where the last line of the agent shows. */
	note(id: string, text: string): void {
		this.apply(id, { type: 'line', text }, 0);
	}

	/** Text is sent to the agent on behalf of the user. */
	input(id: string, now: number): void {
		this.entries.get(id)?.tracker?.input(now);
	}

	dismiss(id: string): void {
		const entry = this.entries.get(id);
		if (entry && this.entries.delete(id)) {
			this.fire([{ id, from: entry.session.state, to: undefined, session: undefined }]);
		}
	}

	/** Removes the sessions that are over. Returns them. */
	clearEnded(): Session[] {
		const ended = this.sessions.filter(session => !isLive(session));
		for (const session of ended) {
			this.entries.delete(session.id);
		}
		if (ended.length > 0) {
			this.fire(ended.map(session => ({ id: session.id, from: session.state, to: undefined, session: undefined })));
		}
		return ended;
	}

	//#endregion

	//#region Output and time

	/** The terminal of the session wrote `chunk`. */
	output(id: string, chunk: string, now: number): void {
		const entry = this.entries.get(id);
		if (!entry || chunk.length === 0 || (!isLive(entry.session) && !entry.draining)) {
			return;
		}

		const signals = entry.parser.push(chunk);
		const events: SessionEvent[] = [];
		let line: string | undefined;
		let isRunning = entry.session.state !== 'starting';
		/** The prompt of the shell is back: what follows is not the agent any more. */
		let isOver = false;
		for (const signal of signals) {
			if (isOver) {
				break;
			}
			if (!isLive(entry.session)) {
				// Draining: only the last words of the agent, up to the prompt of the shell
				if (signal.kind === 'text') {
					line = isMeaningfulLine(signal.line) ? signal.line : line;
				} else if (signal.kind === 'cwd' || (signal.kind === 'mark' && (signal.mark === 'D' || signal.mark === 'A'))) {
					isOver = true;
				}
				continue;
			}
			if (signal.kind === 'mark') {
				// The marks of the shell tell when the command runs, also where the editor does not: before it
				// runs, what ends is the previous command line. `C` executes the command, `D` ends it.
				if (signal.mark === 'C' && !isRunning) {
					isRunning = true;
					events.push({ type: 'started', at: now });
				} else if (signal.mark === 'D' && isRunning) {
					events.push({ type: 'exited', exitCode: signal.exitCode, at: now });
					isOver = true;
				}
			} else if (signal.kind === 'cwd') {
				// A shell without marks still tells where it is when it draws its prompt: the command is
				// over, with an exit code nobody knows.
				if (isRunning) {
					events.push({ type: 'exited', exitCode: undefined, at: now });
					isOver = true;
				}
			} else if (signal.kind === 'mode' && signal.mode === 2004 && !isRunning) {
				entry.promptReady = signal.set;
			} else if (!isRunning) {
				// Before the command runs it is the shell that talks: its title, what its startup files print
				// and its bell say nothing about the agent
			} else if (signal.kind === 'text') {
				// The last line that says something: shells and full screen programs end their output with
				// frames, prompts and marks (zsh: `%` for a partial line) that would hide it
				line = isMeaningfulLine(signal.line) ? signal.line : line;
			} else if (signal.kind === 'notification') {
				line = undefined;
				events.push({ type: 'notified', text: signal.title && signal.body ? `${signal.title}: ${signal.body}` : signal.body, at: now });
			} else if (signal.kind === 'title') {
				events.push({ type: 'title', text: signal.text });
			}
		}
		if (line !== undefined) {
			events.push({ type: 'line', text: line });
		}

		if (isOver) {
			entry.draining = false;
		}

		// Activity: only of the command, never of the prompt before it
		if (isRunning && isLive(entry.session)) {
			const activity = this.trackerOf(entry, now).output(now, chunk.length, signals);
			events.unshift({ type: 'activity', activity, at: now });
		}

		this.applyAll(entry, events);
	}

	/** Time passed: call about once a second. */
	tick(now: number): void {
		for (const entry of [...this.entries.values()]) {
			if (entry.tracker && (entry.session.state === 'working' || entry.session.state === 'waiting')) {
				this.applyAll(entry, [{ type: 'activity', activity: entry.tracker.tick(now), at: now }]);
			}
		}
	}

	private trackerOf(entry: Entry, now: number): ActivityTracker {
		if (!entry.tracker) {
			const state = entry.session.state;
			entry.tracker = new ActivityTracker({ ...DEFAULT_ACTIVITY_OPTIONS, quietMs: entry.quietMs }, now,
				entry.interactive || state === 'waiting' ? { state: state === 'waiting' ? 'waiting' : 'working', interactive: entry.interactive } : undefined);
		}
		return entry.tracker;
	}

	//#endregion

	//#region Persistence

	snapshot(): RegistrySnapshot {
		return {
			version: SNAPSHOT_VERSION,
			sessions: [...this.entries.values()].map(entry => ({ session: entry.session, quietMs: entry.quietMs, interactive: entry.interactive || (entry.tracker?.interactive ?? false) })),
		};
	}

	/** Takes over the sessions of a previous window. Returns them: the host finds out which terminals are still there. */
	restore(snapshot: unknown, now: number): Session[] {
		const raw = snapshot as Partial<RegistrySnapshot> | undefined | null;
		if (typeof raw !== 'object' || raw === null || raw.version !== SNAPSHOT_VERSION || !Array.isArray(raw.sessions)) {
			return [];
		}

		const restored: Session[] = [];
		for (const item of raw.sessions as Partial<SerializedEntry>[]) {
			const session = restoreSession(item?.session);
			if (!session || this.entries.has(session.id)) {
				continue;
			}
			const entry: Entry = {
				session,
				quietMs: typeof item.quietMs === 'number' && item.quietMs >= 0 ? item.quietMs : DEFAULT_ACTIVITY_OPTIONS.quietMs,
				parser: new SignalParser(),
				tracker: undefined,
				interactive: item.interactive === true,
				promptReady: false,
				draining: false,
			};
			this.entries.set(session.id, entry);
			if (session.state === 'working' || session.state === 'waiting') {
				this.trackerOf(entry, now);
			}
			restored.push(session);
		}
		if (restored.length > 0) {
			this.fire(restored.map(session => ({ id: session.id, from: undefined, to: session.state, session })));
		}
		return restored;
	}

	//#endregion

	private apply(id: string, event: SessionEvent, now: number): void {
		const entry = this.entries.get(id);
		if (entry) {
			if (event.type === 'started' && entry.session.state === 'starting') {
				this.trackerOf(entry, now);
			}
			this.applyAll(entry, [event]);
		}
	}

	private applyAll(entry: Entry, events: readonly SessionEvent[]): void {
		const before = entry.session;
		entry.session = events.reduce(reduce, before);
		if (entry.session !== before) {
			this.fire([{ id: before.id, from: before.state, to: entry.session.state, session: entry.session }]);
		}
	}

	private fire(changes: readonly SessionChange[]): void {
		for (const listener of [...this.listeners]) {
			listener(changes);
		}
	}
}
