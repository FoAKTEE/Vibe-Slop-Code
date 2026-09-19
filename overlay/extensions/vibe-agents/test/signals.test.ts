// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignalParser, decodeShellIntegrationValue, isMeaningfulLine, type Signal } from '../src/model/signals.ts';

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;

function parse(...chunks: string[]): Signal[] {
	const parser = new SignalParser();
	return chunks.flatMap(chunk => parser.push(chunk));
}

/** Every way to cut `data` in two, to prove that a chunk border is invisible wherever it falls. */
function everySplit(data: string): string[][] {
	const splits: string[][] = [];
	for (let i = 1; i < data.length; i++) {
		splits.push([data.slice(0, i), data.slice(i)]);
	}
	return splits;
}

function kinds(signals: readonly Signal[]): string[] {
	return signals.map(signal => signal.kind);
}

test('a bell in plain output is a bell', () => {
	assert.deepEqual(parse(`done${BEL}\r\n`), [{ kind: 'bell' }, { kind: 'text', line: 'done', transient: false }]);
});

test('the BEL that terminates an OSC is not a bell', () => {
	// As written by a shell prompt: title, then the prompt text
	assert.deepEqual(parse(`${ESC}]0;me@mac: ~/Chandra${BEL}$ `), [{ kind: 'title', text: 'me@mac: ~/Chandra' }]);
	// OSC 9 ends with BEL and is followed by a real bell: exactly one of each
	assert.deepEqual(parse(`${ESC}]9;Turn complete${BEL}${BEL}`), [
		{ kind: 'notification', source: 'osc9', body: 'Turn complete' },
		{ kind: 'bell' },
	]);
});

test('an OSC may end with ST instead of BEL', () => {
	assert.deepEqual(parse(`${ESC}]2;build${ST}${ESC}]9;Agent turn complete${ST}`), [
		{ kind: 'title', text: 'build' },
		{ kind: 'notification', source: 'osc9', body: 'Agent turn complete' },
	]);
});

test('chunks split anywhere give the same signals', () => {
	const data = `${ESC}[?25l${ESC}[2K\rworking ${ESC}[32m3s${ESC}[0m${ESC}]9;Turn complete${BEL}${BEL}${ESC}]777;notify;Codex;Approval needed${ST}${ESC}]0;my title${BEL}final line\r\n`;
	const expected = parse(data);
	assert.deepEqual(kinds(expected), ['mode', 'notification', 'bell', 'notification', 'title', 'text']);
	for (const chunks of everySplit(data)) {
		assert.deepEqual(parse(...chunks), expected, `split at ${chunks[0].length}`);
	}
	// and one character at a time
	assert.deepEqual(parse(...data), expected);
});

test('OSC 9: a desktop notification, but never the ConEmu sub commands (9;4 is progress)', () => {
	assert.deepEqual(parse(`${ESC}]9;4;3;0${BEL}`), [{ kind: 'progress', state: 3, value: 0 }]);
	assert.deepEqual(parse(`${ESC}]9;4;1;42${ST}`), [{ kind: 'progress', state: 1, value: 42 }]);
	assert.deepEqual(parse(`${ESC}]9;4;0${BEL}`), [{ kind: 'progress', state: 0 }]);
	assert.deepEqual(parse(`${ESC}]9;9;/home/me${BEL}`), [{ kind: 'cwd', path: '/home/me' }], 'ConEmu/Windows Terminal working directory: no notification');
	assert.deepEqual(parse(`${ESC}]9;12${BEL}${ESC}]9;1;500${BEL}`), [], 'other ConEmu commands');
	assert.deepEqual(parse(`${ESC}]9;\n\nNeeds your input${BEL}`), [{ kind: 'notification', source: 'osc9', body: 'Needs your input' }]);
	assert.deepEqual(parse(`${ESC}]9;3 tests failed; see log${BEL}`), [{ kind: 'notification', source: 'osc9', body: '3 tests failed; see log' }]);
});

test('OSC 777 notify carries a title and a body', () => {
	assert.deepEqual(parse(`${ESC}]777;notify;Codex;Turn complete; 3 files changed${BEL}`), [
		{ kind: 'notification', source: 'osc777', title: 'Codex', body: 'Turn complete; 3 files changed' },
	]);
	assert.deepEqual(parse(`${ESC}]777;notify;Only a title${BEL}`), [{ kind: 'notification', source: 'osc777', body: 'Only a title' }]);
	assert.deepEqual(parse(`${ESC}]777;precmd${BEL}`), [], 'other OSC 777 sub commands are no notification');
});

test('OSC 99 (kitty): chunked title and body, base64 payloads, no notification for queries and closes', () => {
	// The example of the kitty documentation
	assert.deepEqual(parse(`${ESC}]99;i=1:d=0;Hello world${ST}${ESC}]99;i=1:p=body;This is cool${ST}`), [
		{ kind: 'notification', source: 'osc99', title: 'Hello world', body: 'This is cool' },
	]);
	assert.deepEqual(parse(`${ESC}]99;;Hello world${ST}`), [{ kind: 'notification', source: 'osc99', body: 'Hello world' }]);
	assert.deepEqual(parse(`${ESC}]99;e=1;VHVybiBjb21wbGV0ZSDinJM=${ST}`), [{ kind: 'notification', source: 'osc99', body: 'Turn complete \u2713' }]);
	assert.deepEqual(parse(`${ESC}]99;i=1:p=?;${ST}${ESC}]99;i=1:p=close;${ST}${ESC}]99;i=2:p=alive;${ST}`), []);
});

test('shell integration marks are reported with exit code and command line', () => {
	assert.deepEqual(parse(`${ESC}]633;A${BEL}${ESC}]633;B${BEL}${ESC}]633;E;claude --resume\\x3b echo;nonce${BEL}${ESC}]633;C${BEL}${ESC}]633;D;3${BEL}${ESC}]133;D;0${ST}${ESC}]633;D${BEL}${ESC}]633;P;Cwd=/tmp${BEL}`), [
		{ kind: 'mark', source: '633', mark: 'A' },
		{ kind: 'mark', source: '633', mark: 'B' },
		{ kind: 'mark', source: '633', mark: 'E', commandLine: 'claude --resume; echo' },
		{ kind: 'mark', source: '633', mark: 'C' },
		{ kind: 'mark', source: '633', mark: 'D', exitCode: 3 },
		{ kind: 'mark', source: '133', mark: 'D', exitCode: 0 },
		{ kind: 'mark', source: '633', mark: 'D' },
		{ kind: 'mark', source: '633', mark: 'P' },
		{ kind: 'cwd', path: '/tmp' },
	]);
	assert.equal(decodeShellIntegrationValue('a\\\\b\\x3bc\\x0ad'), 'a\\b;c\nd');
});

test('a shell that reports its working directory is at its prompt: OSC 7, OSC 633;P;Cwd, OSC 1337;CurrentDir, OSC 9;9', () => {
	assert.deepEqual(parse(`${ESC}]7;file://example-mac.local/Users/me/My%20Code${BEL}`), [{ kind: 'cwd', path: '/Users/me/My Code' }]);
	assert.deepEqual(parse(`${ESC}]7;file:///home/me${ST}`), [{ kind: 'cwd', path: '/home/me' }]);
	assert.deepEqual(parse(`${ESC}]7;not a url${BEL}`), [{ kind: 'cwd', path: 'not a url' }]);
	assert.deepEqual(parse(`${ESC}]1337;CurrentDir=/home/me${BEL}${ESC}]1337;SetMark${BEL}`), [{ kind: 'cwd', path: '/home/me' }]);
	assert.deepEqual(parse(`${ESC}]9;9;C:\\Users\\me${BEL}`), [{ kind: 'cwd', path: 'C:\\Users\\me' }]);
});

test('captured: the prompt of zsh with oh-my-zsh and powerlevel10k, which draws no shell integration marks', () => {
	// window.onDidWriteTerminalData of a new terminal: properties, titles and the working directory, then the
	// line editor turns on bracketed paste, which is the last thing a shell does before it reads a command line
	const captured = '\u001b[?25l\u001b8\u001b[0m\u001b[J\u001b]633;P;PromptType=p10k\u0007\u001b]2;me@mac:~/Chandra\u0007\u001b]1;~/Chandra\u0007\u001b]7;file://mac.local/Users/me/Chandra\u0007\u001b[38;5;39m~/Chandra\u001b[0m \u001b[?1h\u001b=\u001b[?25h\u001b[?2004h';
	const signals = parse(captured);
	assert.deepEqual(signals.filter(signal => signal.kind === 'mark' && signal.mark !== 'P'), [], 'no prompt or command marks');
	assert.deepEqual(signals.filter(signal => signal.kind === 'cwd'), [{ kind: 'cwd', path: '/Users/me/Chandra' }]);
	assert.deepEqual(signals[signals.length - 1], { kind: 'mode', mode: 2004, set: true });
});

test('captured: vim entering and leaving the alternate screen (modes, no text, no bell)', () => {
	// script(1) capture of `vim --clean -c q` on macOS, TERM=xterm-256color
	const captured = '\u001b[?1006;1000h\u001b[?1002h\u001b[?1049h\u001b[22;0;0t\u001b[>4;2m\u001b[?1h\u001b=\u001b[?2004h\u001b[?1004h\u001b[1;24r\u001b[?12h\u001b[?12l\u001b[22;2t\u001b[22;1t\u001b[27m\u001b[23m\u001b[29m\u001b[m\u001b[H\u001b[2J\u001b[24;1H\u001b[?1006;1000l\u001b[?1002l\u001b[?2004l\u001b[>4;m\u001b[23;2t\u001b[23;1t\u001b[?1004l\u001b[?2004l\u001b[?1l\u001b>\u001b[?1049l\u001b[23;0;0t\u001b[>4;m';
	const signals = parse(captured);
	assert.deepEqual(signals.filter(signal => signal.kind !== 'mode'), []);
	assert.deepEqual(signals.filter(signal => signal.kind === 'mode' && signal.set).map(signal => signal.kind === 'mode' ? signal.mode : 0), [1006, 1000, 1002, 1049, 1, 2004, 1004, 12]);
	for (const chunks of everySplit(captured)) {
		assert.deepEqual(parse(...chunks), signals);
	}
});

test('captured: coloured git log becomes plain lines', () => {
	// script(1) capture of `git --no-pager log --oneline --color=always -2`
	const captured = '\u001b[33me5180b6\u001b[m\u001b[33m (\u001b[m\u001b[1;36mHEAD -> \u001b[m\u001b[1;32mGUI_VSC\u001b[m\u001b[33m)\u001b[m notes(vibe): plan rename\r\n\u001b[33ma77b28d\u001b[m\u001b[33m (\u001b[m\u001b[1;31morigin/GUI_VSC\u001b[m\u001b[33m)\u001b[m notes(vibe): re-point the verifier\r\n';
	assert.deepEqual(parse(captured), [
		{ kind: 'text', line: 'e5180b6 (HEAD -> GUI_VSC) notes(vibe): plan rename', transient: false },
		{ kind: 'text', line: 'a77b28d (origin/GUI_VSC) notes(vibe): re-point the verifier', transient: false },
	]);
});

test('a spinner that rewrites its line reports transient lines, the final newline a lasting one', () => {
	const frames = ['\u280b', '\u2819', '\u2839'];
	const data = `${ESC}[?25l` + frames.map((frame, i) => `\r${ESC}[2K${frame} Working\u2026 ${i}s`).join('') + `\r${ESC}[2K\u2713 Done in 3s\r\n${ESC}[?25h`;
	assert.deepEqual(parse(data), [
		{ kind: 'mode', mode: 25, set: false },
		{ kind: 'text', line: '\u280b Working\u2026 0s', transient: true },
		{ kind: 'text', line: '\u2819 Working\u2026 1s', transient: true },
		{ kind: 'text', line: '\u2839 Working\u2026 2s', transient: true },
		{ kind: 'text', line: '\u2713 Done in 3s', transient: false },
		{ kind: 'mode', mode: 25, set: true },
	]);
});

test('the line under construction can be peeked at without consuming it', () => {
	const parser = new SignalParser();
	assert.deepEqual(parser.push('Thinking about it'), []);
	assert.equal(parser.pendingLine, 'Thinking about it');
	assert.deepEqual(parser.push(' some more\n'), [{ kind: 'text', line: 'Thinking about it some more', transient: false }]);
	assert.equal(parser.pendingLine, '');
});

test('full screen drawing: a row ends when the cursor moves to another one, cursor forward is a gap', () => {
	const data = `${ESC}[2;1H\u256d\u2500\u2500\u2500\u256e${ESC}[3;1H\u2502${ESC}[2CFix${ESC}[1Cthe login bug${ESC}[5C\u2502${ESC}[4;1H\u2570\u2500\u2500\u2500\u256f${ESC}[5;1H`;
	assert.deepEqual(parse(data), [
		{ kind: 'text', line: '\u256d\u2500\u2500\u2500\u256e', transient: false },
		{ kind: 'text', line: '\u2502 Fix the login bug \u2502', transient: false },
		{ kind: 'text', line: '\u2570\u2500\u2500\u2500\u256f', transient: false },
	]);
});

test('strings that are no OSC are skipped whole: DCS, APC, PM, SOS; a BEL inside is data, ESC ends them', () => {
	assert.deepEqual(parse(`a${ESC}P1$r0m${BEL}still dcs${ST}b${ESC}_Gf=100;AAAA${ST}c${ESC}^pm${ST}d${ESC}Xsos${ST}e\n`), [{ kind: 'text', line: 'abcde', transient: false }]);
	// An OSC that is cut off by a new escape sequence does not swallow what follows
	assert.deepEqual(parse(`${ESC}]0;never ends${ESC}[31mred\n`), [{ kind: 'text', line: 'red', transient: false }]);
	// CAN aborts a sequence
	assert.deepEqual(parse(`${ESC}[12\x18ok\n`), [{ kind: 'text', line: 'ok', transient: false }]);
});

test('two byte escapes, charset designations and C1 free text are not text', () => {
	assert.deepEqual(parse(`${ESC}(B${ESC})0${ESC}=${ESC}>${ESC}7${ESC}8${ESC}Mx${ESC}#8y\n`), [{ kind: 'text', line: 'xy', transient: false }]);
});

test('backspace, tab and surrogate pairs split across chunks', () => {
	assert.deepEqual(parse('abd\bc\tx\n'), [{ kind: 'text', line: 'abc x', transient: false }]);
	const rocket = '\ud83d\ude80';
	assert.deepEqual(parse(`go ${rocket[0]}`, `${rocket[1]} now\n`), [{ kind: 'text', line: `go ${rocket} now`, transient: false }]);
});

test('an endless line or an endless OSC stays bounded', () => {
	const parser = new SignalParser();
	parser.push('x'.repeat(100_000));
	assert.ok(parser.pendingLine.length <= 1024);
	assert.deepEqual(parser.push(`\n${ESC}]0;${'t'.repeat(100_000)}`), [{ kind: 'text', line: 'x'.repeat(1024), transient: false }]);
	assert.deepEqual(parser.push(`${BEL}after\n`), [{ kind: 'text', line: 'after', transient: false }], 'an oversized OSC is dropped, its terminator is still no bell');
});

test('isMeaningfulLine: words count, frames and spinners do not', () => {
	assert.equal(isMeaningfulLine('\u256d\u2500\u2500\u2500\u256e'), false);
	assert.equal(isMeaningfulLine('> '), false);
	assert.equal(isMeaningfulLine('\u2502 > \u2502'), false);
	assert.equal(isMeaningfulLine('\u280b'), false);
	assert.equal(isMeaningfulLine('ok'), false);
	assert.equal(isMeaningfulLine('\u2502 Fix the login bug \u2502'), true);
	assert.equal(isMeaningfulLine('\u4fee\u590d\u767b\u5f55\u9519\u8bef'), true);
});
