/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeHex, VSBuffer } from '../../../base/common/buffer.js';
import { basename, dirname, joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';

//#region Parsing

export interface ISshConfigHost {

	/**
	 * A name that `ssh <host>` connects to.
	 */
	readonly host: string;

	/**
	 * The machine behind the name, if the configuration tells it.
	 */
	readonly hostName: string | undefined;
}

export interface ISshConfigInclude {
	readonly pattern: string;

	/**
	 * How many hosts the file lists before the include.
	 */
	readonly position: number;
}

export interface ISshConfig {
	readonly hosts: ISshConfigHost[];
	readonly includes: ISshConfigInclude[];
}

/**
 * The hosts of a `ssh_config` file that one can connect to by name: patterns
 * with wildcards and negated patterns configure hosts, they do not name one.
 */
export function parseSshConfig(content: string): ISshConfig {
	const hosts: { host: string; hostName: string | undefined }[] = [];
	const includes: ISshConfigInclude[] = [];
	const seen = new Map<string, { host: string; hostName: string | undefined }>();

	let current: { host: string; hostName: string | undefined }[] = [];
	for (const line of content.split(/\r?\n/)) {
		const directive = parseDirective(line);
		if (!directive) {
			continue;
		}

		switch (directive.keyword) {
			case 'host':
				current = [];
				for (const pattern of directive.args) {
					if (pattern.startsWith('!') || /[*?]/.test(pattern)) {
						continue;
					}

					let host = seen.get(pattern);
					if (!host) {
						host = { host: pattern, hostName: undefined };
						seen.set(pattern, host);
						hosts.push(host);
					}
					current.push(host);
				}
				break;
			case 'match':
				current = [];
				break;
			case 'hostname':
				for (const host of current) {
					host.hostName ??= directive.args[0];
				}
				break;
			case 'include':
				includes.push(...directive.args.map(pattern => ({ pattern, position: hosts.length })));
				break;
		}
	}

	return { hosts, includes };
}

/**
 * `keyword arguments` or `keyword=arguments`. Arguments in double quotes
 * can contain whitespace, a `#` that starts an argument starts a comment.
 */
function parseDirective(line: string): { readonly keyword: string; readonly args: string[] } | undefined {
	const match = /^\s*(?<keyword>[A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(?<rest>.*)$/.exec(line);
	if (!match?.groups) {
		return undefined; // empty, a comment or nothing we know
	}

	const args: string[] = [];
	const tokens = /"(?<quoted>[^"]*)"|(?<plain>[^\s"]+)/g;
	for (let token = tokens.exec(match.groups.rest); token?.groups; token = tokens.exec(match.groups.rest)) {
		if (token.groups.plain?.startsWith('#')) {
			break;
		}

		args.push(token.groups.quoted ?? token.groups.plain);
	}

	return args.length > 0 ? { keyword: match.groups.keyword.toLowerCase(), args } : undefined;
}

//#endregion

//#region Includes

export interface ISshConfigFileReader {

	/**
	 * The content of a file, `undefined` if it cannot be read.
	 */
	readFile(resource: URI): Promise<string | undefined>;

	/**
	 * The names of the files of a folder, `undefined` if it cannot be read.
	 */
	readFolder(resource: URI): Promise<string[] | undefined>;
}

const MAX_INCLUDE_DEPTH = 8;

/**
 * The hosts of a `ssh_config` file and of the files it includes, in the order `ssh` reads them.
 * Includes are relative to the folder of `config`, `~` is `userHome`. Wildcards are
 * understood in the name of a file, not in the folders that lead to it.
 */
export async function collectSshConfigHosts(config: URI, userHome: URI, reader: ISshConfigFileReader): Promise<ISshConfigHost[]> {
	const hosts = new Map<string, ISshConfigHost>();
	for (const host of await readSshConfigHosts(config, dirname(config), userHome, reader, new Set(), 0)) {
		if (!hosts.has(host.host)) {
			hosts.set(host.host, host);
		}
	}

	return [...hosts.values()];
}

async function readSshConfigHosts(resource: URI, base: URI, userHome: URI, reader: ISshConfigFileReader, visited: Set<string>, depth: number): Promise<ISshConfigHost[]> {
	const key = resource.toString();
	if (visited.has(key) || depth > MAX_INCLUDE_DEPTH) {
		return [];
	}
	visited.add(key);

	const content = await reader.readFile(resource);
	if (content === undefined) {
		return [];
	}

	const config = parseSshConfig(content);
	const result: ISshConfigHost[] = [];
	let position = 0;
	for (const include of config.includes) {
		result.push(...config.hosts.slice(position, include.position));
		position = include.position;

		for (const included of await expandInclude(include.pattern, base, userHome, reader)) {
			result.push(...await readSshConfigHosts(included, base, userHome, reader, visited, depth + 1));
		}
	}
	result.push(...config.hosts.slice(position));

	return result;
}

async function expandInclude(pattern: string, base: URI, userHome: URI, reader: ISshConfigFileReader): Promise<URI[]> {
	let resource: URI;
	if (/^~[\\/]/.test(pattern)) {
		resource = joinPath(userHome, pattern.substring(2));
	} else if (/^([\\/]|[A-Za-z]:[\\/])/.test(pattern)) {
		resource = URI.file(pattern);
	} else {
		resource = joinPath(base, pattern);
	}

	const name = basename(resource);
	if (!/[*?]/.test(name)) {
		return [resource];
	}

	const folder = dirname(resource);
	const matcher = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
	const names = await reader.readFolder(folder) ?? [];

	return names.filter(candidate => matcher.test(candidate)).sort().map(candidate => joinPath(folder, candidate));
}

//#endregion

//#region Authority

const SSH_REMOTE_NAME = 'ssh-remote';

/**
 * The remote authority that connects to a host of the SSH configuration, encoded the way the
 * resolvers of `ssh-remote` decode it. URIs lower the case of an authority: upper case travels
 * as `\x<code>`. A plain authority is read as `user@host:port` and ends the name of the remote
 * at its first `+`: a host that would be misread travels as hex encoded JSON `{"hostName":...}`.
 */
export function getSshRemoteAuthority(host: string): string {
	const isPlain = /^[A-Za-z0-9._~-]+$/.test(host) && !/^([0-9a-f]{2})+$/i.test(host); // hex is taken for encoded data
	const detail = isPlain
		? host.replace(/[A-Z]/g, char => `\\x${char.charCodeAt(0).toString(16)}`)
		: encodeHex(VSBuffer.fromString(JSON.stringify({ hostName: host })));

	return `${SSH_REMOTE_NAME}+${detail}`;
}

//#endregion
