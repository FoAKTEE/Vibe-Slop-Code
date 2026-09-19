// SPDX-License-Identifier: MIT

// What the machine does for the ChatGPT Web panel, behind one interface, so that everything above it runs in a test
// without a launcher, a runtime or Codex. A program is run WITHOUT a shell, with a deadline that holds even when the
// program ignores it, with a cap on what is kept of its output, in a directory that is nobody's workspace, and
// without the authorizations the launcher gives to its own children. Nothing in here imports the editor.
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fetchHealthBody, nodeSystem, type BridgeSystem } from '../chatgptWeb.ts';
import type { ProbeFailure } from '../../model/chatgptWeb.ts';
import { MAX_OUTPUT_BYTES, RUNTIME_VERSIONS_DIR, expandHome, openArgv, quitArgv, runningArgv } from '../../model/launcher/runtime.ts';
import { childEnvOf, type LauncherSettings } from '../../model/launcher/settings.ts';

export type RunResult =
	| { kind: 'exit'; code: number; stdout: string; stderr: string }
	/** Something else ended it. */
	| { kind: 'signal' }
	| { kind: 'timeout' }
	/** It wrote more than is kept. Nothing of it is. */
	| { kind: 'overflow' }
	| { kind: 'cancelled' }
	/** It did not start: `ENOENT`, `EACCES`. */
	| { kind: 'spawn'; code: string | undefined };

export interface RunOptions {
	timeoutMs: number;
	/** Not set: the environment of this process. Either way without the authorizations of the launcher. */
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
}

export interface Clock {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface LauncherSystem extends BridgeSystem {
	arch: string;
	clock: Clock;
	/** The NAMES of the entries of `~/.codex-chatgpt-web/versions`. Not set: there is no such directory. Nothing in it is opened. */
	listRuntimeVersions(): Promise<string[] | undefined>;
	run(exe: string, args: readonly string[], options: RunOptions): Promise<RunResult>;
	/** Not set: not known (not macOS, or the process list could not be asked). */
	isLauncherRunning(): Promise<boolean | undefined>;
	/** Hidden: starts it without its window. Not hidden: shows its window, and starts it when it is closed. */
	openLauncher(options: { hidden: boolean }): Promise<RunResult>;
	/** The quit event: the launcher cancels its turns, stops its daemon and exits by itself. It is never killed. */
	quitLauncher(): Promise<RunResult>;
	fetchHealth(port: number): Promise<{ body: string } | { error: ProbeFailure }>;
}

/** After its deadline a program gets this long to end before it is ended. */
const KILL_GRACE_MS = 2000;

/** Runs a program to its end, its deadline, or the cap of its output. Never through a shell. */
export function runProgram(exe: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
	return new Promise(resolve => {
		let settled = false;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		const settle = (result: RunResult) => {
			if (!settled) {
				settled = true;
				clearTimeout(deadline);
				options.signal?.removeEventListener('abort', onAbort);
				resolve(result);
			}
		};
		const end = (result: RunResult) => {
			child?.kill('SIGTERM');
			const hard = setTimeout(() => child?.kill('SIGKILL'), KILL_GRACE_MS);
			hard.unref();
			child?.once('exit', () => clearTimeout(hard));
			settle(result);
		};
		const onAbort = () => end({ kind: 'cancelled' });

		let child: childProcess.ChildProcess | undefined;
		try {
			// cwd: a program that reads `.env` or a config from where it starts must not find the ones of a workspace
			child = childProcess.execFile(exe, [...args], { env: childEnvOf(options.env ?? process.env), cwd: os.tmpdir(), maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8', windowsHide: true, shell: false }, (error, stdout, stderr) => {
				const code = (error as (Error & { code?: number | string | null }) | null)?.code;
				settle(!error ? { kind: 'exit', code: 0, stdout, stderr }
					: code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? { kind: 'overflow' }
						: typeof code === 'number' ? { kind: 'exit', code, stdout, stderr }
							: typeof code === 'string' ? { kind: 'spawn', code } : { kind: 'signal' });
			});
			child.stdin?.end(); // nothing is ever typed into it: a program that asks gets no answer
		} catch {
			settle({ kind: 'spawn', code: undefined });
			return;
		}
		if (options.signal?.aborted) {
			onAbort();
			return;
		}
		options.signal?.addEventListener('abort', onAbort, { once: true });
		deadline = setTimeout(() => end({ kind: 'timeout' }), options.timeoutMs);
	});
}

export function nodeLauncherSystem(settings: () => LauncherSettings): LauncherSystem {
	const base = nodeSystem();
	const system: LauncherSystem = {
		...base,
		arch: process.arch,
		clock: { now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
		listRuntimeVersions: () => fs.promises.readdir(expandHome(RUNTIME_VERSIONS_DIR, system.homedir)).catch(() => undefined),
		run: runProgram,
		isLauncherRunning: async () => {
			if (system.platform !== 'darwin') {
				return undefined;
			}
			const result = await system.run(settings().pgrepCommand, runningArgv(), { timeoutMs: 5000 });
			return result.kind !== 'exit' ? undefined : result.code === 0 ? true : result.code === 1 ? false : undefined;
		},
		openLauncher: options => system.run(settings().openCommand, openArgv(settings().launcherBundleId, options), { timeoutMs: 10_000 }),
		quitLauncher: () => system.run(settings().osascriptCommand, quitArgv(settings().launcherBundleId), { timeoutMs: 15_000 }),
		fetchHealth: port => fetchHealthBody(port, system.healthTimeoutMs),
	};
	return system;
}
