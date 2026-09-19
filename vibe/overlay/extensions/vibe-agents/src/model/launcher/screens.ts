// SPDX-License-Identifier: MIT

// The screens of the ChatGPT Web panel, in the order of its rail. On its own, without an import: the webview needs
// this and nothing else of the model at run time.
export type ScreenId = 'overview' | 'setup' | 'models' | 'bridge' | 'engine' | 'subagents' | 'mcp' | 'doctor' | 'activity';

export const SCREEN_IDS: readonly ScreenId[] = Object.freeze(['overview', 'setup', 'models', 'bridge', 'engine', 'subagents', 'mcp', 'doctor', 'activity']);

export function isScreenId(value: unknown): value is ScreenId {
	return typeof value === 'string' && (SCREEN_IDS as readonly string[]).includes(value);
}
