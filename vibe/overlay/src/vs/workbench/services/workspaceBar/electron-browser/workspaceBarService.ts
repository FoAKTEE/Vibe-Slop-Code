/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceBarMainService, WORKSPACE_BAR_CHANNEL_NAME } from '../../../../platform/workspaceBar/common/workspaceBar.js';

// The workspace bar lives in the main process, every window talks to the same service
registerMainProcessRemoteService(IWorkspaceBarMainService, WORKSPACE_BAR_CHANNEL_NAME);

//#region Configuration

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

//#endregion

//#region Actions

abstract class NavigateWorkspaceBarAction extends Action2 {

	constructor(id: string, title: ILocalizedString, private readonly delta: number) {
		super({ id, title, category: Categories.View, f1: true });
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const workspaceBarService = accessor.get(IWorkspaceBarMainService);
		const windowId = accessor.get(INativeHostService).windowId;

		const entries = await workspaceBarService.getEntries();
		if (entries.length === 0) {
			return;
		}

		// A window without workspace has no entry: enter at either end
		const currentIndex = entries.findIndex(entry => entry.windowId === windowId);
		const nextIndex = currentIndex < 0 ? (this.delta > 0 ? 0 : entries.length - 1) : (currentIndex + this.delta + entries.length) % entries.length;
		if (nextIndex !== currentIndex) {
			await workspaceBarService.switchTo(entries[nextIndex].id, windowId);
		}
	}
}

registerAction2(class extends NavigateWorkspaceBarAction {
	constructor() {
		super('workbench.action.workspaceBar.next', localize2('workspaceBar.next', "Switch to Next Workspace"), 1);
	}
});

registerAction2(class extends NavigateWorkspaceBarAction {
	constructor() {
		super('workbench.action.workspaceBar.previous', localize2('workspaceBar.previous', "Switch to Previous Workspace"), -1);
	}
});

//#endregion
