/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceBarEntry, IWorkspaceBarMainService, WORKSPACE_BAR_CHANNEL_NAME } from '../../../../platform/workspaceBar/common/workspaceBar.js';
import { IWorkspaceBarService } from '../common/workspaceBarService.js';

// The workspace bar lives in the main process, every window talks to the same service
registerMainProcessRemoteService(IWorkspaceBarMainService, WORKSPACE_BAR_CHANNEL_NAME);

export class NativeWorkspaceBarService extends Disposable implements IWorkspaceBarService {

	declare readonly _serviceBrand: undefined;

	readonly supported = true;
	readonly windowId: number;
	readonly whenReady: Promise<void>;

	private _entries: readonly IWorkspaceBarEntry[] = [];
	get entries(): readonly IWorkspaceBarEntry[] { return this._entries; }

	private readonly _onDidChangeEntries = this._register(new Emitter<readonly IWorkspaceBarEntry[]>());
	readonly onDidChangeEntries = this._onDidChangeEntries.event;

	constructor(
		@IWorkspaceBarMainService private readonly workspaceBarMainService: IWorkspaceBarMainService,
		@INativeHostService nativeHostService: INativeHostService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this.windowId = nativeHostService.windowId;

		// Entries that arrive as event are never older than the ones asked for
		let didReceiveEntries = false;
		this._register(this.workspaceBarMainService.onDidChangeEntries(entries => {
			didReceiveEntries = true;
			this.setEntries(entries);
		}));

		this.whenReady = this.resolveEntries(() => didReceiveEntries);
	}

	private async resolveEntries(didReceiveEntries: () => boolean): Promise<void> {
		try {
			const entries = await this.workspaceBarMainService.getEntries();
			if (!didReceiveEntries()) {
				this.setEntries(entries);
			}
		} catch (error) {
			this.logService.error(error);
		}
	}

	private setEntries(entries: readonly IWorkspaceBarEntry[]): void {
		this._entries = entries;
		this._onDidChangeEntries.fire(entries);
	}

	switchTo(entryId: string): Promise<void> {
		return this.workspaceBarMainService.switchTo(entryId, this.windowId);
	}

	pin(entryId: string): Promise<void> {
		return this.workspaceBarMainService.pin(entryId);
	}

	unpin(entryId: string): Promise<void> {
		return this.workspaceBarMainService.unpin(entryId);
	}

	remove(entryId: string): Promise<void> {
		return this.workspaceBarMainService.remove(entryId);
	}

	closeEntryWindow(entryId: string): Promise<void> {
		return this.workspaceBarMainService.closeEntryWindow(entryId);
	}

	reorder(entryId: string, beforeId?: string): Promise<void> {
		return this.workspaceBarMainService.reorder(entryId, beforeId);
	}
}

registerSingleton(IWorkspaceBarService, NativeWorkspaceBarService, InstantiationType.Delayed);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	'id': 'window',
	'order': 8,
	'title': localize('windowConfigurationTitle', "Window"),
	'type': 'object',
	'properties': {
		'window.singleFrame': {
			'type': 'boolean',
			'default': true,
			'scope': ConfigurationScope.APPLICATION,
			'markdownDescription': localize('window.singleFrame', "Controls whether all windows are presented in a single frame. When enabled, exactly one window is visible and the workspace bar switches between windows in place. Windows that are not visible keep running. When disabled, every window is presented on its own and the workspace bar focuses the window of a workspace.")
		}
	}
});
