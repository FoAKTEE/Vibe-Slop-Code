/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { encodeHex, VSBuffer } from '../../../../base/common/buffer.js';
import { revive } from '../../../../base/common/marshalling.js';
import { isLinux } from '../../../../base/common/platform.js';
import { extUri, extUriIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IAnyWorkspaceIdentifier } from '../../../workspace/common/workspace.js';
import { IWorkspaceBarEntry, sanitizeWorkspaceBarWindowStatus } from '../../common/workspaceBar.js';
import { getWorkspaceBarEntryId, getWorkspaceBarEntryLabel, getWorkspaceBarHost, groupWorkspaceBarEntries, IWorkspaceBarWindow, toWorkspaceBarTarget, WorkspaceBarModel } from '../../common/workspaceBarModel.js';

suite('WorkspaceBarModel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const MAX_HOST_LABEL_LENGTH = 32;

	function hexAuthority(remoteName: string, data: unknown): string {
		return `${remoteName}+${encodeHex(VSBuffer.fromString(JSON.stringify(data)))}`;
	}

	function remoteFolder(authority: string, path: string): URI {
		return URI.from({ scheme: 'vscode-remote', authority, path });
	}

	function folderWindow(windowId: number, uri: URI, remoteAuthority?: string): IWorkspaceBarWindow {
		return { windowId, workspace: { id: `folder-${windowId}`, uri }, remoteAuthority: remoteAuthority ?? (uri.scheme === 'vscode-remote' ? uri.authority : undefined) };
	}

	function workspaceWindow(windowId: number, configPath: URI, remoteAuthority?: string): IWorkspaceBarWindow {
		return { windowId, workspace: { id: `workspace-${windowId}`, configPath }, remoteAuthority };
	}

	function emptyWindow(windowId: number): IWorkspaceBarWindow {
		return { windowId, workspace: { id: `empty-${windowId}` }, remoteAuthority: undefined };
	}

	function labels(model: WorkspaceBarModel): string[] {
		return model.getEntries().map(entry => `${entry.host.label}/${entry.label}`);
	}

	function entryByLabel(model: WorkspaceBarModel, label: string): IWorkspaceBarEntry {
		const entry = model.getEntries().find(candidate => candidate.label === label);
		assert.ok(entry, `expected an entry labelled ${label}`);
		return entry;
	}

	const localA = URI.file('/Users/me/alpha');
	const localB = URI.file('/Users/me/beta');
	const localC = URI.file('/Users/me/gamma');
	const sshA = remoteFolder('ssh-remote+myhost', '/home/me/alpha');
	const sshB = remoteFolder('ssh-remote+myhost', '/home/me/beta');
	const otherA = remoteFolder('ssh-remote+otherhost', '/home/me/alpha');
	const wslA = remoteFolder('wsl+Ubuntu', '/home/me/delta');

	suite('entry id', () => {

		test('is deterministic', () => {
			assert.strictEqual(getWorkspaceBarEntryId(localA, 'folder'), getWorkspaceBarEntryId(URI.parse(localA.toString()), 'folder'));
			assert.strictEqual(getWorkspaceBarEntryId(sshA, 'folder'), getWorkspaceBarEntryId(URI.revive(JSON.parse(JSON.stringify(sshA))), 'folder'));
		});

		test('same folder on two hosts yields two ids', () => {
			const ids = new Set([
				getWorkspaceBarEntryId(URI.file('/home/me/alpha'), 'folder'),
				getWorkspaceBarEntryId(sshA, 'folder'),
				getWorkspaceBarEntryId(otherA, 'folder'),
				getWorkspaceBarEntryId(remoteFolder('wsl+Ubuntu', '/home/me/alpha'), 'folder')
			]);
			assert.strictEqual(ids.size, 4);
		});

		test('ignores a trailing path separator', () => {
			assert.strictEqual(getWorkspaceBarEntryId(URI.file('/Users/me/alpha/'), 'folder'), getWorkspaceBarEntryId(localA, 'folder'));
			assert.strictEqual(getWorkspaceBarEntryId(remoteFolder('ssh-remote+myhost', '/home/me/alpha/'), 'folder'), getWorkspaceBarEntryId(sshA, 'folder'));
			assert.ok(getWorkspaceBarEntryId(remoteFolder('ssh-remote+myhost', '/'), 'folder'));
			assert.notStrictEqual(getWorkspaceBarEntryId(remoteFolder('ssh-remote+myhost', '/'), 'folder'), getWorkspaceBarEntryId(sshA, 'folder'));
		});

		test('path casing follows the provided comparison rules', () => {
			const upper = URI.file('/Users/me/Alpha');
			const lower = URI.file('/users/me/alpha');
			assert.notStrictEqual(getWorkspaceBarEntryId(upper, 'folder', extUri), getWorkspaceBarEntryId(lower, 'folder', extUri));
			assert.strictEqual(getWorkspaceBarEntryId(upper, 'folder', extUriIgnorePathCase), getWorkspaceBarEntryId(lower, 'folder', extUriIgnorePathCase));

			// default: same rules the main process uses to find the window of a workspace
			assert.strictEqual(getWorkspaceBarEntryId(upper, 'folder') === getWorkspaceBarEntryId(lower, 'folder'), !isLinux);
			assert.strictEqual(getWorkspaceBarEntryId(remoteFolder('ssh-remote+myhost', '/home/me/Alpha'), 'folder'), getWorkspaceBarEntryId(sshA, 'folder'));
		});

		test('authority casing never matters', () => {
			assert.strictEqual(getWorkspaceBarEntryId(remoteFolder('ssh-remote+MyHost', '/home/me/alpha'), 'folder', extUri), getWorkspaceBarEntryId(sshA, 'folder', extUri));
		});

		test('kind is part of the identity', () => {
			const uri = URI.file('/Users/me/odd.code-workspace');
			assert.notStrictEqual(getWorkspaceBarEntryId(uri, 'folder'), getWorkspaceBarEntryId(uri, 'workspace'));
		});

		test('toWorkspaceBarTarget', () => {
			const folder: IAnyWorkspaceIdentifier = { id: 'a', uri: localA };
			const workspace: IAnyWorkspaceIdentifier = { id: 'b', configPath: URI.file('/Users/me/team.code-workspace') };
			const empty: IAnyWorkspaceIdentifier = { id: 'c' };

			const folderTarget = toWorkspaceBarTarget(folder);
			assert.strictEqual(folderTarget?.kind, 'folder');
			assert.strictEqual(folderTarget?.uri.toString(), localA.toString());

			const workspaceTarget = toWorkspaceBarTarget(workspace);
			assert.strictEqual(workspaceTarget?.kind, 'workspace');
			assert.strictEqual(workspaceTarget?.uri.toString(), URI.file('/Users/me/team.code-workspace').toString());

			assert.strictEqual(toWorkspaceBarTarget(empty), undefined);
			assert.strictEqual(toWorkspaceBarTarget(undefined), undefined);
		});
	});

	suite('host', () => {

		test('no authority is the local host', () => {
			assert.deepStrictEqual(getWorkspaceBarHost(localA), { id: 'local', label: 'Local', isLocal: true });
			assert.deepStrictEqual(getWorkspaceBarHost(localA, ''), { id: 'local', label: 'Local', isLocal: true });
		});

		test('ssh host is labelled by its host name', () => {
			assert.deepStrictEqual(getWorkspaceBarHost(sshA), { id: 'remote:ssh-remote+myhost', label: 'myhost', isLocal: false, remoteAuthority: 'ssh-remote+myhost' });
			assert.strictEqual(getWorkspaceBarHost(localA, 'ssh-remote+me@box.example.org').label, 'me@box.example.org');
			assert.strictEqual(getWorkspaceBarHost(localA, 'ssh-remote+\\x42uild.\\x42ox').label, 'Build.Box', 'upper case travels escaped');
		});

		test('explicit remote authority wins over the resource', () => {
			const host = getWorkspaceBarHost(URI.file('/Users/me/team.code-workspace'), 'ssh-remote+myhost');
			assert.strictEqual(host.id, 'remote:ssh-remote+myhost');
			assert.strictEqual(host.isLocal, false);
		});

		test('host ids ignore authority casing', () => {
			assert.strictEqual(getWorkspaceBarHost(localA, 'wsl+Ubuntu').id, getWorkspaceBarHost(localA, 'wsl+ubuntu').id);
			assert.strictEqual(getWorkspaceBarHost(localA, 'wsl+Ubuntu').label, 'WSL: Ubuntu');
		});

		test('well known remotes get short labels', () => {
			assert.strictEqual(getWorkspaceBarHost(localA, 'tunnel+my-box').label, 'Tunnel: my-box');
			assert.strictEqual(getWorkspaceBarHost(localA, 'codespaces+fuzzy-space-waffle').label, 'Codespaces: fuzzy-space-waffle');
			assert.strictEqual(getWorkspaceBarHost(localA, hexAuthority('dev-container', { hostPath: '/Users/me/projects/chandra', configFile: { path: '/Users/me/projects/chandra/.devcontainer/devcontainer.json' } })).label, 'Container: chandra');
			assert.strictEqual(getWorkspaceBarHost(localA, hexAuthority('attached-container', { containerName: '/funny_whale' })).label, 'Container: funny_whale');
			assert.strictEqual(getWorkspaceBarHost(localA, hexAuthority('k8s-container', { context: 'prod', podname: 'api-7f9c', namespace: 'default' })).label, 'Container: api-7f9c');
			assert.strictEqual(getWorkspaceBarHost(localA, hexAuthority('ssh-remote', { hostName: 'Build.Box' })).label, 'Build.Box');
		});

		test('unknown remotes degrade gracefully', () => {
			assert.strictEqual(getWorkspaceBarHost(localA, 'acme+build-farm').label, 'acme: build-farm');
			assert.strictEqual(getWorkspaceBarHost(localA, 'localhost:8000').label, 'localhost:8000');
			assert.strictEqual(getWorkspaceBarHost(localA, 'ssh-remote+').label, 'ssh-remote');
			assert.strictEqual(getWorkspaceBarHost(localA, '+').label, '+');
			assert.strictEqual(getWorkspaceBarHost(localA, '+').isLocal, false);
		});

		test('encoded or oversized authorities never produce long labels', () => {
			const opaqueHex = 'dev-container+' + '7b22'.padEnd(160, 'ab');
			const authorities = [
				opaqueHex,
				hexAuthority('dev-container', { unknownKey: 'x'.repeat(100) }),
				hexAuthority('dev-container', ['not', 'an', 'object']),
				hexAuthority('dev-container', 42),
				hexAuthority('dev-container', { hostPath: '/' + 'y'.repeat(200) }),
				hexAuthority('dev-container', { hostPath: '' }),
				hexAuthority('dev-container', { hostPath: 17 }),
				'dev-container+7b227d', // `{"}`: hex, but not JSON
				'dev-container+7b2', // odd length
				'ssh-remote+' + 'h'.repeat(300),
				'z'.repeat(300),
				`${'r'.repeat(300)}+x`
			];
			for (const authority of authorities) {
				const host = getWorkspaceBarHost(localA, authority);
				assert.ok(host.label.length > 0, authority);
				assert.ok(host.label.length <= MAX_HOST_LABEL_LENGTH, `${host.label} (${host.label.length})`);
				assert.strictEqual(host.remoteAuthority, authority);
			}

			// distinct opaque authorities remain distinguishable
			const one = getWorkspaceBarHost(localA, 'dev-container+' + '7b22'.padEnd(160, 'ab') + '01');
			const two = getWorkspaceBarHost(localA, 'dev-container+' + '7b22'.padEnd(160, 'ab') + '02');
			assert.notStrictEqual(one.label, two.label);
			assert.notStrictEqual(one.id, two.id);
		});

		test('virtual file systems are their own host', () => {
			const host = getWorkspaceBarHost(URI.parse('vscode-vfs://github/microsoft/vscode'));
			assert.deepStrictEqual(host, { id: 'virtual:vscode-vfs://github', label: 'github', isLocal: false });
			assert.strictEqual(getWorkspaceBarHost(URI.parse('memfs:/sample')).isLocal, true);
		});
	});

	suite('labels', () => {

		test('folder', () => {
			assert.strictEqual(getWorkspaceBarEntryLabel(localA, 'folder'), 'alpha');
			assert.strictEqual(getWorkspaceBarEntryLabel(URI.file('/Users/me/alpha/'), 'folder'), 'alpha');
			assert.strictEqual(getWorkspaceBarEntryLabel(sshA, 'folder'), 'alpha');
			assert.strictEqual(getWorkspaceBarEntryLabel(remoteFolder('ssh-remote+myhost', '/home/me/with space'), 'folder'), 'with space');
			assert.strictEqual(getWorkspaceBarEntryLabel(remoteFolder('ssh-remote+myhost', '/'), 'folder'), '/');
			assert.strictEqual(getWorkspaceBarEntryLabel(URI.file('/'), 'folder'), '/');
			assert.strictEqual(getWorkspaceBarEntryLabel(URI.parse('file:///c:/'), 'folder'), 'c:');
			assert.strictEqual(getWorkspaceBarEntryLabel(URI.file('/Users/me/odd.code-workspace'), 'folder'), 'odd.code-workspace');
		});

		test('workspace', () => {
			assert.strictEqual(getWorkspaceBarEntryLabel(URI.file('/Users/me/team.code-workspace'), 'workspace'), 'team');
			assert.strictEqual(getWorkspaceBarEntryLabel(remoteFolder('ssh-remote+myhost', '/home/me/a.b.code-workspace'), 'workspace'), 'a.b');
			assert.strictEqual(getWorkspaceBarEntryLabel(URI.file('/Users/me/.code-workspace'), 'workspace'), '.code-workspace');
			assert.strictEqual(getWorkspaceBarEntryLabel(URI.file('/Users/me/custom.json'), 'workspace'), 'custom.json');
			assert.strictEqual(getWorkspaceBarEntryLabel(URI.file('/Users/me/Library/App/Workspaces/1700000000000/workspace.json'), 'workspace'), 'Untitled (Workspace)');
		});

		test('unique labels carry no description', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), folderWindow(2, localB)]);
			assert.deepStrictEqual(model.getEntries().map(entry => entry.description), [undefined, undefined]);
		});

		test('duplicate labels within a host are disambiguated by parent segments', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([
				folderWindow(1, URI.file('/a/b/proj')),
				folderWindow(2, URI.file('/a/c/proj')),
				folderWindow(3, URI.file('/z/b/proj')),
				folderWindow(4, URI.file('/proj')),
				folderWindow(5, URI.file('/a/b/other'))
			]);
			assert.deepStrictEqual(model.getEntries().map(entry => [entry.label, entry.description]), [
				['proj', 'a/b'],
				['proj', 'c'],
				['proj', 'z/b'],
				['proj', '/'],
				['other', undefined]
			]);
		});

		test('the same label on different hosts is not a duplicate', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), folderWindow(2, sshA), folderWindow(3, otherA)]);
			assert.deepStrictEqual(model.getEntries().map(entry => entry.description), [undefined, undefined, undefined]);
		});

		test('labels that cannot be told apart by path fall back to the parent', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([
				folderWindow(1, URI.file('/a/proj')),
				workspaceWindow(2, URI.file('/a/proj.code-workspace'))
			]);
			assert.deepStrictEqual(model.getEntries().map(entry => [entry.kind, entry.label, entry.description]), [
				['folder', 'proj', 'a'],
				['workspace', 'proj', 'a']
			]);
		});
	});

	suite('reconcile', () => {

		test('lists every window that has a workspace', () => {
			const model = new WorkspaceBarModel();
			assert.deepStrictEqual(model.getEntries(), []);

			const changed = model.reconcile([folderWindow(1, localA), emptyWindow(2), workspaceWindow(3, URI.file('/Users/me/team.code-workspace'))]);
			assert.strictEqual(changed, true);

			const entries = model.getEntries();
			assert.deepStrictEqual(entries.map(entry => [entry.label, entry.kind, entry.windowId, entry.pinned, entry.active, entry.lastActiveTime]), [
				['alpha', 'folder', 1, false, false, 0],
				['team', 'workspace', 3, false, false, 0]
			]);
			assert.strictEqual(entries[0].id, getWorkspaceBarEntryId(localA, 'folder'));
			assert.strictEqual(URI.revive(entries[0].uri).toString(), localA.toString());
			assert.strictEqual(model.getEntryForWindow(3)?.label, 'team');
			assert.strictEqual(model.getEntryForWindow(2), undefined);
			assert.strictEqual(model.getEntry(entries[1].id)?.label, 'team');
			assert.strictEqual(model.getEntry('nope'), undefined);
		});

		test('is idempotent and reports changes', () => {
			const model = new WorkspaceBarModel();
			const windows = [folderWindow(1, localA), folderWindow(2, sshA)];
			assert.strictEqual(model.reconcile(windows), true);
			assert.strictEqual(model.reconcile(windows), false);
			assert.strictEqual(model.reconcile([...windows].reverse()), false);
			assert.strictEqual(model.reconcile([...windows, emptyWindow(3)]), false);
			assert.strictEqual(model.reconcile([folderWindow(1, localA)]), true);
		});

		test('keeps host groups contiguous, local first, hosts in first-seen order', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, sshA)]);
			model.reconcile([folderWindow(1, sshA), folderWindow(2, wslA)]);
			model.reconcile([folderWindow(1, sshA), folderWindow(2, wslA), folderWindow(3, localA)]);
			model.reconcile([folderWindow(1, sshA), folderWindow(2, wslA), folderWindow(3, localA), folderWindow(4, sshB)]);
			model.reconcile([folderWindow(1, sshA), folderWindow(2, wslA), folderWindow(3, localA), folderWindow(4, sshB), folderWindow(5, localB), folderWindow(6, otherA)]);

			assert.deepStrictEqual(labels(model), [
				'Local/alpha',
				'Local/beta',
				'myhost/alpha',
				'myhost/beta',
				'WSL: Ubuntu/delta',
				'otherhost/alpha'
			]);
		});

		test('new windows are added in window id order regardless of input order', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(3, localC), folderWindow(1, localA), folderWindow(2, localB)]);
			assert.deepStrictEqual(labels(model), ['Local/alpha', 'Local/beta', 'Local/gamma']);
		});

		test('closed entries disappear unless pinned', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), folderWindow(2, localB), folderWindow(3, sshA)]);
			model.pin(entryByLabel(model, 'beta').id);

			assert.strictEqual(model.reconcile([folderWindow(3, sshA)]), true);
			assert.deepStrictEqual(model.getEntries().map(entry => [entry.label, entry.pinned, entry.windowId]), [
				['beta', true, undefined],
				['alpha', false, 3]
			]);
		});

		test('a pinned entry is bound again in place when its window opens', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), folderWindow(2, localB), folderWindow(3, localC)]);
			model.pin(entryByLabel(model, 'beta').id);
			model.reconcile([folderWindow(1, localA), folderWindow(3, localC)]);
			assert.strictEqual(entryByLabel(model, 'beta').windowId, undefined);

			model.reconcile([folderWindow(1, localA), folderWindow(3, localC), folderWindow(7, URI.file('/Users/me/beta/'))]);
			assert.deepStrictEqual(model.getEntries().map(entry => [entry.label, entry.windowId]), [['alpha', 1], ['beta', 7], ['gamma', 3]]);
		});

		test('a window that loads another workspace moves to the new entry', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), folderWindow(2, localB)]);
			model.pin(entryByLabel(model, 'alpha').id);

			model.reconcile([folderWindow(1, sshA), folderWindow(2, localB)]);
			assert.deepStrictEqual(model.getEntries().map(entry => [entry.host.label, entry.label, entry.windowId]), [
				['Local', 'alpha', undefined],
				['Local', 'beta', 2],
				['myhost', 'alpha', 1]
			]);

			model.reconcile([emptyWindow(1), folderWindow(2, localB)]);
			assert.deepStrictEqual(labels(model), ['Local/alpha', 'Local/beta']);
		});

		test('two windows on the same workspace share one entry, first window wins and stays', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(5, localA), folderWindow(2, localA)]);
			assert.deepStrictEqual(model.getEntries().map(entry => entry.windowId), [2]);

			model.reconcile([folderWindow(5, localA), folderWindow(2, localA), folderWindow(1, localA)]);
			assert.deepStrictEqual(model.getEntries().map(entry => entry.windowId), [2]);

			model.reconcile([folderWindow(5, localA), folderWindow(1, localA)]);
			assert.deepStrictEqual(model.getEntries().map(entry => entry.windowId), [1]);
		});

		test('an entry follows the remote authority of its window', () => {
			const config = URI.file('/Users/me/team.code-workspace');
			const model = new WorkspaceBarModel();
			model.reconcile([workspaceWindow(1, config), folderWindow(2, localB), folderWindow(3, sshA)]);
			model.pin(entryByLabel(model, 'team').id);
			assert.deepStrictEqual(labels(model), ['Local/team', 'Local/beta', 'myhost/alpha']);

			assert.strictEqual(model.reconcile([workspaceWindow(1, config, 'ssh-remote+myhost'), folderWindow(2, localB), folderWindow(3, sshA)]), true);
			assert.deepStrictEqual(labels(model), ['Local/beta', 'myhost/alpha', 'myhost/team']);
			assert.strictEqual(entryByLabel(model, 'team').host.remoteAuthority, 'ssh-remote+myhost');
			assert.strictEqual(entryByLabel(model, 'team').pinned, true);
		});
	});

	suite('active entry and MRU', () => {

		test('setActive marks exactly one entry and records the time', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), folderWindow(2, localB), emptyWindow(3)]);

			assert.strictEqual(model.setActive(2, 100), true);
			assert.deepStrictEqual(model.getEntries().map(entry => [entry.label, entry.active, entry.lastActiveTime]), [['alpha', false, 0], ['beta', true, 100]]);

			assert.strictEqual(model.setActive(1, 200), true);
			assert.deepStrictEqual(model.getEntries().map(entry => [entry.label, entry.active, entry.lastActiveTime]), [['alpha', true, 200], ['beta', false, 100]]);

			// a window without workspace: nothing is active, times are kept
			assert.strictEqual(model.setActive(3, 300), true);
			assert.deepStrictEqual(model.getEntries().map(entry => [entry.label, entry.active, entry.lastActiveTime]), [['alpha', false, 200], ['beta', false, 100]]);

			assert.strictEqual(model.setActive(undefined, 400), false);
			assert.strictEqual(model.getEntries().some(entry => entry.active), false);
		});

		test('setActive never moves time backwards', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA)]);
			model.setActive(1, 500);
			model.setActive(1, 100);
			assert.strictEqual(entryByLabel(model, 'alpha').lastActiveTime, 500);
		});

		test('activation that precedes the window being listed is not lost', () => {
			const model = new WorkspaceBarModel();
			model.setActive(9, 1234);
			model.reconcile([folderWindow(9, localA), folderWindow(10, localB)]);
			assert.deepStrictEqual(model.getEntries().map(entry => [entry.label, entry.active, entry.lastActiveTime]), [['alpha', true, 1234], ['beta', false, 0]]);
		});

		test('the active window is forgotten once it is gone', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), folderWindow(2, localB)]);
			model.setActive(1, 10);
			model.pin(entryByLabel(model, 'alpha').id);

			assert.strictEqual(model.reconcile([folderWindow(2, localB)]), true);
			assert.strictEqual(model.getEntries().some(entry => entry.active), false);

			// a later window that reuses nothing of the old one is not active by accident
			model.reconcile([folderWindow(2, localB), folderWindow(3, localA)]);
			assert.strictEqual(model.getEntries().some(entry => entry.active), false);
		});

		test('pickNextActive reveals the most recently used other open entry', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), folderWindow(2, localB), folderWindow(3, sshA), folderWindow(4, sshB)]);
			model.setActive(3, 10);
			model.setActive(1, 20);
			model.setActive(4, 30);
			model.setActive(2, 40);

			const beta = entryByLabel(model, 'beta');
			assert.strictEqual(model.pickNextActive(beta.id)?.windowId, 4);
			assert.strictEqual(model.pickNextActive()?.windowId, 2);
			assert.strictEqual(model.pickNextActive('unknown')?.windowId, 2);
		});

		test('pickNextActive skips entries without a window', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), folderWindow(2, localB), folderWindow(3, localC)]);
			model.setActive(1, 10);
			model.setActive(2, 20);
			model.setActive(3, 30);
			model.pin(entryByLabel(model, 'beta').id);
			model.reconcile([folderWindow(1, localA), folderWindow(3, localC)]);

			assert.strictEqual(model.pickNextActive(entryByLabel(model, 'gamma').id)?.label, 'alpha');
			assert.strictEqual(model.pickNextActive(entryByLabel(model, 'alpha').id)?.label, 'gamma');

			model.reconcile([folderWindow(3, localC)]);
			assert.strictEqual(model.pickNextActive(entryByLabel(model, 'gamma').id), undefined);
			assert.strictEqual(new WorkspaceBarModel().pickNextActive(), undefined);
		});

		test('pickNextActive breaks ties by proximity, then by order', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), folderWindow(2, localB), folderWindow(3, localC), folderWindow(4, sshA)]);

			const ids = model.getEntries().map(entry => entry.id);
			assert.strictEqual(model.pickNextActive(ids[3])?.label, 'gamma');
			assert.strictEqual(model.pickNextActive(ids[0])?.label, 'beta');
			assert.strictEqual(model.pickNextActive(ids[1])?.label, 'alpha');
			assert.strictEqual(model.pickNextActive()?.label, 'alpha');
		});
	});

	suite('reorder', () => {

		function createModel(): WorkspaceBarModel {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), folderWindow(2, localB), folderWindow(3, localC), folderWindow(4, sshA), folderWindow(5, sshB)]);
			return model;
		}

		test('moves an entry before another one of the same host', () => {
			const model = createModel();
			const [alpha, beta, gamma] = model.getEntries();

			assert.strictEqual(model.reorder(gamma.id, alpha.id), true);
			assert.deepStrictEqual(labels(model), ['Local/gamma', 'Local/alpha', 'Local/beta', 'myhost/alpha', 'myhost/beta']);

			assert.strictEqual(model.reorder(gamma.id, beta.id), true);
			assert.deepStrictEqual(labels(model), ['Local/alpha', 'Local/gamma', 'Local/beta', 'myhost/alpha', 'myhost/beta']);
		});

		test('without a target moves to the end of the own host group', () => {
			const model = createModel();
			const [alpha] = model.getEntries();

			assert.strictEqual(model.reorder(alpha.id), true);
			assert.deepStrictEqual(labels(model), ['Local/beta', 'Local/gamma', 'Local/alpha', 'myhost/alpha', 'myhost/beta']);
		});

		test('a target on another host is clamped to the own host group', () => {
			const model = createModel();
			const [alpha, , , sshAlpha, sshBeta] = model.getEntries();

			assert.strictEqual(model.reorder(alpha.id, sshBeta.id), true);
			assert.deepStrictEqual(labels(model), ['Local/beta', 'Local/gamma', 'Local/alpha', 'myhost/alpha', 'myhost/beta']);

			assert.strictEqual(model.reorder(sshBeta.id, alpha.id), true);
			assert.deepStrictEqual(labels(model), ['Local/beta', 'Local/gamma', 'Local/alpha', 'myhost/beta', 'myhost/alpha']);

			assert.strictEqual(model.reorder(sshBeta.id, alpha.id), false);
			assert.strictEqual(model.reorder(sshAlpha.id), false);
		});

		test('no-ops and unknown ids report no change', () => {
			const model = createModel();
			const [alpha, beta, gamma] = model.getEntries();
			const before = labels(model);

			assert.strictEqual(model.reorder(alpha.id, alpha.id), false);
			assert.strictEqual(model.reorder(alpha.id, beta.id), false);
			assert.strictEqual(model.reorder(gamma.id), false);
			assert.strictEqual(model.reorder('unknown', alpha.id), false);
			assert.strictEqual(model.reorder(alpha.id, 'unknown'), false);
			assert.deepStrictEqual(labels(model), before);
		});

		test('user order survives windows closing and opening', () => {
			const model = createModel();
			const [alpha, , gamma] = model.getEntries();
			model.reorder(gamma.id, alpha.id);
			model.reconcile([folderWindow(1, localA), folderWindow(3, localC), folderWindow(4, sshA), folderWindow(6, URI.file('/Users/me/epsilon'))]);
			assert.deepStrictEqual(labels(model), ['Local/gamma', 'Local/alpha', 'Local/epsilon', 'myhost/alpha']);
		});
	});

	suite('pin, unpin, remove', () => {

		test('pin and unpin an open entry', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA)]);
			const id = entryByLabel(model, 'alpha').id;

			assert.strictEqual(model.pin(id), true);
			assert.strictEqual(model.pin(id), false);
			assert.strictEqual(entryByLabel(model, 'alpha').pinned, true);

			assert.strictEqual(model.unpin(id), true);
			assert.strictEqual(model.unpin(id), false);
			assert.deepStrictEqual(model.getEntries().map(entry => [entry.label, entry.pinned, entry.windowId]), [['alpha', false, 1]]);

			assert.strictEqual(model.pin('unknown'), false);
			assert.strictEqual(model.unpin('unknown'), false);
			assert.strictEqual(model.remove('unknown'), false);
		});

		test('unpinning a closed entry makes it disappear', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), folderWindow(2, localB)]);
			const id = entryByLabel(model, 'alpha').id;
			model.pin(id);
			model.reconcile([folderWindow(2, localB)]);
			assert.deepStrictEqual(labels(model), ['Local/alpha', 'Local/beta']);

			assert.strictEqual(model.unpin(id), true);
			assert.deepStrictEqual(labels(model), ['Local/beta']);
		});

		test('removing an open entry only unpins it', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA)]);
			const id = entryByLabel(model, 'alpha').id;

			assert.strictEqual(model.remove(id), false);
			model.pin(id);
			assert.strictEqual(model.remove(id), true);
			assert.deepStrictEqual(model.getEntries().map(entry => [entry.label, entry.pinned, entry.windowId]), [['alpha', false, 1]]);
		});

		test('removing a pinned closed entry deletes it', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), folderWindow(2, localB)]);
			const id = entryByLabel(model, 'alpha').id;
			model.pin(id);
			model.reconcile([folderWindow(2, localB)]);

			assert.strictEqual(model.remove(id), true);
			assert.deepStrictEqual(labels(model), ['Local/beta']);
			assert.deepStrictEqual(model.serialize().entries, []);
		});
	});

	suite('persisted state', () => {

		test('only pinned entries are persisted, in order, and restored as closed', () => {
			const config = URI.file('/Users/me/team.code-workspace');
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), folderWindow(2, localB), folderWindow(3, sshA), workspaceWindow(4, config, 'ssh-remote+myhost')]);
			model.setActive(3, 77);
			for (const label of ['beta', 'alpha', 'team']) {
				model.pin(entryByLabel(model, label).id);
			}
			model.pin(model.getEntries()[2].id);
			model.reorder(entryByLabel(model, 'beta').id, model.getEntries()[0].id);

			const state = model.serialize();
			assert.deepStrictEqual(state, {
				version: 1,
				entries: [
					{ uri: localB.toString(), kind: 'folder', lastActiveTime: 0 },
					{ uri: localA.toString(), kind: 'folder', lastActiveTime: 0 },
					{ uri: sshA.toString(), kind: 'folder', remoteAuthority: 'ssh-remote+myhost', lastActiveTime: 77 },
					{ uri: config.toString(), kind: 'workspace', remoteAuthority: 'ssh-remote+myhost', lastActiveTime: 0 }
				]
			});

			for (const raw of [state, JSON.parse(JSON.stringify(state)), JSON.stringify(state)]) {
				const restored = new WorkspaceBarModel(raw);
				assert.deepStrictEqual(restored.getEntries().map(entry => [entry.host.label, entry.label, entry.pinned, entry.windowId, entry.active, entry.lastActiveTime]), [
					['Local', 'beta', true, undefined, false, 0],
					['Local', 'alpha', true, undefined, false, 0],
					['myhost', 'alpha', true, undefined, false, 77],
					['myhost', 'team', true, undefined, false, 0]
				]);
				assert.deepStrictEqual(restored.getEntries().map(entry => entry.id), model.getEntries().map(entry => entry.id));
				assert.deepStrictEqual(restored.serialize(), state);
			}
		});

		test('unpinned entries are never persisted', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA)]);
			assert.deepStrictEqual(model.serialize(), { version: 1, entries: [] });
		});

		test('restored entries are bound to the windows that open them', () => {
			const model = new WorkspaceBarModel({ version: 1, entries: [{ uri: sshA.toString(), kind: 'folder' }, { uri: localA.toString(), kind: 'folder' }] });
			assert.deepStrictEqual(labels(model), ['Local/alpha', 'myhost/alpha']);

			model.reconcile([folderWindow(4, sshA), folderWindow(5, localB)]);
			assert.deepStrictEqual(model.getEntries().map(entry => [entry.host.label, entry.label, entry.pinned, entry.windowId]), [
				['Local', 'alpha', true, undefined],
				['Local', 'beta', false, 5],
				['myhost', 'alpha', true, 4]
			]);
		});

		test('corrupt or older state yields an empty model and never throws', () => {
			const cyclic: Record<string, unknown> = { version: 1 };
			cyclic.entries = cyclic;

			const inputs: unknown[] = [
				undefined,
				null,
				0,
				42,
				true,
				'',
				'not json',
				'{"version":1,"entries":',
				'[]',
				[],
				[{ uri: localA.toString(), kind: 'folder' }],
				{},
				{ version: 1 },
				{ version: 1, entries: null },
				{ version: 1, entries: 'nope' },
				{ version: 1, entries: { 0: { uri: localA.toString(), kind: 'folder' } } },
				{ version: 0, entries: [{ uri: localA.toString(), kind: 'folder' }] },
				{ version: '1', entries: [{ uri: localA.toString(), kind: 'folder' }] },
				{ version: NaN, entries: [{ uri: localA.toString(), kind: 'folder' }] },
				{ entries: [{ uri: localA.toString(), kind: 'folder' }] },
				cyclic
			];
			for (const input of inputs) {
				const model = new WorkspaceBarModel(input);
				assert.deepStrictEqual(model.getEntries(), []);
				assert.deepStrictEqual(model.serialize(), { version: 1, entries: [] });
			}
		});

		test('invalid entries are skipped, valid ones survive', () => {
			const model = new WorkspaceBarModel({
				version: 1,
				entries: [
					null,
					17,
					'file:///Users/me/alpha',
					{},
					{ uri: 17, kind: 'folder' },
					{ uri: '', kind: 'folder' },
					{ uri: 'no-scheme/relative', kind: 'folder' },
					{ uri: 'bad scheme://authority/path', kind: 'folder' },
					{ uri: 'foo:////path-without-authority', kind: 'folder' },
					{ uri: 'vscode-remote://ssh-remote+myhost', kind: 'folder' },
					{ uri: localC.toString(), kind: 'banana' },
					{ uri: localB.toString() },
					{ uri: localA.toString(), kind: 'folder', remoteAuthority: 42, lastActiveTime: 'yesterday' },
					{ uri: URI.file('/Users/me/alpha/').toString(), kind: 'folder', lastActiveTime: 9 },
					{ uri: sshA.toString(), kind: 'folder', lastActiveTime: -5, extra: { nested: true } }
				]
			});
			assert.deepStrictEqual(model.getEntries().map(entry => [entry.host.label, entry.label, entry.pinned, entry.lastActiveTime]), [
				['Local', 'alpha', true, 0],
				['myhost', 'alpha', true, 0]
			]);
		});

		test('state written by a newer version is read on a best effort basis', () => {
			const model = new WorkspaceBarModel({ version: 99, future: true, entries: [{ uri: localA.toString(), kind: 'folder', colour: 'red' }, { uri: localB.toString(), kind: 'tab-group' }] });
			assert.deepStrictEqual(labels(model), ['Local/alpha']);
		});
	});

	// vibe: what the agents of a window do, shown on its tab
	suite('window status', () => {

		function statuses(model: WorkspaceBarModel): (string | undefined)[] {
			return model.getEntries().map(entry => entry.status ? `${entry.label}:${entry.status.working}/${entry.status.attention}${entry.status.label ? `:${entry.status.label}` : ''}` : undefined);
		}

		test('is merged into the entry of its window, as plain data, and only there', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), folderWindow(2, sshA)]);

			assert.strictEqual(model.setWindowStatus(2, { working: 2, attention: 1, label: '2 working, 1 waiting' }), true);
			assert.deepStrictEqual(statuses(model), [undefined, 'alpha:2/1:2 working, 1 waiting']);
			assert.strictEqual(Object.keys(model.getEntries()[0]).includes('status'), false, 'optional properties are left out');
			assert.deepStrictEqual(JSON.parse(JSON.stringify(model.getEntries()))[1].status, { working: 2, attention: 1, label: '2 working, 1 waiting' });
		});

		test('setting what is set already changes nothing', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA)]);

			assert.deepStrictEqual([
				model.setWindowStatus(1, { working: 1, attention: 0 }),
				model.setWindowStatus(1, { working: 1, attention: 0 }),
				model.setWindowStatus(1, { working: 1, attention: 0, label: 'now with a label' }),
				model.setWindowStatus(1, undefined),
				model.setWindowStatus(1, undefined),
				model.setWindowStatus(7, undefined)
			], [true, false, true, true, false, false]);
			assert.deepStrictEqual(statuses(model), [undefined]);
		});

		test('of a window without entry is kept and shows once the window has one', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), emptyWindow(2)]);

			assert.strictEqual(model.setWindowStatus(2, { working: 1, attention: 0 }), false, 'no entry shows it');
			assert.deepStrictEqual(statuses(model), [undefined]);

			model.reconcile([folderWindow(1, localA), folderWindow(2, localB)]);
			assert.deepStrictEqual(statuses(model), [undefined, 'beta:1/0']);
		});

		test('goes away with its window, a pinned entry that stays around loses it', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), folderWindow(2, localB)]);
			model.pin(entryByLabel(model, 'beta').id);
			model.setWindowStatus(1, { working: 1, attention: 0 });
			model.setWindowStatus(2, { working: 0, attention: 3 });

			assert.strictEqual(model.reconcile([folderWindow(1, localA)]), true);
			assert.deepStrictEqual(statuses(model), ['alpha:1/0', undefined]);

			// a new window that happens to show the entry again starts without status
			model.reconcile([folderWindow(1, localA), folderWindow(3, localB)]);
			assert.deepStrictEqual(statuses(model), ['alpha:1/0', undefined]);
		});

		test('follows its window to the entry of another folder', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA)]);
			model.setWindowStatus(1, { working: 1, attention: 0 });

			model.reconcile([folderWindow(1, localC)]);
			assert.deepStrictEqual(statuses(model), ['gamma:1/0']);
		});

		test('is not persisted', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA)]);
			model.pin(entryByLabel(model, 'alpha').id);
			const before = JSON.stringify(model.serialize());

			model.setWindowStatus(1, { working: 4, attention: 2 });
			assert.strictEqual(JSON.stringify(model.serialize()), before);
		});

		test('what arrives from a window is sanitized', () => {
			assert.deepStrictEqual([
				sanitizeWorkspaceBarWindowStatus({ working: 2, attention: 1, label: ' 2 working ' }),
				sanitizeWorkspaceBarWindowStatus({ working: 2.9, attention: -4, other: 'dropped' }),
				sanitizeWorkspaceBarWindowStatus({ working: '3', attention: Number.NaN, label: 7 }),
				sanitizeWorkspaceBarWindowStatus({ working: 1e9, attention: 0, label: 'x'.repeat(1000) })?.working,
				sanitizeWorkspaceBarWindowStatus({ working: 1, attention: 0, label: 'x'.repeat(1000) })?.label?.length,
				sanitizeWorkspaceBarWindowStatus({ working: 0, attention: 0 }),
				sanitizeWorkspaceBarWindowStatus({ working: 0, attention: 0, label: '1 waiting' }),
				sanitizeWorkspaceBarWindowStatus(undefined),
				sanitizeWorkspaceBarWindowStatus(null),
				sanitizeWorkspaceBarWindowStatus('2 working'),
				sanitizeWorkspaceBarWindowStatus([1, 2])
			], [
				{ working: 2, attention: 1, label: '2 working' },
				{ working: 2, attention: 0 },
				{ working: 0, attention: 0 },
				9999,
				200,
				{ working: 0, attention: 0 },
				{ working: 0, attention: 0, label: '1 waiting' },
				undefined,
				undefined,
				undefined,
				undefined
			]);
		});
	});

	suite('wire format', () => {

		test('entries survive JSON marshalling', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, localA), folderWindow(2, sshA), folderWindow(3, URI.file('/other/alpha'))]);
			model.setActive(2, 5);
			const entries = model.getEntries();

			// events: plain JSON, uri stays `UriComponents`
			const overEvent: IWorkspaceBarEntry[] = JSON.parse(JSON.stringify(entries));
			assert.deepStrictEqual(overEvent.map(entry => URI.revive(entry.uri).toString()), [localA.toString(), URI.file('/other/alpha').toString(), sshA.toString()]);
			assert.deepStrictEqual(overEvent.map(entry => ({ ...entry, uri: undefined })), entries.map(entry => ({ ...entry, uri: undefined })));

			// calls: results are revived
			const overCall = revive<IWorkspaceBarEntry[]>(JSON.parse(JSON.stringify(entries)));
			assert.ok(overCall.every(entry => URI.isUri(entry.uri)));
			assert.deepStrictEqual(overCall.map(entry => getWorkspaceBarEntryId(URI.revive(entry.uri), entry.kind)), entries.map(entry => entry.id));
		});

		test('groupWorkspaceBarEntries groups by host in order of appearance', () => {
			const model = new WorkspaceBarModel();
			model.reconcile([folderWindow(1, sshA), folderWindow(2, localA), folderWindow(3, sshB), folderWindow(4, wslA)]);

			const wire: IWorkspaceBarEntry[] = JSON.parse(JSON.stringify(model.getEntries()));
			assert.deepStrictEqual(groupWorkspaceBarEntries(wire).map(group => [group.host.label, group.entries.map(entry => entry.label)]), [
				['Local', ['alpha']],
				['myhost', ['alpha', 'beta']],
				['WSL: Ubuntu', ['delta']]
			]);
			assert.deepStrictEqual(groupWorkspaceBarEntries([]), []);

			// tolerates input that is not contiguous
			const shuffled = [wire[1], wire[0], wire[2]];
			assert.deepStrictEqual(groupWorkspaceBarEntries(shuffled).map(group => group.entries.map(entry => entry.label)), [['alpha', 'beta'], ['alpha']]);
		});
	});
});
