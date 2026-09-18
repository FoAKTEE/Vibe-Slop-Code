// SPDX-License-Identifier: MIT

import type { DirectoryEntry, FolderFs } from '../src/host/ledgers.ts';

/** An in-memory workspace folder. Files are keyed by their `/`-joined path; directories are implied. */
export class MemoryFs implements FolderFs {
	readonly files = new Map<string, Uint8Array>();
	reads: string[] = [];
	lists: string[] = [];
	/** Called before a read resolves: lets a test delete or change the file "mid-read", or stall the read. */
	beforeRead: (path: string) => void | Promise<void> = () => { };
	failing = new Set<string>();

	write(path: string, text: string): this {
		this.files.set(path, new TextEncoder().encode(text));
		return this;
	}

	append(path: string, text: string): this {
		const before = this.files.get(path) ?? new Uint8Array();
		const more = new TextEncoder().encode(text);
		const joined = new Uint8Array(before.length + more.length);
		joined.set(before);
		joined.set(more, before.length);
		this.files.set(path, joined);
		return this;
	}

	remove(prefix: string): this {
		for (const path of [...this.files.keys()]) {
			if (path === prefix || path.startsWith(prefix + '/')) {
				this.files.delete(path);
			}
		}
		return this;
	}

	async list(segments: readonly string[]): Promise<DirectoryEntry[] | undefined> {
		const prefix = segments.length ? segments.join('/') + '/' : '';
		this.lists.push(segments.join('/'));
		const entries = new Map<string, boolean>();
		for (const path of this.files.keys()) {
			if (path.startsWith(prefix)) {
				const rest = path.slice(prefix.length).split('/');
				entries.set(rest[0], rest.length > 1);
			}
		}
		return entries.size ? [...entries].map(([name, directory]) => ({ name, directory })) : undefined;
	}

	async read(segments: readonly string[]): Promise<Uint8Array | undefined> {
		const path = segments.join('/');
		this.reads.push(path);
		await this.beforeRead(path);
		if (this.failing.has(path)) {
			throw new Error(`EIO: ${path}`);
		}
		return this.files.get(path);
	}
}
