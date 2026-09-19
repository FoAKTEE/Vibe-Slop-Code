// SPDX-License-Identifier: MIT

// A bench: the controller on the REAL machine layer (real processes, real loopback sockets, real files) with every
// seam pointed at a stand-in of this directory and everything it writes below one temporary directory. It is also
// the recipe for a window under test. Nothing of it can reach the real launcher, the real runtime or the real Codex.
import type { TestContext } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LauncherController } from '../../src/host/launcher/controller.ts';
import { nodeLauncherSystem, type LauncherSystem, type RunOptions } from '../../src/host/launcher/system.ts';
import { launcherSettingsOf, type LauncherSettings } from '../../src/model/launcher/settings.ts';
import { healthOf, startFakeDaemon, type FakeDaemon } from './fake-daemon.ts';

const FAKES = import.meta.dirname;
export const fake = (name: string) => path.join(FAKES, name);

export interface Bench {
	dir: string;
	settings: LauncherSettings;
	system: LauncherSystem & { listed: number };
	controller: LauncherController;
	env: Record<string, string>;
	daemon: FakeDaemon | undefined;
	runtimeCalls(): string[];
	launcherCalls(): string[];
	launcherState(): string;
	forbidden(): string;
}

export async function bench(t: TestContext, scenario: string, options: { daemon?: boolean; routed?: boolean; launcher?: 'stopped' | 'running-visible'; env?: Record<string, string> } = {}): Promise<Bench> {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-agents-cgw-fakes-')));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const daemon = options.daemon === false ? undefined : await startFakeDaemon({ body: healthOf(scenario) });
	if (daemon) {
		t.after(() => daemon.close());
	}
	fs.mkdirSync(path.join(dir, 'codex'));
	fs.mkdirSync(path.join(dir, 'Fake Launcher.app'));
	fs.writeFileSync(path.join(dir, 'codex', 'config.toml'), options.routed === false ? 'model = "gpt-6-astra"\n' : `model = "gpt-6-astra"\nopenai_base_url = "http://127.0.0.1:${daemon?.port ?? 9}/v1"\n`);
	fs.writeFileSync(path.join(dir, 'launcher-state'), `${options.launcher ?? 'running-visible'}\n`);

	const settings = launcherSettingsOf({
		runtimePath: fake('fake-runtime.mjs'), launcherBundleId: 'dev.vibe.fake-launcher', launcherAppPath: path.join(dir, 'Fake Launcher.app'), openCommand: fake('fake-open.sh'),
		osascriptCommand: fake('fake-osascript.sh'), pgrepCommand: fake('fake-pgrep.sh'), codexCommand: fake('fake-codex.mjs'), codexConfigPath: path.join(dir, 'codex', 'config.toml'),
	});
	const env = {
		PATH: process.env.PATH ?? '', HOME: dir, TMPDIR: dir, CODEX_HOME: path.join(dir, 'codex'), FAKE_CGW_STATE_DIR: path.join(dir, 'state'), FAKE_CGW_SCENARIO: scenario,
		FAKE_CGW_PORT: String(daemon?.port ?? 9), FAKE_LAUNCHER_STATE: path.join(dir, 'launcher-state'), ...options.env,
	};
	// The real machine layer, changed in place: its own `openLauncher`, `quitLauncher` and `isLauncherRunning` are what runs
	const system = Object.assign(nodeLauncherSystem(() => settings), { listed: 0 });
	const run = system.run;
	Object.assign(system, {
		platform: 'darwin', homedir: dir, env,
		listRuntimeVersions: async () => { system.listed++; return undefined; },
		run: (exe: string, args: readonly string[], runOptions: RunOptions) => run(exe, args, { ...runOptions, env }),
	});

	const controller = new LauncherController(system, { settings: () => settings });
	t.after(() => controller.dispose());
	const lines = (file: string) => { try { return fs.readFileSync(file, 'utf8').trim().split('\n'); } catch { return []; } };
	return {
		dir, settings, system, controller, env, daemon,
		runtimeCalls: () => lines(path.join(dir, 'state', 'calls.jsonl')).map(line => (JSON.parse(line) as { args: string[] }).args.join(' ')),
		launcherCalls: () => lines(path.join(dir, 'launcher-state.calls')),
		launcherState: () => lines(path.join(dir, 'launcher-state')).join(''),
		forbidden: () => lines(path.join(dir, 'state', 'forbidden.log')).join('\n'),
	};
}
