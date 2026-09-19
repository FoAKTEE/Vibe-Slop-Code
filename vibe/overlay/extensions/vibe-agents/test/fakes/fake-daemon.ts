// SPDX-License-Identifier: MIT

// A stand-in for the daemon of the launcher: a server on loopback that answers `GET /healthz` in the documented
// shape and NOTHING else. Any other request -- `/v1/*` would be a prompt, `/admin/*` needs a token Vibe never has --
// is counted as forbidden, so a test fails when the panel as much as asks. Used by the tests, and started by hand
// for a window under test:
//
//   node test/fakes/fake-daemon.ts [--port 0] [--scenario ready-browser-only]
//
// It prints `listening <port>`. Scenarios: ready-browser-only, ready-full, doctor-with-warnings, draining, busy,
// restart-codex (no catalog request yet). `not-set-up` and `route-dead` have no daemon: there it hangs up on whoever
// connects, as a port does on which nothing listens. With FAKE_CGW_STATE_DIR the file `scenario` in it wins, and is
// read again for every request, so a window under test is switched while it runs. `requests.log` there lists every
// request, and `forbidden.log` gets a line for each one that is not `GET /healthz`.
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

export const HEALTH = Object.freeze({
	status: 'ok', service: 'codex-chatgpt-web', version: '5.0.8', mode: 'browser-only', pid: 4242, port: 0, uptime: 3700, accepting_turns: true, successful_model_catalog_requests: 2,
	last_successful_model_catalog_request_at: null, model_catalog_requests: 2, last_model_catalog_result: null, active_http_turns: 0, active_browser_turns: 0,
});

export function healthOf(scenario: string): Record<string, unknown> {
	switch (scenario) {
		case 'ready-full':
		case 'doctor-with-warnings': return { ...HEALTH, mode: 'full' };
		case 'draining': return { ...HEALTH, accepting_turns: false };
		case 'busy': return { ...HEALTH, active_http_turns: 1, active_browser_turns: 1 };
		case 'restart-codex': return { ...HEALTH, successful_model_catalog_requests: 0, model_catalog_requests: 0 };
		default: return { ...HEALTH };
	}
}

export interface FakeDaemon {
	port: number;
	/** Every request, as `METHOD url`. */
	requests: string[];
	/** Those that are not `GET /healthz`. */
	forbidden: string[];
	/** What `/healthz` answers. A string is sent as it is. */
	body: unknown;
	/** Milliseconds before it answers. */
	delay: number;
	/** It hangs up instead of answering: nothing listens. */
	dead: boolean;
	/** Called before a request is answered. */
	onRequest: ((line: string) => void) | undefined;
	close(): Promise<void>;
}

export async function startFakeDaemon(options: { port?: number; body?: unknown } = {}): Promise<FakeDaemon> {
	const server = http.createServer((request, response) => {
		const line = `${request.method} ${request.url}`;
		daemon.requests.push(line);
		daemon.onRequest?.(line);
		if (daemon.dead) {
			request.socket.destroy();
			return;
		}
		setTimeout(() => {
			if (line !== 'GET /healthz') {
				daemon.forbidden.push(line);
				response.writeHead(request.url?.startsWith('/admin/') ? 401 : 404).end();
				return;
			}
			response.writeHead(200, { 'content-type': 'application/json' }).end(typeof daemon.body === 'string' ? daemon.body : JSON.stringify(daemon.body));
		}, daemon.delay);
	});
	const daemon: FakeDaemon = {
		port: 0, requests: [], forbidden: [], body: options.body ?? HEALTH, delay: 0, dead: false, onRequest: undefined,
		close: () => new Promise(resolve => {
			server.closeAllConnections();
			server.close(() => resolve());
		}),
	};
	await new Promise<void>(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve));
	daemon.port = (server.address() as AddressInfo).port;
	return daemon;
}

/** A port on which nothing listens: one that was just given back. */
export async function deadPort(): Promise<number> {
	const server = http.createServer();
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as AddressInfo).port;
	await new Promise(resolve => server.close(resolve));
	return port;
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
	const option = (name: string, fallback: string) => {
		const index = process.argv.indexOf(`--${name}`);
		return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
	};
	const stateDir = process.env.FAKE_CGW_STATE_DIR;
	const scenarioNow = (): string => {
		try {
			return (stateDir && fs.readFileSync(path.join(stateDir, 'scenario'), 'utf8').trim()) || option('scenario', process.env.FAKE_CGW_SCENARIO ?? 'ready-browser-only');
		} catch {
			return option('scenario', process.env.FAKE_CGW_SCENARIO ?? 'ready-browser-only');
		}
	};
	const daemon = await startFakeDaemon({ port: Number(option('port', '0')) });
	daemon.onRequest = line => {
		const scenario = scenarioNow();
		daemon.dead = scenario === 'not-set-up' || scenario === 'route-dead';
		daemon.body = healthOf(scenario);
		if (stateDir) {
			fs.appendFileSync(path.join(stateDir, 'requests.log'), `${line}\n`);
			if (line !== 'GET /healthz') {
				fs.appendFileSync(path.join(stateDir, 'forbidden.log'), `daemon ${line}\n`);
			}
		}
	};
	console.log(`listening ${daemon.port}`);
}
