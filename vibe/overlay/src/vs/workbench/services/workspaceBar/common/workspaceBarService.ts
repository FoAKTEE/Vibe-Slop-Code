/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceBarEntry, IWorkspaceBarWindowStatus } from '../../../../platform/workspaceBar/common/workspaceBar.js';

export const IWorkspaceBarService = createDecorator<IWorkspaceBarService>('workspaceBarService');

/**
 * The workspace bar as a window sees it: the entries of all windows of
 * the application and what can be done with them from this window.
 */
export interface IWorkspaceBarService {

	readonly _serviceBrand: undefined;

	/**
	 * Whether there is a workspace bar at all. There is none where
	 * windows are not managed by the application, such as on the web.
	 */
	readonly supported: boolean;

	/**
	 * The window this service belongs to: the entry with this
	 * `windowId` is the one this window shows.
	 */
	readonly windowId: number;

	/**
	 * All entries in the order to show them. Empty
	 * until the entries are known, see `whenReady`.
	 */
	readonly entries: readonly IWorkspaceBarEntry[];

	readonly onDidChangeEntries: Event<readonly IWorkspaceBarEntry[]>;

	/**
	 * Resolves when `entries` has been read for the first time.
	 */
	readonly whenReady: Promise<void>;

	/**
	 * Presents the entry in place of this window,
	 * opening it if it is not opened.
	 */
	switchTo(entryId: string): Promise<void>;

	pin(entryId: string): Promise<void>;

	unpin(entryId: string): Promise<void>;

	remove(entryId: string): Promise<void>;

	closeEntryWindow(entryId: string): Promise<void>;

	reorder(entryId: string, beforeId?: string): Promise<void>;

	/**
	 * vibe: sets what the agents of this window do, or clears it with
	 * `undefined`. It shows on the tab of this window in every window.
	 */
	setWindowStatus(status: IWorkspaceBarWindowStatus | undefined): Promise<void>;
}
