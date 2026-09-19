/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceBarEntry } from '../../../../platform/workspaceBar/common/workspaceBar.js';
import { IWorkspaceBarService } from '../common/workspaceBarService.js';

/**
 * There is no workspace bar where the application does not manage windows.
 */
export class NullWorkspaceBarService implements IWorkspaceBarService {

	declare readonly _serviceBrand: undefined;

	readonly supported = false;
	readonly windowId = -1;
	readonly entries: readonly IWorkspaceBarEntry[] = [];
	readonly onDidChangeEntries = Event.None;
	readonly whenReady = Promise.resolve();

	async switchTo(): Promise<void> { }
	async pin(): Promise<void> { }
	async unpin(): Promise<void> { }
	async remove(): Promise<void> { }
	async closeEntryWindow(): Promise<void> { }
	async reorder(): Promise<void> { }
	async setWindowStatus(): Promise<void> { } // vibe
}

registerSingleton(IWorkspaceBarService, NullWorkspaceBarService, InstantiationType.Delayed);
