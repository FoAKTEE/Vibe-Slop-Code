// SPDX-License-Identifier: MIT

// ChatGPT Web, drawn: the editor panel (a rail of screens and the items of one of them) and the compact view below
// Sessions. The view owns no state besides which screen shows: the host sends everything, the view names the
// operation the user clicked. Every operation that is no probe says what it does BESIDE its button, not in a
// tooltip, and a hand-off says where in the launcher its step is and why it is there. Nothing in here writes a style
// attribute: the page runs under a strict content security policy.
import type { BusyView, CompactModel, ItemView, LauncherInbound, LauncherOutbound, Layout, OperationView, PanelModel, ScreenView } from '../model/launcher/panel.ts';
import { isScreenId, type ScreenId } from '../model/launcher/screens.ts';
import { el, setAttribute, setText } from './dom.ts';
import { panelGlyph, severityGlyph, stepGlyph } from './glyphs.ts';

export interface LauncherViewHost {
	onData(callback: (message: LauncherInbound) => void): void;
	post(message: LauncherOutbound): void;
	getState(): { screen?: unknown };
	setState(state: { screen: ScreenId }): void;
}

export function mountLauncher(root: HTMLElement, layout: Layout, host: LauncherViewHost): void {
	new LauncherView(root, layout, host);
}

class LauncherView {

	private readonly host: LauncherViewHost;
	private readonly layout: Layout;
	private readonly headline: HTMLElement;
	private readonly headGlyph: HTMLElement;
	private readonly busy: HTMLElement;
	private readonly result: HTMLElement;
	private readonly rail: HTMLElement;
	private readonly body: HTMLElement;

	private screen: ScreenId;
	private model: PanelModel | CompactModel | undefined;
	private readonly keys = new Map<HTMLElement, string>();

	constructor(root: HTMLElement, layout: Layout, host: LauncherViewHost) {
		this.host = host;
		this.layout = layout;
		const restored = host.getState().screen;
		this.screen = isScreenId(restored) ? restored : 'overview';

		this.headGlyph = el('span', 'cw-head-glyph');
		this.headline = el(layout === 'panel' ? 'h1' : 'span', 'cw-headline');
		this.busy = el('span', 'cw-busy');
		this.busy.hidden = true;
		const refresh = el('button', 'va-action', panelGlyph('refresh'));
		refresh.type = 'button';
		refresh.title = 'Refresh';
		refresh.setAttribute('aria-label', 'Refresh: look at the engine again');
		refresh.addEventListener('click', () => host.post({ type: 'refresh' }));
		const head = el('header', 'cw-head', this.headGlyph, this.headline, this.busy, refresh);

		// One quiet line for how the last operation ended, read out as it changes
		this.result = el('div', 'cw-result');
		this.result.setAttribute('role', 'status');
		this.result.setAttribute('aria-live', 'polite');
		this.result.hidden = true;

		this.rail = el('nav', 'cw-rail');
		this.rail.setAttribute('role', 'tablist');
		this.rail.setAttribute('aria-label', 'ChatGPT Web');
		this.rail.addEventListener('keydown', event => this.onRailKeyDown(event));
		this.rail.hidden = layout !== 'panel';

		this.body = el(layout === 'panel' ? 'main' : 'div', 'cw-screen');
		if (layout === 'panel') {
			this.body.id = 'cw-screen';
			this.body.setAttribute('role', 'tabpanel');
		}

		root.classList.add('cw', `cw-${layout}`);
		root.append(head, this.result, el('div', 'cw-body', this.rail, this.body));

		host.onData(message => {
			if (message.type === 'state') {
				this.model = message.model;
				this.render();
			} else if (message.type === 'show' && isScreenId(message.screen)) {
				this.select(message.screen, false);
			}
		});
		host.post({ type: 'ready' });
	}

	//#region Rendering

	/** Draws a part again only when what it shows changed, and gives the focus back to what had it. */
	private draw(container: HTMLElement, key: string, build: () => Node[]): void {
		if (this.keys.get(container) === key) {
			return;
		}
		this.keys.set(container, key);
		const focused = document.activeElement instanceof HTMLElement && container.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
		container.replaceChildren(...build());
		if (focused !== undefined) {
			[...container.querySelectorAll<HTMLElement>('[data-key]')].find(candidate => candidate.dataset.key === focused)?.focus();
		}
	}

	private render(): void {
		const model = this.model;
		if (!model) {
			return;
		}
		this.draw(this.headGlyph, model.severity, () => [severityGlyph(model.severity)]);
		setText(this.headline, model.headline);
		this.headline.className = `cw-headline cw-severity-${model.severity}`;
		this.draw(this.busy, JSON.stringify(model.busy ?? null), () => model.busy ? this.busyNodes(model.busy) : []);
		this.busy.hidden = !model.busy;
		setText(this.result, model.result?.text ?? '');
		this.result.className = `cw-result cw-result-${model.result?.status ?? 'none'}`;
		this.result.hidden = !model.result;

		if (model.layout === 'panel') {
			const screen = model.screens.find(candidate => candidate.id === this.screen) ?? model.screens[0];
			this.draw(this.rail, JSON.stringify([model.rail, screen.id]), () => model.rail.map(entry => {
				const count = entry.count === undefined ? undefined : el('span', 'cw-tab-count', entry.count);
				const tab = el('button', `cw-tab cw-severity-${entry.severity}`, el('span', 'cw-tab-mark'), el('span', 'cw-tab-title', entry.title), count);
				tab.type = 'button';
				tab.id = `cw-tab-${entry.id}`;
				tab.dataset.key = `tab:${entry.id}`;
				tab.dataset.screen = entry.id;
				tab.tabIndex = entry.id === screen.id ? 0 : -1;
				tab.setAttribute('role', 'tab');
				tab.setAttribute('aria-selected', String(entry.id === screen.id));
				tab.setAttribute('aria-controls', 'cw-screen');
				setAttribute(tab, 'aria-label', [entry.title, entry.count, entry.severity === 'warning' ? 'needs attention' : entry.severity === 'error' ? 'something failed' : undefined].filter(Boolean).join(', '));
				tab.addEventListener('click', () => this.select(entry.id, false));
				return tab;
			}));
			this.body.setAttribute('aria-labelledby', `cw-tab-${screen.id}`);
			this.draw(this.body, JSON.stringify(screen), () => this.screenNodes(screen));
		} else {
			this.draw(this.body, JSON.stringify([model.attention, model.nextStep, model.bridge, model.engine]), () => this.compactNodes(model));
		}
	}

	private busyNodes(busy: BusyView): Node[] {
		const text = el('span', 'cw-busy-text', `${busy.label}...${busy.queued > 0 ? ` (${busy.queued} waiting)` : ''}`);
		if (busy.cancelTicket === undefined) {
			return [panelGlyph('working'), text];
		}
		const ticket = busy.cancelTicket;
		const cancel = el('button', 'va-link', 'Cancel');
		cancel.type = 'button';
		cancel.dataset.key = 'busy:cancel';
		cancel.setAttribute('aria-label', `Cancel: ${busy.label}`);
		cancel.addEventListener('click', () => this.host.post({ type: 'cancel', ticket }));
		return [panelGlyph('working'), text, cancel];
	}

	private screenNodes(screen: ScreenView): Node[] {
		const list = el('ul', 'cw-items', ...screen.items.map(item => this.itemNode(item, screen.id)));
		list.setAttribute('aria-label', screen.title);
		return [el('h2', 'cw-screen-title', screen.title), el('p', 'cw-screen-summary', screen.summary), list];
	}

	private compactNodes(model: CompactModel): Node[] {
		const items: (ItemView | undefined)[] = [model.attention, model.nextStep && { ...model.nextStep, label: `Next: ${model.nextStep.label}` }, model.bridge, model.engine];
		const list = el('ul', 'cw-items', ...items.filter(item => item !== undefined).map(item => this.itemNode(item, 'compact')));
		const open = el('button', 'va-link cw-open-panel', 'Open Full Panel');
		open.type = 'button';
		open.dataset.key = 'open-panel';
		open.addEventListener('click', () => this.host.post({ type: 'openPanel', screen: model.nextStep ? 'setup' : undefined }));
		return [list, el('div', 'cw-foot', open)];
	}

	private itemNode(item: ItemView, scope: string): HTMLElement {
		// A shape where there is something to tell: a step, the state, or an item that is not simply a fact
		const glyph = item.step ? stepGlyph(item.step) : item.severity !== 'off' || item.id === 'state' ? severityGlyph(item.severity) : el('span', 'cw-item-mark');
		const time = item.at === undefined ? undefined : el('time', 'cw-item-time', new Date(item.at).toLocaleTimeString());
		const className = `cw-item cw-severity-${item.severity}${item.next ? ' cw-next' : ''}${item.step ? ` cw-item-${item.step}` : ''}`;
		const detail = item.detail ? el('p', 'cw-item-detail', item.detail) : undefined;

		// A fact: nothing to do on it. Its name and what is known stand in one line, as in a table
		if (item.operations.length === 0 && item.step === undefined && this.layout === 'panel') {
			return el('li', `${className} cw-item-fact`, glyph, el('span', 'cw-item-label', item.label), el('div', 'cw-fact', el('div', 'cw-item-text', item.text), detail), time);
		}

		// A step that is done is one line as well: its shape says it is done, and what it found stands beside its name
		const isDone = item.step === 'done';
		const step = item.step === undefined || isDone ? undefined : el('span', `cw-step cw-step-${item.step}`, item.step === 'handoff' ? 'in the launcher' : item.step === 'todo' ? 'to do' : 'not known');
		const head = el('div', 'cw-item-head', glyph, el('span', 'cw-item-label', item.label), isDone && item.text ? el('span', 'cw-item-inline', item.text) : undefined, step, time);
		return el('li', className,
			head,
			item.text && !isDone ? el('div', 'cw-item-text', item.text) : undefined,
			detail,
			item.operations.length > 0 ? el('div', 'cw-ops', ...item.operations.map(operation => this.operationNode(operation, `${scope}/${item.id}`))) : undefined);
	}

	/** A button, and BESIDE it what it does: the consequence, or why it cannot run now; for a hand-off also where and why. */
	private operationNode(operation: OperationView, scope: string): HTMLElement {
		const asks = operation.confirm ? '...' : '';
		const button = el('button', `va-button ${operation.primary ? 'va-button-primary' : 'va-button-secondary'} cw-op-button`, operation.busy === 'running' ? panelGlyph('working') : undefined, `${operation.label}${asks}`);
		button.type = 'button';
		button.dataset.key = `op:${scope}/${operation.id}`;
		button.disabled = !operation.enabled || operation.busy !== undefined;
		button.addEventListener('click', () => this.host.post({ type: 'run', id: operation.id }));

		const said: Node[] = [];
		if (operation.busy !== undefined) {
			said.push(el('p', 'cw-op-state', operation.busy === 'running' ? 'Running.' : 'Waiting for what runs now.'));
			if (operation.cancelTicket !== undefined) {
				const ticket = operation.cancelTicket;
				const cancel = el('button', 'va-link', 'Cancel');
				cancel.type = 'button';
				cancel.dataset.key = `cancel:${scope}/${operation.id}`;
				cancel.setAttribute('aria-label', `Cancel: ${operation.label}`);
				cancel.addEventListener('click', () => this.host.post({ type: 'cancel', ticket }));
				said.push(cancel);
			}
		}
		if (!operation.enabled && operation.disabledReason) {
			said.push(el('p', 'cw-op-reason', operation.disabledReason));
		}
		if (operation.hint) {
			said.push(el('p', 'cw-op-hint', el('span', 'cw-op-arrow', '\u2192 '), operation.hint));
		}
		if (operation.consequence) {
			said.push(el('p', 'cw-op-consequence', operation.consequence));
		}
		if (operation.why) {
			said.push(el('p', 'cw-op-why', operation.why));
		}
		const text = el('div', 'cw-op-text', ...said);
		if (said.length > 0) {
			text.id = `cw-said-${scope.replace(/[^A-Za-z0-9]/g, '-')}-${operation.id.replace(/[^A-Za-z0-9]/g, '-')}`;
			button.setAttribute('aria-describedby', text.id);
		}
		return el('div', `cw-op cw-op-${operation.kind}`, button, text);
	}

	//#endregion

	//#region The rail

	private select(screen: ScreenId, focus: boolean): void {
		if (this.layout !== 'panel') {
			return;
		}
		this.screen = screen;
		this.host.setState({ screen });
		this.render();
		this.body.scrollTop = 0;
		if (focus) {
			this.rail.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
		}
	}

	/** A tab list: one tab stop, the arrow keys move, and what they move to shows. Both pairs of arrows: the rail lies down when the panel is narrow. */
	private onRailKeyDown(event: KeyboardEvent): void {
		const tabs = [...this.rail.querySelectorAll<HTMLElement>('[role="tab"]')];
		const index = tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true');
		let next: number;
		switch (event.key) {
			case 'ArrowDown':
			case 'ArrowRight': next = (index + 1) % tabs.length; break;
			case 'ArrowUp':
			case 'ArrowLeft': next = (index - 1 + tabs.length) % tabs.length; break;
			case 'Home': next = 0; break;
			case 'End': next = tabs.length - 1; break;
			default: return;
		}
		event.preventDefault();
		const screen = tabs[next]?.dataset.screen;
		if (isScreenId(screen)) {
			this.select(screen, true);
		}
	}

	//#endregion
}
