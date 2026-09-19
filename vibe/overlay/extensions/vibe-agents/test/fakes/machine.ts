// SPDX-License-Identifier: MIT

// A machine that is made up, for the controller and everything above it: what is done to it is written down, what
// it answers is scripted, and its clock only moves when a test moves it. It starts no program and opens no socket.
import type { TestContext } from 'node:test';
import { LauncherController } from '../../src/host/launcher/controller.ts';
import type { LauncherSystem, RunResult } from '../../src/host/launcher/system.ts';
import { DEFAULT_LAUNCHER_SETTINGS } from '../../src/model/launcher/settings.ts';

export const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEf';
export const exit = (stdout: unknown, code = 0, stderr = ''): RunResult => ({ kind: 'exit', code, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout, null, 2), stderr });

const runtimeOf = (platform: string) => `/Users/someone/.codex-chatgpt-web/versions/5.0.8-${platform}-arm64/bin/codex-chatgpt-web`;

export interface Machine {
	system: LauncherSystem;
	controller: LauncherController;
	/** Everything the controller did to the machine, in order. */
	calls: string[];
	/** The most programs that ran at the same time. */
	mostAtOnce: number;
	world: { appInstalled: boolean; running: boolean | undefined; daemon: boolean; installed: boolean; active: boolean; turns: number; quitAfterPolls: number; protocol: string };
	/** An answer that replaces the usual one of a command line of the runtime, of `codex`, `open`, `osascript`. */
	script: Map<string, () => RunResult | Promise<RunResult>>;
	opened: string[];
	advance(ms: number): Promise<void>;
	settle(): Promise<void>;
}

export function machine(t: TestContext, options: { platform?: string; openExternal?: boolean } = {}): Machine {
	const RUNTIME = runtimeOf(options.platform ?? 'darwin');
	let time = 1_000_000;
	let timers: { id: number; at: number; callback: () => void }[] = [];
	let ids = 0;
	let atOnce = 0;
	const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise(resolve => setImmediate(resolve)); } };
	const track = async (answer: RunResult | Promise<RunResult>): Promise<RunResult> => {
		m.mostAtOnce = Math.max(m.mostAtOnce, ++atOnce);
		try {
			return await answer;
		} finally {
			atOnce--;
		}
	};
	const routeToml = () => m.world.installed && m.world.active ? 'model = "gpt-6-astra"\nopenai_base_url = "http://127.0.0.1:17841/v1"\n' : 'model = "gpt-6-astra"\n';
	const runtime = (line: string): RunResult => {
		switch (line) {
			case '--version': return exit('5.0.8\n');
			case 'route status': return exit({ installed: m.world.installed, active: m.world.active, ...(m.world.installed ? { routeUrl: 'http://127.0.0.1:17841/v1' } : {}), errors: [] });
			case 'route connect': { const changed = !m.world.active; m.world.active = true; return exit({ changed, active: true }); }
			case 'route disconnect': { const changed = m.world.active; m.world.active = false; return exit({ changed, active: false }); }
			case 'subagents status': return exit({ protocol: m.world.protocol, installed: m.world.installed, active: m.world.active });
			case 'subagents native': m.world.protocol = 'native'; return exit({ protocol: 'native', codexRestartRequired: true, launcherRestartRequired: true });
			case 'doctor --json': return exit({ ok: true, mode: 'browser-only', checks: [{ id: 'config', status: 'ok', message: 'Configuration is valid (/Users/someone/.codex-chatgpt-web/config.json)' }] });
			case 'service cancel-turns': m.world.turns = 0; return exit({ cancelledHttpTurns: 1, cancelledBrowserTurns: 1 });
			default: return exit('', 1, `codex-chatgpt-web: Unknown command: ${line}\n`);
		}
	};

	const system: LauncherSystem = {
		platform: options.platform ?? 'darwin', arch: 'arm64', homedir: '/Users/someone', env: { PATH: '/usr/bin' }, healthTimeoutMs: 1500,
		timers: { setInterval: () => 0, clearInterval: () => { } },
		clock: {
			now: () => time,
			setTimeout: (callback, ms) => { timers.push({ id: ++ids, at: time + ms, callback }); return ids; },
			clearTimeout: handle => { timers = timers.filter(timer => timer.id !== handle); },
		},
		readFile: async path => { m.calls.push(`read ${path}`); return routeToml(); },
		exists: async path => path === '/Applications/Codex Web GPT.app' ? m.world.appInstalled : path === RUNTIME,
		execFile: () => { throw new Error('not used'); },
		listRuntimeVersions: async () => { m.calls.push('list versions'); return [`5.0.8-${options.platform ?? 'darwin'}-arm64`, '5.0.8-win32-x64', '.DS_Store']; },
		run: (exe, args) => {
			const line = args.join(' ');
			m.calls.push(`${exe === RUNTIME ? 'runtime' : exe} ${line}`);
			return track(m.script.get(line)?.() ?? (exe === RUNTIME ? runtime(line) : exit({ models: [{ slug: 'gpt-6-astra' }, { slug: 'chatgpt-web/high', display_name: 'ChatGPT Web - High' }] })));
		},
		isLauncherRunning: async () => {
			m.calls.push('pgrep');
			if (m.world.running && m.world.quitAfterPolls > 0 && --m.world.quitAfterPolls === 0) {
				m.world.running = false;
				m.world.daemon = false;
			}
			return m.world.running;
		},
		openLauncher: ({ hidden }) => {
			m.calls.push(hidden ? 'open hidden' : 'open');
			return track(m.script.get('open')?.() ?? (() => { m.world.running = true; return exit(''); })());
		},
		quitLauncher: () => {
			m.calls.push('osascript quit');
			return track(m.script.get('quit')?.() ?? exit('', 1, 'execution error: User canceled. (-128)'));
		},
		fetchHealth: async port => {
			m.calls.push(`GET /healthz :${port}`);
			return m.world.daemon ? { body: JSON.stringify({ status: 'ok', service: 'codex-chatgpt-web', version: '5.0.8', mode: 'browser-only', accepting_turns: true, successful_model_catalog_requests: 1, model_catalog_requests: 1, active_http_turns: 0, active_browser_turns: m.world.turns, uptime: 60 }) } : { error: 'unreachable' };
		},
	};

	const m: Machine = {
		system, controller: undefined!, calls: [], mostAtOnce: 0, script: new Map(), opened: [],
		world: { appInstalled: true, running: true, daemon: true, installed: true, active: true, turns: 0, quitAfterPolls: 0, protocol: 'compatibility-v1' },
		settle,
		advance: async ms => {
			const until = time + ms;
			await settle();
			for (let due = timers.filter(timer => timer.at <= until).sort((a, b) => a.at - b.at)[0]; due; due = timers.filter(timer => timer.at <= until).sort((a, b) => a.at - b.at)[0]) {
				timers = timers.filter(timer => timer !== due);
				time = due.at;
				due.callback();
				await settle();
			}
			time = until;
		},
	};
	m.controller = new LauncherController(system, { settings: () => DEFAULT_LAUNCHER_SETTINGS, openExternal: options.openExternal === false ? undefined : url => { m.opened.push(url); } });
	t.after(() => m.controller.dispose());
	return m;
}
