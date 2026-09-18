// SPDX-License-Identifier: MIT

// Layer 3: the only file that talks to the editor. Everything it decides is decided by the pure helpers in
// ./host; this file wires them to workspace.fs, file watchers, webviews, the tree, the status bar and commands.
import * as vscode from 'vscode';
import { BurstDebouncer } from './host/debounce.ts';
import { normalizeRoot, relativeSegments } from './host/discovery.ts';
import { LedgerService, type FolderFs, type LedgerChange, type LedgerFolder, type Snapshot } from './host/ledgers.ts';
import { renderPage } from './host/page.ts';
import { statusBarText, statusBarTooltip, summarize } from './host/status.ts';
import { findNodeRow, planOpen, taskCandidates, type FileLocation } from './host/targets.ts';
import { buildTree, findTreeNode, type TreeGroup, type TreeNode } from './host/tree.ts';
import type { GraphNode } from './model/types.ts';
import type { FlowDirection, HostInbound, HostOutbound, OpenTarget } from './protocol.ts';

const GRAPH_VIEW = 'vibeChandra.graph';
const NODES_VIEW = 'vibeChandra.nodes';
const PANEL_TYPE = 'vibeChandra.graphPanel';
const PAPERS_STATE = 'vibeChandra.papers';
const SECTION = 'vibeChandra';

export function activate(context: vscode.ExtensionContext): void {
	const controller = new Controller(context);
	context.subscriptions.push(controller);
	controller.start();
}

export function deactivate(): void { }

function isNotFound(error: unknown): boolean {
	return error instanceof vscode.FileSystemError && (error.code === 'FileNotFound' || error.code === 'FileNotADirectory' || error.code === 'FileIsADirectory');
}

/** A workspace folder as the ledger service sees it. `workspace.fs` makes remote and virtual folders work like local ones. */
function folderFs(folder: vscode.Uri): FolderFs {
	const at = (segments: readonly string[]): vscode.Uri => vscode.Uri.joinPath(folder, ...segments);
	const orMissing = async <T>(read: Thenable<T>): Promise<T | undefined> => {
		try {
			return await read;
		} catch (error) {
			if (isNotFound(error)) {
				return undefined;
			}
			throw error;
		}
	};
	return {
		list: async segments => (await orMissing(vscode.workspace.fs.readDirectory(at(segments))))?.map(([name, type]) => ({ name, directory: (type & vscode.FileType.Directory) !== 0 })),
		read: segments => orMissing(vscode.workspace.fs.readFile(at(segments))),
	};
}

async function exists(uri: vscode.Uri, type: vscode.FileType): Promise<boolean> {
	try {
		return ((await vscode.workspace.fs.stat(uri)).type & type) !== 0;
	} catch {
		return false;
	}
}

function nonce(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A live webview showing the graph: the side bar view or the editor panel. */
interface Surface {
	readonly kind: 'view' | 'panel';
	readonly webview: vscode.Webview;
	ready: boolean;
	isVisible(): boolean;
}

/** The part of the Git extension's API used to show a commit. */
interface GitApi {
	readonly state: 'uninitialized' | 'initialized';
	readonly onDidChangeState: vscode.Event<unknown>;
	readonly repositories: readonly GitRepository[];
	getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitRepository {
	readonly rootUri: vscode.Uri;
	getCommit(ref: string): Promise<{ readonly hash: string }>;
}

class NodesTree implements vscode.TreeDataProvider<TreeGroup | TreeNode> {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	private groups: TreeGroup[] = [];
	private evidence = new Set<string>();

	update(snapshot: Snapshot): void {
		this.groups = buildTree(snapshot.graph);
		this.evidence = new Set(snapshot.graph.nodes.filter(n => n.evidence !== undefined).map(n => n.id));
		this.changed.fire();
	}

	find(id: string): TreeNode | undefined {
		return findTreeNode(this.groups, id)?.node;
	}

	getChildren(element?: TreeGroup | TreeNode): (TreeGroup | TreeNode)[] {
		return element === undefined ? this.groups : 'children' in element ? element.children : [];
	}

	getParent(element: TreeGroup | TreeNode): TreeGroup | undefined {
		return 'children' in element ? undefined : this.groups.find(group => group.key === element.group);
	}

	getTreeItem(element: TreeGroup | TreeNode): vscode.TreeItem {
		if ('children' in element) {
			const item = new vscode.TreeItem(element.label, element.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
			item.id = `group:${element.key}`;
			item.description = element.description;
			item.contextValue = 'group';
			return item;
		}
		const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
		item.id = `node:${element.id}`;
		item.description = element.description;
		item.tooltip = element.tooltip;
		item.iconPath = nodeIcon(element);
		item.contextValue = this.evidence.has(element.id) ? 'node evidence' : element.ghost ? 'ghost' : 'node';
		item.command = { command: 'vibeChandra.focusNode', title: vscode.l10n.t("Focus in Graph"), arguments: [element.id] };
		item.accessibilityInformation = { label: `${element.label}, ${element.ghost ? 'ghost' : element.status}${element.description ? `, ${element.description}` : ''}` };
		return item;
	}

	dispose(): void {
		this.changed.dispose();
	}
}

/** The status glyphs of the graph, as close as the icon font gets; a failing node is marked whatever its status. */
function nodeIcon(node: TreeNode): vscode.ThemeIcon {
	if (node.failing) {
		return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
	}
	if (node.ghost) {
		return new vscode.ThemeIcon('question', new vscode.ThemeColor('disabledForeground'));
	}
	const frontier = node.ready ? new vscode.ThemeColor('charts.purple') : undefined;
	switch (node.status) {
		case 'solid': return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
		case 'preliminary': return new vscode.ThemeIcon('color-mode', frontier ?? new vscode.ThemeColor('charts.yellow'));
		case 'hypothesis': return new vscode.ThemeIcon('circle-large-outline', frontier ?? new vscode.ThemeColor('charts.blue'));
		case 'blocking': return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.red'));
		case 'future': return new vscode.ThemeIcon('circle-small', frontier ?? new vscode.ThemeColor('descriptionForeground'));
		default: return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
	}
}

class Controller implements vscode.Disposable {
	private readonly context: vscode.ExtensionContext;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly ledgers: LedgerService;
	private readonly changes: BurstDebouncer<string>;
	private readonly surfaces = new Set<Surface>();
	private readonly tree = new NodesTree();
	private readonly treeView: vscode.TreeView<TreeGroup | TreeNode>;
	private readonly statusBar: vscode.StatusBarItem;
	private readonly log: vscode.LogOutputChannel;
	private watchers: vscode.Disposable[] = [];
	private panel: vscode.WebviewPanel | undefined;
	private focusedId: string | undefined;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this.log = vscode.window.createOutputChannel('Chandra', { log: true });
		this.ledgers = new LedgerService({
			folders: () => (vscode.workspace.workspaceFolders ?? []).map((folder): LedgerFolder => ({ key: folder.uri.toString(), name: folder.name, fs: folderFs(folder.uri) })),
			options: () => ({ root: this.configuration().get('ledgerRoot'), papers: context.workspaceState.get(PAPERS_STATE) ?? this.configuration().get('papers') }),
			now: () => performance.now(),
		});
		this.changes = new BurstDebouncer<string>(uris => void this.applyChanges(uris));
		this.treeView = vscode.window.createTreeView(NODES_VIEW, { treeDataProvider: this.tree, showCollapseAll: true });
		this.statusBar = vscode.window.createStatusBarItem('vibeChandra.status', vscode.StatusBarAlignment.Left, 0);
		this.statusBar.name = vscode.l10n.t("Chandra Workflow");
		this.statusBar.command = 'vibeChandra.openGraph';

		this.disposables.push(
			this.log, this.tree, this.treeView, this.statusBar,
			{ dispose: () => this.changes.dispose() },
			this.ledgers.onDidChange(snapshot => this.show(snapshot)),
			vscode.window.registerWebviewViewProvider(GRAPH_VIEW, { resolveWebviewView: view => this.resolveView(view) }),
			vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, { deserializeWebviewPanel: async panel => this.adoptPanel(panel) }),
			vscode.commands.registerCommand('vibeChandra.openGraph', () => this.openGraph()),
			vscode.commands.registerCommand('vibeChandra.focusNode', (arg?: unknown) => this.focusNode(arg)),
			vscode.commands.registerCommand('vibeChandra.selectPaper', () => this.selectPaper()),
			vscode.commands.registerCommand('vibeChandra.refresh', () => this.reload(true)),
			vscode.commands.registerCommand('vibeChandra.revealNodeInLedger', (arg?: unknown) => this.revealNodeInLedger(arg)),
			vscode.commands.registerCommand('vibeChandra.openEvidence', (arg?: unknown) => this.openEvidence(arg)),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.start()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(`${SECTION}.ledgerRoot`)) {
					this.start();
				} else if (e.affectsConfiguration(`${SECTION}.papers`)) {
					void this.reload(false);
				}
				if (e.affectsConfiguration(`${SECTION}.layoutDirection`)) {
					for (const surface of this.surfaces) {
						if (surface.ready) {
							void surface.webview.postMessage({ type: 'config', direction: this.direction(surface.kind) } satisfies HostInbound);
						}
					}
				}
			}),
		);
	}

	dispose(): void {
		vscode.Disposable.from(...this.watchers, ...this.disposables).dispose();
		this.panel?.dispose();
	}

	/** (Re)creates the watchers for the current folders and ledger root, then loads everything. */
	start(): void {
		vscode.Disposable.from(...this.watchers).dispose();
		const root = normalizeRoot(this.configuration().get('ledgerRoot')).join('/');
		this.watchers = (vscode.workspace.workspaceFolders ?? []).map(folder => {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `${root}/**`));
			const push = (uri: vscode.Uri): void => this.changes.push(uri.toString());
			return vscode.Disposable.from(watcher, watcher.onDidCreate(push), watcher.onDidChange(push), watcher.onDidDelete(push));
		});
		void this.reload(false);
	}

	private configuration(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration(SECTION);
	}

	/** `auto` follows the shape of the surface: the side bar is tall and narrow, the editor area is wide. */
	private direction(kind: Surface['kind']): FlowDirection {
		const setting = this.configuration().get('layoutDirection');
		return setting === 'td' || setting === 'lr' ? setting : kind === 'view' ? 'td' : 'lr';
	}

	// --- ledgers -------------------------------------------------------------------------------------------

	private async reload(announce: boolean): Promise<void> {
		// The snapshot is shown by the change listener, like every other one.
		const snapshot = await this.ledgers.reload();
		if (announce) {
			const { stats } = snapshot;
			vscode.window.setStatusBarMessage(vscode.l10n.t("Chandra: {0} rows of {1} ledger files in {2} ms", stats.rows, stats.files, Math.round(stats.readMs + stats.foldMs)), 4000);
		}
	}

	private async applyChanges(uris: Set<string>): Promise<void> {
		const root = normalizeRoot(this.configuration().get('ledgerRoot'));
		const changes: LedgerChange[] = [];
		for (const text of uris) {
			const uri = vscode.Uri.parse(text);
			const folder = vscode.workspace.getWorkspaceFolder(uri);
			const path = folder && relativeSegments(folder.uri.path, root, uri.path);
			if (folder && path) {
				changes.push({ folder: folder.uri.toString(), path });
			}
		}
		await this.ledgers.refresh(changes);
	}

	/** Everything that shows the ledgers follows the snapshot: the webviews, the tree, the status bar. */
	private show(snapshot: Snapshot): void {
		const { stats, graph } = snapshot;
		this.log.info(`revision ${snapshot.revision}: ${graph.nodes.length} nodes of ${snapshot.selected.join(' + ') || 'no paper'}; read ${stats.filesRead}/${stats.files} files (${stats.bytesRead} bytes, ${stats.rowsParsed} new rows) in ${stats.readMs.toFixed(1)} ms, fold ${stats.foldMs.toFixed(1)} ms`);
		for (const problem of [...snapshot.problems, ...graph.warnings]) {
			this.log.warn(problem);
		}
		this.broadcast({ type: 'graph', graph });
		this.tree.update(snapshot);
		const summary = summarize(graph);
		this.treeView.description = snapshot.selected.length === snapshot.available.length ? snapshot.selected.join(' + ') : vscode.l10n.t("{0} of {1} papers", snapshot.selected.join(' + '), snapshot.available.length);
		this.treeView.message = snapshot.problems.length ? snapshot.problems.join('\n') : undefined;
		this.treeView.badge = summary.failing ? { value: summary.failing, tooltip: vscode.l10n.t("{0} failing", summary.failing) } : undefined;
		this.statusBar.text = statusBarText(summary);
		this.statusBar.tooltip = statusBarTooltip(summary);
		if (snapshot.available.length) {
			this.statusBar.show();
		} else {
			this.statusBar.hide();
		}
	}

	// --- webviews ------------------------------------------------------------------------------------------

	private broadcast(message: HostInbound, except?: Surface): void {
		for (const surface of this.surfaces) {
			if (surface.ready && surface !== except) {
				void surface.webview.postMessage(message);
			}
		}
	}

	private attach(surface: Surface): vscode.Disposable {
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		const { webview } = surface;
		webview.options = { enableScripts: true, localResourceRoots: [media] };
		const listener = webview.onDidReceiveMessage((message: HostOutbound) => {
			if (message.type === 'ready') {
				// Sent by every incarnation of the page: a hidden view is destroyed and starts over when shown again.
				surface.ready = true;
				void webview.postMessage({ type: 'graph', graph: this.ledgers.snapshot.graph } satisfies HostInbound);
				if (this.focusedId !== undefined) {
					void webview.postMessage({ type: 'focus', id: this.focusedId } satisfies HostInbound);
				}
			} else if (message.type === 'focused') {
				this.setFocused(message.id, surface);
			} else if (message.type === 'open') {
				void this.open(message.target, surface);
			}
		});
		const asset = (name: string): string => webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
		webview.html = renderPage({
			cspSource: webview.cspSource, nonce: nonce(), styleUris: [asset('webview.css'), asset('graph.css')], scriptUri: asset('graph.js'),
			direction: this.direction(surface.kind), surface: surface.kind, title: vscode.l10n.t("Workflow Graph"),
		});
		this.surfaces.add(surface);
		return { dispose: () => { listener.dispose(); this.surfaces.delete(surface); } };
	}

	private resolveView(view: vscode.WebviewView): void {
		const attached = this.attach({ kind: 'view', webview: view.webview, ready: false, isVisible: () => view.visible });
		view.onDidDispose(() => attached.dispose());
	}

	private adoptPanel(panel: vscode.WebviewPanel): void {
		this.panel?.dispose();
		this.panel = panel;
		// A tab icon is drawn as it is (the activity bar uses its icon as a mask), so it needs a colour per theme kind.
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		panel.iconPath = { light: vscode.Uri.joinPath(media, 'chandra-light.svg'), dark: vscode.Uri.joinPath(media, 'chandra.svg') };
		const attached = this.attach({ kind: 'panel', webview: panel.webview, ready: false, isVisible: () => panel.visible });
		panel.onDidDispose(() => {
			attached.dispose();
			if (this.panel === panel) {
				this.panel = undefined;
			}
		});
	}

	private openGraph(): void {
		if (this.panel) {
			this.panel.reveal();
		} else {
			this.adoptPanel(vscode.window.createWebviewPanel(PANEL_TYPE, vscode.l10n.t("Workflow Graph"), vscode.ViewColumn.Active, { retainContextWhenHidden: true }));
		}
	}

	/** One focused node per window: the graph surfaces and the tree follow each other. */
	private setFocused(id: string, from?: Surface): void {
		if (id === this.focusedId && from) {
			return;
		}
		this.focusedId = id;
		this.broadcast({ type: 'focus', id }, from);
		const item = this.tree.find(id);
		if (item && this.treeView.visible && this.treeView.selection[0] !== item) {
			this.treeView.reveal(item, { select: true, focus: false, expand: true }).then(undefined, () => undefined);
		}
	}

	// --- commands ------------------------------------------------------------------------------------------

	private nodeOf(arg: unknown): GraphNode | undefined {
		const id = typeof arg === 'string' ? arg : typeof (arg as { id?: unknown } | undefined)?.id === 'string' ? (arg as { id: string }).id : undefined;
		return id === undefined ? undefined : this.ledgers.snapshot.graph.nodes.find(n => n.id === id);
	}

	/** The node a command is about: its argument (a tree row, an id), else the focused node, else the user picks. */
	private async resolveNode(arg: unknown, placeHolder: string, useFocused: boolean): Promise<GraphNode | undefined> {
		const given = this.nodeOf(arg) ?? (useFocused ? this.nodeOf(this.focusedId) : undefined);
		if (given) {
			return given;
		}
		const frontier = new Set(this.ledgers.snapshot.graph.frontier);
		const picks = this.ledgers.snapshot.graph.nodes.map(node => ({
			label: node.id, description: [node.ghost ? 'ghost' : node.status, frontier.has(node.id) ? 'ready' : '', node.taskId ?? ''].filter(Boolean).join(' \u00b7 '), detail: node.summary, node,
		}));
		return (await vscode.window.showQuickPick(picks, { placeHolder, matchOnDescription: true, matchOnDetail: true }))?.node;
	}

	private async focusNode(arg: unknown): Promise<void> {
		const node = await this.resolveNode(arg, vscode.l10n.t("Focus a node of the workflow graph"), false);
		if (!node) {
			return;
		}
		if (![...this.surfaces].some(surface => surface.isVisible())) {
			this.openGraph();
		}
		this.setFocused(node.id);
	}

	private async selectPaper(): Promise<void> {
		const { available, selected } = this.ledgers.snapshot;
		if (available.length === 0) {
			void vscode.window.showInformationMessage(vscode.l10n.t("No Chandra ledgers found under '{0}' in this workspace.", normalizeRoot(this.configuration().get('ledgerRoot')).join('/')));
			return;
		}
		const picked = await vscode.window.showQuickPick(available.map(paper => ({ label: paper, picked: selected.includes(paper) })), {
			canPickMany: true, placeHolder: vscode.l10n.t("Papers to show in the workflow graph (none or all: follow the vibeChandra.papers setting)"),
		});
		if (picked) {
			const all = picked.length === 0 || picked.length === available.length;
			await this.context.workspaceState.update(PAPERS_STATE, all ? undefined : picked.map(p => p.label));
			await this.reload(false);
		}
	}

	private ownerFolder(paper: string): vscode.Uri | undefined {
		const owner = this.ledgers.snapshot.owner(paper);
		return owner !== undefined ? vscode.Uri.parse(owner) : vscode.workspace.workspaceFolders?.[0]?.uri;
	}

	private async revealNodeInLedger(arg: unknown): Promise<void> {
		const node = await this.resolveNode(arg, vscode.l10n.t("Reveal a node in its knowledge ledger"), true);
		const source = node && this.ledgers.snapshot.sources.find(s => s.paper === node.paper && s.files.knowledge);
		if (!node || !source?.files.knowledge) {
			if (node) {
				void vscode.window.showInformationMessage(vscode.l10n.t("{0} has no row in a loaded knowledge ledger.", node.id));
			}
			return;
		}
		const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.Uri.parse(source.folder), ...source.files.knowledge));
		const row = findNodeRow(document.getText(), node.id);
		const selection = row ? new vscode.Range(row.line, 0, row.line, row.length) : undefined;
		const editor = await vscode.window.showTextDocument(document, { selection, viewColumn: this.besideGraph() });
		if (selection) {
			editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
		}
	}

	private async openEvidence(arg: unknown): Promise<void> {
		const node = await this.resolveNode(arg, vscode.l10n.t("Open the evidence of a node"), true);
		if (node?.evidence !== undefined) {
			await this.open({ kind: 'evidence', value: node.evidence, nodeId: node.id, paper: node.paper });
		} else if (node) {
			void vscode.window.showInformationMessage(vscode.l10n.t("{0} records no evidence yet.", node.id));
		}
	}

	// --- open targets --------------------------------------------------------------------------------------

	/** The editor group next to the graph when the graph asked (or is the active editor): opening something never covers it. */
	private besideGraph(from?: Surface): vscode.ViewColumn {
		const panel = this.panel;
		return panel?.viewColumn !== undefined && (panel.active || from?.kind === 'panel') ? panel.viewColumn + 1 : vscode.ViewColumn.Active;
	}

	private async open(target: OpenTarget, from?: Surface): Promise<void> {
		const plan = planOpen(target);
		const folder = this.ownerFolder(target.paper);
		try {
			if (plan.kind === 'url') {
				await vscode.env.openExternal(vscode.Uri.parse(plan.url));
				return;
			}
			if (plan.kind === 'commit' && await this.showCommit(plan.sha, folder)) {
				return;
			}
			if (plan.kind === 'file' && folder && await this.showFile(folder, plan.location, from)) {
				return;
			}
			if (plan.kind === 'task' && folder) {
				const root = this.ledgers.snapshot.root;
				const projects = await folderFs(folder).list(root.slice(0, -1)) ?? [];
				for (const path of taskCandidates(root, plan.paper, plan.taskId, projects.filter(e => e.directory).map(e => e.name))) {
					if (await this.showFile(folder, { path }, from)) {
						return;
					}
				}
			}
		} catch (error) {
			this.log.warn(`open ${target.kind} ${target.value}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const copy = vscode.l10n.t("Copy");
		const message = plan.kind === 'task' ? vscode.l10n.t("No task file for {0} of paper {1} in this workspace.", target.value, target.paper)
			: plan.kind === 'file' ? vscode.l10n.t("'{0}' is not a file of this workspace.", target.value)
				: plan.kind === 'commit' ? vscode.l10n.t("Commit {0} cannot be shown here.", target.value)
					: target.value;
		if (await vscode.window.showInformationMessage(message, copy) === copy) {
			await vscode.env.clipboard.writeText(target.value);
		}
	}

	private async showFile(folder: vscode.Uri, location: FileLocation, from?: Surface): Promise<boolean> {
		const uri = vscode.Uri.joinPath(folder, ...location.path);
		if (!await exists(uri, vscode.FileType.File)) {
			return false;
		}
		const selection = location.line === undefined ? undefined : new vscode.Range(location.line - 1, 0, (location.endLine ?? location.line) - 1, Number.MAX_SAFE_INTEGER);
		try {
			await vscode.window.showTextDocument(uri, { selection, viewColumn: this.besideGraph(from) });
		} catch {
			// Not text (a figure, a PDF): let the editor pick what can show it.
			await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: this.besideGraph(from) });
		}
		return true;
	}

	/** Shows a commit with the Git extension when it runs in this extension host and knows the commit. */
	private async showCommit(sha: string, folder: vscode.Uri | undefined): Promise<boolean> {
		const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
		if (!extension) {
			return false;
		}
		let api: GitApi;
		try {
			api = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
		} catch {
			return false;
		}
		if (api.state !== 'initialized') {
			await new Promise<void>(resolve => {
				const timer = setTimeout(done, 3000);
				const listener = api.onDidChangeState(done);
				function done(): void {
					clearTimeout(timer);
					listener.dispose();
					resolve();
				}
			});
		}
		const repository = (folder && api.getRepository(folder)) ?? api.repositories[0];
		const commit = await repository?.getCommit(sha).then(c => c, () => undefined);
		if (!repository || !commit) {
			return false;
		}
		await vscode.commands.executeCommand('git.viewCommit', repository.rootUri, commit.hash);
		return true;
	}
}
