// SPDX-License-Identifier: MIT

// The runtime of the launcher as text: where its command is found, which command lines exist, and what their
// answers mean. Nothing in here runs anything: the answers are the shapes the source of codex-chatgpt-web documents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	MAX_OUTPUT_BYTES, RUNTIME_COMMAND, describeCommand, isBundleId, openArgv, parseCancelledTurns, parseCliError, parseCodexModels, parseDoctor, parseEngineHealth,
	parseRouteChange, parseRouteStatus, parseSubagentsChange, parseSubagentsStatus, parseVersion, parseVersionDirName, quitArgv, runningArgv, runtimeArgv, runtimeCandidates,
	runtimeCommandOf, sanitizeText, type DiscoveryInput,
} from '../src/model/launcher/runtime.ts';

const HOME = '/Users/someone';
const discovery = (patch: Partial<DiscoveryInput>): DiscoveryInput => ({ setting: undefined, homedir: HOME, versionNames: undefined, platform: 'darwin', arch: 'arm64', pathEnv: undefined, ...patch });

//#region Discovery

test('discovery: the newest version directory by semver, of this platform, junk names ignored', () => {
	const names = ['5.0.8-darwin-arm64', '5.0.10-darwin-arm64', '4.9.99-darwin-arm64', '5.0.10-darwin-x64', '5.1.0-beta.1-darwin-arm64', '.DS_Store', 'current', 'v5.2.0-darwin-arm64', '5.0', '../../etc', '6.0.0-darwin-arm64/../..', ''];
	assert.deepEqual(runtimeCandidates(discovery({ versionNames: names })), [
		{ path: `${HOME}/.codex-chatgpt-web/versions/5.1.0-beta.1-darwin-arm64/bin/codex-chatgpt-web`, source: 'versions', version: '5.1.0-beta.1' },
		{ path: `${HOME}/.codex-chatgpt-web/versions/5.0.10-darwin-arm64/bin/codex-chatgpt-web`, source: 'versions', version: '5.0.10' },
		{ path: `${HOME}/.codex-chatgpt-web/versions/5.0.8-darwin-arm64/bin/codex-chatgpt-web`, source: 'versions', version: '5.0.8' },
		{ path: `${HOME}/.codex-chatgpt-web/versions/4.9.99-darwin-arm64/bin/codex-chatgpt-web`, source: 'versions', version: '4.9.99' },
	], '5.0.10 is newer than 5.0.8: numbers, not text; the build of another architecture is not ours');

	// a release is newer than its own pre-release
	assert.deepEqual(runtimeCandidates(discovery({ versionNames: ['5.1.0-beta.1-darwin-arm64', '5.1.0-darwin-arm64', '5.1.0-beta.2-darwin-arm64'] })).map(candidate => candidate.version), ['5.1.0', '5.1.0-beta.2', '5.1.0-beta.1']);
	assert.deepEqual(parseVersionDirName('5.0.8-darwin-arm64'), { name: '5.0.8-darwin-arm64', version: '5.0.8', numbers: [5, 0, 8], prerelease: undefined, platformTag: 'darwin-arm64' });
	assert.equal(parseVersionDirName('5.0.8'), undefined, 'a directory of the runtime names its platform');
});

test('discovery: no directory falls back to PATH; a setting is the only candidate and never falls back', () => {
	assert.deepEqual(runtimeCandidates(discovery({ versionNames: undefined })), [], 'no directory, no PATH: nothing');
	assert.deepEqual(runtimeCandidates(discovery({ versionNames: [], pathEnv: '/opt/homebrew/bin::relative/bin:/usr/bin:/opt/homebrew/bin' })), [
		{ path: '/opt/homebrew/bin/codex-chatgpt-web', source: 'path', version: undefined },
		{ path: '/usr/bin/codex-chatgpt-web', source: 'path', version: undefined },
	], 'absolute entries only, each once');
	assert.deepEqual(runtimeCandidates(discovery({ versionNames: ['5.0.8-darwin-arm64'], pathEnv: '/usr/bin' })).map(candidate => candidate.source), ['versions', 'path'], 'the installed copy first');

	// The seam of a test profile: what it names is all there is, so a fake that is missing never becomes the real one
	assert.deepEqual(runtimeCandidates(discovery({ setting: ' ~/fakes/fake-runtime.mjs ', versionNames: ['5.0.8-darwin-arm64'], pathEnv: '/usr/bin' })), [{ path: `${HOME}/fakes/fake-runtime.mjs`, source: 'setting', version: undefined }]);
	assert.deepEqual(runtimeCandidates(discovery({ setting: 'relative/runtime', versionNames: ['5.0.8-darwin-arm64'], pathEnv: '/usr/bin' })), [], 'a relative setting names nothing, and still nothing else is tried');
	assert.deepEqual(runtimeCandidates(discovery({ setting: '   ', versionNames: ['5.0.8-darwin-arm64'] })).length, 1, 'an empty setting is no setting');
});

//#endregion

//#region Command lines

test('argv: every command line Vibe can run, exactly', () => {
	assert.deepEqual([
		runtimeArgv('version'), runtimeArgv('help'), runtimeArgv('route-status'), runtimeArgv('route-connect'), runtimeArgv('route-disconnect'), runtimeArgv('doctor'),
		runtimeArgv('subagents-status'), runtimeArgv('subagents-compatibility-v1'), runtimeArgv('subagents-native'), runtimeArgv('cancel-turns'),
	], [['--version'], ['--help'], ['route', 'status'], ['route', 'connect'], ['route', 'disconnect'], ['doctor', '--json'], ['subagents', 'status'], ['subagents', 'compatibility-v1'], ['subagents', 'native'], ['service', 'cancel-turns']]);
	assert.deepEqual(runtimeArgv('route-status', { home: '/tmp/x/bridge' }), ['--home', '/tmp/x/bridge', 'route', 'status'], 'a sandbox names its own home');

	assert.deepEqual(openArgv('dev.codexwebgpt.launcher', { hidden: true }), ['-g', '-j', '-b', 'dev.codexwebgpt.launcher', '--args', '--hidden']);
	assert.deepEqual(openArgv('dev.codexwebgpt.launcher', { hidden: false }), ['-b', 'dev.codexwebgpt.launcher']);
	assert.deepEqual(quitArgv('dev.codexwebgpt.launcher'), ['-e', 'tell application id "dev.codexwebgpt.launcher" to quit']);
	assert.deepEqual(runningArgv(), ['-f', 'Codex Web GPT.app/Contents/MacOS/']);

	assert.ok(isBundleId('dev.codexwebgpt.launcher') && isBundleId('dev.vibe.fake-launcher'));
	for (const hostile of ['', 'x', 'a.b" to quit\ntell application "Finder', 'a b.c', '-b.evil', 'a..b', 'a.b;c']) {
		assert.equal(isBundleId(hostile), false, hostile);
		assert.throws(() => quitArgv(hostile), /bundle id/);
		assert.throws(() => openArgv(hostile, { hidden: true }), /bundle id/);
	}
});

test('argv: the allow-list knows exactly these shapes, and nothing that sets up, serves, signs in or removes', () => {
	assert.equal(runtimeCommandOf(['route', 'status']), 'route-status');
	assert.equal(runtimeCommandOf(['--home', '/tmp/x', 'doctor', '--json']), 'doctor');
	assert.equal(runtimeCommandOf(['service', 'cancel-turns']), 'cancel-turns');
	for (const refused of [
		[], ['setup'], ['setup', '--browser-only'], ['login'], ['uninstall', '--yes'], ['serve'], ['mcp'], ['hook', 'interrupt'], ['dev', 'chat', 'x'], ['tunnel', 'status'], ['tunnel', 'start'],
		['service', 'status'], ['service', 'install'], ['service', 'start'], ['service', 'stop'], ['service', 'restart'], ['open', 'tunnels'], ['browser', 'check'], ['doctor'], ['status', '--json'],
		['route'], ['route', 'status', 'extra'], ['route', 'connect', '--home', '/x'], ['--home', 'route', 'status'], ['--home', '--x', 'route', 'status'], ['subagents', 'anything'],
	]) {
		assert.equal(runtimeCommandOf(refused), undefined, refused.join(' '));
	}
});

test('argv: what is shown of a command line is its documented words, never a path or a value', () => {
	assert.equal(describeCommand('runtime', ['route', 'status']), `${RUNTIME_COMMAND} route status`);
	assert.equal(describeCommand('runtime', ['--home', '/Users/someone/secret', 'doctor', '--json']), `${RUNTIME_COMMAND} --home [path] doctor --json`);
	assert.equal(describeCommand('runtime', ['setup', '--runtime-key-file', '/Users/someone/key', 'sk-abcdefghijklmnop']), `${RUNTIME_COMMAND} [arg] [arg] [arg] [arg]`);
	assert.equal(describeCommand('codex', ['debug', 'models']), 'codex debug models');
	assert.equal(describeCommand('codex', ['exec', 'tell me a secret']), 'codex [arg] [arg]');
	assert.equal(describeCommand('open', openArgv('dev.codexwebgpt.launcher', { hidden: true })), 'open -g -j -b dev.codexwebgpt.launcher --args --hidden');
	assert.equal(describeCommand('open', ['/Users/someone/file']), 'open [arg]');
	assert.equal(describeCommand('osascript', quitArgv('dev.codexwebgpt.launcher')), 'osascript -e [quit dev.codexwebgpt.launcher]');
	assert.equal(describeCommand('osascript', ['-e', 'do shell script "rm -rf /Users/someone"']), 'osascript -e [script]');
	assert.equal(describeCommand('pgrep', runningArgv()), 'pgrep -f [launcher]');
});

//#endregion

//#region Text that may be shown

test('sanitize: first line, no home, no token, no query, bounded', () => {
	assert.equal(sanitizeText('Configuration is valid (/Users/someone/.codex-chatgpt-web/config.json)\nsecond line'), 'Configuration is valid (~/.codex-chatgpt-web/config.json)');
	assert.equal(sanitizeText('at /home/other/x and C:\\Users\\Third\\y'), 'at ~/x and ~\\y');
	assert.equal(sanitizeText('key sk-abcdefghijklmnop123 id tunnel_0123456789abcdef0123456789abcdef auth Bearer abcdefghijklmnopqrstuvwx.yz'), 'key [key] id [tunnel-id] auth Bearer [redacted]');
	assert.equal(sanitizeText('token AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEf done'), 'token [redacted] done');
	assert.equal(sanitizeText('see https://chatgpt.com/c/68f1-private-conversation?model=x#frag, then stop'), 'see https://chatgpt.com, then stop');
	assert.equal(sanitizeText('\u001b[31mred\u001b[0m\u0007 text\ttab'), 'red text tab');
	assert.equal(sanitizeText('lorem '.repeat(100)), `${'lorem '.repeat(100).slice(0, 197)}...`);
	assert.equal(sanitizeText('lorem '.repeat(100)).length, 200);
	assert.equal(sanitizeText('\n\n  \n'), '');
});

test('errors of the command line: the message after the name of the command, sanitized', () => {
	assert.equal(parseCliError('codex-chatgpt-web: Codex integration is not installed\n'), 'Codex integration is not installed');
	assert.equal(parseCliError('codex-chatgpt-web: Configuration is missing: /Users/someone/.codex-chatgpt-web/config.json. Run codex-chatgpt-web setup first.\n'), 'Configuration is missing: ~/.codex-chatgpt-web/config.json. Run codex-chatgpt-web setup first.');
	assert.equal(parseCliError('codex-chatgpt-web: Unknown command: x\n\ncodex-chatgpt-web 5.0.8\n\nUsage:\n'), 'Unknown command: x');
	assert.equal(parseCliError(''), '');
});

//#endregion

//#region Parsers

test('--version', () => {
	assert.deepEqual(parseVersion('5.0.8\n'), { kind: 'version', version: '5.0.8' });
	assert.deepEqual(parseVersion('5.1.0-beta.1\n'), { kind: 'version', version: '5.1.0-beta.1' });
	assert.deepEqual(parseVersion(''), { kind: 'unparseable', reason: 'empty', firstLine: '' });
	assert.deepEqual(parseVersion('bun: command not found in /Users/someone/x\nmore'), { kind: 'unparseable', reason: 'shape', firstLine: 'bun: command not found in ~/x' });
});

test('route status, connect and disconnect', () => {
	assert.deepEqual(parseRouteStatus('{\n  "installed": true,\n  "active": true,\n  "routeUrl": "http://127.0.0.1:17841/v1",\n  "errors": []\n}\n'), { kind: 'route-status', installed: true, active: true, port: 17841, errors: [], extra: {} });
	assert.deepEqual(parseRouteStatus('{"installed":false,"active":false,"errors":[]}'), { kind: 'route-status', installed: false, active: false, port: undefined, errors: [], extra: {} });

	// an inconsistent route: the words of upstream, without the home in them; fields of a later version are kept
	const inconsistent = parseRouteStatus(JSON.stringify({
		installed: true, active: true, routeUrl: 'https://elsewhere.test/v1?key=SECRET', journalVersion: 11, note: 'in /Users/someone/x', nested: { a: 1 }, list: [1, 2],
		errors: ['Codex integration journal belongs to /Users/someone/.codex/config.toml, not the active config /Users/someone/other/config.toml', 42, 'lorem '.repeat(150)],
	}));
	assert.deepEqual(inconsistent, {
		kind: 'route-status', installed: true, active: true, port: undefined,
		errors: ['Codex integration journal belongs to ~/.codex/config.toml, not the active config ~/other/config.toml', `${'lorem '.repeat(150).slice(0, 197)}...`],
		extra: { journalVersion: 11, note: 'in ~/x', nested: '[object]', list: '[array of 2]' },
	});
	assert.ok(!JSON.stringify(inconsistent).includes('SECRET'), 'a route that is not the one of the launcher is not kept');

	assert.deepEqual(parseRouteChange('{\n  "changed": true,\n  "active": true\n}\n'), { kind: 'route-change', changed: true, active: true, extra: {} });
	assert.deepEqual(parseRouteChange('{"changed":false,"active":false}'), { kind: 'route-change', changed: false, active: false, extra: {} });

	assert.deepEqual(parseRouteStatus('{"installed":"yes","active":true}'), { kind: 'unparseable', reason: 'shape', firstLine: '{"installed":"yes","active":true}' });
	assert.deepEqual(parseRouteStatus('[1,2]'), { kind: 'unparseable', reason: 'shape', firstLine: '[1,2]' });
	assert.deepEqual(parseRouteChange('{"active":true}'), { kind: 'unparseable', reason: 'shape', firstLine: '{"active":true}' });
	assert.deepEqual(parseRouteStatus('Segmentation fault in /Users/someone/.codex-chatgpt-web\n{"installed":true}'), { kind: 'unparseable', reason: 'not-json', firstLine: 'Segmentation fault in ~/.codex-chatgpt-web' });
});

test('doctor --json: ready, not configured, warnings, and what a later or a broken version may send', () => {
	const ready = parseDoctor(JSON.stringify({
		ok: true, mode: 'browser-only', checks: [
			{ id: 'config', status: 'ok', message: 'Configuration is valid (/Users/someone/.codex-chatgpt-web/config.json)' },
			{ id: 'browser-host', status: 'ok', message: 'Embedded launcher browser is authenticated and reachable (pid 80324)' },
			{ id: 'codex', status: 'ok', message: 'Codex native model route is installed' },
			{ id: 'service', status: 'ok', message: 'Launcher owns the background runtime' },
			{ id: 'proxy', status: 'ok', message: 'Responses proxy is healthy on 127.0.0.1:17841' },
			{ id: 'tools', status: 'warning', message: 'Browser-only mode intentionally has no local tools or MCP tunnel' },
		],
	}, null, 2));
	assert.ok(ready.kind === 'doctor');
	assert.deepEqual([ready.ok, ready.mode, ready.partial, ready.checks.length, ready.checks[0], ready.checks[5]], [true, 'browser-only', false, 6,
		{ id: 'config', status: 'ok', message: 'Configuration is valid (~/.codex-chatgpt-web/config.json)', detail: undefined },
		{ id: 'tools', status: 'warning', message: 'Browser-only mode intentionally has no local tools or MCP tunnel', detail: undefined }]);

	assert.deepEqual(parseDoctor('{"ok":false,"checks":[{"id":"config","status":"error","message":"Configuration is invalid","detail":"Configuration is missing: /Users/someone/.codex-chatgpt-web/config.json. Run codex-chatgpt-web setup first."}]}'), {
		kind: 'doctor', ok: false, mode: undefined, partial: false, extra: {},
		checks: [{ id: 'config', status: 'error', message: 'Configuration is invalid', detail: 'Configuration is missing: ~/.codex-chatgpt-web/config.json. Run codex-chatgpt-web setup first.' }],
	});

	// partial and unknown: nothing is thrown away, nothing is trusted
	const partial = parseDoctor(JSON.stringify({ mode: 7, schema: 2, checks: [{ id: 'proxy', status: 'degraded', message: 'New kind of status' }, { status: 'error' }, 'text', null, { id: 'x'.repeat(200), status: 'ok', message: 'm', detail: 'see https://chatgpt.com/c/private?x=1' }] }));
	assert.deepEqual(partial, {
		kind: 'doctor', ok: false, mode: undefined, partial: true, extra: { schema: 2 },
		checks: [
			{ id: 'proxy', status: 'unknown', message: 'New kind of status', detail: undefined },
			{ id: 'check-2', status: 'error', message: '', detail: undefined },
			{ id: 'x'.repeat(60), status: 'ok', message: 'm', detail: 'see https://chatgpt.com' },
		],
	}, 'no `ok`: there is an error, so it is not');
	assert.deepEqual(parseDoctor('{"checks":[{"id":"a","status":"ok","message":"fine"}]}'), { kind: 'doctor', ok: true, mode: undefined, partial: true, extra: {}, checks: [{ id: 'a', status: 'ok', message: 'fine', detail: undefined }] });
	assert.deepEqual(parseDoctor('{"ok":true}'), { kind: 'doctor', ok: true, mode: undefined, partial: true, extra: {}, checks: [] });
	assert.equal((parseDoctor(JSON.stringify({ ok: true, checks: Array.from({ length: 500 }, (_, i) => ({ id: `c${i}`, status: 'ok', message: 'm' })) })) as { checks: unknown[] }).checks.length, 40, 'bounded');

	assert.deepEqual(parseDoctor('\u2713 Configuration is valid\nDoctor result: ready\n'), { kind: 'unparseable', reason: 'not-json', firstLine: '\u2713 Configuration is valid' });
	assert.deepEqual(parseDoctor('"text"'), { kind: 'unparseable', reason: 'shape', firstLine: '"text"' });
});

test('subagents and cancel-turns', () => {
	assert.deepEqual(parseSubagentsStatus('{\n  "protocol": "compatibility-v1",\n  "installed": true,\n  "active": true\n}\n'), { kind: 'subagents-status', protocol: 'compatibility-v1', installed: true, active: true, extra: {} });
	assert.deepEqual(parseSubagentsStatus('{"protocol":"native","installed":true,"active":false,"later":1}'), { kind: 'subagents-status', protocol: 'native', installed: true, active: false, extra: { later: 1 } });
	assert.deepEqual(parseSubagentsStatus('{"protocol":5}'), { kind: 'unparseable', reason: 'shape', firstLine: '{"protocol":5}' });
	assert.deepEqual(parseSubagentsChange('{"protocol":"native","codexRestartRequired":true,"launcherRestartRequired":true}'), { kind: 'subagents-change', protocol: 'native', codexRestartRequired: true, launcherRestartRequired: true, extra: {} });
	assert.deepEqual(parseCancelledTurns('{\n  "cancelledHttpTurns": 1,\n  "cancelledBrowserTurns": 2\n}\n'), { kind: 'cancelled-turns', http: 1, browser: 2, extra: {} });
	assert.deepEqual(parseCancelledTurns('{"cancelledHttpTurns":-1,"cancelledBrowserTurns":0}'), { kind: 'unparseable', reason: 'shape', firstLine: '{"cancelledHttpTurns":-1,"cancelledBrowserTurns":0}' });
});

test('codex debug models: only the rows of the bridge are kept, the others are counted', () => {
	const catalog = {
		models: [
			{ slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], context_window: 400000 },
			{ slug: 'chatgpt-web/high', display_name: 'ChatGPT Web \u2014 High', supported_reasoning_levels: [{ effort: 'high', description: 'x' }], context_window: 90000, auto_compact_token_limit: 80000, tool_mode: null },
			{ slug: 'chatgpt-web/light', display_name: 'ChatGPT Web \u2014 Instant', supported_reasoning_levels: ['low'], context_window: '41000' },
			{ slug: 'chatgpt-web/../../etc', display_name: 'hostile' },
			{ display_name: 'no slug' }, 'text', null,
		],
	};
	assert.deepEqual(parseCodexModels(JSON.stringify(catalog)), {
		kind: 'models', otherCount: 1,
		web: [
			{ slug: 'chatgpt-web/high', name: 'ChatGPT Web \u2014 High', effort: 'high', contextWindow: 90000 },
			{ slug: 'chatgpt-web/light', name: 'ChatGPT Web \u2014 Instant', effort: 'low', contextWindow: undefined },
		],
	});
	assert.deepEqual(parseCodexModels('[{"id":"chatgpt-web/pro"},{"id":"gpt-6-astra"}]'), { kind: 'models', otherCount: 1, web: [{ slug: 'chatgpt-web/pro', name: undefined, effort: undefined, contextWindow: undefined }] }, 'a bare list with ids is read as well');
	assert.deepEqual(parseCodexModels('{"models":[]}'), { kind: 'models', otherCount: 0, web: [] });
	assert.deepEqual(parseCodexModels('{"error":"x"}'), { kind: 'unparseable', reason: 'shape', firstLine: '{"error":"x"}' });
	assert.deepEqual(parseCodexModels('stream error: error sending request for url (http://127.0.0.1:17841/v1/models?client_version=1)'), { kind: 'unparseable', reason: 'not-json', firstLine: 'stream error: error sending request for url (http://127.0.0.1:17841)' });
});

test('every parser: empty and oversized output is refused before it is read', () => {
	const huge = `{"installed":true,"active":true,"errors":[],"pad":"${'x'.repeat(MAX_OUTPUT_BYTES)}"}`;
	for (const parse of [parseVersion, parseRouteStatus, parseRouteChange, parseDoctor, parseSubagentsStatus, parseSubagentsChange, parseCancelledTurns, parseCodexModels]) {
		assert.deepEqual(parse('  \n'), { kind: 'unparseable', reason: 'empty', firstLine: '' }, parse.name);
		const refused = parse(huge);
		assert.deepEqual([refused.kind, 'reason' in refused && refused.reason, 'firstLine' in refused && refused.firstLine.length <= 200], ['unparseable', 'oversized', true], parse.name);
	}
});

test('healthz: what the row knows, and what the panel adds', () => {
	const body = JSON.stringify({ status: 'ok', service: 'codex-chatgpt-web', version: '5.0.8', mode: 'full', pid: 1, port: 17841, uptime: 3671.4, accepting_turns: true, successful_model_catalog_requests: 2, model_catalog_requests: 3, last_model_catalog_result: { request: 'x', at: 1, status: 200 }, active_http_turns: 1, active_browser_turns: 2 });
	assert.deepEqual(parseEngineHealth(body), { mode: 'full', acceptingTurns: true, activeBrowserTurns: 2, version: '5.0.8', activeHttpTurns: 1, catalogRequests: 3, catalogVerified: true, uptimeSeconds: 3671 });
	assert.deepEqual(parseEngineHealth('{"status":"ok","service":"codex-chatgpt-web"}'), { mode: 'unknown', acceptingTurns: false, activeBrowserTurns: 0, version: undefined, activeHttpTurns: 0, catalogRequests: 0, catalogVerified: false, uptimeSeconds: undefined });
	assert.equal(parseEngineHealth('{"status":"ok","service":"something-else"}'), undefined);
	assert.equal(parseEngineHealth('<html>'), undefined);
});

//#endregion
