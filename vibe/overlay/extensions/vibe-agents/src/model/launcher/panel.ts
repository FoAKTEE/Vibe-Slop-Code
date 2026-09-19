// SPDX-License-Identifier: MIT

// What the ChatGPT Web webviews get: the snapshot of the controller as two layouts. `panel`: a rail with the nine
// screens and their items, for the editor. `compact`: one line of state, the one state that asks for attention, the
// step to take now, the bridge and the engine, for the view below Sessions. Both are plain data that crosses the
// webview boundary as it is; they hold what the view state holds, which is sanitized text and typed values, never a
// path of this machine and never what a program wrote.
import type { BridgeState } from '../chatgptWeb.ts';
import type { ActivityOutcome } from './activity.ts';
import { isAbortable, isOperationId, operationOf, type OperationId, type ResolvedOperation } from './operations.ts';
import { SCREEN_IDS, isScreenId, type ScreenId } from './screens.ts';
import type { LauncherViewState, Severity, ViewItem } from './state.ts';

export type Layout = 'panel' | 'compact';

export { SCREEN_IDS, isScreenId };

/** What of the controller a layout is made of. */
export interface PanelInput {
	view: LauncherViewState;
	running: { ticket: number; operation: OperationId | 'refresh'; startedAt: number } | undefined;
	queued: readonly { ticket: number; operation: OperationId | 'refresh' }[];
	/** How the last operation the user asked for ended. */
	result: { operation: OperationId; status: ActivityOutcome | 'needs-confirmation'; message: string; hint: string | undefined } | undefined;
}

export interface OperationView extends ResolvedOperation {
	/** Asked for already: it runs, or it waits for what runs. */
	busy: 'running' | 'queued' | undefined;
	/** What Cancel names. Set while it waits, and while it runs when it only reads. */
	cancelTicket: number | undefined;
	/** The filled button: the step to take now, and the way out of the state that asks for attention. */
	primary: boolean;
}

export interface ItemView extends Omit<ViewItem, 'operations'> {
	operations: OperationView[];
}

export interface ScreenView {
	id: ScreenId;
	title: string;
	summary: string;
	severity: Severity;
	items: ItemView[];
}

export interface RailEntry {
	id: ScreenId;
	title: string;
	severity: Severity;
	/** A few characters beside the title: steps done, entries. */
	count: string | undefined;
}

export interface BusyView {
	label: string;
	/** Not set: it writes, and is left to finish. */
	cancelTicket: number | undefined;
	startedAt: number;
	queued: number;
}

export interface ResultView {
	status: ActivityOutcome;
	/** One quiet line, also read out: `Pause Bridge: The bridge is paused...`. */
	text: string;
}

interface Common {
	state: BridgeState;
	headline: string;
	severity: Severity;
	busy: BusyView | undefined;
	result: ResultView | undefined;
}

export interface PanelModel extends Common {
	layout: 'panel';
	rail: RailEntry[];
	screens: ScreenView[];
}

export interface CompactModel extends Common {
	layout: 'compact';
	/** The one state that asks for attention, with the ways out of it. */
	attention: ItemView | undefined;
	/** The step of the checklist to take now. */
	nextStep: ItemView | undefined;
	bridge: ItemView;
	engine: ItemView;
}

function labelOf(operation: OperationId | 'refresh'): string {
	return operation === 'refresh' ? 'Looking' : operationOf(operation).label;
}

function commonOf(input: PanelInput): Common {
	const overview = input.view.screens[0].items[0];
	const running = input.running;
	const result = input.result;
	const text = !result || result.status === 'needs-confirmation' ? undefined
		: [result.message || (result.status === 'ok' ? 'Done.' : result.status === 'cancelled' ? 'Cancelled.' : 'It did not work.'), result.hint ? `In the launcher: ${result.hint}.` : undefined].filter(Boolean).join(' ');
	return {
		state: input.view.bridge,
		headline: input.view.headline,
		severity: overview.severity,
		busy: running === undefined ? undefined : {
			label: labelOf(running.operation),
			cancelTicket: running.operation === 'refresh' || isAbortable(running.operation) ? running.ticket : undefined,
			startedAt: running.startedAt,
			queued: input.queued.length,
		},
		result: result && result.status !== 'needs-confirmation' && text !== undefined ? { status: result.status, text: `${labelOf(result.operation)}: ${text}` } : undefined,
	};
}

function itemOf(item: ViewItem, input: PanelInput, primary: boolean, keep?: (id: OperationId) => boolean): ItemView {
	let isFirst = true;
	return {
		...item,
		operations: item.operations.filter(operation => keep?.(operation.id) ?? true).map((operation): OperationView => {
			const queued = input.queued.find(job => job.operation === operation.id);
			const isRunning = input.running?.operation === operation.id;
			const view: OperationView = {
				...operation,
				busy: isRunning ? 'running' : queued ? 'queued' : undefined,
				cancelTicket: queued ? queued.ticket : isRunning && isAbortable(operation.id) ? input.running?.ticket : undefined,
				primary: primary && isFirst && operation.enabled,
			};
			isFirst &&= !operation.enabled;
			return view;
		}),
	};
}

export function panelModelOf(input: PanelInput): PanelModel {
	const screens = input.view.screens.map((screen): ScreenView => ({
		...screen,
		items: screen.items.map(item => itemOf(item, input, item.next || (input.view.attention !== undefined && screen.id === 'overview' && item.id === input.view.attention.id))),
	}));
	return {
		layout: 'panel',
		...commonOf(input),
		rail: screens.map((screen): RailEntry => {
			const steps = screen.items.filter(item => item.step !== undefined && !item.id.startsWith('step.fullHarness'));
			const entries = screen.items.filter(item => item.at !== undefined).length;
			return { id: screen.id, title: screen.title, severity: screen.severity, count: screen.id === 'setup' ? `${steps.filter(item => item.step === 'done').length}/${steps.length}` : screen.id === 'activity' && entries > 0 ? String(entries) : undefined };
		}),
		screens,
	};
}

/** The states in which Codex is routed to the launcher. */
const ROUTED: ReadonlySet<BridgeState> = new Set<BridgeState>(['route-dead', 'draining', 'busy', 'ready-browser-only', 'ready-full']);

export function compactModelOf(input: PanelInput): CompactModel {
	const find = (screen: ScreenId, id: string): ViewItem => {
		const item = input.view.screens.find(candidate => candidate.id === screen)?.items.find(candidate => candidate.id === id);
		if (!item) {
			throw new Error(`no such item: ${screen}/${id}`);
		}
		return item;
	};
	// An operation shows once: where it matters most
	const shown = new Set<OperationId>();
	const once = (id: OperationId) => !shown.has(id) && Boolean(shown.add(id));

	const attention = input.view.attention && itemOf(input.view.attention, input, true, once);
	const next = input.view.screens.find(screen => screen.id === 'setup')?.items.find(item => item.next);
	const nextStep = next && itemOf(next, input, attention === undefined, once);
	const route = find('bridge', 'route');
	const routeOperation = route.operations.find(operation => (operation.id === 'bridge.connect' || operation.id === 'bridge.pause') && operation.enabled)
		?? route.operations.find(operation => operation.id === (ROUTED.has(input.view.bridge) ? 'bridge.pause' : 'bridge.connect'));
	return {
		layout: 'compact',
		...commonOf(input),
		attention,
		nextStep: nextStep && (nextStep.operations.length > 0 || next.operations.length === 0) ? nextStep : undefined,
		bridge: itemOf(route, input, false, id => id === routeOperation?.id && once(id)),
		engine: itemOf(find('engine', 'process'), input, false, id => find('engine', 'process').operations.some(operation => operation.id === id && operation.enabled) && once(id)),
	};
}

//#region Commands

/** The commands of the palette that are one operation each. They go the way every button goes: through the controller. */
export const COMMAND_OPERATIONS: Readonly<Record<string, OperationId>> = Object.freeze({
	'vibeAgents.chatgptWeb.connectBridge': 'bridge.connect',
	'vibeAgents.chatgptWeb.pauseBridge': 'bridge.pause',
	'vibeAgents.chatgptWeb.startEngine': 'engine.startHidden',
	'vibeAgents.chatgptWeb.showLauncher': 'engine.showWindow',
	'vibeAgents.chatgptWeb.quitEngine': 'engine.quit',
	'vibeAgents.chatgptWeb.runDoctor': 'doctor.run',
	'vibeAgents.chatgptWeb.cancelTurns': 'turns.cancel',
});

export const PANEL_COMMANDS = Object.freeze({
	openPanel: 'vibeAgents.chatgptWeb.openPanel',
	refresh: 'vibeAgents.chatgptWeb.refresh',
});

//#endregion

//#region Messages

/** To a webview. */
export type LauncherInbound =
	| { type: 'state'; model: PanelModel | CompactModel }
	/** The panel: show this screen. */
	| { type: 'show'; screen: ScreenId };

/** From a webview. Whatever arrives is checked: a webview is not trusted with more than naming an operation. */
export type LauncherOutbound =
	| { type: 'ready' }
	| { type: 'run'; id: OperationId }
	| { type: 'cancel'; ticket: number }
	| { type: 'refresh' }
	| { type: 'openPanel'; screen: ScreenId | undefined };

export function parseOutbound(raw: unknown): LauncherOutbound | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const message = raw as Record<string, unknown>;
	switch (message.type) {
		case 'ready': return { type: 'ready' };
		case 'refresh': return { type: 'refresh' };
		case 'run': return isOperationId(message.id) ? { type: 'run', id: message.id } : undefined;
		case 'cancel': return typeof message.ticket === 'number' && Number.isInteger(message.ticket) && message.ticket > 0 ? { type: 'cancel', ticket: message.ticket } : undefined;
		case 'openPanel': return message.screen === undefined || isScreenId(message.screen) ? { type: 'openPanel', screen: message.screen } : undefined;
		default: return undefined;
	}
}

//#endregion
