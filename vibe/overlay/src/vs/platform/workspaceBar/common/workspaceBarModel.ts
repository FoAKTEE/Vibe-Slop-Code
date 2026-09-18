/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { findLastIdx } from '../../../base/common/arraysFind.js';
import { decodeHex } from '../../../base/common/buffer.js';
import { Schemas } from '../../../base/common/network.js';
import { basename, extUriBiasedIgnorePathCase, IExtUri } from '../../../base/common/resources.js';
import { isObject } from '../../../base/common/types.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { getRemoteAuthority } from '../../remote/common/remoteHosts.js';
import { IAnyWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, UNTITLED_WORKSPACE_NAME, WORKSPACE_SUFFIX } from '../../workspace/common/workspace.js';
import { IWorkspaceBarEntry, IWorkspaceBarHost, WorkspaceBarEntryKind } from './workspaceBar.js';

//#region Identity

export interface IWorkspaceBarTarget {
	readonly uri: URI;
	readonly kind: WorkspaceBarEntryKind;
}

/**
 * The folder or workspace file a window has opened
 * or `undefined` for windows without workspace.
 */
export function toWorkspaceBarTarget(workspace: IAnyWorkspaceIdentifier | undefined): IWorkspaceBarTarget | undefined {
	if (isSingleFolderWorkspaceIdentifier(workspace)) {
		return { uri: workspace.uri, kind: 'folder' };
	}

	if (isWorkspaceIdentifier(workspace)) {
		return { uri: workspace.configPath, kind: 'workspace' };
	}

	return undefined;
}

/**
 * A stable identifier for a folder or workspace file. Two resources
 * share an identifier exactly when the application treats them as the
 * same workspace: a trailing path separator and the casing of the
 * authority never matter, the casing of the path matters as decided
 * by `extUri`. The default is what the main process uses to find
 * the window of a workspace.
 */
export function getWorkspaceBarEntryId(uri: URI, kind: WorkspaceBarEntryKind, extUri: IExtUri = extUriBiasedIgnorePathCase): string {
	return `${kind}:${extUri.getComparisonKey(extUri.removeTrailingPathSeparator(uri))}`;
}

//#endregion

//#region Host

const MAX_HOST_LABEL_LENGTH = 32;
const MAX_HOST_DETAIL_LENGTH = 24;
const OPAQUE_HOST_DETAIL_TAIL_LENGTH = 6;
const ELLIPSIS = '\u2026';

/**
 * Properties of hex encoded JSON authorities that name the
 * machine, as used by the SSH and container remotes.
 */
const HOST_DETAIL_PROPERTIES = ['hostName', 'containerName', 'podname', 'hostPath', 'name'];

/**
 * The host of a folder or workspace file. `remoteAuthority` is the
 * authority of the window, which is not necessarily part of the
 * resource: a local workspace file can open on a remote.
 */
export function getWorkspaceBarHost(uri: URI, remoteAuthority?: string): IWorkspaceBarHost {
	const authority = remoteAuthority || getRemoteAuthority(uri);
	if (authority) {
		return { id: `remote:${authority.toLowerCase()}`, label: truncate(getRemoteHostLabel(authority), MAX_HOST_LABEL_LENGTH), isLocal: false, remoteAuthority: authority };
	}

	if (uri.scheme !== Schemas.file && uri.authority) {
		return { id: `virtual:${uri.scheme}://${uri.authority.toLowerCase()}`, label: truncate(uri.authority, MAX_HOST_LABEL_LENGTH), isLocal: false }; // virtual file system
	}

	return { id: 'local', label: localize('workspaceBar.localHost', "Local"), isLocal: true };
}

function getRemoteHostLabel(authority: string): string {
	const separator = authority.indexOf('+');
	const remoteName = authority.substring(0, separator);
	const detail = authority.substring(separator + 1);
	if (separator < 0 || !remoteName || !detail) {
		return remoteName || authority; // e.g. `localhost:8000`
	}

	const name = getRemoteHostName(detail);
	switch (remoteName.toLowerCase()) {
		case 'ssh-remote':
			return name.replace(/\\x(?<code>[0-9a-f]{2})/g, (_match, code: string) => String.fromCharCode(parseInt(code, 16))); // upper case travels escaped, see `getSshRemoteAuthority`
		case 'wsl':
			return localize('workspaceBar.wslHost', "WSL: {0}", name);
		case 'dev-container':
		case 'attached-container':
		case 'k8s-container':
			return localize('workspaceBar.containerHost', "Container: {0}", name);
		case 'tunnel':
			return localize('workspaceBar.tunnelHost', "Tunnel: {0}", name);
		case 'codespaces':
			return localize('workspaceBar.codespacesHost', "Codespaces: {0}", name);
		default:
			return `${remoteName}: ${name}`;
	}
}

function getRemoteHostName(detail: string): string {
	const decoded = decodeRemoteHostName(detail);
	if (decoded) {
		return decoded;
	}

	if (detail.length > MAX_HOST_DETAIL_LENGTH && /^[0-9a-f]+$/i.test(detail)) {
		return ELLIPSIS + detail.substring(detail.length - OPAQUE_HOST_DETAIL_TAIL_LENGTH); // encoded data differs at its end
	}

	return detail;
}

function decodeRemoteHostName(detail: string): string | undefined {
	if (detail.length % 2 !== 0 || !/^7b[0-9a-f]*7d$/i.test(detail)) {
		return undefined; // not hex encoded `{...}`
	}

	let data: unknown;
	try {
		data = JSON.parse(decodeHex(detail).toString());
	} catch {
		return undefined;
	}

	if (!isObject(data)) {
		return undefined;
	}

	for (const property of HOST_DETAIL_PROPERTIES) {
		const value = (data as Record<string, unknown>)[property];
		if (typeof value === 'string') {
			const name = value.split(/[\\/]/).filter(segment => segment.length > 0).pop(); // paths and `/container` names
			if (name) {
				return name;
			}
		}
	}

	return undefined;
}

function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : value.substring(0, maxLength - 1) + ELLIPSIS;
}

//#endregion

//#region Labels

/**
 * The name of a folder, or of a workspace without its file extension.
 */
export function getWorkspaceBarEntryLabel(uri: URI, kind: WorkspaceBarEntryKind): string {
	const name = basename(uri);
	if (kind === 'workspace') {
		if (name === UNTITLED_WORKSPACE_NAME) {
			return localize('workspaceBar.untitledWorkspace', "Untitled (Workspace)");
		}

		if (name.length > WORKSPACE_SUFFIX.length && name.endsWith(WORKSPACE_SUFFIX)) {
			return name.substring(0, name.length - WORKSPACE_SUFFIX.length);
		}
	}

	return name || '/';
}

function getParentSegments(uri: URI): string[] {
	return uri.path.split('/').filter(segment => segment.length > 0).slice(0, -1);
}

//#endregion

//#region Groups

export interface IWorkspaceBarHostGroup {
	readonly host: IWorkspaceBarHost;
	readonly entries: readonly IWorkspaceBarEntry[];
}

/**
 * Groups entries by host, keeping the order of hosts and entries.
 */
export function groupWorkspaceBarEntries(entries: readonly IWorkspaceBarEntry[]): IWorkspaceBarHostGroup[] {
	const groups = new Map<string, { readonly host: IWorkspaceBarHost; readonly entries: IWorkspaceBarEntry[] }>();
	for (const entry of entries) {
		let group = groups.get(entry.host.id);
		if (!group) {
			group = { host: entry.host, entries: [] };
			groups.set(entry.host.id, group);
		}

		group.entries.push(entry);
	}

	return [...groups.values()];
}

//#endregion

//#region Model

/**
 * An opened window as the model needs to know it.
 */
export interface IWorkspaceBarWindow {
	readonly windowId: number;

	/**
	 * The workspace of the window. Windows without
	 * folder or workspace do not show up as entry.
	 */
	readonly workspace: IAnyWorkspaceIdentifier | undefined;

	readonly remoteAuthority: string | undefined;
}

export interface ISerializedWorkspaceBarEntry {
	readonly uri: string;
	readonly kind: WorkspaceBarEntryKind;
	readonly remoteAuthority?: string;
	readonly lastActiveTime: number;
}

export interface ISerializedWorkspaceBarState {
	readonly version: number;
	readonly entries: readonly ISerializedWorkspaceBarEntry[];
}

const SERIALIZED_STATE_VERSION = 1;

interface IWorkspaceBarEntryState {
	readonly id: string;
	readonly uri: URI;
	readonly kind: WorkspaceBarEntryKind;
	readonly label: string;
	host: IWorkspaceBarHost;
	pinned: boolean;
	windowId: number | undefined;
	lastActiveTime: number;
}

/**
 * The entries of the workspace bar: derived from the pinned entries of
 * previous sessions and the windows that are opened. The model has no
 * side effects and no notion of time: methods that change entries
 * return whether the result of `getEntries` changed.
 *
 * Order invariants: entries of one host are contiguous, the local host
 * comes first, other hosts follow in the order they were first seen and
 * a new entry goes to the end of its host group.
 */
export class WorkspaceBarModel {

	private readonly entries: IWorkspaceBarEntryState[] = [];

	private activeWindowId: number | undefined = undefined;
	private activeTime = 0;

	/**
	 * @param serializedState what `serialize` returned in a previous session.
	 * Anything that is not understood is ignored.
	 * @param extUri decides about equality of resources, see `getWorkspaceBarEntryId`.
	 */
	constructor(serializedState?: unknown, private readonly extUri: IExtUri = extUriBiasedIgnorePathCase) {
		for (const entry of this.deserialize(serializedState)) {
			if (!this.entries.some(candidate => candidate.id === entry.id)) {
				this.insert(entry);
			}
		}
	}

	//#region Entries

	getEntries(): IWorkspaceBarEntry[] {
		const descriptions = this.computeDescriptions();
		const activeEntry = this.activeEntry;

		return this.entries.map(entry => {
			const description = descriptions.get(entry);

			return {
				id: entry.id,
				uri: entry.uri,
				kind: entry.kind,
				label: entry.label,
				...(description !== undefined ? { description } : undefined),
				host: entry.host,
				pinned: entry.pinned,
				...(entry.windowId !== undefined ? { windowId: entry.windowId } : undefined),
				active: entry === activeEntry,
				lastActiveTime: entry.lastActiveTime
			};
		});
	}

	getEntry(entryId: string): IWorkspaceBarEntry | undefined {
		return this.getEntries().find(entry => entry.id === entryId);
	}

	getEntryForWindow(windowId: number): IWorkspaceBarEntry | undefined {
		return this.getEntries().find(entry => entry.windowId === windowId);
	}

	private get activeEntry(): IWorkspaceBarEntryState | undefined {
		return this.activeWindowId === undefined ? undefined : this.entries.find(entry => entry.windowId === this.activeWindowId);
	}

	private computeDescriptions(): Map<IWorkspaceBarEntryState, string> {
		const entriesByLabel = new Map<string, IWorkspaceBarEntryState[]>();
		for (const entry of this.entries) {
			const key = `${entry.host.id}\n${entry.label}`;
			const entries = entriesByLabel.get(key);
			if (entries) {
				entries.push(entry);
			} else {
				entriesByLabel.set(key, [entry]);
			}
		}

		const descriptions = new Map<IWorkspaceBarEntryState, string>();
		for (const entries of entriesByLabel.values()) {
			if (entries.length < 2) {
				continue;
			}

			// Take as many parent segments as it needs to be different from all others
			const parents = entries.map(entry => getParentSegments(entry.uri));
			const maxDepth = Math.max(...parents.map(segments => segments.length));
			entries.forEach((entry, index) => {
				let depth = 1;
				while (depth <= maxDepth && parents.some((other, otherIndex) => otherIndex !== index && other.slice(-depth).join('/') === parents[index].slice(-depth).join('/'))) {
					depth++;
				}

				descriptions.set(entry, parents[index].slice(depth <= maxDepth ? -depth : -1).join('/') || '/');
			});
		}

		return descriptions;
	}

	//#endregion

	//#region Windows

	/**
	 * Updates the entries from all windows that are opened: entries get
	 * bound to their window, windows that are not known yet add an entry
	 * and entries without window remain only when pinned.
	 */
	reconcile(windows: readonly IWorkspaceBarWindow[]): boolean {
		const windowsByEntryId = new Map<string, { readonly window: IWorkspaceBarWindow; readonly target: IWorkspaceBarTarget }[]>();
		for (const window of [...windows].sort((windowA, windowB) => windowA.windowId - windowB.windowId)) {
			const target = toWorkspaceBarTarget(window.workspace);
			if (!target) {
				continue;
			}

			const entryId = getWorkspaceBarEntryId(target.uri, target.kind, this.extUri);
			const candidates = windowsByEntryId.get(entryId);
			if (candidates) {
				candidates.push({ window, target });
			} else {
				windowsByEntryId.set(entryId, [{ window, target }]);
			}
		}

		let changed = false;

		// Known entries: an entry keeps its window for as long as that
		// window shows it, otherwise the oldest window wins
		for (const entry of [...this.entries]) {
			const candidates = windowsByEntryId.get(entry.id);
			windowsByEntryId.delete(entry.id);

			const window = (candidates?.find(candidate => candidate.window.windowId === entry.windowId) ?? candidates?.[0])?.window;
			if (window) {
				changed = this.bind(entry, window) || changed;
			} else if (entry.windowId !== undefined || !entry.pinned) {
				entry.windowId = undefined;
				if (!entry.pinned) {
					this.entries.splice(this.entries.indexOf(entry), 1);
				}
				changed = true;
			}
		}

		// New entries
		for (const [{ window, target }] of windowsByEntryId.values()) {
			const entry = this.createEntry(target.uri, target.kind, window.remoteAuthority, false, 0);
			this.bind(entry, window);
			this.insert(entry);
			changed = true;
		}

		return changed;
	}

	private bind(entry: IWorkspaceBarEntryState, window: IWorkspaceBarWindow): boolean {
		let changed = false;

		if (entry.windowId !== window.windowId) {
			entry.windowId = window.windowId;
			changed = true;
		}

		const host = getWorkspaceBarHost(entry.uri, window.remoteAuthority);
		if (host.id !== entry.host.id) {
			entry.host = host;
			const index = this.entries.indexOf(entry);
			if (index >= 0) {
				this.entries.splice(index, 1);
				this.insert(entry);
			}
			changed = true;
		}

		if (window.windowId === this.activeWindowId && entry.lastActiveTime < this.activeTime) {
			entry.lastActiveTime = this.activeTime;
			changed = true;
		}

		return changed;
	}

	private createEntry(uri: URI, kind: WorkspaceBarEntryKind, remoteAuthority: string | undefined, pinned: boolean, lastActiveTime: number): IWorkspaceBarEntryState {
		return {
			id: getWorkspaceBarEntryId(uri, kind, this.extUri),
			uri,
			kind,
			label: getWorkspaceBarEntryLabel(uri, kind),
			host: getWorkspaceBarHost(uri, remoteAuthority),
			pinned,
			windowId: undefined,
			lastActiveTime
		};
	}

	private insert(entry: IWorkspaceBarEntryState): void {
		let index = findLastIdx(this.entries, candidate => candidate.host.id === entry.host.id) + 1;
		if (index === 0) {
			index = entry.host.isLocal ? 0 : this.entries.length;
		}

		this.entries.splice(index, 0, entry);
	}

	//#endregion

	//#region Active entry

	/**
	 * Sets the window that is presented to the user at the given time. The
	 * window may have no entry (yet): the time is applied once it has one.
	 */
	setActive(windowId: number | undefined, time: number): boolean {
		const previousActiveEntry = this.activeEntry;

		this.activeWindowId = windowId;
		this.activeTime = time;

		const activeEntry = this.activeEntry;
		let changed = previousActiveEntry !== activeEntry;
		if (activeEntry && activeEntry.lastActiveTime < time) {
			activeEntry.lastActiveTime = time;
			changed = true;
		}

		return changed;
	}

	/**
	 * The entry to present when the window of `closedEntryId` goes away: the
	 * most recently active other entry that has a window. Entries that were
	 * active at the same time (typically never) are picked by their distance
	 * to the closed entry, which requires to call this method before the
	 * closed window is reconciled, and then by their order.
	 */
	pickNextActive(closedEntryId?: string): IWorkspaceBarEntry | undefined {
		const closedIndex = this.entries.findIndex(entry => entry.id === closedEntryId);

		let nextIndex = -1;
		this.entries.forEach((entry, index) => {
			if (entry.windowId === undefined || index === closedIndex) {
				return;
			}

			const next: IWorkspaceBarEntryState | undefined = this.entries[nextIndex];
			if (
				!next ||
				entry.lastActiveTime > next.lastActiveTime ||
				(entry.lastActiveTime === next.lastActiveTime && closedIndex >= 0 && Math.abs(index - closedIndex) < Math.abs(nextIndex - closedIndex))
			) {
				nextIndex = index;
			}
		});

		return nextIndex < 0 ? undefined : this.getEntries()[nextIndex];
	}

	//#endregion

	//#region Pinning and order

	pin(entryId: string): boolean {
		const entry = this.entries.find(candidate => candidate.id === entryId);
		if (!entry || entry.pinned) {
			return false;
		}

		entry.pinned = true;

		return true;
	}

	unpin(entryId: string): boolean {
		const entry = this.entries.find(candidate => candidate.id === entryId);
		if (!entry?.pinned) {
			return false;
		}

		entry.pinned = false;
		if (entry.windowId === undefined) {
			this.entries.splice(this.entries.indexOf(entry), 1);
		}

		return true;
	}

	/**
	 * Removes an entry that has no window. An entry with
	 * a window is unpinned and goes away with its window.
	 */
	remove(entryId: string): boolean {
		return this.unpin(entryId);
	}

	/**
	 * Moves the entry before the entry `beforeId` or to the end of its
	 * host group if `beforeId` is not provided. Entries never leave
	 * their host group: a position outside is moved to the closest
	 * position inside.
	 */
	reorder(entryId: string, beforeId?: string): boolean {
		const from = this.entries.findIndex(entry => entry.id === entryId);
		if (from < 0) {
			return false;
		}

		const entry = this.entries[from];
		const groupStart = this.entries.findIndex(candidate => candidate.host.id === entry.host.id);
		const groupEnd = findLastIdx(this.entries, candidate => candidate.host.id === entry.host.id) + 1;

		let to = groupEnd;
		if (beforeId !== undefined) {
			const before = this.entries.findIndex(candidate => candidate.id === beforeId);
			if (before < 0) {
				return false;
			}

			to = Math.min(Math.max(before, groupStart), groupEnd);
		}

		if (to === from || to === from + 1) {
			return false; // already there
		}

		this.entries.splice(from, 1);
		this.entries.splice(to > from ? to - 1 : to, 0, entry);

		return true;
	}

	//#endregion

	//#region Persisted state

	/**
	 * The entries to restore in the next session: pinned ones.
	 */
	serialize(): ISerializedWorkspaceBarState {
		return {
			version: SERIALIZED_STATE_VERSION,
			entries: this.entries.filter(entry => entry.pinned).map(entry => ({
				uri: entry.uri.toString(),
				kind: entry.kind,
				...(entry.host.remoteAuthority !== undefined ? { remoteAuthority: entry.host.remoteAuthority } : undefined),
				lastActiveTime: entry.lastActiveTime
			}))
		};
	}

	private deserialize(serializedState: unknown): IWorkspaceBarEntryState[] {
		let state = serializedState;
		if (typeof state === 'string') {
			try {
				state = JSON.parse(state);
			} catch {
				return [];
			}
		}

		if (!isObject(state)) {
			return [];
		}

		// State of a newer version is read for what is understood of it
		const { version, entries } = state as { readonly version?: unknown; readonly entries?: unknown };
		if (typeof version !== 'number' || !(version >= SERIALIZED_STATE_VERSION) || !Array.isArray(entries)) {
			return [];
		}

		const result: IWorkspaceBarEntryState[] = [];
		for (const entry of entries) {
			if (!isObject(entry)) {
				continue;
			}

			const { uri, kind, remoteAuthority, lastActiveTime } = entry as { readonly [property: string]: unknown };
			if (typeof uri !== 'string' || (kind !== 'folder' && kind !== 'workspace')) {
				continue;
			}

			let resource: URI;
			try {
				resource = URI.parse(uri, true);
			} catch {
				continue;
			}

			if (!resource.path) {
				continue;
			}

			result.push(this.createEntry(
				resource,
				kind,
				typeof remoteAuthority === 'string' ? remoteAuthority : undefined,
				true,
				typeof lastActiveTime === 'number' && Number.isFinite(lastActiveTime) && lastActiveTime > 0 ? lastActiveTime : 0
			));
		}

		return result;
	}

	//#endregion
}

//#endregion
