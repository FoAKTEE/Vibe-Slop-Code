/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workspacebarpart.css';
import './workspaceBarColors.js';
import { $, addDisposableListener, append, clearNode, DragAndDropObserver, EventType, getWindow, isAncestor, isHTMLElement, trackFocus } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceBarEntry } from '../../../../platform/workspaceBar/common/workspaceBar.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IWorkspaceBarPartService } from '../../../services/workspaceBar/browser/workspaceBarPartService.js';
import { IWorkspaceBarService } from '../../../services/workspaceBar/common/workspaceBarService.js';
import { Part } from '../../part.js';
import { ADD_WORKSPACE_BAR_ENTRY_COMMAND_ID, switchToWorkspaceBarEntry, WORKSPACE_BAR_VISIBLE_SETTING, WorkspaceBarEntryLocalFileContext, WorkspaceBarEntryOpenedContext, WorkspaceBarEntryPinnedContext, WorkspaceBarFocusedContext, WorkspaceBarSupportedContext } from './workspaceBarActions.js';
import { closeWorkspaceBarEntry, getWorkspaceBarRenderKey, IWorkspaceBarTabViewItem, toWorkspaceBarViewItems, WorkspaceBarTabState } from './workspaceBarViewModel.js';

/**
 * A row of tabs below the title bar: the folders and workspaces of the windows
 * of the application, grouped by the host they are on. It reads as a second,
 * higher level tab strip: the tab of the window is the active one and
 * activating another tab presents its window in place of this one.
 */
export class WorkspaceBarPart extends Part implements IWorkspaceBarPartService {

	declare readonly _serviceBrand: undefined;

	static readonly HEIGHT = 32;

	private static readonly OVERFLOW_FADE_WIDTH = 24; // as in the stylesheet

	//#region IView

	readonly minimumWidth: number = 0;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;

	get minimumHeight(): number {
		return this.visible ? WorkspaceBarPart.HEIGHT : 0;
	}

	get maximumHeight(): number {
		return this.visible ? WorkspaceBarPart.HEIGHT : 0;
	}

	private readonly _onDidChangeSize = this._register(new Emitter<{ width: number; height: number } | undefined>());
	override get onDidChange() { return this._onDidChangeSize.event; }

	//#endregion

	private visible: boolean;
	private zenMode = false;

	private tabsContainer: HTMLElement | undefined;
	private renderKey: string | undefined;

	/**
	 * The tabs that are rendered, in the order they show.
	 */
	private readonly renderedTabs: { readonly element: HTMLElement; readonly hostLabel: HTMLElement; readonly selected: boolean }[] = [];
	private readonly renderDisposables = this._register(new DisposableStore());

	private focusedContext: IContextKey<boolean> | undefined;
	private draggedEntry: IWorkspaceBarEntry | undefined;

	constructor(
		@IThemeService themeService: IThemeService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IStorageService storageService: IStorageService,
		@IWorkspaceBarService private readonly workspaceBarService: IWorkspaceBarService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHoverService private readonly hoverService: IHoverService
	) {
		super(Parts.WORKSPACEBAR_PART, { hasTitle: false }, themeService, storageService, layoutService);

		WorkspaceBarSupportedContext.bindTo(this.contextKeyService).set(this.workspaceBarService.supported);

		this.visible = this.shouldBeVisible();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(WORKSPACE_BAR_VISIBLE_SETTING)) {
				this.updateVisibility();
			}
		}));
		this._register(this.layoutService.onDidChangeZenMode(zenMode => {
			this.zenMode = zenMode;
			this.updateVisibility();
		}));
		this._register(this.workspaceBarService.onDidChangeEntries(() => this.render()));
	}

	//#region Visibility

	/**
	 * The workspace bar shows in every main window, also when the window has no
	 * workspace, unless there is no workspace bar at all (web), the user turned
	 * it off or wants to see nothing but the editor (zen mode).
	 */
	private shouldBeVisible(): boolean {
		return this.workspaceBarService.supported && !this.zenMode && this.configurationService.getValue<boolean>(WORKSPACE_BAR_VISIBLE_SETTING) !== false;
	}

	private updateVisibility(): void {
		const visible = this.shouldBeVisible();
		if (visible !== this.visible) {
			this.visible = visible;

			this.layoutService.setPartHidden(!visible, Parts.WORKSPACEBAR_PART);
			this._onDidChangeSize.fire(undefined);
		}
	}

	//#endregion

	//#region Rendering

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;

		const content = append(this.element, $('.workspacebar-content'));

		// Tabs: scroll horizontally when there are more than fit
		const tabsContainer = this.tabsContainer = append(content, $('.workspace-tabs'));
		tabsContainer.setAttribute('role', 'tablist');
		tabsContainer.setAttribute('aria-label', localize('workspaceBar.ariaLabel', "Workspaces"));
		tabsContainer.setAttribute('aria-orientation', 'horizontal');

		this._register(addDisposableListener(tabsContainer, EventType.WHEEL, (e: WheelEvent) => {
			if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
				tabsContainer.scrollLeft += e.deltaY; // a mouse wheel scrolls the tabs
				e.preventDefault();
			}
		}, { passive: false }));
		this._register(addDisposableListener(tabsContainer, EventType.SCROLL, () => this.updateOverflow()));
		this._register(addDisposableListener(tabsContainer, EventType.KEY_DOWN, (e: KeyboardEvent) => this.onKeyDown(new StandardKeyboardEvent(e))));

		// Add
		const addButton = append(append(content, $('.workspace-add-container')), $('a.workspace-add.codicon'));
		addButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.plus));
		addButton.tabIndex = 0;
		addButton.setAttribute('role', 'button');
		addButton.setAttribute('aria-label', localize('workspaceBar.addAriaLabel', "Add Workspace"));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), addButton, localize('workspaceBar.addTooltip', "Add Workspace...")));
		this._register(addDisposableListener(addButton, EventType.CLICK, () => this.commandService.executeCommand(ADD_WORKSPACE_BAR_ENTRY_COMMAND_ID)));
		this._register(addDisposableListener(addButton, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				event.preventDefault();
				this.commandService.executeCommand(ADD_WORKSPACE_BAR_ENTRY_COMMAND_ID);
			}
		}));

		// What remains moves the window
		append(content, $('.workspace-drag-region'));

		// Track focus
		const scopedContextKeyService = this._register(this.contextKeyService.createScoped(this.element));
		this.focusedContext = WorkspaceBarFocusedContext.bindTo(scopedContextKeyService);
		const focusTracker = this._register(trackFocus(this.element));
		this._register(focusTracker.onDidFocus(() => this.focusedContext?.set(true)));
		this._register(focusTracker.onDidBlur(() => this.focusedContext?.set(false)));

		this.render();
		this.workspaceBarService.whenReady.then(() => this.render());

		return this.element;
	}

	private render(): void {
		const tabsContainer = this.tabsContainer;
		if (!tabsContainer) {
			return;
		}

		const entries = this.workspaceBarService.entries;
		const renderKey = getWorkspaceBarRenderKey(entries, this.workspaceBarService.windowId);
		if (renderKey === this.renderKey) {
			return; // entries change more often than what shows
		}
		this.renderKey = renderKey;

		// Keep keyboard focus where it is
		const activeElement = getWindow(tabsContainer).document.activeElement;
		const focusedEntryId = isHTMLElement(activeElement) && isAncestor(activeElement, tabsContainer) ? activeElement.dataset.entryId : undefined;

		this.renderDisposables.clear();
		this.renderedTabs.length = 0;
		clearNode(tabsContainer);

		const hosts = toWorkspaceBarViewItems(entries, this.workspaceBarService.windowId);
		const hasSelectedTab = hosts.some(host => host.tabs.some(tab => tab.selected));

		let isFirstTab = true;
		for (const host of hosts) {
			const hostElement = append(tabsContainer, $('.workspace-host'));
			hostElement.setAttribute('role', 'presentation');
			hostElement.classList.toggle('remote', host.isRemote);

			// Host: part of the label of every tab and as such not announced on its own
			const hostLabel = append(hostElement, $('.workspace-host-label'));
			hostLabel.setAttribute('aria-hidden', 'true');
			const hostChip = append(hostLabel, $('.workspace-host-chip'));
			append(hostChip, $('span.codicon')).classList.add(...ThemeIcon.asClassNameArray(host.icon));
			append(hostChip, $('span.workspace-host-name')).textContent = host.host.label;
			if (host.host.remoteAuthority) {
				this.renderDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), hostLabel, host.host.remoteAuthority));
			}

			for (const tab of host.tabs) {
				const tabElement = this.renderTab(hostElement, tab);
				this.renderedTabs.push({ element: tabElement, hostLabel, selected: tab.selected });

				// Roving tabindex: the tab of the window, or else the first one
				tabElement.tabIndex = tab.selected || (!hasSelectedTab && isFirstTab) ? 0 : -1;
				isFirstTab = false;

				if (tab.entry.id === focusedEntryId) {
					tabElement.tabIndex = 0;
					tabElement.focus();
				}
			}
		}

		this.revealSelectedTab();
		this.updateOverflow();
	}

	private renderTab(container: HTMLElement, tab: IWorkspaceBarTabViewItem): HTMLElement {
		const entry = tab.entry;

		const tabElement = append(container, $('.workspace-tab'));
		tabElement.classList.add(...tab.classes);
		tabElement.dataset.entryId = entry.id;
		tabElement.draggable = true;
		tabElement.setAttribute('role', 'tab');
		tabElement.setAttribute('aria-selected', String(tab.selected));
		tabElement.setAttribute('aria-label', tab.ariaLabel);
		this.renderDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), tabElement, tab.tooltip));

		// Opened in the background: a window that is alive
		if (tab.state === WorkspaceBarTabState.Background) {
			append(tabElement, $('span.workspace-tab-indicator'));
		}

		append(tabElement, $('span.workspace-tab-label')).textContent = entry.label;
		if (entry.description) {
			append(tabElement, $('span.workspace-tab-description')).textContent = entry.description;
		}

		// As with editor tabs: the pin makes room for closing when hovering
		const actions = append(tabElement, $('.workspace-tab-actions'));
		if (entry.pinned) {
			append(actions, $('span.workspace-tab-pin.codicon')).classList.add(...ThemeIcon.asClassNameArray(Codicon.pinned));
		}
		const closeButton = append(actions, $('a.workspace-tab-close.codicon'));
		closeButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		closeButton.setAttribute('role', 'button');
		closeButton.setAttribute('aria-hidden', 'true'); // Delete does the same from the keyboard
		this.renderDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), closeButton, tab.state === WorkspaceBarTabState.Closed ? localize('workspaceBar.removeTooltip', "Remove from Workspace Bar") : localize('workspaceBar.closeTooltip', "Close Window")));

		this.renderDisposables.add(addDisposableListener(closeButton, EventType.CLICK, e => {
			e.stopPropagation();
			this.close(entry);
		}));
		this.renderDisposables.add(addDisposableListener(tabElement, EventType.CLICK, () => switchToWorkspaceBarEntry(this.workspaceBarService, this.notificationService, entry)));
		this.renderDisposables.add(addDisposableListener(tabElement, EventType.MOUSE_DOWN, e => {
			if (e.button === 1) {
				e.preventDefault(); // no scrolling from the middle mouse button
			}
		}));
		this.renderDisposables.add(addDisposableListener(tabElement, EventType.AUXCLICK, e => {
			if (e.button === 1) {
				e.preventDefault();
				this.close(entry);
			}
		}));
		this.renderDisposables.add(addDisposableListener(tabElement, EventType.CONTEXT_MENU, e => {
			e.preventDefault();
			e.stopPropagation();
			this.showContextMenu(entry, new StandardMouseEvent(getWindow(tabElement), e));
		}));

		this.registerDragAndDrop(tabElement, entry);

		return tabElement;
	}

	/**
	 * Tabs reorder by drag and drop among the tabs of their host.
	 */
	private registerDragAndDrop(tabElement: HTMLElement, entry: IWorkspaceBarEntry): void {
		const isDropTarget = () => !!this.draggedEntry && this.draggedEntry.id !== entry.id && this.draggedEntry.host.id === entry.host.id;
		const isDropBefore = (e: DragEvent) => {
			const rect = tabElement.getBoundingClientRect();

			return e.clientX < rect.left + rect.width / 2;
		};
		const clearDropFeedback = () => tabElement.classList.remove('drop-before', 'drop-after');

		this.renderDisposables.add(new DragAndDropObserver(tabElement, {
			onDragStart: e => {
				this.draggedEntry = entry;
				if (e.dataTransfer) {
					e.dataTransfer.effectAllowed = 'move';
					e.dataTransfer.setData('text/plain', entry.label);
				}
			},
			onDragEnd: () => {
				this.draggedEntry = undefined;
				clearDropFeedback();
			},
			onDragOver: e => {
				if (!isDropTarget()) {
					return;
				}

				e.preventDefault();
				if (e.dataTransfer) {
					e.dataTransfer.dropEffect = 'move';
				}

				const before = isDropBefore(e);
				tabElement.classList.toggle('drop-before', before);
				tabElement.classList.toggle('drop-after', !before);
			},
			onDragLeave: () => clearDropFeedback(),
			onDrop: e => {
				clearDropFeedback();

				const draggedEntry = this.draggedEntry;
				this.draggedEntry = undefined;
				if (!draggedEntry || draggedEntry.id === entry.id || draggedEntry.host.id !== entry.host.id) {
					return;
				}

				e.preventDefault();

				// Before this tab, or before the one that follows it: nothing follows the last one of a host
				let beforeId: string | undefined = entry.id;
				if (!isDropBefore(e)) {
					const entries = this.workspaceBarService.entries;
					const next = entries[entries.findIndex(candidate => candidate.id === entry.id) + 1];
					beforeId = next?.host.id === entry.host.id ? next.id : undefined;
				}

				this.workspaceBarService.reorder(draggedEntry.id, beforeId);
			}
		}));
	}

	private revealSelectedTab(): void {
		const tabsContainer = this.tabsContainer;
		const selectedTab = this.renderedTabs.find(tab => tab.selected);
		if (!tabsContainer || !selectedTab) {
			return;
		}

		// Not `scrollIntoView`, that scrolls the workbench as well. The name
		// of the host stays in sight to the left and covers what is below it.
		const tabStart = selectedTab.element.offsetLeft - tabsContainer.offsetLeft - selectedTab.hostLabel.offsetWidth;
		const tabEnd = selectedTab.element.offsetLeft - tabsContainer.offsetLeft + selectedTab.element.offsetWidth;
		if (tabStart < tabsContainer.scrollLeft) {
			tabsContainer.scrollLeft = tabStart;
		} else if (tabEnd > tabsContainer.scrollLeft + tabsContainer.clientWidth - WorkspaceBarPart.OVERFLOW_FADE_WIDTH) {
			tabsContainer.scrollLeft = tabEnd - tabsContainer.clientWidth + WorkspaceBarPart.OVERFLOW_FADE_WIDTH; // clear of where tabs fade out
		}
	}

	/**
	 * Tabs fade out where there are more of them.
	 */
	private updateOverflow(): void {
		const tabsContainer = this.tabsContainer;
		if (tabsContainer) {
			tabsContainer.classList.toggle('overflow-start', tabsContainer.scrollLeft > 0);
			tabsContainer.classList.toggle('overflow-end', Math.ceil(tabsContainer.scrollLeft + tabsContainer.clientWidth) < tabsContainer.scrollWidth);
		}
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);
		super.layoutContents(width, height);

		this.revealSelectedTab();
		this.updateOverflow();
	}

	//#endregion

	//#region Interaction

	private async close(entry: IWorkspaceBarEntry): Promise<void> {
		try {
			if (entry.windowId === undefined) {
				await this.workspaceBarService.remove(entry.id);
			} else {
				await closeWorkspaceBarEntry(this.workspaceBarService, entry);
			}
		} catch (error) {
			this.notificationService.error(error);
		}
	}

	private showContextMenu(entry: IWorkspaceBarEntry, anchor: HTMLElement | StandardMouseEvent): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			menuId: MenuId.WorkspaceBarContext,
			menuActionOptions: { arg: entry, shouldForwardArgs: true },
			contextKeyService: this.contextKeyService.createOverlay([
				[WorkspaceBarEntryPinnedContext.key, entry.pinned],
				[WorkspaceBarEntryOpenedContext.key, entry.windowId !== undefined],
				[WorkspaceBarEntryLocalFileContext.key, entry.host.isLocal && entry.uri.scheme === Schemas.file]
			])
		});
	}

	private onKeyDown(event: StandardKeyboardEvent): void {
		const target = event.target;
		const tabs = this.renderedTabs.map(tab => tab.element);
		const index = isHTMLElement(target) ? tabs.indexOf(target) : -1;
		if (!isHTMLElement(target) || index < 0) {
			return;
		}

		const entry = this.workspaceBarService.entries.find(candidate => candidate.id === target.dataset.entryId);

		let handled = true;
		if (event.equals(KeyCode.RightArrow)) {
			this.focusTab(tabs, (index + 1) % tabs.length);
		} else if (event.equals(KeyCode.LeftArrow)) {
			this.focusTab(tabs, (index - 1 + tabs.length) % tabs.length);
		} else if (event.equals(KeyCode.Home)) {
			this.focusTab(tabs, 0);
		} else if (event.equals(KeyCode.End)) {
			this.focusTab(tabs, tabs.length - 1);
		} else if (entry && (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space))) {
			switchToWorkspaceBarEntry(this.workspaceBarService, this.notificationService, entry);
		} else if (entry && (event.equals(KeyCode.Delete) || event.equals(KeyMod.CtrlCmd | KeyCode.Backspace))) {
			this.close(entry);
		} else if (entry && (event.equals(KeyMod.Shift | KeyCode.F10) || event.equals(KeyCode.ContextMenu))) {
			this.showContextMenu(entry, target);
		} else {
			handled = false;
		}

		if (handled) {
			event.preventDefault();
			event.stopPropagation();
		}
	}

	private focusTab(tabs: HTMLElement[], index: number): void {
		tabs.forEach((tab, tabIndex) => tab.tabIndex = tabIndex === index ? 0 : -1);
		tabs[index]?.focus();
	}

	focus(): void {
		if (this.visible) {
			(this.renderedTabs.find(tab => tab.element.tabIndex === 0) ?? this.renderedTabs.at(0))?.element.focus();
		}
	}

	//#endregion

	toJSON(): object {
		return {
			type: Parts.WORKSPACEBAR_PART
		};
	}
}

registerSingleton(IWorkspaceBarPartService, WorkspaceBarPart, InstantiationType.Eager);

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.focusWorkspaceBar',
			title: localize2('focusWorkspaceBar', "Focus Workspace Bar"),
			category: Categories.View,
			f1: true,
			precondition: WorkspaceBarSupportedContext
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IWorkspaceBarPartService).focus();
	}
});
