// SPDX-License-Identifier: MIT

// The runtime of the Codex Web GPT launcher (github.com/miuuyy/codex-chatgpt-web, MIT), as text: where its command
// is found, which of its command lines Vibe runs, and what their answers mean. The launcher stays the engine: it
// owns the ChatGPT page, the sign-in, its ports and its daemon. Vibe runs a handful of documented commands of the
// runtime the launcher installed, and nothing in here reads a file, runs a program or opens a socket: see ../../host.
//
// An answer of a program is not trusted. What is kept of it is typed, bounded and sanitized, and an answer that does
// not have the documented shape becomes `unparseable` with its first line only: the rest may hold paths or text that
// is nobody's business. The sanitizing rules follow the ones the launcher applies to its own log (see THIRD_PARTY.md).
import { LAUNCHER_APP_NAME, parseHealth, type BridgeHealth } from '../chatgptWeb.ts';

export const RUNTIME_COMMAND = 'codex-chatgpt-web';
/** Only the NAMES of its entries are listed: a name is a version, and nothing in it is opened. */
export const RUNTIME_VERSIONS_DIR = '~/.codex-chatgpt-web/versions';
/** The most that is kept of what a program writes. The answers are a few hundred bytes. */
export const MAX_OUTPUT_BYTES = 1024 * 1024;

const MAX_TEXT = 200;
const MAX_CHECKS = 40;
const MAX_ERRORS = 10;
const MAX_EXTRA = 20;
const MAX_MODELS = 40;

//#region Text that may be shown

const ESCAPE_SEQUENCES = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;
const CONTROL_CHARACTERS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const URLS = /https?:\/\/[^\s"'`<>]+/gi;
const POSIX_HOME = /\/(?:Users|home)\/[^/\s"'`<>:(),;]+/g;
const WINDOWS_HOME = /\b[A-Za-z]:\\+Users\\+[^\\/\s"'`<>|:(),;]+/g;

function originOf(candidate: string): string {
	const trailing = /[),.;:!?]+$/.exec(candidate)?.[0] ?? '';
	const url = trailing ? candidate.slice(0, -trailing.length) : candidate;
	try {
		return `${new URL(url).origin}${trailing}`;
	} catch {
		return `[url]${trailing}`;
	}
}

/**
 * What may be shown of a line a program wrote: its first line that is not empty, without escape sequences, with
 * the home of the user as `~`, a URL as its origin, and anything that looks like a key or a token replaced.
 */
export function sanitizeText(text: string, max = MAX_TEXT): string {
	const line = text.slice(0, 4096).split(/\r?\n/).map(candidate => candidate.replace(ESCAPE_SEQUENCES, '').replace(/\t/g, ' ').replace(CONTROL_CHARACTERS, '').trim()).find(candidate => candidate !== '') ?? '';
	const clean = line
		.replace(/tunnel_[a-f0-9]{32}/g, '[tunnel-id]')
		.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[key]')
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
		.replace(URLS, originOf)
		.replace(WINDOWS_HOME, '~')
		.replace(POSIX_HOME, '~')
		.replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]');
	return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

/** The message of a failed command: the runtime writes `codex-chatgpt-web: <message>` to stderr and exits with 1. */
export function parseCliError(stderr: string): string {
	return sanitizeText(stderr).replace(/^codex-chatgpt-web:\s*/, '');
}

//#endregion

//#region Discovery

export interface RuntimeVersionName {
	name: string;
	version: string;
	numbers: [number, number, number];
	prerelease: string | undefined;
	platformTag: string;
}

const VERSION_DIR = /^(?<major>\d{1,6})\.(?<minor>\d{1,6})\.(?<patch>\d{1,6})(?:-(?<prerelease>[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*?))?-(?<platform>darwin|linux|win32)-(?<arch>arm64|x64|ia32)$/;

/** The launcher installs its runtime as `versions/<version>-<platform>-<arch>`. Any other name is none of it. */
export function parseVersionDirName(name: string): RuntimeVersionName | undefined {
	const groups = VERSION_DIR.exec(name)?.groups;
	if (!groups) {
		return undefined;
	}
	const core = `${Number(groups.major)}.${Number(groups.minor)}.${Number(groups.patch)}`;
	return {
		name,
		version: groups.prerelease ? `${core}-${groups.prerelease}` : core,
		numbers: [Number(groups.major), Number(groups.minor), Number(groups.patch)],
		prerelease: groups.prerelease,
		platformTag: `${groups.platform}-${groups.arch}`,
	};
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
	if (a === undefined || b === undefined) {
		return a === b ? 0 : a === undefined ? 1 : -1; // a release is newer than its pre-releases
	}
	const left = a.split('.');
	const right = b.split('.');
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		if (left[i] === undefined || right[i] === undefined) {
			return left[i] === undefined ? -1 : 1;
		}
		const numeric = /^\d+$/.test(left[i]) && /^\d+$/.test(right[i]);
		const order = numeric ? Number(left[i]) - Number(right[i]) : left[i] < right[i] ? -1 : left[i] > right[i] ? 1 : 0;
		if (order !== 0) {
			return order;
		}
	}
	return 0;
}

/** Positive when `a` is the newer one. */
function compareVersions(a: RuntimeVersionName, b: RuntimeVersionName): number {
	for (let i = 0; i < 3; i++) {
		if (a.numbers[i] !== b.numbers[i]) {
			return a.numbers[i] - b.numbers[i];
		}
	}
	return comparePrerelease(a.prerelease, b.prerelease);
}

export interface DiscoveryInput {
	/** The setting `vibeAgents.chatgptWeb.runtimePath`. Empty: the runtime is looked for. */
	setting: string | undefined;
	homedir: string;
	/** The names of the entries of the versions directory. Not set: there is no such directory. */
	versionNames: readonly string[] | undefined;
	platform: string;
	arch: string;
	/** `PATH`, for a runtime that was installed without the launcher. */
	pathEnv: string | undefined;
}

export interface RuntimeCandidate {
	path: string;
	source: 'setting' | 'versions' | 'path';
	version: string | undefined;
}

export function expandHome(path: string, homedir: string): string {
	return path === '~' || path.startsWith('~/') ? `${homedir}${path.slice(1)}` : path;
}

/**
 * Where the command of the runtime may be, best first: the newest installed version of this platform, then `PATH`.
 * A setting is the ONLY candidate. That is what lets a test profile name a fake: when the fake is missing, nothing
 * falls back to the real runtime.
 */
export function runtimeCandidates(input: DiscoveryInput): RuntimeCandidate[] {
	const setting = input.setting?.trim();
	if (setting) {
		const path = expandHome(setting, input.homedir);
		return path.startsWith('/') ? [{ path, source: 'setting', version: undefined }] : [];
	}

	const versionsDir = expandHome(RUNTIME_VERSIONS_DIR, input.homedir);
	const installed = (input.versionNames ?? [])
		.map(parseVersionDirName)
		.filter((candidate): candidate is RuntimeVersionName => candidate?.platformTag === `${input.platform}-${input.arch}`)
		.sort((a, b) => compareVersions(b, a))
		.map((candidate): RuntimeCandidate => ({ path: `${versionsDir}/${candidate.name}/bin/${RUNTIME_COMMAND}`, source: 'versions', version: candidate.version }));

	const onPath = [...new Set((input.pathEnv ?? '').split(':').filter(entry => entry.startsWith('/')).map(entry => entry.replace(/\/+$/, '')))]
		.map((entry): RuntimeCandidate => ({ path: `${entry}/${RUNTIME_COMMAND}`, source: 'path', version: undefined }));

	return [...installed, ...onPath];
}

//#endregion

//#region Command lines

export type RuntimeCommandId =
	| 'version' | 'help' | 'route-status' | 'route-connect' | 'route-disconnect' | 'doctor'
	| 'subagents-status' | 'subagents-compatibility-v1' | 'subagents-native' | 'cancel-turns';

/**
 * Every command line of the runtime Vibe runs. What is NOT in here is never run: `setup`, `login`, `uninstall`,
 * `serve`, `mcp`, `hook`, `dev`, `tunnel`, `browser`, `open` and every `service` action but `cancel-turns`. Those
 * belong to the launcher, which wraps them in its own transaction and owns the daemon.
 */
const RUNTIME_ARGV: Readonly<Record<RuntimeCommandId, readonly string[]>> = Object.freeze({
	'version': ['--version'],
	'help': ['--help'],
	'route-status': ['route', 'status'],
	'route-connect': ['route', 'connect'],
	'route-disconnect': ['route', 'disconnect'],
	'doctor': ['doctor', '--json'],
	'subagents-status': ['subagents', 'status'],
	'subagents-compatibility-v1': ['subagents', 'compatibility-v1'],
	'subagents-native': ['subagents', 'native'],
	'cancel-turns': ['service', 'cancel-turns'],
});

/** `home`: the state directory of a sandbox (`--home`). Vibe itself never names one: the default is the launcher's. */
export function runtimeArgv(command: RuntimeCommandId, options: { home?: string } = {}): string[] {
	return [...(options.home === undefined ? [] : ['--home', options.home]), ...RUNTIME_ARGV[command]];
}

/** The allow-list: the command an argument list is, when it is exactly one of the above. */
export function runtimeCommandOf(args: readonly string[]): RuntimeCommandId | undefined {
	const hasHome = args[0] === '--home';
	if (hasHome && (args[1] === undefined || args[1] === '' || args[1].startsWith('-'))) {
		return undefined;
	}
	const rest = hasHome ? args.slice(2) : args;
	return (Object.keys(RUNTIME_ARGV) as RuntimeCommandId[]).find(id => RUNTIME_ARGV[id].length === rest.length && RUNTIME_ARGV[id].every((word, i) => word === rest[i]));
}

export const CODEX_MODELS_ARGV: readonly string[] = Object.freeze(['debug', 'models']);

/** A bundle id goes into a line of AppleScript: nothing but the characters of one is let through. */
export function isBundleId(value: string): boolean {
	return value.length <= 100 && /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(value);
}

function checkedBundleId(bundleId: string): string {
	if (!isBundleId(bundleId)) {
		throw new Error('not a bundle id');
	}
	return bundleId;
}

/**
 * `open`. Hidden: the launcher starts without its window (`--hidden`, honoured once its first-run setup is done),
 * not brought to the front (`-g`, `-j`). Not hidden: its window comes to the front, and it starts when it is closed.
 */
export function openArgv(bundleId: string, options: { hidden: boolean }): string[] {
	return options.hidden ? ['-g', '-j', '-b', checkedBundleId(bundleId), '--args', '--hidden'] : ['-b', checkedBundleId(bundleId)];
}

/** `osascript`. The quit event is the graceful way: the launcher cancels its turns, stops its daemon, then exits. */
export function quitArgv(bundleId: string): string[] {
	return ['-e', `tell application id "${checkedBundleId(bundleId)}" to quit`];
}

/** `pgrep`. Exit code 0: it runs, 1: it does not. */
export function runningArgv(): string[] {
	return ['-f', `${LAUNCHER_APP_NAME}.app/Contents/MacOS/`];
}

export type Program = 'runtime' | 'codex' | 'open' | 'osascript' | 'pgrep';

const SAFE_WORDS: Readonly<Record<Program, ReadonlySet<string>>> = Object.freeze({
	runtime: new Set([...Object.values(RUNTIME_ARGV).flat(), '--home']),
	codex: new Set(CODEX_MODELS_ARGV),
	open: new Set(['-g', '-j', '-b', '--args', '--hidden']),
	osascript: new Set(['-e']),
	pgrep: new Set(['-f']),
});

const PROGRAM_NAMES: Readonly<Record<Program, string>> = Object.freeze({ runtime: RUNTIME_COMMAND, codex: 'codex', open: 'open', osascript: 'osascript', pgrep: 'pgrep' });

/**
 * A command line as it may be written down: the documented name of the program and the documented words. The path
 * of the program is never part of it (it is below the home of the user), and every other argument is a placeholder.
 */
export function describeCommand(program: Program, args: readonly string[]): string {
	const words = args.map((word, i) => {
		const before = args[i - 1];
		if (SAFE_WORDS[program].has(word)) {
			return word;
		}
		if (program === 'runtime' && before === '--home') {
			return '[path]';
		}
		if (program === 'open' && before === '-b' && isBundleId(word)) {
			return word;
		}
		if (program === 'osascript' && before === '-e') {
			const bundleId = /^tell application id "(?<id>[^"]+)" to quit$/.exec(word)?.groups?.id;
			return bundleId !== undefined && isBundleId(bundleId) ? `[quit ${bundleId}]` : '[script]';
		}
		if (program === 'pgrep' && before === '-f' && word === runningArgv()[1]) {
			return '[launcher]';
		}
		return '[arg]';
	});
	return [PROGRAM_NAMES[program], ...words].join(' ');
}

//#endregion

//#region Answers

export interface Unparseable {
	kind: 'unparseable';
	reason: 'empty' | 'oversized' | 'not-json' | 'shape';
	/** Sanitized, and all that is kept of the answer. */
	firstLine: string;
}

export type ExtraValue = string | number | boolean | null;

function unparseable(reason: Unparseable['reason'], stdout: string): Unparseable {
	return { kind: 'unparseable', reason, firstLine: reason === 'empty' ? '' : sanitizeText(stdout) };
}

function readJson(stdout: string): { value: unknown } | Unparseable {
	if (stdout.length > MAX_OUTPUT_BYTES) {
		return unparseable('oversized', stdout);
	}
	if (stdout.trim() === '') {
		return unparseable('empty', stdout);
	}
	try {
		return { value: JSON.parse(stdout) };
	} catch {
		return unparseable('not-json', stdout);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(stdout: string): { record: Record<string, unknown> } | Unparseable {
	const json = readJson(stdout);
	if ('kind' in json) {
		return json;
	}
	return isRecord(json.value) ? { record: json.value } : unparseable('shape', stdout);
}

/** The fields a later version of the runtime adds: kept, as something that is safe to show. */
function extraOf(record: Record<string, unknown>, known: readonly string[]): Record<string, ExtraValue> {
	const extra: Record<string, ExtraValue> = {};
	for (const key of Object.keys(record).filter(candidate => !known.includes(candidate) && /^[A-Za-z0-9_.-]{1,40}$/.test(candidate)).slice(0, MAX_EXTRA)) {
		const value = record[key];
		extra[key] = typeof value === 'string' ? sanitizeText(value, 120)
			: typeof value === 'number' || typeof value === 'boolean' || value === null ? value
				: Array.isArray(value) ? `[array of ${value.length}]` : '[object]';
	}
	return extra;
}

function isCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export interface RuntimeVersion {
	kind: 'version';
	version: string;
}

export function parseVersion(stdout: string): RuntimeVersion | Unparseable {
	if (stdout.length > MAX_OUTPUT_BYTES) {
		return unparseable('oversized', stdout);
	}
	const line = stdout.trim().split(/\r?\n/)[0].trim();
	if (line === '') {
		return unparseable('empty', stdout);
	}
	return /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/.test(line) ? { kind: 'version', version: line } : unparseable('shape', stdout);
}

/** `route status`: what the journal of the bridge says about the route of Codex. */
export interface RouteStatus {
	kind: 'route-status';
	/** Install models ran: there is a journal. */
	installed: boolean;
	/** The route is in the config of Codex now. Not so: it is paused, and the previous route is back. */
	active: boolean;
	/** The port of the daemon, of the route that was installed. */
	port: number | undefined;
	/** Why the config of Codex no longer matches the journal, in the words of the runtime. */
	errors: string[];
	extra: Record<string, ExtraValue>;
}

const LOOPBACK_ROUTE = /^http:\/\/(?:127\.0\.0\.1|localhost):(?<port>[0-9]{1,5})\/v1\/?$/;

export function parseRouteStatus(stdout: string): RouteStatus | Unparseable {
	const read = readRecord(stdout);
	if ('kind' in read) {
		return read;
	}
	const { installed, active, routeUrl, errors } = read.record;
	if (typeof installed !== 'boolean' || typeof active !== 'boolean') {
		return unparseable('shape', stdout);
	}
	const port = Number(LOOPBACK_ROUTE.exec(typeof routeUrl === 'string' ? routeUrl : '')?.groups?.port ?? 0);
	return {
		kind: 'route-status',
		installed,
		active,
		port: port >= 1 && port <= 65535 ? port : undefined,
		errors: (Array.isArray(errors) ? errors : []).filter((error): error is string => typeof error === 'string').slice(0, MAX_ERRORS).map(error => sanitizeText(error)),
		extra: extraOf(read.record, ['installed', 'active', 'routeUrl', 'errors']),
	};
}

/** `route connect` and `route disconnect`. */
export interface RouteChange {
	kind: 'route-change';
	changed: boolean;
	active: boolean;
	extra: Record<string, ExtraValue>;
}

export function parseRouteChange(stdout: string): RouteChange | Unparseable {
	const read = readRecord(stdout);
	if ('kind' in read) {
		return read;
	}
	const { changed, active } = read.record;
	return typeof changed === 'boolean' && typeof active === 'boolean' ? { kind: 'route-change', changed, active, extra: extraOf(read.record, ['changed', 'active']) } : unparseable('shape', stdout);
}

export type CheckStatus = 'ok' | 'warning' | 'error' | 'unknown';

export interface DoctorCheck {
	id: string;
	status: CheckStatus;
	message: string;
	detail: string | undefined;
}

export interface DoctorReport {
	kind: 'doctor';
	ok: boolean;
	/** `browser-only` or `full`. Not set while the configuration check fails. */
	mode: string | undefined;
	checks: DoctorCheck[];
	/** The report lacks `ok` or `checks`: what is missing was concluded from what is there. */
	partial: boolean;
	extra: Record<string, ExtraValue>;
}

export function parseDoctor(stdout: string): DoctorReport | Unparseable {
	const read = readRecord(stdout);
	if ('kind' in read) {
		return read;
	}
	const { ok, mode, checks } = read.record;
	const list = (Array.isArray(checks) ? checks : []).filter(isRecord).slice(0, MAX_CHECKS).map((check, i): DoctorCheck => ({
		id: typeof check.id === 'string' && check.id !== '' ? check.id.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60) || `check-${i + 1}` : `check-${i + 1}`,
		status: check.status === 'ok' || check.status === 'warning' || check.status === 'error' ? check.status : 'unknown',
		message: typeof check.message === 'string' ? sanitizeText(check.message) : '',
		detail: typeof check.detail === 'string' ? sanitizeText(check.detail, 300) : undefined,
	}));
	return {
		kind: 'doctor',
		ok: typeof ok === 'boolean' ? ok : !list.some(check => check.status === 'error'),
		mode: typeof mode === 'string' ? sanitizeText(mode, 40) : undefined,
		checks: list,
		partial: typeof ok !== 'boolean' || !Array.isArray(checks),
		extra: extraOf(read.record, ['ok', 'mode', 'checks']),
	};
}

export interface SubagentsStatus {
	kind: 'subagents-status';
	/** `compatibility-v1` or `native`. */
	protocol: string;
	installed: boolean;
	active: boolean;
	extra: Record<string, ExtraValue>;
}

export function parseSubagentsStatus(stdout: string): SubagentsStatus | Unparseable {
	const read = readRecord(stdout);
	if ('kind' in read) {
		return read;
	}
	const { protocol, installed, active } = read.record;
	return typeof protocol === 'string' && typeof installed === 'boolean' && typeof active === 'boolean'
		? { kind: 'subagents-status', protocol: sanitizeText(protocol, 40), installed, active, extra: extraOf(read.record, ['protocol', 'installed', 'active']) }
		: unparseable('shape', stdout);
}

export interface SubagentsChange {
	kind: 'subagents-change';
	protocol: string;
	codexRestartRequired: boolean;
	launcherRestartRequired: boolean;
	extra: Record<string, ExtraValue>;
}

export function parseSubagentsChange(stdout: string): SubagentsChange | Unparseable {
	const read = readRecord(stdout);
	if ('kind' in read) {
		return read;
	}
	const { protocol, codexRestartRequired, launcherRestartRequired } = read.record;
	return typeof protocol === 'string'
		? { kind: 'subagents-change', protocol: sanitizeText(protocol, 40), codexRestartRequired: codexRestartRequired === true, launcherRestartRequired: launcherRestartRequired === true, extra: extraOf(read.record, ['protocol', 'codexRestartRequired', 'launcherRestartRequired']) }
		: unparseable('shape', stdout);
}

/** `service cancel-turns`. */
export interface CancelledTurns {
	kind: 'cancelled-turns';
	http: number;
	browser: number;
	extra: Record<string, ExtraValue>;
}

export function parseCancelledTurns(stdout: string): CancelledTurns | Unparseable {
	const read = readRecord(stdout);
	if ('kind' in read) {
		return read;
	}
	const { cancelledHttpTurns, cancelledBrowserTurns } = read.record;
	return isCount(cancelledHttpTurns) && isCount(cancelledBrowserTurns)
		? { kind: 'cancelled-turns', http: cancelledHttpTurns, browser: cancelledBrowserTurns, extra: extraOf(read.record, ['cancelledHttpTurns', 'cancelledBrowserTurns']) }
		: unparseable('shape', stdout);
}

export interface WebModelRow {
	slug: string;
	/** The name the model picker of Codex shows. */
	name: string | undefined;
	/** The one effort the slug fixes. */
	effort: string | undefined;
	contextWindow: number | undefined;
}

/** `codex debug models`: the catalog Codex fetched through the route. The rows of other models are only counted. */
export interface CodexModels {
	kind: 'models';
	web: WebModelRow[];
	otherCount: number;
}

const WEB_SLUG = /^chatgpt-web\/[A-Za-z0-9._-]{1,40}$/;

export function parseCodexModels(stdout: string): CodexModels | Unparseable {
	const json = readJson(stdout);
	if ('kind' in json) {
		return json;
	}
	const rows = Array.isArray(json.value) ? json.value : isRecord(json.value) ? json.value.models ?? json.value.data : undefined;
	if (!Array.isArray(rows)) {
		return unparseable('shape', stdout);
	}

	const web: WebModelRow[] = [];
	let otherCount = 0;
	for (const row of rows.filter(isRecord)) {
		const slug = [row.slug, row.id, row.name].find((candidate): candidate is string => typeof candidate === 'string');
		if (slug === undefined) {
			continue;
		}
		if (!slug.startsWith('chatgpt-web/')) {
			otherCount++;
		} else if (WEB_SLUG.test(slug) && web.length < MAX_MODELS && !web.some(other => other.slug === slug)) {
			const name = [row.display_name, row.displayName].find((candidate): candidate is string => typeof candidate === 'string');
			const level: unknown = Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels[0] : undefined;
			const effort = typeof level === 'string' ? level : isRecord(level) && typeof level.effort === 'string' ? level.effort : undefined;
			const contextWindow = row.context_window;
			web.push({
				slug,
				name: name === undefined ? undefined : sanitizeText(name, 80),
				effort: effort !== undefined && /^[a-z-]{1,20}$/.test(effort) ? effort : undefined,
				contextWindow: typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow) : undefined,
			});
		}
	}
	return { kind: 'models', web, otherCount };
}

/** `GET /healthz`: what the status row knows of it, and what the panel adds. It knows nothing about the sign-in. */
export interface EngineHealth extends BridgeHealth {
	activeHttpTurns: number;
	/** How often Codex asked the daemon for its model catalog since the daemon started. */
	catalogRequests: number;
	/** At least one of them succeeded: Codex was restarted after Install models, and it sees the models. */
	catalogVerified: boolean;
	uptimeSeconds: number | undefined;
}

export function parseEngineHealth(body: string): EngineHealth | undefined {
	const base = parseHealth(body);
	if (!base) {
		return undefined;
	}
	const health = JSON.parse(body) as Record<string, unknown>;
	const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
	return {
		...base,
		activeHttpTurns: count(health.active_http_turns),
		catalogRequests: count(health.model_catalog_requests),
		catalogVerified: count(health.successful_model_catalog_requests) >= 1,
		uptimeSeconds: typeof health.uptime === 'number' && Number.isFinite(health.uptime) && health.uptime >= 0 ? Math.floor(health.uptime) : undefined,
	};
}

//#endregion
