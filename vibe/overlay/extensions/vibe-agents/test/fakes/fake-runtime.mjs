#!/usr/bin/env node
// SPDX-License-Identifier: MIT

// A stand-in for the command of the runtime of the Codex Web GPT launcher (`codex-chatgpt-web`), for tests and for
// a window under test. It answers in the shapes the source of codex-chatgpt-web 5.0.8 documents, keeps a "journal"
// in a state directory so that `route connect` shows in the next `route status`, and REFUSES (exit code 97, and a
// line in `forbidden.log`) everything Vibe must never run: setup, login, uninstall, serve, mcp, hook, dev, tunnel,
// browser, open and every service action but cancel-turns. It touches nothing but its state directory and, like the
// real one, the config of Codex -- and that only when CODEX_HOME names a directory that is not the real ~/.codex.
//
//   FAKE_CGW_SCENARIO    not-set-up | ready-browser-only | ready-full | route-dead | draining | doctor-with-warnings
//                        | slow | crash | garbage-output | oversized        (default: ready-browser-only)
//                        A file `scenario` in the state directory wins, so a running window can be switched.
//   FAKE_CGW_STATE_DIR   where `state.json`, `calls.jsonl` and `forbidden.log` are (default: <tmp>/vibe-fake-cgw)
//   FAKE_CGW_PORT        the port of the route it "installs" (default 17841)
//   FAKE_CGW_SLOW_MS     how long `slow` takes to answer (default 60000); FAKE_CGW_IGNORE_TERM=1: it ignores SIGTERM
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = '5.0.8';
const stateDir = process.env.FAKE_CGW_STATE_DIR || path.join(os.tmpdir(), 'vibe-fake-cgw');
fs.mkdirSync(stateDir, { recursive: true });
const readText = file => { try { return fs.readFileSync(path.join(stateDir, file), 'utf8').trim(); } catch { return ''; } };
const scenario = readText('scenario') || process.env.FAKE_CGW_SCENARIO || 'ready-browser-only';
const port = Number(process.env.FAKE_CGW_PORT || 17841);

const args = process.argv.slice(2);
fs.appendFileSync(path.join(stateDir, 'calls.jsonl'), JSON.stringify({ args, scenario, home: process.env.HOME, codexHome: process.env.CODEX_HOME }) + '\n');

const HELP = `codex-chatgpt-web ${VERSION}

Focused ChatGPT web-backed models for the native Codex harness.

Usage:
  codex-chatgpt-web setup --browser-only [options]
  codex-chatgpt-web setup --full --tunnel-id ID --runtime-key-file PATH [options]
  codex-chatgpt-web login
  codex-chatgpt-web doctor [--json]
  codex-chatgpt-web route <status|connect|disconnect>
  codex-chatgpt-web subagents <status|compatibility-v1|native>
  codex-chatgpt-web browser check
  codex-chatgpt-web serve
  codex-chatgpt-web mcp [--broker-socket PATH]
  codex-chatgpt-web service <status|install|start|restart|stop|cancel-turns>
  codex-chatgpt-web tunnel <status|start|restart|stop|key-import>
  codex-chatgpt-web open <tunnels|runtime-keys|connectors>
  codex-chatgpt-web uninstall --yes

Global:
  --home PATH                  Override ~/.codex-chatgpt-web
  -h, --help
  -v, --version
`;

function out(value) {
	process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}

function fail(message, code = 1) {
	process.stderr.write(`codex-chatgpt-web: ${message}\n`);
	process.exit(code);
}

function refuse() {
	fs.appendFileSync(path.join(stateDir, 'forbidden.log'), args.join(' ') + '\n');
	process.stderr.write('fake-runtime: Vibe must never run this\n');
	process.exit(97);
}

// The global options come first, as in the real command
const homeAt = args.indexOf('--home');
if (homeAt >= 0) {
	if (!args[homeAt + 1] || args[homeAt + 1].startsWith('--')) {
		fail('--home requires a value');
	}
	args.splice(homeAt, 2);
}
if (args.includes('--help') || args.includes('-h')) {
	out(HELP);
	process.exit(0);
}
if (args.includes('--version') || args.includes('-v')) {
	out(`${VERSION}\n`);
	process.exit(0);
}

const statePath = path.join(stateDir, 'state.json');
function readState() {
	try {
		return JSON.parse(fs.readFileSync(statePath, 'utf8'));
	} catch {
		const installed = scenario !== 'not-set-up';
		return { installed, active: installed, protocol: 'compatibility-v1' };
	}
}
function writeState(state) {
	fs.writeFileSync(statePath, JSON.stringify(state));
}

/** Like the real one: the route is one top-level key of the config of Codex. Never the real config. */
function writeCodexRoute(active) {
	const codexHome = process.env.CODEX_HOME;
	if (!codexHome || path.resolve(codexHome) === path.join(os.homedir(), '.codex')) {
		return;
	}
	const configPath = path.join(codexHome, 'config.toml');
	let lines = [];
	try { lines = fs.readFileSync(configPath, 'utf8').split('\n'); } catch { /* no config yet */ }
	lines = lines.filter(line => !/^openai_base_url\s*=/.test(line) && !/^# Managed by codex-chatgpt-web/.test(line));
	if (active) {
		lines.unshift('# Managed by codex-chatgpt-web: Responses use the local bridge; Voice stays on ChatGPT.', `openai_base_url = "http://127.0.0.1:${port}/v1"`);
	}
	fs.mkdirSync(codexHome, { recursive: true });
	fs.writeFileSync(configPath, lines.join('\n'));
}

async function misbehave() {
	if (scenario === 'slow') {
		if (process.env.FAKE_CGW_IGNORE_TERM === '1') {
			process.on('SIGTERM', () => { });
		}
		await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_CGW_SLOW_MS || 60000)));
	}
	if (scenario === 'crash') {
		process.stdout.write('{\n  "installed": tr');
		process.stderr.write('codex-chatgpt-web: EACCES: permission denied, open \'/Users/someone/.codex-chatgpt-web/config.json\' (Bearer AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEf)\n    at readFileSync (/Users/someone/.codex-chatgpt-web/versions/5.0.8-darwin-arm64/app/cli.js:1:1)\n');
		process.exit(134);
	}
	if (scenario === 'garbage-output') {
		out('\u001b[31mwarn\u001b[0m something unexpected in /Users/someone/.codex-chatgpt-web/runtime\ntoken AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEf\nUSER PROMPT: this line must never be shown\n');
		process.exit(0);
	}
	if (scenario === 'oversized') {
		// a pipe takes 64 KiB at once: the rest is written as the reader reads, so the exit waits for it
		await new Promise(resolve => process.stdout.write(`{"installed":true,"active":true,"errors":[],"pad":"${'x'.repeat(3 * 1024 * 1024)}"}\n`, resolve));
		process.exit(0);
	}
}

const CONFIGURED = { id: 'config', status: 'ok', message: 'Configuration is valid (/Users/someone/.codex-chatgpt-web/config.json)' };
const BROWSER_ONLY_CHECKS = [
	CONFIGURED,
	{ id: 'browser-host', status: 'ok', message: 'Embedded launcher browser is authenticated and reachable (pid 4242)' },
	{ id: 'codex', status: 'ok', message: 'Codex native model route is installed' },
	{ id: 'service', status: 'ok', message: 'Launcher owns the background runtime' },
	{ id: 'proxy', status: 'ok', message: `Responses proxy is healthy on 127.0.0.1:${port}` },
];
const FULL_CHECKS = [
	...BROWSER_ONLY_CHECKS,
	{ id: 'tunnel-binary', status: 'ok', message: 'Pinned openai/tunnel-client binary is installed' },
	{ id: 'tunnel-key', status: 'ok', message: 'Tunnel runtime key is stored privately' },
	{ id: 'tunnel-service', status: 'ok', message: 'Launcher owns the tunnel runtime' },
	{ id: 'tunnel-runtime', status: 'ok', message: 'Tunnel runtime reports healthy and ready' },
	{ id: 'connector', status: 'warning', message: 'Local checks cannot prove that ChatGPT connector "Codex Native2" is attached to this tunnel' },
];

function doctorReport() {
	switch (scenario) {
		case 'not-set-up': return { ok: false, checks: [{ id: 'config', status: 'error', message: 'Configuration is invalid', detail: 'Configuration is missing: /Users/someone/.codex-chatgpt-web/config.json. Run codex-chatgpt-web setup first.' }] };
		case 'ready-full': return { ok: true, mode: 'full', checks: FULL_CHECKS };
		case 'doctor-with-warnings': return { ok: true, mode: 'full', checks: FULL_CHECKS.map(check => check.id === 'service' ? { id: 'service', status: 'warning', message: 'Launcher owns the background runtime; a launchd service of the terminal mode is still installed' } : check) };
		case 'route-dead': return {
			ok: false, mode: 'browser-only', checks: [
				CONFIGURED,
				{ id: 'browser-host', status: 'error', message: 'Embedded launcher browser is unavailable', detail: 'Launcher browser host is not running' },
				BROWSER_ONLY_CHECKS[2],
				{ id: 'proxy', status: 'error', message: 'Responses proxy is not reachable', detail: `connect ECONNREFUSED 127.0.0.1:${port}` },
				{ id: 'tools', status: 'warning', message: 'Browser-only mode intentionally has no local tools or MCP tunnel' },
			],
		};
		case 'draining': return { ok: false, mode: 'browser-only', checks: [...BROWSER_ONLY_CHECKS.slice(0, 4), { id: 'proxy', status: 'error', message: 'Responses proxy is still drained and is not accepting Codex turns' }] };
		default: return { ok: true, mode: 'browser-only', checks: [...BROWSER_ONLY_CHECKS, { id: 'tools', status: 'warning', message: 'Browser-only mode intentionally has no local tools or MCP tunnel' }] };
	}
}

const [command, action, ...rest] = args;
const onlyThese = allowed => { if (rest.length > 0 || (action !== undefined && !allowed.includes(action))) { fail(`Unknown arguments: ${[action, ...rest].join(' ')}`); } };

if (['setup', 'login', 'uninstall', 'serve', 'mcp', 'hook', 'dev', 'tunnel', 'browser', 'open'].includes(command) || (command === 'service' && action !== 'cancel-turns' && action !== 'status' && action !== undefined)) {
	refuse();
}

await misbehave();

if (command === 'doctor' || command === 'status') {
	const json = args.includes('--json');
	const report = doctorReport();
	if (json) {
		out(report);
	} else {
		const icon = { ok: '\u2713', warning: '!', error: '\u2717' };
		out(report.checks.flatMap(check => [`${icon[check.status]} ${check.message}`, ...(check.detail ? [`  ${check.detail}`] : [])]).concat(report.ok ? 'Doctor result: ready' : 'Doctor result: not ready').join('\n') + '\n');
	}
	process.exit(report.ok ? 0 : 1);
} else if (command === 'route') {
	onlyThese(['status', 'connect', 'disconnect']);
	const state = readState();
	if (action === undefined || action === 'status') {
		out({ installed: state.installed, active: state.active, ...(state.installed ? { routeUrl: `http://127.0.0.1:${port}/v1` } : {}), errors: [] });
	} else if (action === 'connect') {
		if (!state.installed) {
			fail('Codex integration is not installed');
		}
		const changed = !state.active;
		writeState({ ...state, active: true });
		writeCodexRoute(true);
		out({ changed, active: true });
	} else {
		const changed = state.installed && state.active;
		writeState({ ...state, active: false });
		writeCodexRoute(false);
		out({ changed, active: false });
	}
} else if (command === 'subagents') {
	onlyThese(['status', 'compatibility-v1', 'native']);
	const state = readState();
	if (scenario === 'not-set-up') {
		fail('Configuration is missing: /Users/someone/.codex-chatgpt-web/config.json. Run codex-chatgpt-web setup first.');
	}
	if (action === undefined || action === 'status') {
		out({ protocol: state.protocol, installed: state.installed, active: state.active });
	} else {
		writeState({ ...state, protocol: action });
		out({ protocol: action, codexRestartRequired: true, launcherRestartRequired: true });
	}
} else if (command === 'service') {
	if (scenario === 'not-set-up' && action === 'cancel-turns') {
		fail('Configuration is missing: /Users/someone/.codex-chatgpt-web/config.json. Run codex-chatgpt-web setup first.');
	}
	out(action === 'cancel-turns' ? { cancelledHttpTurns: 1, cancelledBrowserTurns: 1 } : { supported: true, installed: false, loaded: false, label: 'io.github.codex-chatgpt-web.daemon' });
} else if (command === undefined || command === 'help') {
	out(HELP);
} else {
	process.stderr.write(`codex-chatgpt-web: Unknown command: ${command}\n\n${HELP}\n`);
	process.exit(1);
}
