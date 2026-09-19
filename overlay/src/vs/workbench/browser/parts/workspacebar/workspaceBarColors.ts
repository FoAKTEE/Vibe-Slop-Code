/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';
import { chartsGreen } from '../../../../platform/theme/common/colors/chartsColors.js';
import { descriptionForeground } from '../../../../platform/theme/common/colors/baseColors.js';
import { STATUS_BAR_REMOTE_ITEM_BACKGROUND, TAB_ACTIVE_BACKGROUND, TAB_ACTIVE_BORDER_TOP, TAB_ACTIVE_FOREGROUND, TAB_HOVER_BACKGROUND, TAB_INACTIVE_FOREGROUND, TITLE_BAR_ACTIVE_BACKGROUND, TITLE_BAR_BORDER } from '../../../common/theme.js';

// The workspace bar reads as a second, higher level tab strip below the title
// bar. All colors default to the ones of the title bar and of editor tabs so
// that the bar looks right in any theme.

export const WORKSPACE_BAR_BACKGROUND = registerColor('workspaceBar.background', TITLE_BAR_ACTIVE_BACKGROUND, localize('workspaceBarBackground', "Background color of the workspace bar. The workspace bar shows the folders and workspaces of all hosts below the title bar."));

export const WORKSPACE_BAR_BORDER = registerColor('workspaceBar.border', TITLE_BAR_BORDER, localize('workspaceBarBorder', "Color of the border that separates the workspace bar from what is below it and hosts from each other."));

export const WORKSPACE_BAR_FOREGROUND = registerColor('workspaceBar.foreground', TAB_ACTIVE_FOREGROUND, localize('workspaceBarForeground', "Foreground color of the active tab in the workspace bar: the folder or workspace of the window."));

export const WORKSPACE_BAR_INACTIVE_FOREGROUND = registerColor('workspaceBar.inactiveForeground', TAB_INACTIVE_FOREGROUND, localize('workspaceBarInactiveForeground', "Foreground color of tabs in the workspace bar that are not the active one."));

export const WORKSPACE_BAR_ACTIVE_TAB_BACKGROUND = registerColor('workspaceBar.activeTabBackground', TAB_ACTIVE_BACKGROUND, localize('workspaceBarActiveTabBackground', "Background color of the active tab in the workspace bar."));

export const WORKSPACE_BAR_ACTIVE_TAB_BORDER_TOP = registerColor('workspaceBar.activeTabBorderTop', TAB_ACTIVE_BORDER_TOP, localize('workspaceBarActiveTabBorderTop', "Color of the border on the top of the active tab in the workspace bar."));

export const WORKSPACE_BAR_HOVER_BACKGROUND = registerColor('workspaceBar.hoverBackground', TAB_HOVER_BACKGROUND, localize('workspaceBarHoverBackground', "Background color of tabs in the workspace bar when hovering."));

export const WORKSPACE_BAR_HOST_FOREGROUND = registerColor('workspaceBar.hostForeground', { dark: descriptionForeground, light: descriptionForeground, hcDark: TAB_INACTIVE_FOREGROUND, hcLight: TAB_INACTIVE_FOREGROUND }, localize('workspaceBarHostForeground', "Foreground color of the names of hosts in the workspace bar."));

export const WORKSPACE_BAR_REMOTE_HOST_FOREGROUND = registerColor('workspaceBar.remoteHostForeground', { dark: STATUS_BAR_REMOTE_ITEM_BACKGROUND, light: STATUS_BAR_REMOTE_ITEM_BACKGROUND, hcDark: WORKSPACE_BAR_HOST_FOREGROUND, hcLight: WORKSPACE_BAR_HOST_FOREGROUND }, localize('workspaceBarRemoteHostForeground', "Color of the icon that marks a remote host in the workspace bar. Defaults to the color of the remote indicator in the status bar."));

export const WORKSPACE_BAR_LIVE_INDICATOR_FOREGROUND = registerColor('workspaceBar.liveIndicatorForeground', chartsGreen, localize('workspaceBarLiveIndicatorForeground', "Color of the indicator of tabs in the workspace bar that are opened in the background."));
