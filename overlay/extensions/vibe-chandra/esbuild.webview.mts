// SPDX-License-Identifier: MIT

import path from 'node:path';
import { run } from '../esbuild-webview-common.mts';

const srcDir = path.join(import.meta.dirname, 'src', 'view');
const outDir = path.join(import.meta.dirname, 'media');

run({
	entryPoints: {
		'graph': path.join(srcDir, 'webview.ts'),
	},
	srcDir: path.join(import.meta.dirname, 'src'),
	outdir: outDir,
}, process.argv);
