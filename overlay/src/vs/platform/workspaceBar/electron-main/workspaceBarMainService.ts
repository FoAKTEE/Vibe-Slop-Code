/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, Rectangle } from 'electron';
import { RunOnceScheduler, timeout } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { IAuxiliaryWindowsMainService } from '../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILifecycleMainService, LifecycleMainPhase } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IStateService } from '../../state/node/state.js';
import { ICodeWindow } from '../../window/electron-main/window.js';
import { IWindowsMainService, OpenContext } from '../../windows/electron-main/windows.js';
import { IWorkspaceBarEntry, IWorkspaceBarMainService, IWorkspaceBarWindowStatus, sanitizeWorkspaceBarWindowStatus } from '../common/workspaceBar.js';
import { WorkspaceBarModel } from '../common/workspaceBarModel.js';

/**
 * Where the one frame that all windows share is on screen.
 */
interface IFrame {
	readonly bounds: Rectangle;
	readonly normalBounds: Rectangle;
	readonly maximized: boolean;
}

interface ISingleFrameWindowSettings {
	readonly singleFrame?: boolean;
	readonly nativeTabs?: boolean;
}

/**
 * Keeps the entries of the workspace bar and presents the windows of the
 * application in a single frame: exactly one window is visible, all others
 * are hidden, and presenting another window means to show it at the very
 * place of the window that was presented before. Windows that are hidden
 * keep running, including their extension host and remote connection.
 *
 * Every window remains an ordinary window. When `window.singleFrame` is
 * disabled nothing gets hidden and switching is focusing.
 */
export class WorkspaceBarMainService extends Disposable implements IWorkspaceBarMainService {

	declare readonly _serviceBrand: undefined;

	private static readonly STATE_KEY = 'workspaceBar.state';

	private static readonly ENTRIES_CHANGE_DELAY = 50;
	private static readonly FRAME_SYNC_DELAY = 300;
	private static readonly WINDOW_READY_TIMEOUT = 7000;
	private static readonly LEAVE_FULLSCREEN_TIMEOUT = 3000;

	private readonly _onDidChangeEntries = this._register(new Emitter<readonly IWorkspaceBarEntry[]>());
	readonly onDidChangeEntries = this._onDidChangeEntries.event;

	private readonly model: WorkspaceBarModel;
	private persistedState: string;
	private lastActiveTime = 0;

	private singleFrame: boolean;
	private frame: IFrame | undefined = undefined;
	private presentedWindowId: number | undefined = undefined;

	private readonly windowListeners = this._register(new DisposableMap<number>());
	private readonly windowsHiddenUntilReady = this._register(new DisposableMap<number>());
	private readonly hiddenAuxiliaryWindows = new Map<number /* parent window */, number[]>();

	private readonly entriesChangeScheduler = this._register(new RunOnceScheduler(() => this._onDidChangeEntries.fire(this.model.getEntries()), WorkspaceBarMainService.ENTRIES_CHANGE_DELAY));
	private readonly frameSyncScheduler = this._register(new RunOnceScheduler(() => this.syncFrameToHiddenWindows(), WorkspaceBarMainService.FRAME_SYNC_DELAY));

	constructor(
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IAuxiliaryWindowsMainService private readonly auxiliaryWindowsMainService: IAuxiliaryWindowsMainService,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@IStateService private readonly stateService: IStateService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this.model = new WorkspaceBarModel(this.stateService.getItem(WorkspaceBarMainService.STATE_KEY));
		this.persistedState = JSON.stringify(this.model.serialize());
		this.singleFrame = this.isSingleFrameConfigured();

		for (const window of this.windowsMainService.getWindows()) {
			this.trackWindow(window);
		}
		this.updateEntries();

		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.windowsMainService.onDidOpenWindow(window => this.onDidOpenWindow(window)));
		this._register(this.windowsMainService.onDidSignalReadyWindow(window => this.onDidSignalReadyWindow(window)));
		this._register(this.windowsMainService.onDidDestroyWindow(window => this.onDidCloseWindow(window))); // only fires for windows that crash
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('window.singleFrame') || e.affectsConfiguration('window.nativeTabs')) {
				this.onDidChangeSingleFrameConfiguration();
			}
		}));
	}

	//#region Entries

	async getEntries(): Promise<readonly IWorkspaceBarEntry[]> {
		return this.model.getEntries();
	}

	async pin(entryId: string): Promise<void> {
		this.onDidChangeModel(this.model.pin(entryId));
	}

	async unpin(entryId: string): Promise<void> {
		this.onDidChangeModel(this.model.unpin(entryId));
	}

	async remove(entryId: string): Promise<void> {
		this.onDidChangeModel(this.model.remove(entryId));
	}

	async reorder(entryId: string, beforeId?: string): Promise<void> {
		this.onDidChangeModel(this.model.reorder(entryId, beforeId));
	}

	/**
	 * vibe: the status is what a window says about itself, so it is only taken from windows
	 * that are around and have a tab to show it on. What arrives over IPC is sanitized.
	 */
	async setWindowStatus(windowId: number, status: IWorkspaceBarWindowStatus | undefined): Promise<void> {
		if (status !== undefined && !this.getManagedWindows().some(window => window.id === windowId)) {
			return;
		}

		const sanitized = status === undefined ? undefined : sanitizeWorkspaceBarWindowStatus(status);
		if (status !== undefined && sanitized === undefined) {
			return;
		}

		this.onDidChangeModel(this.model.setWindowStatus(windowId, sanitized));
	}

	private updateEntries(): void {
		this.onDidChangeModel(this.model.reconcile(this.getManagedWindows().map(window => ({
			windowId: window.id,
			workspace: window.openedWorkspace,
			remoteAuthority: window.remoteAuthority
		}))));
	}

	private setActive(windowId: number): void {
		this.lastActiveTime = Math.max(Date.now(), this.lastActiveTime + 1); // strictly increasing: the order of activation is what matters
		this.onDidChangeModel(this.model.setActive(windowId, this.lastActiveTime));
	}

	private onDidChangeModel(changed: boolean): void {
		if (!changed) {
			return;
		}

		const state = this.model.serialize();
		const serializedState = JSON.stringify(state);
		if (serializedState !== this.persistedState) {
			this.persistedState = serializedState;
			this.stateService.setItem(WorkspaceBarMainService.STATE_KEY, state);
		}

		this.entriesChangeScheduler.schedule();
	}

	//#endregion

	//#region Windows

	/**
	 * Windows for extension development, tests and agent sessions are
	 * not workspaces of the user: they do not show up as entry and
	 * are not part of the frame.
	 */
	private isManaged(window: ICodeWindow): boolean {
		return !window.isExtensionDevelopmentHost && !window.isExtensionTestHost && !window.config?.isSessionsWindow;
	}

	/**
	 * A window that closes is still known to the windows service by the
	 * time its close event fires, tracked windows are the ones around.
	 */
	private getManagedWindows(): ICodeWindow[] {
		return this.windowsMainService.getWindows().filter(window => this.windowListeners.has(window.id) && this.isManaged(window));
	}

	private trackWindow(window: ICodeWindow): void {
		const win = window.win;
		if (!win) {
			return;
		}

		const listeners = new DisposableStore();
		listeners.add(window.onWillLoad(() => this.onWillLoadWindow(window)));
		listeners.add(Event.once(window.onDidClose)(() => this.onDidCloseWindow(window)));
		listeners.add(Event.fromNodeEventEmitter(win, 'show')(() => this.onDidShowWindow(window)));
		listeners.add(Event.fromNodeEventEmitter(win, 'focus')(() => this.onDidFocusWindow(window)));
		for (const event of ['resize', 'move', 'maximize', 'unmaximize']) {
			listeners.add(Event.fromNodeEventEmitter(win, event)(() => this.onDidChangeWindowBounds(window)));
		}

		this.windowListeners.set(window.id, listeners);
	}

	private onDidOpenWindow(window: ICodeWindow): void {
		this.trackWindow(window);

		if (this.singleFrame) {
			const presentedWindow = this.getPresentedWindow();
			if (!presentedWindow) {
				this.presentedWindowId = window.id;
				this.setActive(window.id);
			}

			// Windows that restore on startup open one after the other: the one that
			// opened last is presented, until the windows service is done and focuses
			// the window that was active last, which presents it (see `onDidShowWindow`)
			else if (this.isStartup()) {
				this.presentedWindowId = window.id;
				this.setActive(window.id);
				this.hide(presentedWindow);
			}

			// Any other window opens in the background and takes over once it is ready:
			// the user keeps the window that is presented for as long as the new one
			// loads and also when it fails to. What the window is for is not known
			// before it loads (see `onWillLoadWindow`).
			else {
				this.hideUntilReady(window);
			}
		}

		this.updateEntries();
	}

	private onWillLoadWindow(window: ICodeWindow): void {

		// vibe: what ran in the window is over when it loads, its extension host reports again
		this.onDidChangeModel(this.model.setWindowStatus(window.id, undefined));

		if (!this.isManaged(window)) {
			this.release(window, true);
		} else if (this.windowsHiddenUntilReady.has(window.id) && window.win) {
			this.captureFrame(this.getPresentedWindow());
			this.applyFrame(window.win, false); // loads with the size it is going to be presented with
		}

		this.updateEntries();
	}

	private onDidSignalReadyWindow(window: ICodeWindow): void {

		// Only the first load of a window associates what it loads before `onWillLoad` fires. A window
		// that loads in place (a folder opens in a window without one, another folder opens in the
		// same window, a reload) may veto to unload: it is what it was until the load finished, so
		// `onWillLoadWindow` saw the workspace and remote authority of before. A window that is ready
		// is what it shows, also when it entered a workspace without loading at all.
		this.updateEntries();

		if (this.windowsHiddenUntilReady.has(window.id)) {
			this.reveal(window);
		} else if (window.id === this.presentedWindowId) {
			this.captureFrame(window);
		}
	}

	private onDidCloseWindow(window: ICodeWindow): void {
		if (!this.windowListeners.has(window.id)) {
			return; // closed already
		}

		this.windowListeners.deleteAndDispose(window.id);
		this.windowsHiddenUntilReady.deleteAndDispose(window.id);
		this.hiddenAuxiliaryWindows.delete(window.id);

		// The window to present in place of the one that closed has to be
		// picked for as long as the entry of the closed window is around
		let nextWindow: ICodeWindow | undefined;
		if (window.id === this.presentedWindowId) {
			this.presentedWindowId = undefined;
			if (this.singleFrame && !this.lifecycleMainService.quitRequested) {
				nextWindow = this.pickNextWindow(window);
			}
		}

		this.updateEntries();

		if (nextWindow) {
			this.doReveal(nextWindow);
		}
	}

	private onDidFocusWindow(window: ICodeWindow): void {
		if (!this.isManaged(window)) {
			return;
		}

		if (!this.singleFrame) {
			this.presentedWindowId = window.id; // the window to keep when windows get gathered in one frame
		}

		if (window.id === this.presentedWindowId) {
			this.setActive(window.id);
		} else {
			this.onDidShowWindow(window);
		}
	}

	/**
	 * A window that is hidden gets shown by others for good reasons: it was asked
	 * to focus (a file opens in it from the command line, a protocol link, a
	 * notification, the window that restores as the active one on startup) or
	 * it shows a dialog (such as to confirm closing with unsaved changes).
	 *
	 * macOS reports a window as shown with a noticeable delay, focus is faster.
	 */
	private onDidShowWindow(window: ICodeWindow): void {
		if (this.singleFrame && window.id !== this.presentedWindowId && this.isManaged(window) && window.win?.isVisible()) {
			this.logService.trace(`[workspace bar] window ${window.id} was shown and takes over the frame`);

			this.reveal(window);
		}
	}

	private onDidChangeWindowBounds(window: ICodeWindow): void {
		if (this.singleFrame && window.id === this.presentedWindowId) {
			this.captureFrame(window);
			this.frameSyncScheduler.schedule();
		}
	}

	private onDidChangeSingleFrameConfiguration(): void {
		const singleFrame = this.isSingleFrameConfigured();
		if (singleFrame === this.singleFrame) {
			return;
		}

		this.singleFrame = singleFrame;
		this.logService.trace(`[workspace bar] single frame: ${singleFrame}`);

		// Gather all windows in the frame of the window that was used last
		if (singleFrame) {
			const window = this.getPresentedWindow() ?? this.pickNextWindow(undefined);
			if (window) {
				this.reveal(window);
			}
		}

		// Bring all windows back
		else {
			for (const window of this.getManagedWindows()) {
				this.release(window, false);
			}
		}
	}

	private isSingleFrameConfigured(): boolean {
		const windowSettings = this.configurationService.getValue<ISingleFrameWindowSettings | undefined>('window');

		return windowSettings?.singleFrame !== false && !(isMacintosh && windowSettings?.nativeTabs === true) /* native tabs present windows on their own */;
	}

	private isStartup(): boolean {
		return this.lifecycleMainService.phase < LifecycleMainPhase.AfterWindowOpen;
	}

	private getPresentedWindow(): ICodeWindow | undefined {
		return this.presentedWindowId === undefined ? undefined : this.windowsMainService.getWindowById(this.presentedWindowId);
	}

	/**
	 * The window to present when the presented window is gone: the one of the entry
	 * that was active most recently, or else any window, such as one without workspace.
	 */
	private pickNextWindow(closedWindow: ICodeWindow | undefined): ICodeWindow | undefined {
		const closedEntry = closedWindow ? this.model.getEntryForWindow(closedWindow.id) : undefined;
		const nextEntry = this.model.pickNextActive(closedEntry?.id);

		let nextWindow = nextEntry?.windowId !== undefined ? this.windowsMainService.getWindowById(nextEntry.windowId) : undefined;
		if (!nextWindow) {
			for (const window of this.getManagedWindows()) {
				if (!nextWindow || window.lastFocusTime > nextWindow.lastFocusTime) {
					nextWindow = window;
				}
			}
		}

		return nextWindow;
	}

	//#endregion

	//#region Single frame

	async switchTo(entryId: string, fromWindowId: number): Promise<void> {
		const entry = this.model.getEntry(entryId);
		if (!entry) {
			return;
		}

		const window = entry.windowId !== undefined ? this.windowsMainService.getWindowById(entry.windowId) : undefined;
		if (window) {
			if (this.singleFrame) {
				await this.reveal(window);
			} else {
				window.focus();
			}

			return;
		}

		// The entry has no window: open one. It is going to take over once it is
		// ready (see `onDidOpenWindow`), when it fails to the user remains where
		// they are. A window that opens next to a native fullscreen window would
		// be fullscreen right away on macOS, so leave fullscreen before.
		if (this.singleFrame) {
			await this.leaveFullScreen(this.getPresentedWindow());
		}

		const uri = URI.revive(entry.uri);
		await this.windowsMainService.open({
			context: OpenContext.API,
			contextWindowId: fromWindowId,
			cli: this.environmentMainService.args,
			urisToOpen: [entry.kind === 'workspace' ? { workspaceUri: uri } : { folderUri: uri }],
			forceNewWindow: true,
			remoteAuthority: entry.host.remoteAuthority
		});
	}

	async closeEntryWindow(entryId: string): Promise<void> {
		const entry = this.model.getEntry(entryId);
		const window = entry?.windowId !== undefined ? this.windowsMainService.getWindowById(entry.windowId) : undefined;
		if (!window) {
			return;
		}

		// A window with unsaved changes is likely to ask what to do with them
		if (this.singleFrame && window.id !== this.presentedWindowId && window.isDocumentEdited()) {
			await this.reveal(window);
		}

		window.close();
	}

	async revealLastActive(): Promise<boolean> {
		if (!this.singleFrame) {
			return false;
		}

		const window = this.getPresentedWindow() ?? this.pickNextWindow(undefined);
		if (!window) {
			return false;
		}

		await this.reveal(window);

		return true;
	}

	/**
	 * Presents the window in place of the window that is presented.
	 *
	 * Native fullscreen is a space of its own on macOS that a window cannot be put
	 * into without an animation, so fullscreen is left first. Everything else happens
	 * synchronously and in an order that never leaves the user without a window: the
	 * window is put in place, shown and focused and only then the others get hidden.
	 */
	private async reveal(window: ICodeWindow): Promise<void> {
		const presentedWindow = this.getPresentedWindow();
		if (presentedWindow !== window && presentedWindow?.isFullScreen) {
			await this.leaveFullScreen(presentedWindow); // only await when needed: callers rely on the window to be presented when this method returns otherwise
		}

		this.doReveal(window);
	}

	private doReveal(window: ICodeWindow): void {
		const win = window.win;
		if (!win || win.isDestroyed()) {
			return;
		}

		const presentedWindow = this.getPresentedWindow();
		if (presentedWindow !== window) {
			this.captureFrame(presentedWindow);
		}

		this.logService.trace(`[workspace bar] presenting window ${window.id} in place of window ${presentedWindow?.id}`, this.frame?.bounds);

		this.windowsHiddenUntilReady.deleteAndDispose(window.id);
		this.presentedWindowId = window.id; // before the window shows, to tell this apart from others showing it

		this.applyFrame(win, true);
		if (win.isMinimized()) {
			win.restore();
		} else {
			win.show();
		}
		window.focus();
		this.showAuxiliaryWindows(window);

		for (const otherWindow of this.getManagedWindows()) {
			if (otherWindow !== window) {
				this.hide(otherWindow);
			}
		}

		this.setActive(window.id);
	}

	private hide(window: ICodeWindow): void {
		const win = window.win;
		if (!win || win.isDestroyed() || !win.isVisible()) {
			return;
		}

		this.logService.trace(`[workspace bar] hiding window ${window.id}`);

		this.hideAuxiliaryWindows(window);

		if (window.isFullScreen) {
			this.leaveFullScreen(window).then(() => {
				if (window.id !== this.presentedWindowId && !win.isDestroyed()) {
					win.hide();
				}
			});
		} else {
			win.hide();
		}
	}

	private hideUntilReady(window: ICodeWindow): void {
		this.logService.trace(`[workspace bar] hiding window ${window.id} until it is ready`);

		window.win?.hide();

		const readyTimeout = new RunOnceScheduler(() => {
			this.logService.trace(`[workspace bar] window ${window.id} is not ready after ${WorkspaceBarMainService.WINDOW_READY_TIMEOUT}ms, presenting it anyway`);

			this.reveal(window);
		}, WorkspaceBarMainService.WINDOW_READY_TIMEOUT);
		readyTimeout.schedule();

		this.windowsHiddenUntilReady.set(window.id, readyTimeout);
	}

	/**
	 * Makes a window that was hidden a window of its own again.
	 */
	private release(window: ICodeWindow, focus: boolean): void {
		this.windowsHiddenUntilReady.deleteAndDispose(window.id);
		if (this.presentedWindowId === window.id && !this.isManaged(window)) {
			this.presentedWindowId = undefined;
		}

		const win = window.win;
		if (win && !win.isDestroyed() && !win.isVisible() && !win.isMinimized()) {
			if (focus) {
				win.show();
			} else {
				win.showInactive();
			}
		}

		this.showAuxiliaryWindows(window);
	}

	private async leaveFullScreen(window: ICodeWindow | undefined): Promise<void> {
		if (!window?.isFullScreen) {
			return;
		}

		const disposables = new DisposableStore();
		try {
			const isNativeFullScreen = !window.win?.isSimpleFullScreen();
			const didLeaveFullScreen = new Promise<void>(resolve => disposables.add(window.onDidLeaveFullScreen(() => resolve())));

			window.toggleFullScreen();

			if (isNativeFullScreen) {
				await Promise.race([didLeaveFullScreen, timeout(WorkspaceBarMainService.LEAVE_FULLSCREEN_TIMEOUT)]);
			}
		} finally {
			disposables.dispose();
		}
	}

	private captureFrame(window: ICodeWindow | undefined): void {
		const win = window?.win;
		if (!window || !win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || window.isFullScreen) {
			return;
		}

		if (this.isStartup()) {
			return; // windows restore with the bounds they had
		}

		this.frame = { bounds: win.getBounds(), normalBounds: win.getNormalBounds(), maximized: win.isMaximized() };
	}

	/**
	 * Puts a window where the frame is. Maximizing shows a window
	 * and as such is left to the moment a window is presented.
	 */
	private applyFrame(win: BrowserWindow, presenting: boolean): void {
		const frame = this.frame;
		if (!frame) {
			return; // not known yet, such as on startup
		}

		if (presenting && !frame.maximized && win.isMaximized()) {
			win.unmaximize();
		}

		// macOS: a window is maximized when it has the bounds of a maximized window
		win.setBounds(frame.maximized && !isMacintosh ? frame.normalBounds : frame.bounds);

		if (presenting && frame.maximized && !win.isMaximized()) {
			win.maximize();
		}
	}

	/**
	 * Hidden windows follow the frame so that they have their layout
	 * done when they get presented and restore where the frame was.
	 */
	private syncFrameToHiddenWindows(): void {
		for (const window of this.getManagedWindows()) {
			const win = window.win;
			if (window.id !== this.presentedWindowId && win && !win.isDestroyed() && !win.isVisible() && !win.isMinimized()) {
				this.applyFrame(win, false);
			}
		}
	}

	private hideAuxiliaryWindows(window: ICodeWindow): void {
		const hiddenAuxiliaryWindows: number[] = [];
		for (const auxiliaryWindow of this.auxiliaryWindowsMainService.getWindows()) {
			const win = auxiliaryWindow.win;
			if (auxiliaryWindow.parentId === window.id && win && !win.isDestroyed() && win.isVisible()) {
				win.hide();
				hiddenAuxiliaryWindows.push(auxiliaryWindow.id);
			}
		}

		if (hiddenAuxiliaryWindows.length > 0) {
			this.hiddenAuxiliaryWindows.set(window.id, hiddenAuxiliaryWindows);
		}
	}

	private showAuxiliaryWindows(window: ICodeWindow): void {
		const hiddenAuxiliaryWindows = this.hiddenAuxiliaryWindows.get(window.id);
		if (!hiddenAuxiliaryWindows) {
			return;
		}

		this.hiddenAuxiliaryWindows.delete(window.id);
		for (const auxiliaryWindow of this.auxiliaryWindowsMainService.getWindows()) {
			const win = auxiliaryWindow.win;
			if (hiddenAuxiliaryWindows.includes(auxiliaryWindow.id) && win && !win.isDestroyed()) {
				win.showInactive();
			}
		}
	}

	//#endregion
}
