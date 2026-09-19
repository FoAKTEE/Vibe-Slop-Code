// SPDX-License-Identifier: MIT

// Between the controller and the webviews of ChatGPT Web: the view below Sessions and the editor panel. It turns the
// snapshot into what each of them shows, takes what they ask for, and asks the user first where an operation says so:
// with the consequence of the catalogue, word for word, in a dialog. It also decides WHEN the engine is looked at:
// once when a view opens and when the user asks (that asks the runtime, which starts a program), and the three free
// probes every 30 s while a view shows and when the window gets the focus back. Nothing else runs by itself, ever:
// no bridge operation, no engine operation. What the editor does is behind `PanelUi`, so all of this runs in a test.
import { PROBE_INTERVAL_MS, ProbeSchedule, type IntervalTimers } from '../../model/chatgptWeb.ts';
import type { OperationId } from '../../model/launcher/operations.ts';
import { compactModelOf, panelModelOf, parseOutbound, type LauncherInbound, type Layout, type PanelInput } from '../../model/launcher/panel.ts';
import type { ScreenId } from '../../model/launcher/state.ts';
import type { LauncherController, OperationOutcome } from './controller.ts';

export interface ConfirmRequest {
	/** `Connect Bridge?` */
	title: string;
	/** The consequence, word for word. */
	detail: string;
	/** Goes ahead. */
	button: string;
	/** What keeps the machine working, offered as the other way to go ahead: `Pause Bridge First`. */
	alternative: string | undefined;
}

/** What the editor does for the panel. */
export interface PanelUi {
	/** A modal dialog. Resolves with what was chosen; not set: dismissed. */
	confirm(request: ConfirmRequest): PromiseLike<'go' | 'alternative' | undefined>;
	/** Shows the editor panel, creating it when there is none. */
	openPanel(): void;
	log(message: string): void;
}

export interface Surface {
	layout: Layout;
	post(message: LauncherInbound): void;
}

interface Attached {
	surface: Surface;
	ready: boolean;
	visible: boolean;
	posted: string;
}

/** How often a confirmation is asked again because the fresh look changed what there is to confirm. */
const MAX_QUESTIONS = 3;

export class LauncherPanelHost {

	private readonly attached = new Set<Attached>();
	private readonly schedule: ProbeSchedule;
	private readonly subscription: { dispose(): void };
	private result: PanelInput['result'];
	private pendingScreen: ScreenId | undefined;
	private opening: Promise<void> | undefined;
	private isAsking = false;
	private isPostPending = false;
	private disposed = false;

	private readonly controller: LauncherController;
	private readonly ui: PanelUi;

	constructor(controller: LauncherController, ui: PanelUi, timers: IntervalTimers) {
		this.controller = controller;
		this.ui = ui;
		this.schedule = new ProbeSchedule(() => {
			if (!this.opening) { // what opens a view looks at more than this, and at this as well
				this.controller.refresh('interval').catch(() => ui.log('chatgpt-web panel: the look at the engine failed'));
			}
		}, PROBE_INTERVAL_MS, timers);
		this.subscription = controller.onDidChange(() => this.postSoon());
	}

	dispose(): void {
		this.disposed = true;
		this.schedule.dispose();
		this.subscription.dispose();
		this.attached.clear();
	}

	//#region Views

	/** A webview that shows ChatGPT Web. It gets nothing before it said it is ready. */
	attach(surface: Surface, visible: boolean): { onMessage(raw: unknown): void; setVisible(visible: boolean): void; dispose(): void } {
		const entry: Attached = { surface, ready: false, visible, posted: '' };
		this.attached.add(entry);
		this.updateSchedule();
		return {
			onMessage: raw => this.onMessage(entry, raw),
			setVisible: isVisible => {
				entry.visible = isVisible;
				this.updateSchedule();
				if (isVisible) {
					this.post(entry);
				}
			},
			dispose: () => {
				this.attached.delete(entry);
				this.updateSchedule();
			},
		};
	}

	/** A view of ChatGPT Web is on screen: how an operation ended shows there. */
	get isShowing(): boolean {
		return [...this.attached].some(entry => entry.visible && entry.ready);
	}

	/** The window has the focus again: the user may come back from the launcher. */
	windowFocused(): void {
		this.schedule.poke();
	}

	/** Shows the editor panel, on a screen. */
	openPanel(screen?: ScreenId): void {
		this.pendingScreen = screen;
		this.ui.openPanel();
		this.showPendingScreen();
	}

	private updateSchedule(): void {
		this.schedule.setVisible(!this.disposed && [...this.attached].some(entry => entry.visible));
	}

	private showPendingScreen(): void {
		const panel = [...this.attached].find(entry => entry.surface.layout === 'panel' && entry.ready);
		if (panel && this.pendingScreen) {
			panel.surface.post({ type: 'show', screen: this.pendingScreen });
			this.pendingScreen = undefined;
		}
	}

	private onMessage(entry: Attached, raw: unknown): void {
		const message = parseOutbound(raw);
		if (!message || this.disposed) {
			return; // a webview names an operation, and nothing else
		}
		switch (message.type) {
			case 'ready':
				entry.ready = true;
				entry.posted = '';
				this.post(entry);
				this.showPendingScreen();
				this.refresh();
				break;
			case 'refresh': this.refresh(true); break;
			case 'run': this.run(message.id); break;
			case 'cancel': this.controller.cancel(message.ticket); break;
			case 'openPanel': this.openPanel(message.screen); break;
		}
	}

	//#endregion

	//#region Looking

	/** A view opened, or the user asks (`asked`): the runtime is asked as well. How the last operation ended is old news then. */
	refresh(asked = false): Promise<void> {
		if (asked && this.result) {
			this.result = undefined;
			this.postSoon();
		}
		this.opening ??= this.controller.refresh('open').catch(() => this.ui.log('chatgpt-web panel: the look at the engine failed')).finally(() => { this.opening = undefined; });
		return this.opening;
	}

	//#endregion

	//#region Operations

	/**
	 * What every button and every command does. Where the operation asks first, the dialog says the consequence of
	 * the catalogue word for word, and only going ahead in it runs anything. The controller looks again before it
	 * runs, and may find that there is something else to confirm (the launcher closed meanwhile): then that is asked.
	 */
	async run(id: OperationId): Promise<OperationOutcome> {
		if (this.isAsking) {
			return { ticket: 0, operation: id, status: 'refused', message: 'A question is open already: answer it first.', confirmation: undefined, hint: undefined };
		}
		let outcome = await this.controller.request(id).done;
		for (let asked = 0; outcome.status === 'needs-confirmation' && outcome.confirmation && asked < MAX_QUESTIONS; asked++) {
			const confirmation = outcome.confirmation;
			this.isAsking = true;
			let answer: 'go' | 'alternative' | undefined;
			try {
				answer = await this.ui.confirm({ title: `${confirmation.button}?`, detail: confirmation.text, button: confirmation.button, alternative: confirmation.suggestFirst ? `${confirmation.suggestFirst.label} First` : undefined });
			} finally {
				this.isAsking = false;
			}
			if (answer === 'alternative' && confirmation.suggestFirst) {
				const first = await this.run(confirmation.suggestFirst.id);
				if (first.status !== 'ok') {
					return first; // it has its own question and its own result; what was asked for does not run
				}
				outcome = await this.controller.request(id).done; // asked again, now that there is nothing to do first
				continue;
			}
			if (answer !== 'go') {
				outcome = { ...outcome, status: 'cancelled', message: 'Not confirmed: nothing ran.', confirmation: undefined };
				break;
			}
			outcome = await this.controller.request(id, { confirmed: true }).done;
		}
		if (outcome.status === 'needs-confirmation') {
			outcome = { ...outcome, status: 'cancelled', message: 'What there is to confirm kept changing: nothing ran.', confirmation: undefined };
		}
		this.result = { operation: outcome.operation, status: outcome.status, message: outcome.message, hint: outcome.hint };
		this.postSoon();
		return outcome;
	}

	//#endregion

	//#region Showing

	/** Many changes, one message. */
	private postSoon(): void {
		if (this.isPostPending || this.disposed) {
			return;
		}
		this.isPostPending = true;
		Promise.resolve().then(() => {
			this.isPostPending = false;
			for (const entry of this.attached) {
				this.post(entry);
			}
		});
	}

	private post(entry: Attached): void {
		if (!entry.ready || !entry.visible || this.disposed) {
			return;
		}
		const snapshot = this.controller.snapshot;
		// The looks of the timer are not news: only what the user asked for shows as running
		const isQuiet = (operation: string) => operation === 'refresh' && !this.opening;
		const input: PanelInput = { view: snapshot.view, running: snapshot.running && isQuiet(snapshot.running.operation) ? undefined : snapshot.running, queued: snapshot.queued.filter(job => !isQuiet(job.operation)), result: this.result };
		const model = entry.surface.layout === 'panel' ? panelModelOf(input) : compactModelOf(input);
		const serialized = JSON.stringify(model);
		if (serialized !== entry.posted) {
			entry.posted = serialized;
			entry.surface.post({ type: 'state', model });
		}
	}

	//#endregion
}
