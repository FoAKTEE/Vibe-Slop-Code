/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { UriComponents } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * Name of the IPC channel the main process registers the
 * {@link IWorkspaceBarMainService} under.
 */
export const WORKSPACE_BAR_CHANNEL_NAME = 'workspaceBar';

export type WorkspaceBarEntryKind = 'folder' | 'workspace';

/**
 * The machine a workspace lives on. All entries of one host
 * form a contiguous group in the workspace bar.
 */
export interface IWorkspaceBarHost {

	/**
	 * Stable identifier of the host: `local` or derived from
	 * the (case insensitive) remote authority.
	 */
	readonly id: string;

	/**
	 * Short, human readable name of the host.
	 */
	readonly label: string;

	/**
	 * Whether this is the machine the application runs on.
	 */
	readonly isLocal: boolean;

	/**
	 * The remote authority to open windows of this host
	 * with. Not set for hosts that are not remote.
	 */
	readonly remoteAuthority?: string;
}

/**
 * One folder or multi-root workspace in the workspace bar.
 *
 * Entries are plain data so that they can travel over IPC both as
 * call results and as event payloads. Event payloads are not revived,
 * which is why `uri` is typed as {@link UriComponents}: consumers
 * call `URI.revive(entry.uri)` when they need a `URI`. Optional
 * properties are left out (never set to `undefined`).
 */
export interface IWorkspaceBarEntry {

	/**
	 * Stable identifier derived from `kind` and `uri`. The same
	 * folder on two hosts results in two different identifiers.
	 */
	readonly id: string;

	/**
	 * The folder, or the workspace configuration file
	 * for entries of kind `workspace`.
	 */
	readonly uri: UriComponents;

	readonly kind: WorkspaceBarEntryKind;

	/**
	 * Name of the folder or workspace.
	 */
	readonly label: string;

	/**
	 * Parent path segments that tell entries of the same host apart
	 * that share their `label`. Not set when the label is unique.
	 */
	readonly description?: string;

	readonly host: IWorkspaceBarHost;

	/**
	 * Pinned entries remain in the workspace bar after their
	 * window closed and are restored in the next session.
	 */
	readonly pinned: boolean;

	/**
	 * The window that has this entry opened. Not set for
	 * (pinned) entries that are currently not opened.
	 */
	readonly windowId?: number;

	/**
	 * Whether the window of this entry is the
	 * one that is currently presented to the user.
	 */
	readonly active: boolean;

	/**
	 * The last time this entry was the active one
	 * or `0` if it was never active.
	 */
	readonly lastActiveTime: number;
}

export const IWorkspaceBarMainService = createDecorator<IWorkspaceBarMainService>('workspaceBarMainService');

/**
 * Owns the entries of the workspace bar and presents their windows
 * in a single frame. The service lives in the main process, every
 * window talks to it through {@link WORKSPACE_BAR_CHANNEL_NAME}.
 */
export interface IWorkspaceBarMainService {

	readonly _serviceBrand: undefined;

	/**
	 * Fires with all entries, in the order to show them, whenever
	 * entries are added, removed, reordered or changed.
	 */
	readonly onDidChangeEntries: Event<readonly IWorkspaceBarEntry[]>;

	/**
	 * All entries in the order to show them.
	 */
	getEntries(): Promise<readonly IWorkspaceBarEntry[]>;

	/**
	 * Presents the window of the entry in place of the window
	 * `fromWindowId`, opening the entry if it has no window yet.
	 */
	switchTo(entryId: string, fromWindowId: number): Promise<void>;

	pin(entryId: string): Promise<void>;

	unpin(entryId: string): Promise<void>;

	/**
	 * Removes an entry that is not opened. An entry
	 * that is opened stays, but is unpinned.
	 */
	remove(entryId: string): Promise<void>;

	/**
	 * Closes the window of the entry, if any.
	 */
	closeEntryWindow(entryId: string): Promise<void>;

	/**
	 * Moves the entry before the entry `beforeId` or to the end of its
	 * host group if `beforeId` is not provided. Entries never leave
	 * their host group.
	 */
	reorder(entryId: string, beforeId?: string): Promise<void>;
}
