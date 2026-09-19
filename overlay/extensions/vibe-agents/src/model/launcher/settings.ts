// SPDX-License-Identifier: MIT

// The programs the panel runs, and where they are. Every one of them is a setting with a safe default, for two
// reasons: a machine may have them elsewhere, and a test profile points ALL of them at stand-ins, so that a window
// under test can never reach the real launcher, the real runtime or the real Codex. They are machine settings: a
// workspace cannot set them.
import { LAUNCHER_BUNDLE_ID } from '../chatgptWeb.ts';
import { isBundleId } from './runtime.ts';

export interface LauncherSettings {
	/** The command of the runtime. Not set: the newest one the launcher installed, then `PATH`. */
	runtimePath: string | undefined;
	launcherBundleId: string;
	/** The app of the launcher. Not set: the two places macOS has apps in. Only whether it exists is asked. */
	launcherAppPath: string | undefined;
	openCommand: string;
	osascriptCommand: string;
	pgrepCommand: string;
	codexCommand: string;
	/** Not set: the config Codex itself reads. */
	codexConfigPath: string | undefined;
}

export const SETTINGS_SECTION = 'vibeAgents.chatgptWeb';

export const DEFAULT_LAUNCHER_SETTINGS: Readonly<LauncherSettings> = Object.freeze({
	runtimePath: undefined,
	launcherBundleId: LAUNCHER_BUNDLE_ID,
	launcherAppPath: undefined,
	openCommand: '/usr/bin/open',
	osascriptCommand: '/usr/bin/osascript',
	pgrepCommand: '/usr/bin/pgrep',
	codexCommand: 'codex',
	codexConfigPath: undefined,
});

function text(value: unknown): string | undefined {
	const trimmed = typeof value === 'string' ? value.trim() : '';
	return trimmed === '' || trimmed.includes('\0') ? undefined : trimmed;
}

/** What the settings say, with the default wherever they say nothing usable. A bundle id that is none is the default one. */
export function launcherSettingsOf(raw: Partial<Record<keyof LauncherSettings, unknown>>): LauncherSettings {
	const bundleId = text(raw.launcherBundleId);
	return {
		runtimePath: text(raw.runtimePath),
		launcherBundleId: bundleId !== undefined && isBundleId(bundleId) ? bundleId : DEFAULT_LAUNCHER_SETTINGS.launcherBundleId,
		launcherAppPath: text(raw.launcherAppPath),
		openCommand: text(raw.openCommand) ?? DEFAULT_LAUNCHER_SETTINGS.openCommand,
		osascriptCommand: text(raw.osascriptCommand) ?? DEFAULT_LAUNCHER_SETTINGS.osascriptCommand,
		pgrepCommand: text(raw.pgrepCommand) ?? DEFAULT_LAUNCHER_SETTINGS.pgrepCommand,
		codexCommand: text(raw.codexCommand) ?? DEFAULT_LAUNCHER_SETTINGS.codexCommand,
		codexConfigPath: text(raw.codexConfigPath),
	};
}

/** What a program that Vibe starts must not inherit: the authorizations the launcher hands to ITS children. */
const STRIPPED_ENV: readonly string[] = ['CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN', 'CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR'];

export function childEnvOf(env: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && !STRIPPED_ENV.includes(key)) {
			result[key] = value;
		}
	}
	return result;
}
