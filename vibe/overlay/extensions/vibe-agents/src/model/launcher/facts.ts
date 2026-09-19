// SPDX-License-Identifier: MIT

// What can be observed of the launcher from outside of it, and nothing else: whether its app is there and runs, the
// one key of the config of Codex, the answer of its daemon, and the answers of the documented commands of its runtime.
// Whether ChatGPT is signed in, whether the smoke test passed, and every setting of the launcher are NOT in here:
// they live behind its window, and Vibe does not read its state, its browser profile, its tokens or its log.
import type { BridgeFacts, LauncherRoute, ProbeFailure } from '../chatgptWeb.ts';
import type { CodexModels, DoctorReport, EngineHealth, RouteStatus, RuntimeCandidate, SubagentsStatus } from './runtime.ts';

/** A question that got no answer. */
export interface ProbeFailed {
	kind: 'failed';
	reason: 'no-runtime' | 'spawn' | 'timeout' | 'overflow' | 'cancelled' | 'exit' | 'unparseable';
	exitCode: number | undefined;
	/** Sanitized: the first line of what the program said, or of an answer without the documented shape. */
	message: string;
}

export interface RuntimeFacts {
	found: boolean;
	source: RuntimeCandidate['source'] | undefined;
	/** What `--version` said, and before that the version in the name of its directory. */
	version: string | undefined;
}

export interface LauncherFacts {
	platform: string;
	/** Not set: not known on this platform. */
	appInstalled: boolean | undefined;
	/** Not set: not known. */
	launcherRunning: boolean | undefined;
	/** The top-level `openai_base_url` of the config of Codex: where Codex is routed NOW. */
	configRoute: LauncherRoute;
	health: EngineHealth | undefined;
	healthError: ProbeFailure | undefined;
	runtime: RuntimeFacts;
	/** `route status`: what the journal of the bridge says. Not set: not asked yet. */
	route: RouteStatus | ProbeFailed | undefined;
	subagents: SubagentsStatus | ProbeFailed | undefined;
	doctor: DoctorReport | ProbeFailed | undefined;
	doctorAt: number | undefined;
	models: CodexModels | ProbeFailed | undefined;
	modelsAt: number | undefined;
}

export function emptyFacts(platform: string): LauncherFacts {
	return {
		platform, appInstalled: undefined, launcherRunning: undefined, configRoute: { kind: 'absent' }, health: undefined, healthError: undefined,
		runtime: { found: false, source: undefined, version: undefined }, route: undefined, subagents: undefined, doctor: undefined, doctorAt: undefined, models: undefined, modelsAt: undefined,
	};
}

export function failed(reason: ProbeFailed['reason'], message = '', exitCode?: number): ProbeFailed {
	return { kind: 'failed', reason, exitCode, message };
}

/** Codex is routed to the launcher now. The config of Codex is what Codex reads, so it decides. */
export function isRouteActive(facts: LauncherFacts): boolean {
	return facts.configRoute.kind === 'launcher';
}

/** Install models ran. Not set: the journal was not asked, and the config of Codex does not tell. */
export function isRouteInstalled(facts: LauncherFacts): boolean | undefined {
	if (facts.route?.kind === 'route-status') {
		return facts.route.installed;
	}
	return isRouteActive(facts) ? true : undefined;
}

/** The port of the daemon: the one Codex is routed to, or the one of the paused route. Nothing is probed without one. */
export function daemonPortOf(facts: LauncherFacts): number | undefined {
	return facts.configRoute.kind === 'launcher' ? facts.configRoute.port : facts.route?.kind === 'route-status' ? facts.route.port : undefined;
}

export function activeTurnsOf(facts: LauncherFacts): number {
	return (facts.health?.activeBrowserTurns ?? 0) + (facts.health?.activeHttpTurns ?? 0);
}

/** The same facts as the status row of the Sessions view decides on: both tell one story. */
export function bridgeFactsOf(facts: LauncherFacts): BridgeFacts {
	return { appInstalled: facts.appInstalled, launcherRunning: facts.launcherRunning, route: facts.configRoute, health: facts.health, error: facts.healthError };
}
