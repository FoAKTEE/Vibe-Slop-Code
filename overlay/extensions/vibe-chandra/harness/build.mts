// SPDX-License-Identifier: MIT

// Bundles the browser harness into one classic script: module scripts and fetch() are blocked on file://,
// so the fixtures (raw ledger text) are inlined and folded in the page by the same model code.
import path from 'node:path';
import esbuild from 'esbuild';

const here = import.meta.dirname;

await esbuild.build({
	entryPoints: { harness: path.join(here, 'main.ts') },
	outdir: path.join(here, 'dist'),
	bundle: true,
	format: 'iife',
	platform: 'browser',
	target: ['es2024'],
	sourcemap: true,
	loader: { '.jsonl': 'text' },
	logLevel: 'info',
});
