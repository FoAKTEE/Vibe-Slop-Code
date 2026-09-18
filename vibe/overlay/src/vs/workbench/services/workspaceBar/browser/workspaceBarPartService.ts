/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IWorkspaceBarPartService = createDecorator<IWorkspaceBarPartService>('workspaceBarPartService');

/**
 * The part of the workbench that shows the workspace bar below the title bar.
 */
export interface IWorkspaceBarPartService {

	readonly _serviceBrand: undefined;

	/**
	 * Moves keyboard focus to the tab of the window, if the workspace bar is visible.
	 */
	focus(): void;
}
