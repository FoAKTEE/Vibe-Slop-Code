// SPDX-License-Identifier: MIT

// The ONE test that runs the real runtime of the launcher, so that the parsers are checked against what the real
// program writes and not only against what its source documents. It runs four commands that only read --
// `--version`, `--help`, `route status`, `doctor --json` -- and it runs them SEALED:
//
//   /usr/bin/sandbox-exec -p <profile> /usr/bin/env -i HOME=<tmp> CODEX_HOME=<tmp>/codex PATH=/usr/bin:/bin
//       TMPDIR=<tmp>/tmp <wrapper> --home <tmp>/bridge <command>
//
// Why that cannot reach the account, by the source of codex-chatgpt-web (commit eaf4f09, v5.0.8):
//   - `--home` becomes CODEX_CHATGPT_WEB_HOME before anything else runs (src/cli.ts:547-548), and every path of the
//     bridge is below `getConfigDir()` (src/config.ts:120-123); the config of Codex is `$CODEX_HOME/config.toml`
//     (src/codex-integration-shared.ts:245-252). Both are empty directories below <tmp>.
//   - `--version` and `--help` return before any command (src/cli.ts:549-556).
//   - `route status` is `inspectCodexIntegration()` (src/cli.ts:374-386): with no journal, `readJournal()` returns
//     before it reads or writes anything (src/codex-integration-journal.ts:149-167). No socket, no process.
//   - `doctor --json` returns right after the configuration check when there is no config.json (src/doctor.ts:100-109):
//     before the launcher descriptor, before `/healthz`, before `launchctl`.
// The environment is empty but for the four variables, so no token, descriptor path or proxy can leak in.
//
// That reasoning trusts that the installed bundle is what the source says. The kernel does not: the profile denies
// every network operation, every write outside <tmp>, every read of the private state of the bridge, of the launcher
// and of Codex, and running `launchctl`. Before the real program runs, canaries prove that each of those denials
// holds on this machine. If the wrapper is not installed, or the seal cannot be established, the test is skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseDoctor, parseRouteStatus, parseVersion, runtimeArgv, runtimeCandidates, type RuntimeCommandId } from '../src/model/launcher/runtime.ts';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

function findWrapper(): string | undefined {
	const home = os.homedir();
	let names: string[] | undefined;
	try {
		names = fs.readdirSync(path.join(home, '.codex-chatgpt-web', 'versions')); // names only: nothing in it is opened
	} catch {
		names = undefined;
	}
	return runtimeCandidates({ setting: undefined, homedir: home, versionNames: names, platform: process.platform, arch: process.arch, pathEnv: undefined }).find(candidate => fs.existsSync(candidate.path))?.path;
}

function tree(root: string): string[] {
	return fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).map(entry => entry.split(path.sep).join('/')).sort();
}

test('contract: the real runtime, sealed, answers in the shapes the parsers expect', { timeout: 120_000 }, async t => {
	if (process.env.VIBE_SKIP_REAL_RUNTIME === '1') {
		t.skip('VIBE_SKIP_REAL_RUNTIME=1');
		return;
	}
	const wrapper = findWrapper();
	if (!wrapper) {
		t.skip('the runtime of the Codex Web GPT launcher is not installed on this machine');
		return;
	}
	if (process.platform !== 'darwin' || !fs.existsSync(SANDBOX_EXEC)) {
		t.skip('no kernel sandbox here: the seal cannot be established, so the real runtime is not run');
		return;
	}

	const home = os.homedir();
	const sealed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-agents-cgw-sealed-')));
	const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-agents-cgw-outside-')));
	t.after(() => { fs.rmSync(sealed, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
	for (const dir of ['codex', 'bridge', 'tmp']) {
		fs.mkdirSync(path.join(sealed, dir));
	}
	fs.mkdirSync(path.join(outside, 'private'));
	fs.writeFileSync(path.join(outside, 'private', 'secret'), 'secret');

	const quoted = (value: string) => JSON.stringify(value);
	const profile = [
		'(version 1)', '(allow default)', '(deny network*)', '(deny file-write*)',
		`(allow file-write* (subpath ${quoted(sealed)}) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
		`(deny file-read* file-write* ${[
			path.join(home, '.codex'), path.join(home, '.codex-chatgpt-web', 'runtime'), path.join(home, '.codex-chatgpt-web', 'codex'), path.join(home, '.codex-chatgpt-web', 'browser'),
			path.join(home, '.codex-chatgpt-web', 'logs'), path.join(home, '.codex-chatgpt-web', 'secrets'), path.join(home, 'Library', 'Application Support', 'Codex Web GPT'), path.join(home, 'Library', 'Logs', 'Codex Web GPT'),
			path.join(outside, 'private'),
		].map(dir => `(subpath ${quoted(dir)})`).join(' ')} (literal ${quoted(path.join(home, '.codex-chatgpt-web', 'config.json'))}))`,
		'(deny process-exec* (literal "/bin/launchctl"))',
	].join('\n');
	const variables = [`HOME=${sealed}`, `CODEX_HOME=${path.join(sealed, 'codex')}`, 'PATH=/usr/bin:/bin', `TMPDIR=${path.join(sealed, 'tmp')}`];
	const run = (program: string, args: string[]) => spawnSync(SANDBOX_EXEC, ['-p', profile, '/usr/bin/env', '-i', ...variables, program, ...args], { cwd: sealed, env: {}, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });

	// The seal, proven on this machine before the real program runs. A canary that does not behave: skip, do not run it.
	const connections: string[] = [];
	const listener = net.createServer(socket => { connections.push('connection'); socket.destroy(); });
	await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise(resolve => listener.close(resolve)));
	const port = (listener.address() as net.AddressInfo).port;

	const canaries = {
		environment: run('/usr/bin/env', []).stdout.trim().split('\n').sort(),
		writeInside: run('/bin/sh', ['-c', 'echo inside > "$1"', 'sh', path.join(sealed, 'tmp', 'canary')]).status,
		writeOutside: run('/bin/sh', ['-c', 'echo outside > "$1"', 'sh', path.join(outside, 'canary')]).status,
		readPrivate: run('/bin/cat', [path.join(outside, 'private', 'secret')]).status,
		network: run('/usr/bin/nc', ['-z', '-w', '2', '127.0.0.1', String(port)]).status,
		launchctl: run('/bin/launchctl', ['help']).status,
	};
	await new Promise(resolve => setTimeout(resolve, 50));
	const sealHolds = canaries.writeInside === 0 && canaries.writeOutside !== 0 && canaries.readPrivate !== 0 && canaries.network !== 0 && canaries.launchctl !== 0
		&& connections.length === 0 && !fs.existsSync(path.join(outside, 'canary')) && JSON.stringify(canaries.environment) === JSON.stringify([...variables].sort());
	if (!sealHolds) {
		t.skip(`the seal does not hold on this machine, so the real runtime is not run: ${JSON.stringify({ ...canaries, connections: connections.length })}`);
		return;
	}
	assert.deepEqual(canaries.environment, [...variables].sort(), 'the sandbox environment, and nothing else');
	fs.rmSync(path.join(sealed, 'tmp', 'canary'));
	const before = tree(sealed);

	const runtime = (command: RuntimeCommandId) => run(wrapper, runtimeArgv(command, { home: path.join(sealed, 'bridge') }));

	const version = runtime('version');
	const parsedVersion = parseVersion(version.stdout);
	assert.deepEqual([version.status, parsedVersion.kind], [0, 'version'], version.stderr.slice(0, 200));

	const help = runtime('help');
	assert.equal(help.status, 0);
	assert.equal(help.stdout.split('\n')[0], `codex-chatgpt-web ${parsedVersion.kind === 'version' ? parsedVersion.version : ''}`);
	for (const documented of ['codex-chatgpt-web doctor [--json]', 'codex-chatgpt-web route <status|connect|disconnect>', 'codex-chatgpt-web subagents <status|compatibility-v1|native>', '|cancel-turns>', '--home PATH']) {
		assert.ok(help.stdout.includes(documented), `the help of the runtime no longer documents: ${documented}`);
	}

	const route = runtime('route-status');
	assert.deepEqual([route.status, parseRouteStatus(route.stdout)], [0, { kind: 'route-status', installed: false, active: false, port: undefined, errors: [], extra: {} }], route.stderr.slice(0, 200));

	const doctor = runtime('doctor');
	const report = parseDoctor(doctor.stdout);
	assert.ok(report.kind === 'doctor', doctor.stderr.slice(0, 200));
	assert.deepEqual([doctor.status, report.ok, report.mode, report.partial, report.extra, report.checks.map(check => [check.id, check.status, check.message])], [1, false, undefined, false, {}, [['config', 'error', 'Configuration is invalid']]]);
	assert.match(report.checks[0].detail ?? '', /^Configuration is missing: .*bridge\/config\.json\. Run codex-chatgpt-web setup first\.$/);

	// Nothing was written outside of <tmp> (the kernel refused it, see the canary), and this is what was written inside
	const written = tree(sealed).filter(entry => !before.includes(entry));
	const places = [...new Set(written.map(entry => entry.split('/').slice(0, 3).join('/')))];
	t.diagnostic(`sealed run of ${path.basename(path.dirname(path.dirname(wrapper)))}: ${written.length} entries written, all below <tmp>, in ${JSON.stringify(places)}`);
	assert.deepEqual([tree(outside), connections, written.filter(entry => entry.startsWith('bridge') || entry.startsWith('codex'))], [['private', 'private/secret'], [], []], 'no state of a bridge and no config of Codex came to be, not even in the sandbox');
});
