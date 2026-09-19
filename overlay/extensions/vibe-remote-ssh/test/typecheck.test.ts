// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const extensionRoot = join(import.meta.dirname, '..');
const tsc = join(extensionRoot, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc');

// The tests run the sources through Node's type stripping, which checks nothing. When the checkout
// has its compiler installed, the extension and its tests must also pass it.
for (const project of ['tsconfig.json', 'test/tsconfig.json']) {
	test(`typecheck: ${project}`, t => {
		if (!existsSync(tsc) || !existsSync(join(extensionRoot, 'node_modules'))) {
			t.skip('typescript or the dependencies of the extension are not installed (run npm ci at the repository root)');
			return;
		}
		const result = spawnSync(process.execPath, [tsc, '-p', join(extensionRoot, project), '--noEmit', '--pretty', 'false'], { encoding: 'utf8' });
		assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
	});
}
