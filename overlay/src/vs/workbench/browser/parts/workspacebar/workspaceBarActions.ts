/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { collectSshConfigHosts, ISshConfigHost } from '../../../../platform/workspaceBar/common/sshConfigHosts.js';
import { IWorkspaceBarEntry, sanitizeWorkspaceBarWindowStatus } from '../../../../platform/workspaceBar/common/workspaceBar.js';
import { IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { workbenchConfigurationNodeBase } from '../../../common/configuration.js';
import { IsSessionsWindowContext } from '../../../common/contextkeys.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWorkspaceBarService } from '../../../services/workspaceBar/common/workspaceBarService.js';
import { closeWorkspaceBarEntry, getAdjacentWorkspaceBarEntry, getWorkspaceBarEntryPath, IWorkspaceBarAddPick, toWorkspaceBarAddPicks, toWorkspaceBarSshHostPicks } from './workspaceBarViewModel.js';

export const WORKSPACE_BAR_VISIBLE_SETTING = 'workbench.workspaceBar.visible';

export const ADD_WORKSPACE_BAR_ENTRY_COMMAND_ID = 'workbench.action.workspaceBar.add';

//#region Context keys

export const WorkspaceBarSupportedContext = new RawContextKey<boolean>('workspaceBarSupported', false, localize('workspaceBarSupported', "Whether the window has a workspace bar"));
export const WorkspaceBarFocusedContext = new RawContextKey<boolean>('workspaceBarFocus', false, localize('workspaceBarFocus', "Whether the workspace bar has keyboard focus"));

// Context of the context menu of a tab
export const WorkspaceBarEntryPinnedContext = new RawContextKey<boolean>('workspaceBarEntryPinned', false, localize('workspaceBarEntryPinned', "Whether the entry of the workspace bar is pinned"));
export const WorkspaceBarEntryOpenedContext = new RawContextKey<boolean>('workspaceBarEntryOpened', false, localize('workspaceBarEntryOpened', "Whether the entry of the workspace bar has a window"));
export const WorkspaceBarEntryLocalFileContext = new RawContextKey<boolean>('workspaceBarEntryLocalFile', false, localize('workspaceBarEntryLocalFile', "Whether the entry of the workspace bar is a folder or workspace on the local disk"));

//#endregion

//#region Configuration

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...workbenchConfigurationNodeBase,
	'properties': {
		[WORKSPACE_BAR_VISIBLE_SETTING]: {
			'type': 'boolean',
			'default': true,
			'description': localize('workspaceBarVisibility', "Controls the visibility of the workspace bar below the title bar. The workspace bar shows the folders and workspaces of all hosts and switches between them.")
		}
	}
});

//#endregion

//#region Switching

/**
 * Switches to an entry and tells the user when that fails,
 * such as when a host cannot be reached.
 */
export async function switchToWorkspaceBarEntry(workspaceBarService: IWorkspaceBarService, notificationService: INotificationService, entry: IWorkspaceBarEntry): Promise<void> {
	if (entry.windowId === workspaceBarService.windowId) {
		return;
	}

	try {
		await workspaceBarService.switchTo(entry.id);
	} catch (error) {
		notificationService.error(localize('workspaceBar.switchFailed', "Unable to switch to '{0}': {1}", entry.label, toErrorMessage(error)));
	}
}

abstract class NavigateWorkspaceBarAction extends Action2 {

	constructor(id: string, title: ILocalizedString, private readonly delta: number, key: KeyCode) {
		super({
			id,
			title,
			category: Categories.View,
			f1: true,
			precondition: WorkspaceBarSupportedContext,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | key,
				mac: { primary: KeyMod.WinCtrl | KeyMod.CtrlCmd | key }
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const workspaceBarService = accessor.get(IWorkspaceBarService);
		const notificationService = accessor.get(INotificationService);

		await workspaceBarService.whenReady;

		const entry = getAdjacentWorkspaceBarEntry(workspaceBarService.entries, workspaceBarService.windowId, this.delta);
		if (entry) {
			await switchToWorkspaceBarEntry(workspaceBarService, notificationService, entry);
		}
	}
}

registerAction2(class extends NavigateWorkspaceBarAction {
	constructor() {
		super('workbench.action.workspaceBar.next', localize2('workspaceBar.next', "Switch to Next Workspace"), 1, KeyCode.BracketRight);
	}
});

registerAction2(class extends NavigateWorkspaceBarAction {
	constructor() {
		super('workbench.action.workspaceBar.previous', localize2('workspaceBar.previous', "Switch to Previous Workspace"), -1, KeyCode.BracketLeft);
	}
});

for (let index = 1; index <= 9; index++) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: `workbench.action.workspaceBar.switchTo${index}`,
				title: localize2('workspaceBar.switchToIndex', "Switch to Workspace {0}", index),
				category: Categories.View,
				f1: true,
				precondition: WorkspaceBarSupportedContext
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const workspaceBarService = accessor.get(IWorkspaceBarService);
			const notificationService = accessor.get(INotificationService);

			await workspaceBarService.whenReady;

			const entry = workspaceBarService.entries.at(index - 1);
			if (entry) {
				await switchToWorkspaceBarEntry(workspaceBarService, notificationService, entry);
			}
		}
	});
}

//#endregion

//#region Adding

/**
 * Commands of extensions that connect to a host, best first. The
 * menu of the remote indicator is what all remotes contribute to.
 */
const CONNECT_TO_HOST_COMMANDS = ['openremotessh.openEmptyWindow', 'opensshremotes.openEmptyWindow'];
const REMOTE_MENU_COMMAND = 'workbench.action.remote.showMenu';

function getConnectCommand(): { readonly id: string } | undefined {
	for (const id of CONNECT_TO_HOST_COMMANDS) {
		if (MenuRegistry.getCommand(id) || CommandsRegistry.getCommand(id)) {
			return { id };
		}
	}

	const hasRemoteMenu = MenuRegistry.getMenuItems(MenuId.StatusBarWindowIndicatorMenu).length > 0 || MenuRegistry.getMenuItems(MenuId.StatusBarRemoteIndicatorMenu).length > 0;

	return hasRemoteMenu && CommandsRegistry.getCommand(REMOTE_MENU_COMMAND) ? { id: REMOTE_MENU_COMMAND } : undefined;
}

const SSH_REMOTE_ACTIVATION_EVENT = 'onResolveRemoteAuthority:ssh-remote';
const SSH_CONFIG_FILE_SETTING = 'remote.SSH.configFile'; // of the extensions that resolve `ssh-remote`

/**
 * The hosts of the SSH configuration of the user, or none when no
 * extension of this window is able to connect to them.
 */
async function getSshHosts(accessor: ServicesAccessor): Promise<ISshConfigHost[]> {
	const extensionService = accessor.get(IExtensionService);
	const fileService = accessor.get(IFileService);
	const pathService = accessor.get(IPathService);
	const configurationService = accessor.get(IConfigurationService);

	await extensionService.whenInstalledExtensionsRegistered();
	if (!extensionService.extensions.some(extension => extension.activationEvents?.includes(SSH_REMOTE_ACTIVATION_EVENT))) {
		return [];
	}

	// The configuration is the one of this machine, also in a window that is connected to a host
	const userHome = pathService.userHome({ preferLocal: true });
	const configFile = configurationService.getValue<string>(SSH_CONFIG_FILE_SETTING);
	const config = typeof configFile === 'string' && configFile.trim() ? URI.file(configFile.trim().replace(/^~(?=[\\/])/, userHome.fsPath)) : joinPath(userHome, '.ssh', 'config');

	return collectSshConfigHosts(config, userHome, {
		readFile: async resource => {
			try {
				return (await fileService.readFile(resource)).value.toString();
			} catch {
				return undefined; // most users have no SSH configuration
			}
		},
		readFolder: async resource => {
			try {
				return (await fileService.resolve(resource)).children?.filter(child => child.isFile).map(child => child.name);
			} catch {
				return undefined;
			}
		}
	});
}

/**
 * Connects to a host in a window of its own: the window joins the workspace bar
 * once a folder of the host is opened in it, and this window stays as it is.
 */
function connectToHost(hostService: IHostService, remoteAuthority: string): Promise<void> {
	return hostService.openWindow({ remoteAuthority }); // a window without folder is always a new one
}

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: ADD_WORKSPACE_BAR_ENTRY_COMMAND_ID,
			title: localize2('workspaceBar.add', "Add Workspace to Workspace Bar..."),
			category: Categories.View,
			f1: true,
			precondition: WorkspaceBarSupportedContext
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const workspaceBarService = accessor.get(IWorkspaceBarService);
		const workspacesService = accessor.get(IWorkspacesService);
		const quickInputService = accessor.get(IQuickInputService);
		const fileDialogService = accessor.get(IFileDialogService);
		const hostService = accessor.get(IHostService);
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);
		const labelService = accessor.get(ILabelService);

		const [recentlyOpened, sshHosts] = await Promise.all([workspacesService.getRecentlyOpened(), getSshHosts(accessor), workspaceBarService.whenReady]);

		const pick = await quickInputService.pick<IWorkspaceBarAddPick>(toWorkspaceBarAddPicks(recentlyOpened, workspaceBarService.entries, {
			connectCommand: getConnectCommand(),
			sshHosts,
			getParentLabel: uri => labelService.getUriLabel(dirname(uri))
		}), {
			placeHolder: localize('workspaceBar.addPlaceholder', "Select a folder, workspace or host to add to the workspace bar"),
			matchOnDescription: true
		});

		// Whatever opens must leave this window alone: it joins the workspace bar as another entry
		switch (pick?.action.kind) {
			case 'openFolder':
				return fileDialogService.pickFolderAndOpen({ forceNewWindow: true });
			case 'openWorkspace':
				return fileDialogService.pickWorkspaceAndOpen({ forceNewWindow: true });
			case 'command':
				return commandService.executeCommand(pick.action.commandId);
			case 'connect':
				return connectToHost(hostService, pick.action.remoteAuthority);
			case 'switch': {
				const entryId = pick.action.entryId;
				const entry = workspaceBarService.entries.find(candidate => candidate.id === entryId);

				return entry ? switchToWorkspaceBarEntry(workspaceBarService, notificationService, entry) : undefined;
			}
			case 'open':
				return hostService.openWindow([pick.action.openable], { forceNewWindow: true, remoteAuthority: pick.action.remoteAuthority });
		}
	}
});

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.workspaceBar.connectToSshHost',
			title: localize2('workspaceBar.connectToSshHost', "Connect to SSH Host..."),
			category: Categories.View,
			f1: true,
			precondition: WorkspaceBarSupportedContext
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const hostService = accessor.get(IHostService);
		const notificationService = accessor.get(INotificationService);

		const sshHosts = await getSshHosts(accessor);
		if (sshHosts.length === 0) {
			notificationService.info(localize('workspaceBar.noSshHosts', "There is no host to connect to: either the SSH configuration names none or no extension is enabled that connects to SSH hosts."));
			return;
		}

		const pick = await quickInputService.pick(toWorkspaceBarSshHostPicks(sshHosts), {
			placeHolder: localize('workspaceBar.connectToSshHostPlaceholder', "Select a host of the SSH configuration to connect to"),
			matchOnDescription: true
		});

		if (pick?.action.kind === 'connect') {
			await connectToHost(hostService, pick.action.remoteAuthority);
		}
	}
});

//#endregion

//#region Context menu of a tab

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.workspaceBar.pin',
			title: localize2('workspaceBar.pin', "Pin"),
			menu: { id: MenuId.WorkspaceBarContext, group: '1_pin', order: 1, when: WorkspaceBarEntryPinnedContext.negate() }
		});
	}

	run(accessor: ServicesAccessor, entry: IWorkspaceBarEntry): Promise<void> {
		return accessor.get(IWorkspaceBarService).pin(entry.id);
	}
});

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.workspaceBar.unpin',
			title: localize2('workspaceBar.unpin', "Unpin"),
			menu: { id: MenuId.WorkspaceBarContext, group: '1_pin', order: 1, when: ContextKeyExpr.and(WorkspaceBarEntryPinnedContext, WorkspaceBarEntryOpenedContext) }
		});
	}

	run(accessor: ServicesAccessor, entry: IWorkspaceBarEntry): Promise<void> {
		return accessor.get(IWorkspaceBarService).unpin(entry.id);
	}
});

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.workspaceBar.closeWindow',
			title: localize2('workspaceBar.closeWindow', "Close Window"),
			menu: { id: MenuId.WorkspaceBarContext, group: '2_close', order: 1, when: WorkspaceBarEntryOpenedContext }
		});
	}

	run(accessor: ServicesAccessor, entry: IWorkspaceBarEntry): Promise<void> {
		return closeWorkspaceBarEntry(accessor.get(IWorkspaceBarService), entry);
	}
});

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.workspaceBar.remove',
			title: localize2('workspaceBar.remove', "Remove from Workspace Bar"),
			menu: { id: MenuId.WorkspaceBarContext, group: '2_close', order: 2, when: WorkspaceBarEntryOpenedContext.negate() }
		});
	}

	run(accessor: ServicesAccessor, entry: IWorkspaceBarEntry): Promise<void> {
		return accessor.get(IWorkspaceBarService).remove(entry.id);
	}
});

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.workspaceBar.copyPath',
			title: localize2('workspaceBar.copyPath', "Copy Path"),
			menu: { id: MenuId.WorkspaceBarContext, group: '3_path', order: 1 }
		});
	}

	run(accessor: ServicesAccessor, entry: IWorkspaceBarEntry): Promise<void> {
		return accessor.get(IClipboardService).writeText(getWorkspaceBarEntryPath(entry));
	}
});

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.workspaceBar.revealInOS',
			title: isWindows ? localize2('workspaceBar.revealInWindows', "Reveal in File Explorer") : isMacintosh ? localize2('workspaceBar.revealInMac', "Reveal in Finder") : localize2('workspaceBar.openContainer', "Open Containing Folder"),
			menu: { id: MenuId.WorkspaceBarContext, group: '3_path', order: 2, when: WorkspaceBarEntryLocalFileContext }
		});
	}

	run(accessor: ServicesAccessor, entry: IWorkspaceBarEntry): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand('revealFileInOS', URI.revive(entry.uri));
	}
});

//#endregion

//#region Visibility

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.toggleWorkspaceBarVisibility',
			title: {
				...localize2('toggleWorkspaceBar', "Toggle Workspace Bar Visibility"),
				mnemonicTitle: localize({ key: 'miWorkspaceBar', comment: ['&& denotes a mnemonic'] }, "&&Workspace Bar"),
			},
			category: Categories.View,
			f1: true,
			precondition: ContextKeyExpr.and(WorkspaceBarSupportedContext, IsSessionsWindowContext.negate()),
			toggled: ContextKeyExpr.equals(`config.${WORKSPACE_BAR_VISIBLE_SETTING}`, true),
			menu: [{
				id: MenuId.MenubarAppearanceMenu,
				group: '2_workbench_layout',
				order: 0,
				when: ContextKeyExpr.and(WorkspaceBarSupportedContext, IsSessionsWindowContext.negate())
			}]
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);

		return configurationService.updateValue(WORKSPACE_BAR_VISIBLE_SETTING, configurationService.getValue(WORKSPACE_BAR_VISIBLE_SETTING) === false);
	}
});

//#endregion

//#region Window status

// vibe: how extensions tell what the agents of their window do. The window is the one the command
// runs in, the argument is plain data: `{ working, attention, label? }` or nothing to clear it.
export const SET_WORKSPACE_BAR_WINDOW_STATUS_COMMAND_ID = '_workbench.workspaceBar.setWindowStatus';

CommandsRegistry.registerCommand(SET_WORKSPACE_BAR_WINDOW_STATUS_COMMAND_ID, (accessor: ServicesAccessor, status?: unknown) => {
	return accessor.get(IWorkspaceBarService).setWindowStatus(status === undefined || status === null ? undefined : sanitizeWorkspaceBarWindowStatus(status));
});

//#endregion
