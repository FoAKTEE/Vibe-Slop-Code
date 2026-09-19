// SPDX-License-Identifier: MIT

// Agent profiles: what can be started from the view, and which hand typed command lines are agents.
import { DEFAULT_ACTIVITY_OPTIONS } from './activity.ts';

export interface AgentProfile {
	id: string;
	label: string;
	/** Shell text that starts the agent, run as written. */
	command: string;
	/** Arguments, each one quoted for the shell as needed. */
	args?: string[];
	env?: Record<string, string>;
	/** Where to start: a path, `${workspaceFolder}` stands for the folder the session is started for. */
	cwd?: string;
	/** Name of a product icon, such as `sparkle`. */
	icon?: string;
	/** Silence for this long means the agent waits for the user: default 8, 0 never infers that from silence. */
	quietSeconds?: number;
	/** Regular expression: a terminal in which a matching command line starts becomes a session of this profile. */
	matchCommand?: string;
}

export const BUILTIN_PROFILES: readonly AgentProfile[] = Object.freeze([
	{ id: 'claude', label: 'Claude Code', command: 'claude', icon: 'sparkle', matchCommand: '^claude(\\s|$)' },
	{ id: 'codex', label: 'Codex', command: 'codex', icon: 'code', matchCommand: '^codex(\\s|$)' },
]);

/** Command lines that are adopted although no profile claims them. */
export const DEFAULT_ADOPT_PATTERN = '^(claude|codex|gemini|aider|opencode)(\\s|$)';

//#region Settings

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProfile(raw: unknown): AgentProfile | string {
	if (!isRecord(raw)) {
		return 'a profile is an object';
	}
	const name = typeof raw.id === 'string' && raw.id ? `profile "${raw.id}"` : 'a profile';
	if (typeof raw.id !== 'string' || !raw.id.trim()) {
		return `${name}: "id" is required`;
	}
	if (typeof raw.label !== 'string' || !raw.label.trim()) {
		return `${name}: "label" is required`;
	}
	if (typeof raw.command !== 'string' || !raw.command.trim()) {
		return `${name}: "command" is required`;
	}

	const profile: AgentProfile = { id: raw.id.trim(), label: raw.label.trim(), command: raw.command.trim() };
	if (raw.args !== undefined) {
		if (!Array.isArray(raw.args) || raw.args.some(arg => typeof arg !== 'string')) {
			return `${name}: "args" is a list of strings`;
		}
		profile.args = [...raw.args];
	}
	if (raw.env !== undefined) {
		if (!isRecord(raw.env) || Object.values(raw.env).some(value => typeof value !== 'string')) {
			return `${name}: "env" maps names to strings`;
		}
		profile.env = { ...raw.env as Record<string, string> };
	}
	for (const key of ['cwd', 'icon', 'matchCommand'] as const) {
		if (raw[key] !== undefined) {
			if (typeof raw[key] !== 'string') {
				return `${name}: "${key}" is a string`;
			}
			profile[key] = raw[key];
		}
	}
	if (raw.quietSeconds !== undefined) {
		if (typeof raw.quietSeconds !== 'number' || !Number.isFinite(raw.quietSeconds) || raw.quietSeconds < 0) {
			return `${name}: "quietSeconds" is a number, 0 or more`;
		}
		profile.quietSeconds = raw.quietSeconds;
	}
	if (profile.matchCommand !== undefined && compile(profile.matchCommand) === undefined) {
		return `${name}: "matchCommand" is not a regular expression`;
	}

	return profile;
}

/** The profiles of the setting `vibeAgents.profiles`. What is broken is reported and left out. */
export function parseUserProfiles(raw: unknown): { profiles: AgentProfile[]; problems: string[] } {
	if (raw === undefined || raw === null) {
		return { profiles: [], problems: [] };
	}
	if (!Array.isArray(raw)) {
		return { profiles: [], problems: ['profiles are a list'] };
	}

	const profiles: AgentProfile[] = [];
	const problems: string[] = [];
	for (const item of raw) {
		const profile = parseProfile(item);
		if (typeof profile === 'string') {
			problems.push(profile);
		} else if (profiles.some(other => other.id === profile.id)) {
			problems.push(`profile "${profile.id}" is defined twice`);
		} else {
			profiles.push(profile);
		}
	}
	return { profiles, problems };
}

//#endregion

//#region Providers

export interface Registration {
	dispose(): void;
}

export interface LaunchRequest {
	profile: AgentProfile;
	/** A session is started again: its command line. */
	restartOf?: string;
}

/** The seam for profiles that do not come from settings, such as the ones of a bridge that another extension knows. */
export interface ProfileProvider {
	readonly id: string;
	provideProfiles(): readonly AgentProfile[];
	/**
	 * Asked before one of its profiles starts. Resolves with the profile to start, with what the provider
	 * asked the user filled in, or with nothing when it must not start: the provider told the user why.
	 */
	prepareLaunch?(request: LaunchRequest): Promise<AgentProfile | undefined>;
}

export interface StatusRowAction {
	label: string;
	command: string;
	args?: unknown[];
	/** Drawn as an icon, with the label as its name. */
	icon?: 'refresh';
}

/** A row of the view that is no session: the state of something agents depend on, with one action. */
export interface StatusRow {
	id: string;
	label: string;
	detail?: string;
	/** The whole story, for the pointer that rests on the row. */
	tooltip?: string;
	/** `ok` is quiet, `warning` asks for attention. */
	state: 'ok' | 'warning' | 'off';
	action?: StatusRowAction;
	/** What else can be done, such as asking again. */
	secondaryActions?: StatusRowAction[];
}

export interface StatusRowProvider {
	readonly id: string;
	provideStatusRows(): readonly StatusRow[] | Promise<readonly StatusRow[]>;
	/** The rows are on screen, or no longer. A provider that polls does so only while they are. */
	setVisible?(visible: boolean): void;
}

/** All profiles: the built-in ones, the ones of the user (same id: replaces a built-in one) and provided ones. */
export class ProfileRegistry {

	private userProfiles: readonly AgentProfile[] = [];
	private readonly providers: ProfileProvider[] = [];
	private readonly statusRowProviders: StatusRowProvider[] = [];
	private readonly listeners = new Set<() => void>();
	private rowsVisible = false;

	get profiles(): AgentProfile[] {
		return this.collect().map(entry => entry.profile);
	}

	private collect(): { profile: AgentProfile; provider: ProfileProvider | undefined }[] {
		const entries: { profile: AgentProfile; provider: ProfileProvider | undefined }[] = [];
		const add = (candidates: readonly AgentProfile[], provider: ProfileProvider | undefined) => {
			for (const profile of candidates) {
				if (!entries.some(other => other.profile.id === profile.id)) {
					entries.push({ profile, provider });
				}
			}
		};
		add(BUILTIN_PROFILES.map(builtin => this.userProfiles.find(profile => profile.id === builtin.id) ?? builtin), undefined);
		add(this.userProfiles, undefined);
		for (const provider of this.providers) {
			try {
				add(provider.provideProfiles(), provider);
			} catch {
				// a provider that fails provides nothing
			}
		}
		return entries;
	}

	/**
	 * What to start when `profile` is asked for: the profile itself, or what the provider it comes from made
	 * of it. Nothing: the provider refused, and told the user.
	 */
	async prepareLaunch(profile: AgentProfile, restartOf?: string): Promise<AgentProfile | undefined> {
		const provider = this.collect().find(entry => entry.profile.id === profile.id)?.provider;
		return provider?.prepareLaunch ? provider.prepareLaunch({ profile, restartOf }) : profile;
	}

	get(id: string | undefined): AgentProfile | undefined {
		return id === undefined ? undefined : this.profiles.find(profile => profile.id === id);
	}

	setUserProfiles(profiles: readonly AgentProfile[]): void {
		this.userProfiles = profiles;
		this.fire();
	}

	registerProvider(provider: ProfileProvider): Registration {
		return this.register(this.providers, provider);
	}

	registerStatusRowProvider(provider: StatusRowProvider): Registration {
		provider.setVisible?.(this.rowsVisible);
		return this.register(this.statusRowProviders, provider);
	}

	/** Whether the view that shows the rows is on screen. */
	setRowsVisible(visible: boolean): void {
		if (visible === this.rowsVisible) {
			return;
		}
		this.rowsVisible = visible;
		for (const provider of [...this.statusRowProviders]) {
			provider.setVisible?.(visible);
		}
	}

	/** Tells that the profiles or the status rows of a provider changed. */
	refresh(): void {
		this.fire();
	}

	async statusRows(): Promise<StatusRow[]> {
		const rows: StatusRow[] = [];
		for (const provider of this.statusRowProviders) {
			try {
				rows.push(...await provider.provideStatusRows());
			} catch {
				// a provider that fails has no rows
			}
		}
		return rows;
	}

	onDidChange(listener: () => void): Registration {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	private register<T>(list: T[], item: T): Registration {
		list.push(item);
		this.fire();
		return {
			dispose: () => {
				const index = list.indexOf(item);
				if (index >= 0) {
					list.splice(index, 1);
					this.fire();
				}
			}
		};
	}

	private fire(): void {
		for (const listener of [...this.listeners]) {
			listener();
		}
	}
}

//#endregion

//#region Command lines

function quote(arg: string): string {
	return /^[A-Za-z0-9_\-+=:,.\/@%]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The command line that starts a profile in a POSIX shell. */
export function commandLineOf(profile: AgentProfile): string {
	return [profile.command, ...(profile.args ?? []).map(quote)].join(' ');
}

export function quietMsOf(profile: AgentProfile | undefined): number {
	return profile?.quietSeconds === undefined ? DEFAULT_ACTIVITY_OPTIONS.quietMs : Math.round(profile.quietSeconds * 1000);
}

function compile(pattern: string): RegExp | undefined {
	try {
		return new RegExp(pattern);
	} catch {
		return undefined;
	}
}

/**
 * A command line as typed, reduced to what names the program: leading environment
 * assignments are dropped and so is the directory of the command.
 */
export function normalizeCommandLine(commandLine: string): string {
	let line = commandLine.trim();
	for (; ;) {
		const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)(?:\s+|$)/.exec(line);
		if (!assignment) {
			break;
		}
		line = line.slice(assignment[0].length);
	}
	return line.replace(/^\S*\//, '');
}

export interface CommandLineMatch {
	/** The profile that claims the command line. Not set when only the default pattern matched. */
	profile: AgentProfile | undefined;
	label: string;
}

/**
 * Whether a command line that started in a terminal is an agent: the profiles are asked first, then the
 * default pattern. The profile that matches the most of the command line claims it (`codex -m <model of a
 * bridge>` is the bridge, not Codex), the first one among equals. An empty or broken pattern matches nothing.
 */
export function matchCommandLine(profiles: readonly AgentProfile[], commandLine: string, defaultPattern: string): CommandLineMatch | undefined {
	const raw = commandLine.trim();
	const normalized = normalizeCommandLine(commandLine);
	if (!normalized) {
		return undefined;
	}

	const matches = (pattern: string | undefined): RegExpExecArray | undefined => {
		const expression = pattern ? compile(pattern) : undefined;
		return expression ? expression.exec(normalized) ?? expression.exec(raw) ?? undefined : undefined;
	};

	let best: { profile: AgentProfile; length: number } | undefined;
	for (const profile of profiles) {
		const length = matches(profile.matchCommand)?.[0].length;
		if (length !== undefined && (!best || length > best.length)) {
			best = { profile, length };
		}
	}
	if (best) {
		return { profile: best.profile, label: best.profile.label };
	}

	const match = matches(defaultPattern);
	if (!match) {
		return undefined;
	}
	const program = /^\S+/.exec(normalized)?.[0] ?? normalized;
	const profile = profiles.find(candidate => candidate.command === program);
	return { profile, label: profile?.label ?? program };
}

//#endregion
