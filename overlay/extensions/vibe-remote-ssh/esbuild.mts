// SPDX-License-Identifier: MIT

import * as path from 'node:path';
import { run } from '../esbuild-extension-common.mts';

const srcDir = path.join(import.meta.dirname, 'src');
const outDir = path.join(import.meta.dirname, 'dist');

run({
	platform: 'node',
	entryPoints: {
		'extension': path.join(srcDir, 'extension.ts'),
	},
	srcDir,
	outdir: outDir,
	additionalOptions: {
		// ssh2 probes for its optional native addons inside try/catch and falls back to
		// pure JavaScript: keeping them external means packaging never needs a compiler.
		external: ['vscode', 'cpu-features', '*.node'],
		// ssh2 and friends are CommonJS: resolve `main` first, as webpack does upstream
		mainFields: ['main', 'module'],
	},
}, process.argv);
