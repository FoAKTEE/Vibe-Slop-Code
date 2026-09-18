/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { BrowserWindow, Rectangle, WebContents } from 'electron';
import { timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IAuxiliaryWindow } from '../../../auxiliaryWindow/electron-main/auxiliaryWindow.js';
import { IAuxiliaryWindowsMainService } from '../../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { ConfigurationTarget, IConfigurationChangeEvent } from '../../../configuration/common/configuration.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { NativeParsedArgs } from '../../../environment/common/argv.js';
import { IEnvironmentMainService } from '../../../environment/electron-main/environmentMainService.js';
import { LifecycleMainPhase } from '../../../lifecycle/electron-main/lifecycleMainService.js';
import { NullLogService } from '../../../log/common/log.js';
import { FocusMode } from '../../../native/common/native.js';
import { IStateService } from '../../../state/node/state.js';
import { InMemoryTestStateMainService, TestLifecycleMainService } from '../../../test/electron-main/workbenchTestServices.js';
import { INativeWindowConfiguration, isFolderToOpen, isWorkspaceToOpen, IWindowOpenable } from '../../../window/common/window.js';
import { ICodeWindow, ILoadEvent, IWindowState, LoadReason } from '../../../window/electron-main/window.js';
import { IOpenConfiguration, IWindowsMainService, OpenContext } from '../../../windows/electron-main/windows.js';
import { ISingleFolderWorkspaceIdentifier, IWorkspaceIdentifier } from '../../../workspace/common/workspace.js';
import { IWorkspaceBarEntry } from '../../common/workspaceBar.js';
import { WorkspaceBarMainService } from '../../electron-main/workspaceBarMainService.js';

suite('WorkspaceBarMainService', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	//#region Test doubles

	/**
	 * The subset of `electron.BrowserWindow` the service works with. All
	 * calls that change what the user sees end up in `calls`.
	 */
	class TestBrowserWindow {

		private readonly listeners = new Map<string, Set<() => void>>();

		visible = true;
		minimized = false;
		maximized = false;
		fullScreen = false;
		destroyed = false;

		readonly webContents = { focus: () => { } };

		constructor(readonly id: number, private bounds: Rectangle, private readonly calls: string[]) { }

		on(event: string, listener: () => void): this {
			let listeners = this.listeners.get(event);
			if (!listeners) {
				listeners = new Set();
				this.listeners.set(event, listeners);
			}
			listeners.add(listener);

			return this;
		}

		removeListener(event: string, listener: () => void): this {
			this.listeners.get(event)?.delete(listener);

			return this;
		}

		emit(event: string): void {
			for (const listener of [...this.listeners.get(event) ?? []]) {
				listener();
			}
		}

		listenerCount(): number {
			return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
		}

		show(): void {
			this.calls.push(`show:${this.id}`);
			if (!this.visible) {
				this.visible = true;
				this.emit('show');
			}
		}

		showInactive(): void {
			this.show();
		}

		hide(): void {
			this.calls.push(`hide:${this.id}`);
			if (this.visible) {
				this.visible = false;
				this.emit('hide');
			}
		}

		focus(): void {
			if (this.visible) {
				this.emit('focus');
			}
		}

		restore(): void {
			this.calls.push(`restore:${this.id}`);
			this.minimized = false;
			this.visible = true;
		}

		maximize(): void {
			this.calls.push(`maximize:${this.id}`);
			this.maximized = true;
			this.visible = true;
		}

		unmaximize(): void {
			this.calls.push(`unmaximize:${this.id}`);
			this.maximized = false;
		}

		setFullScreen(fullScreen: boolean): void {
			this.calls.push(`setFullScreen(${fullScreen}):${this.id}`);
			setTimeout(() => {
				this.fullScreen = fullScreen;
				this.emit(fullScreen ? 'enter-full-screen' : 'leave-full-screen');
			}, 700); // native transitions take their time
		}

		setBounds(bounds: Rectangle): void {
			this.calls.push(`setBounds:${this.id}`);
			this.bounds = { ...bounds };
		}

		userResize(bounds: Rectangle): void {
			this.bounds = { ...bounds };
			this.emit('resize');
		}

		getBounds(): Rectangle { return { ...this.bounds }; }
		getNormalBounds(): Rectangle { return { ...this.bounds }; }
		isVisible(): boolean { return this.visible; }
		isMinimized(): boolean { return this.minimized; }
		isMaximized(): boolean { return this.maximized; }
		isFullScreen(): boolean { return this.fullScreen; }
		isSimpleFullScreen(): boolean { return false; }
		isDestroyed(): boolean { return this.destroyed; }
	}

	interface ITestWindowOptions {
		readonly folder?: URI;
		readonly workspace?: URI;
		readonly remoteAuthority?: string;
		readonly bounds?: Rectangle;
		readonly extensionDevelopment?: boolean;
		readonly sessionsWindow?: boolean;
	}

	class TestCodeWindow implements ICodeWindow {

		private readonly _onWillLoad = new Emitter<ILoadEvent>();
		readonly onWillLoad = this._onWillLoad.event;

		private readonly _onDidSignalReady = new Emitter<void>();
		readonly onDidSignalReady = this._onDidSignalReady.event;

		private readonly _onDidLeaveFullScreen = new Emitter<void>();
		readonly onDidLeaveFullScreen = this._onDidLeaveFullScreen.event;

		private readonly _onDidClose = new Emitter<void>();
		readonly onDidClose = this._onDidClose.event;

		readonly onDidMaximize = Event.None;
		readonly onDidUnmaximize = Event.None;
		readonly onDidTriggerSystemContextMenu = Event.None;
		readonly onDidEnterFullScreen = Event.None;
		readonly onDidDestroy = Event.None;
		readonly whenClosedOrLoaded = Promise.resolve();

		readonly testWin: TestBrowserWindow;
		get win(): BrowserWindow { return this.testWin as unknown as BrowserWindow; }

		config: INativeWindowConfiguration | undefined;
		openedWorkspace: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | undefined;
		remoteAuthority: string | undefined;
		isExtensionDevelopmentHost = false;
		isExtensionTestHost = false;
		isReady = false;
		lastFocusTime = 0;
		documentEdited = false;
		closeRequested = false;

		constructor(readonly id: number, bounds: Rectangle, private readonly calls: string[]) {
			this.testWin = new TestBrowserWindow(id, bounds, calls);
			this.testWin.on('leave-full-screen', () => this._onDidLeaveFullScreen.fire());
		}

		get isFullScreen(): boolean { return this.testWin.fullScreen; }
		toggleFullScreen(): void { this.testWin.setFullScreen(!this.testWin.fullScreen); }

		testLoad(options: ITestWindowOptions, reason: LoadReason): void {
			this.config = { isSessionsWindow: options.sessionsWindow } as Partial<INativeWindowConfiguration> as INativeWindowConfiguration;
			this.openedWorkspace = options.folder ? { id: options.folder.path, uri: options.folder } : options.workspace ? { id: options.workspace.path, configPath: options.workspace } : undefined;
			this.remoteAuthority = options.remoteAuthority;
			this.isExtensionDevelopmentHost = !!options.extensionDevelopment;
			this._onWillLoad.fire({ workspace: this.openedWorkspace, reason });
		}

		testSignalReady(): void {
			this.isReady = true;
			this._onDidSignalReady.fire();
		}

		testClosed(): void {
			this.testWin.visible = false;
			this.testWin.destroyed = true;
			this._onDidClose.fire();
		}

		/**
		 * As the real window: a window that is not visible gets shown when it is focused.
		 */
		focus(options?: { mode: FocusMode }): void {
			this.calls.push(`focus:${this.id}`);
			if (this.testWin.minimized) {
				this.testWin.restore();
			} else if (!this.testWin.visible) {
				this.testWin.show();
			}
			this.lastFocusTime = Date.now();
			this.testWin.focus();
		}

		close(): void {
			this.calls.push(`close:${this.id}`);
			this.closeRequested = true;
		}

		getBounds(): Rectangle { return this.testWin.getBounds(); }
		isDocumentEdited(): boolean { return this.documentEdited; }

		ready(): Promise<ICodeWindow> { throw new Error('Method not implemented.'); }
		setReady(): void { throw new Error('Method not implemented.'); }
		addTabbedWindow(window: ICodeWindow): void { throw new Error('Method not implemented.'); }
		load(config: INativeWindowConfiguration, options?: { isReload?: boolean }): void { throw new Error('Method not implemented.'); }
		reload(cli?: NativeParsedArgs): void { throw new Error('Method not implemented.'); }
		send(channel: string, ...args: unknown[]): void { throw new Error('Method not implemented.'); }
		sendWhenReady(channel: string, token: CancellationToken, ...args: unknown[]): void { throw new Error('Method not implemented.'); }
		setRepresentedFilename(name: string): void { throw new Error('Method not implemented.'); }
		getRepresentedFilename(): string | undefined { throw new Error('Method not implemented.'); }
		setDocumentEdited(edited: boolean): void { throw new Error('Method not implemented.'); }
		updateTouchBar(): void { throw new Error('Method not implemented.'); }
		updateWindowControls(): void { throw new Error('Method not implemented.'); }
		notifyZoomLevel(zoomLevel: number | undefined): void { throw new Error('Method not implemented.'); }
		serializeWindowState(): IWindowState { throw new Error('Method not implemented.'); }
		matches(webContents: WebContents): boolean { throw new Error('Method not implemented.'); }

		dispose(): void {
			this._onWillLoad.dispose();
			this._onDidSignalReady.dispose();
			this._onDidLeaveFullScreen.dispose();
			this._onDidClose.dispose();
		}
	}

	class TestWindowsMainService extends mock<IWindowsMainService>() {

		private readonly _onDidOpenWindow = new Emitter<ICodeWindow>();
		override readonly onDidOpenWindow = this._onDidOpenWindow.event;

		private readonly _onDidSignalReadyWindow = new Emitter<ICodeWindow>();
		override readonly onDidSignalReadyWindow = this._onDidSignalReadyWindow.event;

		private readonly _onDidDestroyWindow = new Emitter<ICodeWindow>();
		override readonly onDidDestroyWindow = this._onDidDestroyWindow.event;

		private readonly windows = new Map<number, TestCodeWindow>();
		private windowIds = 0;

		readonly openCalls: IOpenConfiguration[] = [];
		openHandler: (openConfig: IOpenConfiguration) => Promise<ICodeWindow[]> = async () => [];

		constructor(private readonly calls: string[]) {
			super();
		}

		override getWindows(): ICodeWindow[] { return [...this.windows.values()]; }
		override getWindowById(windowId: number): ICodeWindow | undefined { return this.windows.get(windowId); }
		override getWindowCount(): number { return this.windows.size; }

		override open(openConfig: IOpenConfiguration): Promise<ICodeWindow[]> {
			this.openCalls.push(openConfig);

			return this.openHandler(openConfig);
		}

		/**
		 * As the real service: the window is created visible and announced
		 * before it knows its workspace, which it learns about when loading.
		 */
		testOpenWindow(options: ITestWindowOptions): TestCodeWindow {
			const window = new TestCodeWindow(++this.windowIds, options.bounds ?? { x: 10 * this.windowIds, y: 10 * this.windowIds, width: 800, height: 600 }, this.calls);
			this.windows.set(window.id, window);
			this._onDidOpenWindow.fire(window);
			window.testLoad(options, LoadReason.INITIAL);

			return window;
		}

		testOpenReadyWindow(options: ITestWindowOptions): TestCodeWindow {
			const window = this.testOpenWindow(options);
			this.testSignalReady(window);

			return window;
		}

		testSignalReady(window: TestCodeWindow): void {
			window.testSignalReady();
			this._onDidSignalReadyWindow.fire(window);
		}

		/**
		 * As the real service: a window that closes tells its listeners first,
		 * by that time it is still a window of the service. There is no event
		 * of the service for windows that close.
		 */
		testCloseWindow(window: TestCodeWindow): void {
			window.testClosed();
			this.windows.delete(window.id);
			window.dispose();
		}

		/**
		 * As the real service: only windows that get destroyed, because
		 * they crashed, are announced and they are gone by that time.
		 */
		testDestroyWindow(window: TestCodeWindow): void {
			this.windows.delete(window.id);
			window.testWin.visible = false;
			window.testWin.destroyed = true;
			this._onDidDestroyWindow.fire(window);
			window.dispose();
		}

		dispose(): void {
			for (const window of this.windows.values()) {
				window.dispose();
			}
			this._onDidOpenWindow.dispose();
			this._onDidSignalReadyWindow.dispose();
			this._onDidDestroyWindow.dispose();
		}
	}

	class TestAuxiliaryWindowsMainService extends mock<IAuxiliaryWindowsMainService>() {

		readonly windows: IAuxiliaryWindow[] = [];

		override getWindows(): readonly IAuxiliaryWindow[] { return this.windows; }

		testAddWindow(id: number, parentId: number, calls: string[]): TestBrowserWindow {
			const win = new TestBrowserWindow(id, { x: 0, y: 0, width: 300, height: 200 }, calls);
			this.windows.push(new class extends mock<IAuxiliaryWindow>() {
				override readonly id = id;
				override readonly parentId = parentId;
				override get win(): BrowserWindow { return win as unknown as BrowserWindow; }
			});

			return win;
		}
	}

	class TestEnvironmentMainService extends mock<IEnvironmentMainService>() {
		override readonly args: NativeParsedArgs = { _: [] };
	}

	interface ITestHarness {
		readonly service: WorkspaceBarMainService;
		readonly windows: TestWindowsMainService;
		readonly auxiliaryWindows: TestAuxiliaryWindowsMainService;
		readonly lifecycle: TestLifecycleMainService;
		readonly configuration: TestConfigurationService;
		readonly state: IStateService;
		readonly calls: string[];
	}

	function createHarness(options?: { readonly singleFrame?: boolean; readonly state?: IStateService; readonly phase?: LifecycleMainPhase }): ITestHarness {
		const store = disposables.add(new DisposableStore());
		const calls: string[] = [];

		const windows = new TestWindowsMainService(calls);
		store.add(windows);

		const auxiliaryWindows = new TestAuxiliaryWindowsMainService();

		const lifecycle = new TestLifecycleMainService();
		lifecycle.phase = options?.phase ?? LifecycleMainPhase.AfterWindowOpen;

		const configuration = new TestConfigurationService({ window: { singleFrame: options?.singleFrame } });
		const state = options?.state ?? new InMemoryTestStateMainService();

		const service = store.add(new WorkspaceBarMainService(windows, auxiliaryWindows, lifecycle, new TestEnvironmentMainService(), state, configuration, new NullLogService()));

		return { service, windows, auxiliaryWindows, lifecycle, configuration, state, calls };
	}

	function visibleWindows(harness: ITestHarness): number[] {
		return harness.windows.getWindows().filter(window => window.win?.isVisible()).map(window => window.id);
	}

	function describeEntries(entries: readonly IWorkspaceBarEntry[]): string[] {
		return entries.map(entry => `${entry.host.label}/${entry.label}${entry.windowId !== undefined ? `#${entry.windowId}` : ''}${entry.active ? '*' : ''}${entry.pinned ? '!' : ''}`);
	}

	async function entriesOf(harness: ITestHarness): Promise<string[]> {
		return describeEntries(await harness.service.getEntries());
	}

	async function entryId(harness: ITestHarness, label: string): Promise<string> {
		const entry = (await harness.service.getEntries()).find(candidate => candidate.label === label);
		assert.ok(entry, `expected an entry labelled ${label}`);

		return entry.id;
	}

	function describeOpenable(openable: IWindowOpenable): string {
		return isFolderToOpen(openable) ? `folder:${openable.folderUri.toString()}` : isWorkspaceToOpen(openable) ? `workspace:${openable.workspaceUri.toString()}` : `file:${openable.fileUri.toString()}`;
	}

	function singleFrameChangeEvent(): IConfigurationChangeEvent {
		return { affectsConfiguration: key => key === 'window.singleFrame', affectedKeys: new Set(['window.singleFrame']), change: { keys: [], overrides: [] }, source: ConfigurationTarget.USER };
	}

	function fakeTimersTest(name: string, fn: () => Promise<void>): void {
		test(name, () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 1000 }, fn));
	}

	const folderA = URI.file('/Users/me/alpha');
	const folderB = URI.file('/Users/me/beta');
	const folderC = URI.file('/Users/me/gamma');
	const remoteFolder = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+myhost', path: '/home/me/delta' });
	const frame: Rectangle = { x: 100, y: 50, width: 1200, height: 800 };

	//#endregion

	suite('entries', () => {

		fakeTimersTest('follow the windows, ignoring windows that are not workspaces of the user', async () => {
			const harness = createHarness();
			const events: string[][] = [];
			disposables.add(harness.service.onDidChangeEntries(entries => events.push(describeEntries(entries))));

			harness.windows.testOpenReadyWindow({});
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			harness.windows.testOpenReadyWindow({ folder: remoteFolder, remoteAuthority: 'ssh-remote+myhost' });
			harness.windows.testOpenReadyWindow({ folder: folderB, extensionDevelopment: true });
			harness.windows.testOpenReadyWindow({ workspace: URI.file('/Users/me/agents.code-workspace'), sessionsWindow: true });
			assert.deepStrictEqual(await entriesOf(harness), ['Local/alpha#2', 'myhost/delta#3*']);

			// a burst of changes is one event that carries all entries
			await timeout(100);
			assert.deepStrictEqual(events, [['Local/alpha#2', 'myhost/delta#3*']]);

			// a window that loads another folder changes its entry
			windowA.testLoad({ folder: folderC }, LoadReason.LOAD);
			assert.deepStrictEqual(await entriesOf(harness), ['Local/gamma#2', 'myhost/delta#3*']);

			harness.windows.testCloseWindow(windowA);
			assert.deepStrictEqual(await entriesOf(harness), ['myhost/delta#3*']);

			await timeout(100);
			assert.deepStrictEqual(events.slice(1), [['myhost/delta#3*']]);
		});

		fakeTimersTest('pinned entries and their order survive the session', async () => {
			const state = new InMemoryTestStateMainService();
			const harness = createHarness({ state });
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			harness.windows.testOpenReadyWindow({ folder: folderB });

			await harness.service.pin(await entryId(harness, 'alpha'));
			await harness.service.pin(await entryId(harness, 'beta'));
			await harness.service.reorder(await entryId(harness, 'beta'), await entryId(harness, 'alpha'));
			harness.windows.testCloseWindow(windowA);
			assert.deepStrictEqual(await entriesOf(harness), ['Local/beta#2*!', 'Local/alpha!']);

			const nextSession = createHarness({ state });
			assert.deepStrictEqual(await entriesOf(nextSession), ['Local/beta!', 'Local/alpha!']);

			await nextSession.service.unpin(await entryId(nextSession, 'beta'));
			await nextSession.service.remove(await entryId(nextSession, 'alpha'));
			assert.deepStrictEqual(await entriesOf(createHarness({ state })), []);
		});

		test('corrupt state is ignored', async () => {
			const state = new InMemoryTestStateMainService();
			state.setItem('workspaceBar.state', 'garbage');
			assert.deepStrictEqual(await entriesOf(createHarness({ state })), []);
		});
	});

	suite('single frame', () => {

		fakeTimersTest('(a) switching presents the target in place of the source: show before hide', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const windowB = harness.windows.testOpenReadyWindow({ folder: folderB });
			assert.deepStrictEqual(visibleWindows(harness), [windowB.id]);

			windowB.testWin.userResize({ x: 5, y: 6, width: 1000, height: 700 });
			harness.calls.length = 0;

			await harness.service.switchTo(await entryId(harness, 'alpha'), windowB.id);

			assert.deepStrictEqual(harness.calls, ['setBounds:1', 'show:1', 'focus:1', 'hide:2']);
			assert.deepStrictEqual(windowA.getBounds(), { x: 5, y: 6, width: 1000, height: 700 });
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id]);
			assert.deepStrictEqual(await entriesOf(harness), ['Local/alpha#1*', 'Local/beta#2']);

			// switching to what is presented already or to something unknown does nothing
			harness.calls.length = 0;
			await harness.service.switchTo(await entryId(harness, 'alpha'), windowA.id);
			await harness.service.switchTo('unknown', windowA.id);
			assert.deepStrictEqual(harness.calls.filter(call => call.startsWith('hide')), []);
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id]);
		});

		fakeTimersTest('(a) the maximized state travels with the frame', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const windowB = harness.windows.testOpenReadyWindow({ folder: folderB });

			windowB.testWin.maximized = true;
			windowB.testWin.emit('maximize');
			await harness.service.switchTo(await entryId(harness, 'alpha'), windowB.id);
			assert.strictEqual(windowA.testWin.maximized, true);

			windowA.testWin.maximized = false;
			windowA.testWin.emit('unmaximize');
			await harness.service.switchTo(await entryId(harness, 'beta'), windowA.id);
			assert.strictEqual(windowB.testWin.maximized, false);
			assert.deepStrictEqual(visibleWindows(harness), [windowB.id]);
		});

		fakeTimersTest('(a) a fullscreen source leaves fullscreen before anything else happens', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const windowB = harness.windows.testOpenReadyWindow({ folder: folderB });
			windowB.testWin.fullScreen = true;
			harness.calls.length = 0;

			const switched = harness.service.switchTo(await entryId(harness, 'alpha'), windowB.id);
			await timeout(100);
			assert.deepStrictEqual(harness.calls, ['setFullScreen(false):2']);
			assert.deepStrictEqual(visibleWindows(harness), [windowB.id]);

			await switched;
			assert.deepStrictEqual(harness.calls, ['setFullScreen(false):2', 'setBounds:1', 'show:1', 'focus:1', 'hide:2']);
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id]);
		});

		fakeTimersTest('(b) an entry without window opens in the background and takes over once ready', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA, bounds: frame });
			const windowB = harness.windows.testOpenReadyWindow({ folder: remoteFolder, remoteAuthority: 'ssh-remote+myhost' });
			await harness.service.pin(await entryId(harness, 'delta'));
			await harness.service.switchTo(await entryId(harness, 'alpha'), windowB.id);
			harness.windows.testCloseWindow(windowB);
			assert.deepStrictEqual(await entriesOf(harness), ['Local/alpha#1*', 'myhost/delta!']);

			let windowC: TestCodeWindow | undefined;
			harness.windows.openHandler = async () => {
				windowC = harness.windows.testOpenWindow({ folder: remoteFolder, remoteAuthority: 'ssh-remote+myhost' });

				return [windowC];
			};
			harness.calls.length = 0;
			await harness.service.switchTo(await entryId(harness, 'delta'), windowA.id);

			assert.deepStrictEqual(harness.windows.openCalls.map(openConfig => ({ ...openConfig, urisToOpen: openConfig.urisToOpen?.map(describeOpenable) })), [{
				context: OpenContext.API,
				contextWindowId: windowA.id,
				cli: { _: [] },
				urisToOpen: [`folder:${remoteFolder.toString()}`],
				forceNewWindow: true,
				remoteAuthority: 'ssh-remote+myhost'
			}]);

			// not ready: the source is what the user sees, the new window waits in its place
			assert.ok(windowC);
			assert.deepStrictEqual(harness.calls, ['hide:3', 'setBounds:3']);
			assert.deepStrictEqual(windowC.getBounds(), frame);
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id]);
			assert.deepStrictEqual(await entriesOf(harness), ['Local/alpha#1*', 'myhost/delta#3!']);

			harness.calls.length = 0;
			harness.windows.testSignalReady(windowC);
			assert.deepStrictEqual(harness.calls, ['setBounds:3', 'show:3', 'focus:3', 'hide:1']);
			assert.deepStrictEqual(visibleWindows(harness), [windowC.id]);
			assert.deepStrictEqual(await entriesOf(harness), ['Local/alpha#1', 'myhost/delta#3*!']);
		});

		fakeTimersTest('(b) a workspace entry opens its workspace file', async () => {
			const harness = createHarness();
			const workspace = URI.file('/Users/me/team.code-workspace');
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const windowB = harness.windows.testOpenReadyWindow({ workspace });
			await harness.service.pin(await entryId(harness, 'team'));
			harness.windows.testCloseWindow(windowB);

			await harness.service.switchTo(await entryId(harness, 'team'), windowA.id);
			assert.deepStrictEqual(harness.windows.openCalls.map(openConfig => openConfig.urisToOpen?.map(describeOpenable)), [[`workspace:${workspace.toString()}`]]);
		});

		fakeTimersTest('(b) failing to open never takes the source away', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const windowB = harness.windows.testOpenReadyWindow({ folder: folderB });
			await harness.service.pin(await entryId(harness, 'beta'));
			await harness.service.switchTo(await entryId(harness, 'alpha'), windowB.id);
			harness.windows.testCloseWindow(windowB);

			// the folder is gone: nothing opens
			await harness.service.switchTo(await entryId(harness, 'beta'), windowA.id);
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id]);

			// opening fails
			harness.windows.openHandler = async () => { throw new Error('host unreachable'); };
			await assert.rejects(harness.service.switchTo(await entryId(harness, 'beta'), windowA.id));
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id]);

			// the window goes away before it is ready
			let windowC: TestCodeWindow | undefined;
			harness.windows.openHandler = async () => {
				windowC = harness.windows.testOpenWindow({ folder: folderB });

				return [windowC];
			};
			await harness.service.switchTo(await entryId(harness, 'beta'), windowA.id);
			assert.ok(windowC);
			harness.windows.testCloseWindow(windowC);
			await timeout(60000);
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id]);
			assert.deepStrictEqual(await entriesOf(harness), ['Local/alpha#1*', 'Local/beta!']);
		});

		fakeTimersTest('(b) a window that does not get ready is presented eventually', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const windowB = harness.windows.testOpenWindow({ folder: folderB });
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id]);

			await timeout(8000);
			assert.deepStrictEqual(visibleWindows(harness), [windowB.id]);
		});

		fakeTimersTest('(c) closing the presented window presents the most recently used one in place', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const windowB = harness.windows.testOpenReadyWindow({ folder: folderB });
			const windowC = harness.windows.testOpenReadyWindow({ folder: folderC });
			await harness.service.switchTo(await entryId(harness, 'alpha'), windowC.id);
			await harness.service.switchTo(await entryId(harness, 'gamma'), windowA.id);
			windowC.testWin.userResize(frame);
			harness.calls.length = 0;

			harness.windows.testCloseWindow(windowC);
			assert.deepStrictEqual(harness.calls, ['setBounds:1', 'show:1', 'focus:1']);
			assert.deepStrictEqual(windowA.getBounds(), frame);
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id]);
			assert.deepStrictEqual(await entriesOf(harness), ['Local/alpha#1*', 'Local/beta#2']);

			// closing a window that is not presented changes nothing the user sees
			harness.calls.length = 0;
			harness.windows.testCloseWindow(windowB);
			assert.deepStrictEqual(harness.calls, []);

			// closing the last window leaves nothing to present
			harness.windows.testCloseWindow(windowA);
			assert.deepStrictEqual(visibleWindows(harness), []);
		});

		fakeTimersTest('(c) windows without workspace take part as well', async () => {
			const harness = createHarness();
			const emptyWindow = harness.windows.testOpenReadyWindow({});
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id]);

			harness.windows.testCloseWindow(windowA);
			assert.deepStrictEqual(visibleWindows(harness), [emptyWindow.id]);
		});

		fakeTimersTest('(c) a presented window that crashes is replaced as well', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const windowB = harness.windows.testOpenReadyWindow({ folder: folderB });

			harness.windows.testDestroyWindow(windowB);
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id]);
			assert.deepStrictEqual(await entriesOf(harness), ['Local/alpha#1*']);
		});

		fakeTimersTest('(d) activating the application presents the most recently used hidden window', async () => {
			const harness = createHarness();
			assert.strictEqual(await harness.service.revealLastActive(), false);

			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const windowB = harness.windows.testOpenReadyWindow({ folder: folderB });
			const windowC = harness.windows.testOpenReadyWindow({ folder: folderC });
			await harness.service.switchTo(await entryId(harness, 'beta'), windowC.id);
			await harness.service.switchTo(await entryId(harness, 'gamma'), windowB.id);

			// quitting closes the presented window, then the quit is vetoed: only hidden windows remain
			harness.lifecycle.quitRequested = true;
			harness.windows.testCloseWindow(windowC);
			harness.lifecycle.quitRequested = false;
			assert.deepStrictEqual(visibleWindows(harness), []);

			assert.strictEqual(await harness.service.revealLastActive(), true);
			assert.deepStrictEqual(visibleWindows(harness), [windowB.id]);

			// a minimized window is restored
			windowB.testWin.minimized = true;
			windowB.testWin.visible = false;
			assert.strictEqual(await harness.service.revealLastActive(), true);
			assert.deepStrictEqual([windowB.testWin.minimized, visibleWindows(harness)], [false, [windowB.id]]);
			assert.strictEqual(windowA.testWin.visible, false);
		});

		fakeTimersTest('(e) a hidden window that is shown, such as for a dialog, takes over the frame', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const windowB = harness.windows.testOpenReadyWindow({ folder: folderB });
			windowB.testWin.userResize(frame);
			harness.calls.length = 0;

			windowA.testWin.show();
			assert.deepStrictEqual(harness.calls, ['show:1', 'setBounds:1', 'show:1', 'focus:1', 'hide:2']);
			assert.deepStrictEqual(windowA.getBounds(), frame);
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id]);
			assert.deepStrictEqual(await entriesOf(harness), ['Local/alpha#1*', 'Local/beta#2']);
			assert.strictEqual(windowB.testWin.visible, false);
		});

		fakeTimersTest('(e) closing the window of an entry shows it first when it may ask to save', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const windowB = harness.windows.testOpenReadyWindow({ folder: folderB });
			const windowC = harness.windows.testOpenReadyWindow({ folder: folderC });
			harness.calls.length = 0;

			await harness.service.closeEntryWindow(await entryId(harness, 'alpha'));
			assert.deepStrictEqual(harness.calls, ['close:1']);
			assert.deepStrictEqual(visibleWindows(harness), [windowC.id]);

			harness.calls.length = 0;
			windowB.documentEdited = true;
			await harness.service.closeEntryWindow(await entryId(harness, 'beta'));
			assert.deepStrictEqual(harness.calls, ['setBounds:2', 'show:2', 'focus:2', 'hide:3', 'close:2']);

			await harness.service.closeEntryWindow('unknown');
			assert.deepStrictEqual([windowA.closeRequested, windowB.closeRequested, windowC.closeRequested], [true, true, false]);
		});

		fakeTimersTest('(e) quitting does not present windows while they close', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const windowB = harness.windows.testOpenReadyWindow({ folder: folderB });
			harness.calls.length = 0;

			harness.lifecycle.quitRequested = true;
			harness.windows.testCloseWindow(windowB);
			harness.windows.testCloseWindow(windowA);
			assert.deepStrictEqual(harness.calls, []);
		});

		fakeTimersTest('(f) restored windows: all but the one that is focused last start hidden', async () => {
			const harness = createHarness({ phase: LifecycleMainPhase.Ready });
			const boundsA = { x: 1, y: 1, width: 801, height: 601 };
			const windowA = harness.windows.testOpenWindow({ folder: folderA, bounds: boundsA });
			const windowB = harness.windows.testOpenWindow({ folder: folderB });
			const windowC = harness.windows.testOpenWindow({ folder: folderC });
			assert.deepStrictEqual(harness.calls, ['hide:1', 'hide:2']);

			// windows get ready in any order, then the last active window of the previous session is focused
			harness.windows.testSignalReady(windowB);
			harness.windows.testSignalReady(windowC);
			harness.windows.testSignalReady(windowA);
			assert.deepStrictEqual(visibleWindows(harness), [windowC.id]);

			harness.calls.length = 0;
			windowA.focus();
			harness.lifecycle.phase = LifecycleMainPhase.AfterWindowOpen;

			// the restored window keeps the bounds it had: it was the frame
			assert.deepStrictEqual(harness.calls, ['focus:1', 'show:1', 'show:1', 'focus:1', 'hide:3']);
			assert.deepStrictEqual(windowA.getBounds(), boundsA);
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id]);
			assert.deepStrictEqual(await entriesOf(harness), ['Local/alpha#1*', 'Local/beta#2', 'Local/gamma#3']);

			// from now on the frame is shared
			await harness.service.switchTo(await entryId(harness, 'beta'), windowA.id);
			assert.deepStrictEqual(windowB.getBounds(), boundsA);
			assert.deepStrictEqual(visibleWindows(harness), [windowB.id]);
		});

		fakeTimersTest('(g) a hidden window that gets focused takes over the frame', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const windowB = harness.windows.testOpenReadyWindow({ folder: folderB });
			windowB.testWin.userResize(frame);

			windowA.focus(); // e.g. a file of the folder opens from the command line, a protocol link, a notification
			assert.deepStrictEqual(windowA.getBounds(), frame);
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id]);
			assert.deepStrictEqual(await entriesOf(harness), ['Local/alpha#1*', 'Local/beta#2']);
			assert.strictEqual(windowB.testWin.visible, false);
		});

		fakeTimersTest('(g) focus tells as well that a hidden window was shown', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const windowB = harness.windows.testOpenReadyWindow({ folder: folderB });

			windowA.testWin.visible = true; // the platform did not tell yet
			windowA.testWin.focus();
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id]);
			assert.deepStrictEqual(await entriesOf(harness), ['Local/alpha#1*', 'Local/beta#2']);
			assert.strictEqual(windowB.testWin.visible, false);
		});

		fakeTimersTest('(g) a window that someone else opens joins the frame as well', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA, bounds: frame });
			harness.calls.length = 0;

			const windowB = harness.windows.testOpenWindow({ folder: folderB });
			assert.deepStrictEqual(harness.calls, ['hide:2', 'setBounds:2']);
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id]);

			harness.windows.testSignalReady(windowB);
			assert.deepStrictEqual(windowB.getBounds(), frame);
			assert.deepStrictEqual(visibleWindows(harness), [windowB.id]);
		});

		fakeTimersTest('(g) extension development and agents windows stay on their own', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const developmentWindow = harness.windows.testOpenReadyWindow({ folder: folderB, extensionDevelopment: true, bounds: frame });
			const agentsWindow = harness.windows.testOpenReadyWindow({ workspace: URI.file('/Users/me/agents.code-workspace'), sessionsWindow: true, bounds: frame });

			assert.deepStrictEqual(visibleWindows(harness), [windowA.id, developmentWindow.id, agentsWindow.id]);
			assert.deepStrictEqual([developmentWindow.getBounds(), agentsWindow.getBounds()], [frame, frame]);

			harness.windows.testCloseWindow(developmentWindow);
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id, agentsWindow.id]);
		});

		fakeTimersTest('hidden windows follow the frame when it moves or resizes', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const windowB = harness.windows.testOpenReadyWindow({ folder: folderB });

			windowB.testWin.userResize({ x: 1, y: 2, width: 900, height: 700 });
			windowB.testWin.userResize(frame);
			harness.calls.length = 0;
			await timeout(1000);

			assert.deepStrictEqual(harness.calls, ['setBounds:1']);
			assert.deepStrictEqual(windowA.getBounds(), frame);
			assert.deepStrictEqual(visibleWindows(harness), [windowB.id]);
		});

		fakeTimersTest('auxiliary windows are hidden and shown with their window', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const auxiliaryWindow = harness.auxiliaryWindows.testAddWindow(100, windowA.id, harness.calls);
			const hiddenAuxiliaryWindow = harness.auxiliaryWindows.testAddWindow(101, windowA.id, harness.calls);
			hiddenAuxiliaryWindow.visible = false;

			const windowB = harness.windows.testOpenReadyWindow({ folder: folderB });
			assert.deepStrictEqual([auxiliaryWindow.visible, hiddenAuxiliaryWindow.visible], [false, false]);

			await harness.service.switchTo(await entryId(harness, 'alpha'), windowB.id);
			assert.deepStrictEqual([auxiliaryWindow.visible, hiddenAuxiliaryWindow.visible], [true, false]);
		});

		test('listeners go away with the windows', () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			assert.ok(windowA.testWin.listenerCount() > 1);

			harness.windows.testCloseWindow(windowA);
			assert.strictEqual(windowA.testWin.listenerCount(), 1 /* the test window itself */);
		});
	});

	suite('window.singleFrame: false', () => {

		fakeTimersTest('windows are left alone and switching focuses', async () => {
			const harness = createHarness({ singleFrame: false });
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const windowB = harness.windows.testOpenReadyWindow({ folder: folderB });
			assert.deepStrictEqual(harness.calls, []);

			await harness.service.switchTo(await entryId(harness, 'alpha'), windowB.id);
			assert.deepStrictEqual(harness.calls, ['focus:1']);
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id, windowB.id]);
			assert.deepStrictEqual(await entriesOf(harness), ['Local/alpha#1*', 'Local/beta#2']);

			// closing, activating
			harness.calls.length = 0;
			harness.windows.testCloseWindow(windowA);
			assert.strictEqual(await harness.service.revealLastActive(), false);
			assert.deepStrictEqual(harness.calls, []);

			// entries without window open as usual
			await harness.service.pin(await entryId(harness, 'beta'));
			harness.windows.testCloseWindow(windowB);
			const windowC = harness.windows.testOpenReadyWindow({ folder: folderC });
			await harness.service.switchTo(await entryId(harness, 'beta'), windowC.id);
			assert.deepStrictEqual(harness.windows.openCalls.map(openConfig => openConfig.forceNewWindow), [true]);
		});

		fakeTimersTest('changing the setting shows all windows or gathers them in one frame', async () => {
			const harness = createHarness();
			const windowA = harness.windows.testOpenReadyWindow({ folder: folderA });
			const windowB = harness.windows.testOpenReadyWindow({ folder: folderB });
			const windowC = harness.windows.testOpenReadyWindow({ folder: folderC });
			assert.deepStrictEqual(visibleWindows(harness), [windowC.id]);

			await harness.configuration.setUserConfiguration('window', { singleFrame: false });
			harness.configuration.onDidChangeConfigurationEmitter.fire(singleFrameChangeEvent());
			assert.deepStrictEqual(visibleWindows(harness), [windowA.id, windowB.id, windowC.id]);

			await harness.configuration.setUserConfiguration('window', { singleFrame: true });
			harness.configuration.onDidChangeConfigurationEmitter.fire(singleFrameChangeEvent());
			assert.deepStrictEqual(visibleWindows(harness), [windowC.id]);
		});
	});
});
