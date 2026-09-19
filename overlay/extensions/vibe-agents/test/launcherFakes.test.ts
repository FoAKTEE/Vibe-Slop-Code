// SPDX-License-Identifier: MIT

// The controller on the real machine layer (`nodeLauncherSystem`: real processes, real loopback sockets, real files)
// with EVERY seam pointed at a stand-in in ./fakes: the runtime, `open`, `osascript`, `pgrep`, `codex`, the daemon,
// the config of Codex and the app. This is how a window under test is wired as well. Nothing in here can reach the
// real launcher, the real runtime, the real Codex or anything below the real home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runProgram } from '../src/host/launcher/system.ts';
import { MAX_OUTPUT_BYTES } from '../src/model/launcher/runtime.ts';
import { DEFAULT_LAUNCHER_SETTINGS, childEnvOf, launcherSettingsOf } from '../src/model/launcher/settings.ts';
import { bench, fake } from './fakes/bench.ts';

test('settings: safe defaults, nothing unusable gets through', () => {
	assert.deepEqual(launcherSettingsOf({}), DEFAULT_LAUNCHER_SETTINGS);
	assert.deepEqual(DEFAULT_LAUNCHER_SETTINGS, {
		runtimePath: undefined, launcherBundleId: 'dev.codexwebgpt.launcher', launcherAppPath: undefined, openCommand: '/usr/bin/open', osascriptCommand: '/usr/bin/osascript', pgrepCommand: '/usr/bin/pgrep',
		codexCommand: 'codex', codexConfigPath: undefined,
	});
	assert.deepEqual(launcherSettingsOf({ runtimePath: '  ', launcherBundleId: 'x" & do shell script "id', openCommand: 42, codexCommand: ' /opt/bin/codex ', pgrepCommand: 'a\0b' }), { ...DEFAULT_LAUNCHER_SETTINGS, codexCommand: '/opt/bin/codex' });
	assert.deepEqual(childEnvOf({ PATH: '/usr/bin', CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: 'secret', CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: '/x', EMPTY: undefined }), { PATH: '/usr/bin' }, 'a program Vibe starts never inherits an authorization of the launcher');
});

test('settings: each one is in the manifest as a machine setting that an untrusted workspace cannot set, with the default of the model', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
		capabilities: { untrustedWorkspaces: { restrictedConfigurations: string[] } };
		contributes: { configuration: { properties: Record<string, { type: string; default: unknown; scope: string } | undefined> } };
	};
	const strings = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.nls.json'), 'utf8')) as Record<string, string | undefined>;
	for (const [key, fallback] of Object.entries(DEFAULT_LAUNCHER_SETTINGS)) {
		const name = `vibeAgents.chatgptWeb.${key}`;
		const property = manifest.contributes.configuration.properties[name];
		assert.deepEqual([property?.type, property?.scope, manifest.capabilities.untrustedWorkspaces.restrictedConfigurations.includes(name), typeof strings[`config.chatgptWeb.${key}`]], ['string', 'machine', true, 'string'], name);
		if (key !== 'codexConfigPath') { // its default is shown as the path Codex reads; not set means the same
			assert.equal(property?.default, fallback ?? '', name);
		}
	}
});

test('ready: the panel opens, the bridge is paused and connected again through the fake runtime, and only documented commands ran', async t => {
	const b = await bench(t, 'ready-browser-only');
	await b.controller.refresh('open');
	assert.deepEqual([b.controller.snapshot.view.bridge, b.controller.snapshot.facts.runtime, b.system.listed], ['ready-browser-only', { found: true, source: 'setting', version: '5.0.8' }, 0], 'a named runtime: the real versions directory is not even listed');

	assert.equal((await b.controller.request('bridge.pause').done).status, 'needs-confirmation');
	const paused = await b.controller.request('bridge.pause', { confirmed: true }).done;
	assert.deepEqual([paused.status, b.controller.snapshot.view.bridge, fs.readFileSync(b.settings.codexConfigPath!, 'utf8')], ['ok', 'paused', 'model = "gpt-6-astra"\n']);
	const connected = await b.controller.request('bridge.connect', { confirmed: true }).done;
	assert.deepEqual([connected.status, b.controller.snapshot.view.bridge], ['ok', 'ready-browser-only']);

	assert.deepEqual([(await b.controller.request('doctor.run').done).message, (await b.controller.request('models.refresh').done).message], ['The doctor found the runtime healthy.', 'Codex lists 3 ChatGPT Web models.']);
	assert.deepEqual((await b.controller.request('subagents.useNative', { confirmed: true }).done).message, 'The protocol is set. Restart Codex AND the launcher, then start a new task.');
	assert.equal(b.controller.snapshot.facts.subagents?.kind === 'subagents-status' && b.controller.snapshot.facts.subagents.protocol, 'native');

	assert.deepEqual(b.runtimeCalls(), ['--version', 'route status', 'subagents status', 'route disconnect', 'route status', 'route connect', 'route status', 'doctor --json', 'subagents native', 'subagents status']);
	assert.deepEqual([b.forbidden(), b.daemon!.forbidden, fs.readFileSync(path.join(b.dir, 'state', 'codex-calls.jsonl'), 'utf8').trim()], ['', [], '{"args":["debug","models"],"scenario":"ready-browser-only"}']);
	assert.ok(b.daemon!.requests.length > 0 && b.daemon!.requests.every(request => request === 'GET /healthz'), 'one kind of request, ever');
	assert.ok(!JSON.stringify(b.controller.snapshot).includes(b.dir), 'no path of this machine is in what the editor gets');
});

test('not set up: the runtime says so, the doctor says why, and nothing is offered that cannot work', async t => {
	const b = await bench(t, 'not-set-up', { daemon: false, routed: false });
	await b.controller.refresh('open');
	assert.equal(b.controller.snapshot.view.bridge, 'not-set-up');
	const doctor = await b.controller.request('doctor.run').done;
	assert.deepEqual([doctor.status, doctor.message], ['ok', 'The doctor found 1 problem.'], 'exit code 1 is an answer: the report is not healthy');
	assert.equal((await b.controller.request('bridge.connect', { confirmed: true }).done).message, 'Install models did not run yet: there is no route to connect. That step is done in the launcher.');
	assert.deepEqual(b.runtimeCalls(), ['--version', 'route status', 'doctor --json']);
});

test('the engine: started hidden, shown, quit -- a state file changes, and no app, no signal', async t => {
	const b = await bench(t, 'ready-browser-only', { launcher: 'stopped' });
	await b.controller.refresh('open');
	assert.equal(b.controller.snapshot.facts.launcherRunning, false);

	assert.equal((await b.controller.request('engine.startHidden', { confirmed: true }).done).status, 'ok');
	assert.deepEqual([b.launcherState(), b.controller.snapshot.facts.launcherRunning], ['running-hidden', true]);
	assert.equal((await b.controller.request('handoff.signIn').done).hint, 'Setup > 1 Sign in to ChatGPT > Open sign in (or Browser > Use passkey)');
	assert.equal(b.launcherState(), 'running-visible');
	const quit = await b.controller.request('engine.quit', { confirmed: true }).done;
	assert.deepEqual([quit.status, b.launcherState(), b.controller.snapshot.facts.launcherRunning], ['ok', 'stopped', false]);

	assert.deepEqual(b.launcherCalls().filter(line => !line.startsWith('pgrep')), [
		'open -g -j -b dev.vibe.fake-launcher --args --hidden', 'open -b dev.vibe.fake-launcher', 'osascript -e tell application id "dev.vibe.fake-launcher" to quit',
	]);
	assert.deepEqual(b.controller.snapshot.activity.filter(entry => /^(engine|handoff)/.test(entry.operation)).map(entry => [entry.operation, entry.command, entry.outcome]), [
		['engine.startHidden', 'open -g -j -b dev.vibe.fake-launcher --args --hidden', 'ok'], ['handoff.signIn', 'open -b dev.vibe.fake-launcher', 'ok'], ['engine.quit', 'osascript -e [quit dev.vibe.fake-launcher]', 'ok'],
	]);
});

test('a launcher that refuses to quit stays, and is never killed', { timeout: 60_000 }, async t => {
	const b = await bench(t, 'ready-browser-only', { env: { FAKE_LAUNCHER_REFUSES_QUIT: '1' } });
	// the waits of the quit are the real ones here: shorten the clock of the bench, not the code
	const timeouts = b.system.clock.setTimeout;
	b.system.clock.setTimeout = (callback, ms) => timeouts(callback, Math.min(ms, 20));
	await b.controller.refresh('open');
	const quit = await b.controller.request('engine.quit', { confirmed: true }).done;
	assert.deepEqual([quit.status, /still running.*never killed/s.test(quit.message), b.launcherState()], ['failed', true, 'running-visible']);
});

test('a runtime that crashes, writes garbage or too much: a typed failure, one sanitized line, nothing of it in the log', async t => {
	const outcomes: Record<string, unknown> = {};
	for (const scenario of ['crash', 'garbage-output', 'oversized']) {
		const b = await bench(t, scenario);
		await b.controller.refresh('open');
		const outcome = await b.controller.request('probe.routeStatus').done;
		outcomes[scenario] = [outcome.status, outcome.message, b.controller.snapshot.facts.route];
		const told = JSON.stringify(b.controller.snapshot);
		assert.ok(!/\/Users\/|AbCdEf|PROMPT|cli\.js|xxxx/.test(told), `${scenario}: ${told.slice(0, 400)}`);
	}
	assert.deepEqual(outcomes, {
		'crash': ['failed', 'EACCES: permission denied, open \'~/.codex-chatgpt-web/config.json\' (Bearer [redacted])', { kind: 'failed', reason: 'exit', exitCode: 134, message: 'EACCES: permission denied, open \'~/.codex-chatgpt-web/config.json\' (Bearer [redacted])' }],
		'garbage-output': ['unparseable', 'The answer did not have the documented shape, and was not used.', { kind: 'failed', reason: 'unparseable', exitCode: undefined, message: 'warn something unexpected in ~/.codex-chatgpt-web/runtime' }],
		'oversized': ['failed', 'The answer was too large and was not read.', { kind: 'failed', reason: 'overflow', exitCode: undefined, message: '' }],
	});
});

test('runProgram: no shell, a deadline that holds against a program that ignores it, a cap, and what did not start', { timeout: 60_000 }, async t => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-agents-cgw-run-')));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const env = { PATH: process.env.PATH ?? '', HOME: dir, FAKE_CGW_STATE_DIR: path.join(dir, 'state'), FAKE_CGW_SCENARIO: 'slow', FAKE_CGW_IGNORE_TERM: '1', CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: 'secret' };

	const marker = path.join(dir, 'unique-marker');
	const started = Date.now();
	assert.deepEqual(await runProgram(fake('fake-runtime.mjs'), ['--home', marker, 'route', 'status'], { timeoutMs: 400, env }), { kind: 'timeout' });
	assert.ok(Date.now() - started < 2000, 'the answer does not wait for the program to go');
	await new Promise(resolve => setTimeout(resolve, 2600));
	assert.equal(spawnSync('/usr/bin/pgrep', ['-f', marker]).status, 1, 'it ignored the request to end, so it was ended');
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state', 'calls.jsonl'), 'utf8').trim().split('\n')[0]).home, dir, 'the environment it got is the one that was passed');

	const abort = new AbortController();
	setTimeout(() => abort.abort(), 100);
	assert.deepEqual(await runProgram(fake('fake-runtime.mjs'), ['route', 'status'], { timeoutMs: 30_000, env: { ...env, FAKE_CGW_IGNORE_TERM: '0' }, signal: abort.signal }), { kind: 'cancelled' });

	const big = await runProgram(fake('fake-runtime.mjs'), ['route', 'status'], { timeoutMs: 30_000, env: { ...env, FAKE_CGW_SCENARIO: 'oversized' } });
	assert.deepEqual([big, MAX_OUTPUT_BYTES], [{ kind: 'overflow' }, 1024 * 1024]);
	assert.deepEqual(await runProgram(path.join(dir, 'missing'), [], { timeoutMs: 1000, env }), { kind: 'spawn', code: 'ENOENT' });

	// no shell: what would be a command line is one argument, and the fake refuses it as an unknown command
	const injected = await runProgram(fake('fake-runtime.mjs'), [`route status; touch ${path.join(dir, 'pwned')}`], { timeoutMs: 30_000, env: { ...env, FAKE_CGW_SCENARIO: 'ready-browser-only' } });
	assert.deepEqual([injected.kind === 'exit' && injected.code, fs.existsSync(path.join(dir, 'pwned'))], [1, false]);
});

test('the fakes refuse what Vibe must never run, and say so in a file a test can read', async t => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-agents-cgw-refuse-')));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const env = { PATH: process.env.PATH ?? '', HOME: dir, TMPDIR: dir, FAKE_CGW_STATE_DIR: path.join(dir, 'state'), FAKE_LAUNCHER_STATE: path.join(dir, 'launcher-state') };
	const code = async (exe: string, args: string[]) => { const result = await runProgram(fake(exe), args, { timeoutMs: 30_000, env }); return result.kind === 'exit' ? result.code : result.kind; };

	for (const args of [['setup', '--browser-only'], ['login'], ['uninstall', '--yes'], ['serve'], ['mcp'], ['hook', 'interrupt'], ['dev', 'list'], ['tunnel', 'start'], ['browser', 'check'], ['open', 'tunnels'], ['service', 'install'], ['service', 'stop']]) {
		assert.equal(await code('fake-runtime.mjs', args), 97, args.join(' '));
	}
	for (const args of [['exec', '-m', 'chatgpt-web/high', 'hello'], [], ['-m', 'chatgpt-web/high'], ['debug', 'models', 'extra']]) {
		assert.equal(await code('fake-codex.mjs', args), 97, `codex ${args.join(' ')}`);
	}
	assert.equal(fs.readFileSync(path.join(dir, 'state', 'forbidden.log'), 'utf8').trim().split('\n').length, 16);
	assert.deepEqual([await code('fake-osascript.sh', ['-e', 'do shell script "id"']), await code('fake-open.sh', ['/Applications/Safari.app']), await code('fake-open.sh', ['https://example.test'])], [97, 1, 1]);
	assert.deepEqual([await code('fake-runtime.mjs', ['--version']), await code('fake-runtime.mjs', ['--help']), await code('fake-runtime.mjs', ['nonsense'])], [0, 0, 1]);
});

test('a setting that names a runtime that is not there: nothing is found, and nothing else is looked for', async t => {
	const b = await bench(t, 'ready-browser-only');
	b.settings.runtimePath = path.join(b.dir, 'not-there');
	await b.controller.refresh('open');
	assert.deepEqual([b.controller.snapshot.facts.runtime.found, b.system.listed, b.runtimeCalls()], [false, 0, []]);
	assert.match((await b.controller.request('bridge.pause', { confirmed: true }).done).message, /runtime of the launcher was not found/);
});
