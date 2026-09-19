/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceBarEntry } from '../../../../../platform/workspaceBar/common/workspaceBar.js';
import { IWorkspaceBarWindow, WorkspaceBarModel } from '../../../../../platform/workspaceBar/common/workspaceBarModel.js';
import { IRecentlyOpened } from '../../../../../platform/workspaces/common/workspaces.js';
import { closeWorkspaceBarEntry, getAdjacentWorkspaceBarEntry, getWorkspaceBarEntryPath, getWorkspaceBarRenderKey, IWorkspaceBarAddPick, toWorkspaceBarAddPicks, toWorkspaceBarViewItems } from '../../../../browser/parts/workspacebar/workspaceBarViewModel.js';
import { IWorkspaceBarService } from '../../../../services/workspaceBar/common/workspaceBarService.js';

suite('WorkspaceBarViewModel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const localA = URI.file('/Users/me/alpha');
	const localB = URI.file('/Users/me/beta');
	const otherA = URI.file('/other/alpha');
	const remoteSim = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+perlmutter', path: '/global/u1/m/me/sim' });
	const remoteRuns = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+perlmutter', path: '/global/u1/m/me/runs' });
	const team = URI.file('/Users/me/team.code-workspace');

	function folderWindow(windowId: number, uri: URI): IWorkspaceBarWindow {
		return { windowId, workspace: { id: `${windowId}`, uri }, remoteAuthority: uri.scheme === 'vscode-remote' ? uri.authority : undefined };
	}

	/**
	 * Entries as they arrive in a window: window 1 shows alpha, window 2 is
	 * opened in the background, the entries on perlmutter are pinned and closed.
	 */
	function createEntries(): IWorkspaceBarEntry[] {
		const model = new WorkspaceBarModel({ version: 1, entries: [{ uri: remoteSim.toString(), kind: 'folder' }, { uri: remoteRuns.toString(), kind: 'folder' }] });
		model.reconcile([folderWindow(1, localA), folderWindow(2, otherA), folderWindow(3, localB)]);
		model.pin(model.getEntries()[2].id);
		model.setActive(3, 10);
		model.setActive(2, 20);
		model.setActive(1, 30);

		return JSON.parse(JSON.stringify(model.getEntries())); // as received over IPC
	}

	class TestWorkspaceBarService implements IWorkspaceBarService {

		declare readonly _serviceBrand: undefined;

		readonly supported = true;
		readonly onDidChangeEntries = Event.None;
		readonly whenReady = Promise.resolve();
		readonly calls: string[] = [];

		constructor(readonly windowId: number, readonly entries: readonly IWorkspaceBarEntry[]) { }

		private label(entryId: string): string {
			const entry = this.entries.find(candidate => candidate.id === entryId);

			return `${entry?.host.label}/${entry?.label}${entry?.description ? `(${entry.description})` : ''}`;
		}

		async switchTo(entryId: string): Promise<void> { this.calls.push(`switchTo ${this.label(entryId)}`); }
		async pin(entryId: string): Promise<void> { this.calls.push(`pin ${this.label(entryId)}`); }
		async unpin(entryId: string): Promise<void> { this.calls.push(`unpin ${this.label(entryId)}`); }
		async remove(entryId: string): Promise<void> { this.calls.push(`remove ${this.label(entryId)}`); }
		async closeEntryWindow(entryId: string): Promise<void> { this.calls.push(`close ${this.label(entryId)}`); }
		async reorder(entryId: string, beforeId?: string): Promise<void> { this.calls.push(`reorder ${this.label(entryId)}`); }
		async setWindowStatus(): Promise<void> { this.calls.push('setWindowStatus'); }
	}

	test('entries become host groups with tabs that know their state', () => {
		const hosts = toWorkspaceBarViewItems(createEntries(), 1);

		assert.deepStrictEqual(hosts.map(host => ({
			host: host.host.label,
			remote: host.isRemote,
			icon: host.icon.id,
			tabs: host.tabs.map(tab => ({ label: tab.entry.label, description: tab.entry.description, state: tab.state, classes: tab.classes.join(' '), selected: tab.selected }))
		})), [
			{
				host: 'Local', remote: false, icon: 'device-desktop', tabs: [
					{ label: 'alpha', description: 'me', state: 'active', classes: 'workspace-tab active', selected: true },
					{ label: 'alpha', description: 'other', state: 'background', classes: 'workspace-tab background', selected: false },
					{ label: 'beta', description: undefined, state: 'background', classes: 'workspace-tab background pinned', selected: false }
				]
			},
			{
				host: 'perlmutter', remote: true, icon: 'remote', tabs: [
					{ label: 'sim', description: undefined, state: 'closed', classes: 'workspace-tab closed pinned', selected: false },
					{ label: 'runs', description: undefined, state: 'closed', classes: 'workspace-tab closed pinned', selected: false }
				]
			}
		]);
	});

	test('a window without workspace has no active tab', () => {
		const hosts = toWorkspaceBarViewItems(createEntries(), 99);
		assert.deepStrictEqual(hosts.flatMap(host => host.tabs).filter(tab => tab.selected), []);
		assert.deepStrictEqual(toWorkspaceBarViewItems([], 1), []);
	});

	test('tabs describe themselves to assistive technology', () => {
		const tabs = toWorkspaceBarViewItems(createEntries(), 1).flatMap(host => host.tabs);

		assert.deepStrictEqual(tabs.map(tab => tab.ariaLabel), [
			'alpha (me), Local',
			'alpha (other), Local, open in background',
			'beta, Local, pinned, open in background',
			'sim, perlmutter, pinned, closed',
			'runs, perlmutter, pinned, closed'
		]);
		assert.deepStrictEqual(tabs.map(tab => tab.tooltip), [
			'/Users/me/alpha',
			'/other/alpha',
			'/Users/me/beta',
			'/global/u1/m/me/sim \u2022 perlmutter',
			'/global/u1/m/me/runs \u2022 perlmutter'
		]);
	});

	// vibe: what the agents of a window do, shown on its tab
	test('tabs carry a badge for the agents of their window: attention wins over working', () => {
		const entries = createEntries();
		const withStatus = (statuses: (IWorkspaceBarEntry['status'])[]) => toWorkspaceBarViewItems(entries.map((entry, index) => statuses[index] ? { ...entry, status: statuses[index] } : entry), 1).flatMap(host => host.tabs);

		const tabs = withStatus([
			{ working: 2, attention: 1, label: '2 working \u00b7 1 waiting' },
			{ working: 3, attention: 0 },
			{ working: 0, attention: 120 },
			{ working: 0, attention: 0, label: '1 waiting' },
			undefined
		]);
		assert.deepStrictEqual(tabs.map(tab => tab.badge), [
			{ kind: 'attention', text: '1' },
			{ kind: 'working', text: '3' },
			{ kind: 'attention', text: '99+' },
			undefined,
			undefined
		]);
		assert.deepStrictEqual(tabs.map(tab => tab.ariaLabel), [
			'alpha (me), Local, 2 agents working, 1 waiting',
			'alpha (other), Local, open in background, 3 agents working',
			'beta, Local, pinned, open in background, 120 agents waiting',
			'sim, perlmutter, pinned, closed',
			'runs, perlmutter, pinned, closed'
		]);
		assert.deepStrictEqual(tabs.map(tab => tab.tooltip), [
			'/Users/me/alpha \u2022 2 working \u00b7 1 waiting',
			'/other/alpha \u2022 3 agents working',
			'/Users/me/beta \u2022 120 agents waiting',
			'/global/u1/m/me/sim \u2022 perlmutter \u2022 1 waiting',
			'/global/u1/m/me/runs \u2022 perlmutter'
		]);

		assert.deepStrictEqual(withStatus([{ working: 1, attention: 0 }, { working: 0, attention: 1 }, { working: 1, attention: 1 }]).slice(0, 3).map(tab => tab.ariaLabel), [
			'alpha (me), Local, 1 agent working',
			'alpha (other), Local, open in background, 1 agent waiting',
			'beta, Local, pinned, open in background, 1 agent working, 1 waiting'
		]);
	});

	test('the render key changes with the status of a window, not with a status that is the same', () => {
		const entries = createEntries();
		const key = getWorkspaceBarRenderKey(entries, 1);
		const withStatus = (working: number, attention: number, label?: string) => entries.map((entry, index) => index === 1 ? { ...entry, status: { working, attention, ...(label !== undefined ? { label } : undefined) } } : entry);

		assert.notStrictEqual(getWorkspaceBarRenderKey(withStatus(1, 0), 1), key);
		assert.strictEqual(getWorkspaceBarRenderKey(withStatus(1, 0), 1), getWorkspaceBarRenderKey(withStatus(1, 0), 1));
		assert.notStrictEqual(getWorkspaceBarRenderKey(withStatus(1, 0), 1), getWorkspaceBarRenderKey(withStatus(2, 0), 1));
		assert.notStrictEqual(getWorkspaceBarRenderKey(withStatus(1, 0), 1), getWorkspaceBarRenderKey(withStatus(1, 1), 1));
		assert.notStrictEqual(getWorkspaceBarRenderKey(withStatus(1, 0), 1), getWorkspaceBarRenderKey(withStatus(1, 0, '1 working'), 1));
	});

	test('the render key changes with what is shown and with nothing else', () => {
		const entries = createEntries();
		const key = getWorkspaceBarRenderKey(entries, 1);

		assert.strictEqual(getWorkspaceBarRenderKey(createEntries(), 1), key);
		assert.strictEqual(getWorkspaceBarRenderKey(entries.map(entry => ({ ...entry, lastActiveTime: entry.lastActiveTime + 1, active: !entry.active })), 1), key);

		assert.notStrictEqual(getWorkspaceBarRenderKey(entries, 2), key);
		assert.notStrictEqual(getWorkspaceBarRenderKey([...entries].reverse(), 1), key);
		assert.notStrictEqual(getWorkspaceBarRenderKey(entries.slice(1), 1), key);
		assert.notStrictEqual(getWorkspaceBarRenderKey(entries.map(entry => ({ ...entry, pinned: !entry.pinned })), 1), key);
		assert.notStrictEqual(getWorkspaceBarRenderKey(entries.map(entry => ({ ...entry, windowId: undefined })), 1), key);
		assert.notStrictEqual(getWorkspaceBarRenderKey(entries.map(entry => ({ ...entry, label: `${entry.label}!` })), 1), key);
		assert.notStrictEqual(getWorkspaceBarRenderKey(entries.map(entry => ({ ...entry, description: 'x' })), 1), key);
	});

	test('next and previous wrap around, a window without workspace enters at either end', () => {
		const entries = createEntries();
		const labels = (windowId: number, delta: number) => {
			const entry = getAdjacentWorkspaceBarEntry(entries, windowId, delta);

			return entry ? `${entry.host.label}/${entry.label}${entry.description ? `(${entry.description})` : ''}` : undefined;
		};

		assert.deepStrictEqual([labels(1, 1), labels(1, -1), labels(3, 1), labels(3, -1)], ['Local/alpha(other)', 'perlmutter/runs', 'perlmutter/sim', 'Local/alpha(other)']);
		assert.deepStrictEqual([labels(99, 1), labels(99, -1)], ['Local/alpha(me)', 'perlmutter/runs']);
		assert.deepStrictEqual([getAdjacentWorkspaceBarEntry([], 1, 1), getAdjacentWorkspaceBarEntry(entries.slice(0, 1), 1, 1)], [undefined, undefined]);
	});

	test('closing the own window switches to the most recently used one first', async () => {
		const entries = createEntries();

		// own window: window 2 was active before window 1
		let service = new TestWorkspaceBarService(1, entries);
		await closeWorkspaceBarEntry(service, entries[0]);
		assert.deepStrictEqual(service.calls, ['switchTo Local/alpha(other)', 'close Local/alpha(me)']);

		// another window: nothing to switch
		service = new TestWorkspaceBarService(1, entries);
		await closeWorkspaceBarEntry(service, entries[2]);
		assert.deepStrictEqual(service.calls, ['close Local/beta']);

		// own window and no other window to go to
		service = new TestWorkspaceBarService(1, [entries[0], entries[3]]);
		await closeWorkspaceBarEntry(service, entries[0]);
		assert.deepStrictEqual(service.calls, ['close Local/alpha(me)']);

		// an entry that is not opened has nothing to close
		service = new TestWorkspaceBarService(1, entries);
		await closeWorkspaceBarEntry(service, entries[3]);
		assert.deepStrictEqual(service.calls, []);
	});

	test('the path to copy is what a terminal on the host understands', () => {
		const entries = createEntries();
		assert.deepStrictEqual([entries[0], entries[3]].map(getWorkspaceBarEntryPath), [localA.fsPath, '/global/u1/m/me/sim']);
	});

	test('picks to add a workspace: actions, then what was recently opened', () => {
		const recentlyOpened: IRecentlyOpened = {
			files: [{ fileUri: URI.file('/Users/me/notes.md') }],
			workspaces: [
				{ folderUri: localA },
				{ folderUri: URI.file('/Users/me/gamma'), label: '~/gamma' },
				{ folderUri: remoteSim, remoteAuthority: 'ssh-remote+perlmutter' },
				{ folderUri: URI.from({ scheme: 'vscode-remote', authority: 'wsl+Ubuntu', path: '/home/me/delta' }) },
				{ workspace: { id: 'team', configPath: team } },
				{ workspace: { id: 'remote-team', configPath: URI.file('/Users/me/cluster.code-workspace') }, remoteAuthority: 'ssh-remote+perlmutter' }
			]
		};

		const picks = toWorkspaceBarAddPicks(recentlyOpened, createEntries(), {
			connectCommand: { id: 'opensshremotes.openEmptyWindow' },
			sshHosts: [],
			getParentLabel: uri => `~${uri.path.substring('/Users/me'.length, uri.path.lastIndexOf('/'))}` || '~'
		});

		const describe = (pick: IWorkspaceBarAddPick | IQuickPickSeparator) => pick.type === 'separator'
			? `--- ${pick.label}`
			: `${pick.label} | ${pick.description ?? ''} | ${pick.action.kind}${pick.action.kind === 'open' ? ` ${pick.action.remoteAuthority ?? 'local'} ${pick.action.openable.folderUri ? 'folder' : 'workspace'}` : ''}${pick.action.kind === 'command' ? ` ${pick.action.commandId}` : ''}`;

		assert.deepStrictEqual(picks.map(describe), [
			'Open Folder... |  | openFolder',
			'Open Workspace from File... |  | openWorkspace',
			'Connect to Host... |  | command opensshremotes.openEmptyWindow',
			'--- recently opened',
			'alpha | ~ | switch',
			'gamma | ~ | open local folder',
			'sim | perlmutter \u2022 /global/u1/m/me | switch',
			'delta | WSL: Ubuntu \u2022 /home/me | open wsl+Ubuntu folder',
			'team (Workspace) | ~ | open local workspace',
			'cluster (Workspace) | perlmutter \u2022 ~ | open ssh-remote+perlmutter workspace'
		]);

		// icons tell folders, workspaces and remotes apart
		assert.deepStrictEqual(picks.filter(pick => pick.type !== 'separator').map(pick => pick.iconClass?.replace('codicon codicon-', '')), ['folder-opened', 'folder-library', 'remote', 'folder', 'folder', 'remote', 'remote', 'folder-library', 'remote']);
	});

	test('picks without anything to connect to and without history', () => {
		const picks = toWorkspaceBarAddPicks({ files: [], workspaces: [] }, [], { connectCommand: undefined, sshHosts: [], getParentLabel: () => '' });
		assert.deepStrictEqual(picks.map(pick => pick.label), ['Open Folder...', 'Open Workspace from File...']);
	});

	test('picks name the hosts of the SSH configuration instead of a generic way to connect', () => {
		const picks = toWorkspaceBarAddPicks({ files: [], workspaces: [{ folderUri: localA }] }, [], {
			connectCommand: { id: 'openremotessh.openEmptyWindow' },
			sshHosts: [{ host: 'anta', hostName: 'anta.example.edu' }, { host: 'Me', hostName: undefined }, { host: 'a+b', hostName: '10.0.0.7' }],
			getParentLabel: () => '~'
		});

		assert.deepStrictEqual(picks.map(pick => pick.type === 'separator' ? `--- ${pick.label}` : `${pick.label} | ${pick.description ?? ''} | ${pick.iconClass?.replace('codicon codicon-', '')} | ${pick.action.kind}${pick.action.kind === 'connect' ? ` ${pick.action.remoteAuthority}` : ''}`), [
			'Open Folder... |  | folder-opened | openFolder',
			'Open Workspace from File... |  | folder-library | openWorkspace',
			'--- SSH hosts',
			'anta | anta.example.edu | remote | connect ssh-remote+anta',
			'Me |  | remote | connect ssh-remote+\\x4de',
			'a+b | 10.0.0.7 | remote | connect ssh-remote+7b22686f73744e616d65223a22612b62227d',
			'--- recently opened',
			'alpha | ~ | folder | open'
		]);
	});
});
