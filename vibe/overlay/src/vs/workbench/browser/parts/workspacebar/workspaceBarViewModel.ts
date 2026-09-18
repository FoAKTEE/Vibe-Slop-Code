/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Schemas } from '../../../../base/common/network.js';
import { dirname } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IWindowOpenable } from '../../../../platform/window/common/window.js';
import { IWorkspaceBarEntry, IWorkspaceBarHost, WorkspaceBarEntryKind } from '../../../../platform/workspaceBar/common/workspaceBar.js';
import { getWorkspaceBarEntryId, getWorkspaceBarEntryLabel, getWorkspaceBarHost, groupWorkspaceBarEntries } from '../../../../platform/workspaceBar/common/workspaceBarModel.js';
import { IRecentlyOpened, isRecentFolder, isRecentWorkspace } from '../../../../platform/workspaces/common/workspaces.js';
import { IWorkspaceBarService } from '../../../services/workspaceBar/common/workspaceBarService.js';

const SEPARATOR = '\u2022';

//#region Tabs

export const enum WorkspaceBarTabState {

	/**
	 * The entry this window shows.
	 */
	Active = 'active',

	/**
	 * The entry is opened in another window.
	 */
	Background = 'background',

	/**
	 * The entry is not opened, it is around because it is pinned.
	 */
	Closed = 'closed'
}

export interface IWorkspaceBarTabViewItem {
	readonly entry: IWorkspaceBarEntry;
	readonly state: WorkspaceBarTabState;
	readonly selected: boolean;
	readonly classes: string[];
	readonly ariaLabel: string;
	readonly tooltip: string;
}

export interface IWorkspaceBarHostViewItem {
	readonly host: IWorkspaceBarHost;
	readonly isRemote: boolean;
	readonly icon: ThemeIcon;
	readonly tabs: IWorkspaceBarTabViewItem[];
}

/**
 * What the workspace bar of the window `windowId` shows: hosts from left to right,
 * each with its tabs. The tab of the window itself is the selected one, a window
 * without workspace has none.
 */
export function toWorkspaceBarViewItems(entries: readonly IWorkspaceBarEntry[], windowId: number): IWorkspaceBarHostViewItem[] {
	return groupWorkspaceBarEntries(entries).map(group => ({
		host: group.host,
		isRemote: !group.host.isLocal,
		icon: group.host.isLocal ? Codicon.deviceDesktop : Codicon.remote,
		tabs: group.entries.map(entry => {
			const state = getTabState(entry, windowId);
			const classes = ['workspace-tab', state];
			if (entry.pinned) {
				classes.push('pinned');
			}

			return { entry, state, selected: state === WorkspaceBarTabState.Active, classes, ariaLabel: getTabAriaLabel(entry, state), tooltip: getTabTooltip(entry) };
		})
	}));
}

function getTabState(entry: IWorkspaceBarEntry, windowId: number): WorkspaceBarTabState {
	if (entry.windowId === undefined) {
		return WorkspaceBarTabState.Closed;
	}

	return entry.windowId === windowId ? WorkspaceBarTabState.Active : WorkspaceBarTabState.Background;
}

function getTabAriaLabel(entry: IWorkspaceBarEntry, state: WorkspaceBarTabState): string {
	const parts = [
		entry.description ? localize('workspaceBar.tabNameWithDescription', "{0} ({1})", entry.label, entry.description) : entry.label,
		entry.host.label
	];

	if (entry.pinned) {
		parts.push(localize('workspaceBar.tabPinned', "pinned"));
	}

	if (state === WorkspaceBarTabState.Background) {
		parts.push(localize('workspaceBar.tabBackground', "open in background"));
	} else if (state === WorkspaceBarTabState.Closed) {
		parts.push(localize('workspaceBar.tabClosed', "closed"));
	}

	return parts.join(', ');
}

function getTabTooltip(entry: IWorkspaceBarEntry): string {
	const path = getWorkspaceBarEntryPath(entry);

	return entry.host.isLocal ? path : `${path} ${SEPARATOR} ${entry.host.label}`;
}

/**
 * The path of an entry as a terminal on its host understands it.
 */
export function getWorkspaceBarEntryPath(entry: IWorkspaceBarEntry): string {
	const uri = URI.revive(entry.uri);

	return uri.scheme === Schemas.file ? uri.fsPath : uri.path;
}

/**
 * A string that changes exactly when the workspace bar of the window `windowId`
 * has to render again. Entries change more often than that, for example
 * every time another window gets focus.
 */
export function getWorkspaceBarRenderKey(entries: readonly IWorkspaceBarEntry[], windowId: number): string {
	return JSON.stringify(entries.map(entry => [entry.id, entry.label, entry.description, entry.host.id, entry.host.label, entry.pinned, getTabState(entry, windowId)]));
}

//#endregion

//#region Navigation

/**
 * The entry `delta` positions away from the entry of the window `windowId`, wrapping
 * around. A window without workspace has no entry and enters at either end.
 */
export function getAdjacentWorkspaceBarEntry(entries: readonly IWorkspaceBarEntry[], windowId: number, delta: number): IWorkspaceBarEntry | undefined {
	if (entries.length === 0) {
		return undefined;
	}

	const currentIndex = entries.findIndex(entry => entry.windowId === windowId);
	const nextIndex = currentIndex < 0 ? (delta > 0 ? 0 : entries.length - 1) : (((currentIndex + delta) % entries.length) + entries.length) % entries.length;

	return nextIndex === currentIndex ? undefined : entries[nextIndex];
}

/**
 * Closes the window of an entry. The window that asks is about to go away when
 * the entry is its own: it hands over to the window that was active most
 * recently before, so that the user is somewhere right away.
 */
export async function closeWorkspaceBarEntry(workspaceBarService: IWorkspaceBarService, entry: IWorkspaceBarEntry): Promise<void> {
	if (entry.windowId === undefined) {
		return;
	}

	if (entry.windowId === workspaceBarService.windowId) {
		let next: IWorkspaceBarEntry | undefined;
		for (const candidate of workspaceBarService.entries) {
			if (candidate.windowId !== undefined && candidate.id !== entry.id && (!next || candidate.lastActiveTime > next.lastActiveTime)) {
				next = candidate;
			}
		}

		if (next) {
			await workspaceBarService.switchTo(next.id);
		}
	}

	await workspaceBarService.closeEntryWindow(entry.id);
}

//#endregion

//#region Adding

export type WorkspaceBarAddAction =
	{ readonly kind: 'openFolder' } |
	{ readonly kind: 'openWorkspace' } |
	{ readonly kind: 'command'; readonly commandId: string } |
	{ readonly kind: 'switch'; readonly entryId: string } |
	{ readonly kind: 'open'; readonly openable: IWindowOpenable & { readonly folderUri?: URI; readonly workspaceUri?: URI }; readonly remoteAuthority: string | undefined };

export interface IWorkspaceBarAddPick extends IQuickPickItem {
	readonly type?: 'item';
	readonly action: WorkspaceBarAddAction;
}

export interface IWorkspaceBarAddPicksOptions {

	/**
	 * A command that connects to a host, if there is any.
	 */
	readonly connectCommand: { readonly id: string } | undefined;

	/**
	 * The label of the folder that contains a local resource.
	 */
	getParentLabel(uri: URI): string;
}

/**
 * What can be added to the workspace bar: something to pick from disk, a host to
 * connect to when that is possible and the folders and workspaces that were
 * opened recently. Picking what has an entry already switches to it.
 */
export function toWorkspaceBarAddPicks(recentlyOpened: IRecentlyOpened, entries: readonly IWorkspaceBarEntry[], options: IWorkspaceBarAddPicksOptions): (IWorkspaceBarAddPick | IQuickPickSeparator)[] {
	const picks: (IWorkspaceBarAddPick | IQuickPickSeparator)[] = [
		{ label: localize('workspaceBar.openFolder', "Open Folder..."), iconClass: ThemeIcon.asClassName(Codicon.folderOpened), action: { kind: 'openFolder' } },
		{ label: localize('workspaceBar.openWorkspace', "Open Workspace from File..."), iconClass: ThemeIcon.asClassName(Codicon.folderLibrary), action: { kind: 'openWorkspace' } }
	];

	if (options.connectCommand) {
		picks.push({ label: localize('workspaceBar.connectToHost', "Connect to Host..."), iconClass: ThemeIcon.asClassName(Codicon.remote), action: { kind: 'command', commandId: options.connectCommand.id } });
	}

	const entryIds = new Set(entries.map(entry => entry.id));
	const recentPicks: IWorkspaceBarAddPick[] = [];
	for (const recent of recentlyOpened.workspaces) {
		let uri: URI;
		let kind: WorkspaceBarEntryKind;
		if (isRecentFolder(recent)) {
			uri = recent.folderUri;
			kind = 'folder';
		} else if (isRecentWorkspace(recent)) {
			uri = recent.workspace.configPath;
			kind = 'workspace';
		} else {
			continue;
		}

		const host = getWorkspaceBarHost(uri, recent.remoteAuthority);
		const name = getWorkspaceBarEntryLabel(uri, kind); // as the tab is going to be named, `recent.label` is a path
		const parent = uri.scheme === Schemas.file ? options.getParentLabel(uri) : dirname(uri).path;
		const entryId = getWorkspaceBarEntryId(uri, kind);

		recentPicks.push({
			label: kind === 'workspace' ? localize('workspaceBar.workspaceName', "{0} (Workspace)", name) : name,
			description: host.isLocal ? parent : `${host.label} ${SEPARATOR} ${parent}`,
			iconClass: ThemeIcon.asClassName(host.isLocal ? (kind === 'workspace' ? Codicon.folderLibrary : Codicon.folder) : Codicon.remote),
			action: entryIds.has(entryId)
				? { kind: 'switch', entryId }
				: { kind: 'open', openable: kind === 'workspace' ? { workspaceUri: uri } : { folderUri: uri }, remoteAuthority: host.remoteAuthority }
		});
	}

	if (recentPicks.length > 0) {
		picks.push({ type: 'separator', label: localize('workspaceBar.recentlyOpened', "recently opened") }, ...recentPicks);
	}

	return picks;
}

//#endregion
