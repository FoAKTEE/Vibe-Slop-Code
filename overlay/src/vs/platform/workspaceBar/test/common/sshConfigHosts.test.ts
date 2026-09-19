/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { encodeHex, VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { collectSshConfigHosts, getSshRemoteAuthority, ISshConfigFileReader, parseSshConfig } from '../../common/sshConfigHosts.js';
import { getWorkspaceBarHost } from '../../common/workspaceBarModel.js';

suite('SshConfigHosts', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseSshConfig', () => {

		test('lists the concrete hosts with their host name', () => {
			const config = [
				'# my machines',
				'Host anta',
				'    HostName anta.example.edu',
				'    User me',
				'',
				'host Build.Box',
				'\thostname=10.0.0.7',
				'Host=equals',
				'  HostName = equals.example.org # a comment',
				'Host "quoted name" plain',
				'Host bare'
			].join('\n');

			assert.deepStrictEqual(parseSshConfig(config), {
				hosts: [
					{ host: 'anta', hostName: 'anta.example.edu' },
					{ host: 'Build.Box', hostName: '10.0.0.7' },
					{ host: 'equals', hostName: 'equals.example.org' },
					{ host: 'quoted name', hostName: undefined },
					{ host: 'plain', hostName: undefined },
					{ host: 'bare', hostName: undefined }
				],
				includes: []
			});
		});

		test('skips wildcard and negated patterns, keeps what is concrete next to them', () => {
			const config = [
				'Host *',
				'  ServerAliveInterval 60',
				'Host *.example.org !bastion.example.org gate',
				'  HostName gate.example.org',
				'Host node?',
				'Host 10.0.0.*',
				'Host jump',
				'Match host anta exec "true"',
				'  HostName never.a.host',
				'Host last'
			].join('\r\n');

			assert.deepStrictEqual(parseSshConfig(config), {
				hosts: [
					{ host: 'gate', hostName: 'gate.example.org' },
					{ host: 'jump', hostName: undefined },
					{ host: 'last', hostName: undefined }
				],
				includes: []
			});
		});

		test('a host that is listed twice is listed once, the first host name wins', () => {
			assert.deepStrictEqual(parseSshConfig('Host a\nHostName one\nHostName two\nHost a b\nHostName three').hosts, [
				{ host: 'a', hostName: 'one' },
				{ host: 'b', hostName: 'three' }
			]);
		});

		test('reports includes where they are', () => {
			assert.deepStrictEqual(parseSshConfig('Include ~/.orbstack/ssh/config "config.d/my hosts" /etc/ssh/extra\nHost a\n  include nested').includes, [
				{ pattern: '~/.orbstack/ssh/config', position: 0 },
				{ pattern: 'config.d/my hosts', position: 0 },
				{ pattern: '/etc/ssh/extra', position: 0 },
				{ pattern: 'nested', position: 1 }
			]);
		});

		test('garbage in, nothing out', () => {
			assert.deepStrictEqual(parseSshConfig(''), { hosts: [], includes: [] });
			assert.deepStrictEqual(parseSshConfig('\u0000\u0001 binary\nHost\nHostName orphan\n"unterminated'), { hosts: [], includes: [] });
		});
	});

	suite('collectSshConfigHosts', () => {

		const home = URI.file('/Users/me');
		const config = URI.file('/Users/me/.ssh/config');

		function reader(files: Record<string, string>): ISshConfigFileReader {
			return {
				readFile: async resource => files[resource.path],
				readFolder: async resource => {
					const prefix = resource.path + '/';
					const names = Object.keys(files).filter(path => path.startsWith(prefix) && !path.substring(prefix.length).includes('/')).map(path => path.substring(prefix.length));

					return names.length > 0 ? names : undefined;
				}
			};
		}

		test('no config file, no hosts', async () => {
			assert.deepStrictEqual(await collectSshConfigHosts(config, home, reader({})), []);
		});

		test('includes are expanded in place: relative to the config, to the home, absolute and with wildcards', async () => {
			const hosts = await collectSshConfigHosts(config, home, reader({
				'/Users/me/.ssh/config': 'Host first\nInclude config.d/*.conf ~/.orbstack/ssh/config\nInclude /opt/ssh/extra missing\nHost last\nHost first\n  HostName ignored',
				'/Users/me/.ssh/config.d/b.conf': 'Host b',
				'/Users/me/.ssh/config.d/a.conf': 'Host a\n  HostName a.example.org',
				'/Users/me/.ssh/config.d/notes.txt': 'Host never',
				'/Users/me/.orbstack/ssh/config': 'Host orb',
				'/opt/ssh/extra': 'Host extra'
			}));

			assert.deepStrictEqual(hosts.map(host => host.host), ['first', 'a', 'b', 'orb', 'extra', 'last']);
			assert.strictEqual(hosts[1].hostName, 'a.example.org');
		});

		test('includes that include each other end', async () => {
			const hosts = await collectSshConfigHosts(config, home, reader({
				'/Users/me/.ssh/config': 'Include other\nHost a',
				'/Users/me/.ssh/other': 'Include config\nHost b'
			}));

			assert.deepStrictEqual(hosts.map(host => host.host), ['b', 'a']);
		});
	});

	suite('getSshRemoteAuthority', () => {

		/**
		 * What the resolver of the `ssh-remote` authority does with the part after the `+`.
		 */
		function decodeAsResolver(authority: string): string {
			const [, dest] = authority.split('+');
			if (/^([0-9a-f]{2})+$/.test(dest)) {
				try {
					return JSON.parse(VSBuffer.wrap(Uint8Array.from(dest.match(/../g)!.map(byte => parseInt(byte, 16)))).toString()).hostName;
				} catch {
					// not JSON
				}
			}

			return dest.replace(/\\x([0-9a-f]{2})/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
		}

		test('plain hosts stay readable, upper case is escaped as the resolver escapes it', () => {
			assert.deepStrictEqual(['anta', 'gpu-01.example.org', 'Me', 'Build.Box'].map(getSshRemoteAuthority), [
				'ssh-remote+anta',
				'ssh-remote+gpu-01.example.org',
				'ssh-remote+\\x4de',
				'ssh-remote+\\x42uild.\\x42ox'
			]);
		});

		test('what the plain form cannot carry travels as hex encoded JSON', () => {
			assert.deepStrictEqual(['a+b', 'deadbeef'].map(getSshRemoteAuthority), [
				`ssh-remote+${encodeHex(VSBuffer.fromString('{"hostName":"a+b"}'))}`,
				`ssh-remote+${encodeHex(VSBuffer.fromString('{"hostName":"deadbeef"}'))}` // the resolver would take it for encoded data
			]);
		});

		test('every host survives the round trip: authority -> resolver, authority -> label of the workspace bar', () => {
			const hosts = ['anta', 'Me', 'Build.Box', 'a+b', 'with space', 'user@host', 'host:2222', 'UPPER+plus', 'h\u00f6st', 'deadbeef', '7b7d'];
			const pathLikeHosts = ['sl/ash', 'back\\slash']; // the label is their last segment
			const authorities = [...hosts, ...pathLikeHosts].map(getSshRemoteAuthority);

			assert.deepStrictEqual(authorities.map(decodeAsResolver), [...hosts, ...pathLikeHosts]);
			assert.deepStrictEqual(authorities.map(authority => getWorkspaceBarHost(URI.file('/unused'), authority).label), [...hosts, 'ash', 'slash']);
			assert.deepStrictEqual(authorities.filter(authority => authority !== authority.toLowerCase() || authority.indexOf('+') !== authority.lastIndexOf('+')), [], 'an authority has no upper case (URIs lower it) and one + (it ends the name of the remote)');
		});
	});
});
