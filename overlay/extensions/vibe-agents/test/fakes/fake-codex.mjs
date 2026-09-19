#!/usr/bin/env node
// SPDX-License-Identifier: MIT

// A stand-in for `codex`, for tests and for a window under test. It knows ONE thing: `debug models`, which prints a
// model catalog in the shape Codex prints it. Everything else -- above all anything that would send a prompt, such as
// `exec` or the interactive start -- is REFUSED with exit code 97 and a line in `forbidden.log`, so that a test proves
// the panel never runs it. It needs no login and costs nothing.
//
//   FAKE_CGW_SCENARIO, FAKE_CGW_STATE_DIR: as for fake-runtime.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = process.env.FAKE_CGW_STATE_DIR || path.join(os.tmpdir(), 'vibe-fake-cgw');
fs.mkdirSync(stateDir, { recursive: true });
const readText = file => { try { return fs.readFileSync(path.join(stateDir, file), 'utf8').trim(); } catch { return ''; } };
const scenario = readText('scenario') || process.env.FAKE_CGW_SCENARIO || 'ready-browser-only';
const args = process.argv.slice(2);
fs.appendFileSync(path.join(stateDir, 'codex-calls.jsonl'), JSON.stringify({ args, scenario }) + '\n');

if (args.length === 1 && args[0] === '--version') {
	process.stdout.write('codex-cli 0.0.0-fake\n');
	process.exit(0);
}
if (args.length !== 2 || args[0] !== 'debug' || args[1] !== 'models') {
	fs.appendFileSync(path.join(stateDir, 'forbidden.log'), `codex ${args.join(' ')}\n`);
	process.stderr.write('fake-codex: Vibe must never run this\n');
	process.exit(97);
}

const native = slug => ({ slug, display_name: slug, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }], context_window: 400000, supported_in_api: true });
const web = (route, name, effort, contextWindow) => ({ slug: `chatgpt-web/${route}`, display_name: `ChatGPT Web \u2014 ${name}`, supported_reasoning_levels: [{ effort }], context_window: contextWindow, auto_compact_token_limit: contextWindow - 10000, supported_in_api: true, tool_mode: null });

if (scenario === 'route-dead' || scenario === 'crash') {
	process.stderr.write('stream error: error sending request for url (http://127.0.0.1:17841/v1/models?client_version=0.0.0); retrying\n');
	process.exit(1);
}
if (scenario === 'garbage-output') {
	process.stdout.write('not a catalog, and /Users/someone/.codex/auth.json is nobody\'s business\n');
	process.exit(0);
}
if (scenario === 'slow') {
	await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_CGW_SLOW_MS || 60000)));
}

const models = [native('gpt-6-astra'), native('gpt-6-astra-mini')];
if (scenario !== 'not-set-up') {
	models.push(web('light', 'Instant', 'low', 41000), web('medium', 'Medium', 'medium', 90000), web('high', 'High', 'high', 90000));
	if (scenario === 'ready-full' || scenario === 'doctor-with-warnings') {
		models.push(web('pro', 'Pro', 'ultra', 112193));
	}
}
process.stdout.write(JSON.stringify({ models }, null, 2) + '\n');
