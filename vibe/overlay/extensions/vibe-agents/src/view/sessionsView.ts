// SPDX-License-Identifier: MIT

// The Sessions view: a toolbar and one card per agent session. The view owns no state besides what is on
// screen: the host sends everything, the view sends what the user asks for. Nothing in here writes a style
// attribute, the page runs under a strict content security policy.
import type { StatusRow } from '../model/profiles.ts';
import type { HostInbound, HostOutbound, ProfileItem, SessionAction, SessionItem } from '../protocol.ts';
import { cardModelOf, glyphNameOf, timeTextOf, type CardModel } from './cardModel.ts';
import { el, setAttribute, setText } from './dom.ts';
import { actionGlyph, profileGlyph, stateGlyph, toolbarGlyph } from './glyphs.ts';

export interface ViewHost {
	onData(callback: (message: HostInbound) => void): void;
	post(message: HostOutbound): void;
}

const ACTION_LABEL: Record<SessionAction, string> = {
	focus: 'Focus Terminal',
	stop: 'Stop (Ctrl+C)',
	restart: 'Restart',
	dismiss: 'Dismiss',
};

interface Card {
	readonly root: HTMLElement;
	readonly glyph: HTMLElement;
	readonly label: HTMLElement;
	readonly pill: HTMLElement;
	readonly pillIcon: HTMLElement;
	readonly pillText: HTMLElement;
	readonly detail: HTMLElement;
	readonly time: HTMLElement;
	readonly line: HTMLElement;
	readonly actions: HTMLElement;
	item: SessionItem;
	actionsKey: string;
	glyphKey: string;
	stateKey: string;
}

export function mount(root: HTMLElement, host: ViewHost): void {
	new SessionsView(root, host);
}

class SessionsView {

	private readonly host: ViewHost;
	private readonly toolbar: HTMLElement;
	private readonly newButton: HTMLButtonElement;
	private readonly clearButton: HTMLButtonElement;
	private readonly summary: HTMLElement;
	private readonly menu: HTMLElement;
	private readonly list: HTMLElement;
	private readonly rows: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly emptyActions: HTMLElement;
	private readonly live: HTMLElement;

	private readonly cards = new Map<string, Card>();
	private profiles: ProfileItem[] = [];
	private profilesKey = '';
	private rowsKey = '';
	/** The card that holds the roving tab stop. */
	private currentId: string | undefined = undefined;
	/** What the clock of the host is ahead of the one of this page. */
	private clockOffset = 0;

	constructor(root: HTMLElement, host: ViewHost) {
		this.host = host;

		// Toolbar
		this.newButton = el('button', 'va-button va-button-new', toolbarGlyph('add'), el('span', 'va-button-label', 'New Agent'), toolbarGlyph('chevron'));
		this.newButton.type = 'button';
		this.newButton.setAttribute('aria-haspopup', 'menu');
		this.newButton.setAttribute('aria-expanded', 'false');
		const adoptButton = this.iconButton('adopt', 'Adopt Terminal...', () => this.host.post({ type: 'adopt' }));
		this.clearButton = this.iconButton('clear', 'Clear Finished', () => this.host.post({ type: 'clear' }));
		this.summary = el('span', 'va-summary');
		this.toolbar = el('div', 'va-toolbar', this.newButton, this.summary, adoptButton, this.clearButton);
		this.toolbar.setAttribute('role', 'toolbar');
		this.toolbar.setAttribute('aria-label', 'Agent sessions');

		this.menu = el('div', 'va-menu');
		this.menu.setAttribute('role', 'menu');
		this.menu.setAttribute('aria-label', 'New Agent');
		this.menu.hidden = true;

		// Sessions
		this.list = el('div', 'va-list');
		this.list.setAttribute('role', 'list');
		this.list.setAttribute('aria-label', 'Agent sessions');

		this.rows = el('div', 'va-rows');

		this.emptyActions = el('div', 'va-empty-actions');
		this.empty = el('div', 'va-empty',
			el('p', 'va-empty-title', 'No agent sessions'),
			el('p', 'va-empty-text', 'Agents run in the integrated terminal. Start one here, or type its command in any terminal: it is listed as soon as it runs.'),
			this.emptyActions);
		this.empty.hidden = true;

		this.live = el('div', 'va-live');
		this.live.setAttribute('aria-live', 'polite');
		this.live.setAttribute('role', 'status');

		root.append(this.toolbar, this.menu, this.list, this.empty, this.rows, this.live);

		this.newButton.addEventListener('click', () => this.toggleMenu());
		this.newButton.addEventListener('keydown', event => {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				this.toggleMenu(true);
			}
		});
		this.menu.addEventListener('keydown', event => this.onMenuKeyDown(event));
		document.addEventListener('mousedown', event => {
			if (!this.menu.hidden && event.target instanceof Node && !this.menu.contains(event.target) && !this.newButton.contains(event.target)) {
				this.toggleMenu(false);
			}
		});
		window.addEventListener('blur', () => this.toggleMenu(false));
		this.list.addEventListener('keydown', event => this.onListKeyDown(event));

		setInterval(() => this.tick(), 1000);

		host.onData(message => {
			if (message.type === 'state') {
				this.render(message);
			}
		});
		host.post({ type: 'ready' });
	}

	private now(): number {
		return Date.now() + this.clockOffset;
	}

	//#region Rendering

	private render(message: Extract<HostInbound, { type: 'state' }>): void {
		this.clockOffset = message.now - Date.now();
		const now = message.now;

		this.renderProfiles(message.profiles);
		setText(this.summary, message.sessions.length > 0 ? message.summary : '');
		setAttribute(this.summary, 'title', message.sessions.length > 0 ? message.summary : undefined);
		this.clearButton.disabled = !message.sessions.some(item => item.session.state === 'finished' || item.session.state === 'failed' || item.session.state === 'closed');

		// Cards: keyed by session, so that focus and hover survive an update
		const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('.va-card')?.dataset.id : undefined;
		const focusedAction = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.action : undefined;
		const ids = new Set(message.sessions.map(item => item.session.id));
		for (const [id, card] of this.cards) {
			if (!ids.has(id)) {
				card.root.remove();
				this.cards.delete(id);
			}
		}

		let previous: Element | null = null;
		for (const item of message.sessions) {
			let card = this.cards.get(item.session.id);
			if (!card) {
				card = this.createCard(item);
				this.cards.set(item.session.id, card);
			}
			this.updateCard(card, item, now);

			const expectedNext: Element | null = previous ? previous.nextElementSibling : this.list.firstElementChild;
			if (expectedNext !== card.root) {
				this.list.insertBefore(card.root, expectedNext);
			}
			previous = card.root;
		}

		// Roving tab stop: stays where it was, or goes to the first card
		if (this.currentId === undefined || !this.cards.has(this.currentId)) {
			this.currentId = message.sessions[0]?.session.id;
		}
		this.updateTabStops();
		if (focusedId !== undefined) {
			const card = this.cards.get(focusedId) ?? (this.currentId !== undefined ? this.cards.get(this.currentId) : undefined);
			if (card && !card.root.contains(document.activeElement)) {
				(card.actions.querySelector<HTMLElement>(`[data-action="${focusedAction}"]`) ?? card.root).focus();
			}
		}

		this.list.hidden = message.sessions.length === 0;
		this.empty.hidden = message.sessions.length > 0;
		this.renderRows(message.rows);

		if (message.announcement) {
			this.live.textContent = message.announcement;
		}
	}

	private renderProfiles(profiles: ProfileItem[]): void {
		const key = JSON.stringify(profiles);
		if (key === this.profilesKey) {
			return;
		}
		this.profilesKey = key;
		this.profiles = profiles;

		this.menu.replaceChildren(...profiles.map(profile => {
			const item = el('button', 'va-menu-item', profileGlyph(glyphNameOf(profile.icon)), el('span', undefined, profile.label));
			item.type = 'button';
			item.tabIndex = -1;
			item.setAttribute('role', 'menuitem');
			item.addEventListener('click', () => {
				this.toggleMenu(false);
				this.host.post({ type: 'start', profileId: profile.id });
			});
			return item;
		}));

		// The empty state offers the first two profiles with one click
		this.emptyActions.replaceChildren(...profiles.slice(0, 2).map((profile, index) => {
			const button = el('button', index === 0 ? 'va-button va-button-primary' : 'va-button va-button-secondary', `Start ${profile.label}`);
			button.type = 'button';
			button.addEventListener('click', () => this.host.post({ type: 'start', profileId: profile.id }));
			return button;
		}));
	}

	private renderRows(rows: StatusRow[]): void {
		const key = JSON.stringify(rows);
		if (key === this.rowsKey) {
			return;
		}
		this.rowsKey = key;
		this.rows.hidden = rows.length === 0;
		this.rows.replaceChildren(...rows.map(row => {
			const element = el('div', `va-row va-row-${row.state}`, el('span', 'va-row-dot'), el('span', 'va-row-label', row.label), row.detail ? el('span', 'va-row-detail', row.detail) : undefined);
			if (row.action) {
				const button = el('button', 'va-link', row.action.label);
				button.type = 'button';
				button.addEventListener('click', () => this.host.post({ type: 'row', id: row.id }));
				element.append(button);
			}
			return element;
		}));
	}

	private createCard(item: SessionItem): Card {
		const glyph = el('span', 'va-card-glyph');
		const label = el('span', 'va-card-label');
		const pillIcon = el('span', 'va-pill-icon');
		const pillText = el('span', 'va-pill-text');
		const pill = el('span', 'va-pill', pillIcon, pillText);
		const detail = el('span', 'va-card-detail');
		const time = el('span', 'va-card-time');
		const line = el('div', 'va-card-line');
		const actions = el('div', 'va-card-actions');
		actions.setAttribute('role', 'group');
		actions.setAttribute('aria-label', 'Actions');

		const root = el('div', 'va-card',
			el('div', 'va-card-head', glyph, label, pill),
			el('div', 'va-card-meta', detail, time, actions),
			line);
		root.dataset.id = item.session.id;
		root.tabIndex = -1;
		root.setAttribute('role', 'listitem');

		root.addEventListener('focusin', () => {
			if (this.currentId !== item.session.id) {
				this.currentId = item.session.id;
				this.updateTabStops();
			}
		});
		// As in every list of the workbench: a click opens what the row stands for
		root.addEventListener('click', event => {
			if (!(event.target instanceof Element && event.target.closest('button')) && !this.cards.get(item.session.id)?.item.session.terminalGone) {
				this.act('focus', item.session.id);
			}
		});

		return { root, glyph, label, pill, pillIcon, pillText, detail, time, line, actions, item, actionsKey: '', glyphKey: '', stateKey: '' };
	}

	private updateCard(card: Card, item: SessionItem, now: number): void {
		card.item = item;
		const model = cardModelOf(item, now);

		card.root.className = `va-card va-state-${model.state}${model.attention ? ' va-attention' : ''}`;
		setAttribute(card.root, 'aria-label', model.ariaLabel);

		if (card.glyphKey !== model.glyph) {
			card.glyphKey = model.glyph;
			card.glyph.replaceChildren(profileGlyph(model.glyph));
		}
		if (card.stateKey !== model.state) {
			card.stateKey = model.state;
			card.pillIcon.replaceChildren(stateGlyph(model.state));
		}

		setText(card.label, model.label);
		setText(card.pillText, model.pill);
		setText(card.detail, model.detail);
		setAttribute(card.detail, 'title', model.detailTooltip);
		setText(card.time, model.time);
		setAttribute(card.time, 'title', model.timeTooltip);
		setAttribute(card.pill, 'title', model.timeTooltip);
		setText(card.line, model.lastLine ?? '');
		setAttribute(card.line, 'title', model.lastLine);
		card.line.hidden = !model.lastLine;

		this.updateActions(card, model);
	}

	private updateActions(card: Card, model: CardModel): void {
		const key = `${model.actions.join(',')}:${model.stopArmed}`;
		if (key === card.actionsKey) {
			return;
		}
		card.actionsKey = key;

		card.actions.replaceChildren(...model.actions.map(action => {
			const isKill = action === 'stop' && model.stopArmed;
			const title = isKill ? 'Close Terminal' : ACTION_LABEL[action];
			const button = el('button', `va-action${isKill ? ' va-action-armed' : ''}`, actionGlyph(isKill ? 'kill' : action));
			button.type = 'button';
			button.title = title;
			button.dataset.action = action;
			button.setAttribute('aria-label', title);
			button.addEventListener('click', event => {
				event.stopPropagation();
				this.act(action, model.id);
			});
			return button;
		}));
		this.updateTabStops();
	}

	/** One card is reachable by Tab, and so are its actions; the arrow keys move between cards. */
	private updateTabStops(): void {
		for (const [id, card] of this.cards) {
			const isCurrent = id === this.currentId;
			card.root.tabIndex = isCurrent ? 0 : -1;
			for (const button of card.actions.querySelectorAll('button')) {
				button.tabIndex = isCurrent ? 0 : -1;
			}
		}
	}

	private tick(): void {
		const now = this.now();
		for (const card of this.cards.values()) {
			setText(card.time, timeTextOf(card.item.session, now));
		}
	}

	//#endregion

	//#region Interaction

	private act(action: SessionAction, id: string): void {
		this.host.post({ type: 'session', action, id });
	}

	private iconButton(glyph: 'adopt' | 'clear', title: string, run: () => void): HTMLButtonElement {
		const button = el('button', 'va-action', toolbarGlyph(glyph));
		button.type = 'button';
		button.title = title;
		button.setAttribute('aria-label', title);
		button.addEventListener('click', run);
		return button;
	}

	private toggleMenu(open = this.menu.hidden): void {
		if (open && this.profiles.length === 1) {
			this.host.post({ type: 'start', profileId: this.profiles[0].id }); // nothing to choose from
			return;
		}
		const wasOpen = !this.menu.hidden;
		this.menu.hidden = !open;
		this.newButton.setAttribute('aria-expanded', String(open));
		if (open) {
			this.menu.querySelector<HTMLElement>('.va-menu-item')?.focus();
		} else if (wasOpen && this.menu.contains(document.activeElement)) {
			this.newButton.focus();
		}
	}

	private onMenuKeyDown(event: KeyboardEvent): void {
		const items = [...this.menu.querySelectorAll<HTMLElement>('.va-menu-item')];
		const index = items.indexOf(document.activeElement as HTMLElement);
		switch (event.key) {
			case 'ArrowDown': items[(index + 1) % items.length]?.focus(); break;
			case 'ArrowUp': items[(index - 1 + items.length) % items.length]?.focus(); break;
			case 'Home': items[0]?.focus(); break;
			case 'End': items[items.length - 1]?.focus(); break;
			case 'Escape':
			case 'Tab': this.toggleMenu(false); break;
			default: return;
		}
		event.preventDefault();
	}

	private onListKeyDown(event: KeyboardEvent): void {
		const target = event.target instanceof HTMLElement ? event.target : undefined;
		const root = target?.closest<HTMLElement>('.va-card');
		const id = root?.dataset.id;
		if (!target || !root || id === undefined) {
			return;
		}

		const cards = [...this.list.querySelectorAll<HTMLElement>('.va-card')];
		const index = cards.indexOf(root);
		const isCard = target === root;
		switch (event.key) {
			case 'ArrowDown': cards[Math.min(index + 1, cards.length - 1)]?.focus(); break;
			case 'ArrowUp': cards[Math.max(index - 1, 0)]?.focus(); break;
			case 'Home': cards[0]?.focus(); break;
			case 'End': cards[cards.length - 1]?.focus(); break;
			case 'ArrowRight':
			case 'ArrowLeft': {
				const stops = [root, ...root.querySelectorAll<HTMLElement>('.va-card-actions button')];
				const next = stops[stops.indexOf(target) + (event.key === 'ArrowRight' ? 1 : -1)];
				next?.focus();
				break;
			}
			case 'Enter':
				if (!isCard) {
					return; // the button does what it does
				}
				if (!this.cards.get(id)?.item.session.terminalGone) {
					this.act('focus', id);
				}
				break;
			case 'Delete':
			case 'Backspace': {
				const neighbour = cards[index + 1] ?? cards[index - 1];
				this.act('dismiss', id);
				neighbour?.focus();
				break;
			}
			default: return;
		}
		event.preventDefault();
	}

	//#endregion
}
