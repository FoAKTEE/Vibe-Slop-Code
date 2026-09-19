// SPDX-License-Identifier: MIT

// What the output of a terminal says about the agent that runs in it. The parser reads the raw stream of a
// pseudo terminal (text with escape sequences, cut into chunks wherever the operating system cut it) and
// reports the few things that matter, never the sequences themselves. No editor API and no DOM in here.

export type NotificationSource = 'osc9' | 'osc777' | 'osc99';

export type Signal =
	/** BEL outside of any sequence. The BEL that terminates an OSC is not a bell. */
	| { kind: 'bell' }
	/** A desktop notification: OSC 9 (iTerm2), OSC 777;notify (rxvt-unicode) or OSC 99 (kitty). */
	| { kind: 'notification'; source: NotificationSource; title?: string; body: string }
	/** OSC 0 or OSC 2: the window title. */
	| { kind: 'title'; text: string }
	/** OSC 9;4 (ConEmu, Windows Terminal): 0 cleared, 1 value, 2 error, 3 busy, 4 paused. */
	| { kind: 'progress'; state: number; value?: number }
	/** A shell integration mark: OSC 633 (this editor) or OSC 133 (FinalTerm). `D` carries the exit code, `E` the command line. */
	| { kind: 'mark'; source: '633' | '133'; mark: string; exitCode?: number; commandLine?: string }
	/**
	 * The shell told where it is: OSC 7, OSC 633;P;Cwd, OSC 1337;CurrentDir, OSC 9;9. Shells do that when
	 * they draw their prompt, programs that run in them do not: it means the shell is back at its prompt.
	 */
	| { kind: 'cwd'; path: string }
	/** A DEC private mode was set or reset (CSI ? Pm h/l), such as 1049 alternate screen, 2004 bracketed paste, 25 cursor. */
	| { kind: 'mode'; mode: number; set: boolean }
	/** A line of printable text. Transient: the line was overwritten in place (a spinner, a progress bar). */
	| { kind: 'text'; line: string; transient: boolean };

const MAX_LINE = 1024;
const MAX_STRING = 8192;

const State = {
	Ground: 0,
	Escape: 1,
	EscapeIntermediate: 2,
	Csi: 3,
	Osc: 4,
	/** DCS, SOS, PM, APC: skipped until ST. */
	String: 5,
} as const;
type State = typeof State[keyof typeof State];

const BEL = 0x07;
const BS = 0x08;
const HT = 0x09;
const LF = 0x0a;
const VT = 0x0b;
const FF = 0x0c;
const CR = 0x0d;
const CAN = 0x18;
const SUB = 0x1a;
const ESC = 0x1b;
const DEL = 0x7f;

/**
 * An incremental parser. `push` takes the next chunk and returns the signals that are complete with it; whatever
 * is unfinished at the end of a chunk (half a sequence, half a line, half a surrogate pair) waits for the next.
 */
export class SignalParser {

	private state: State = State.Ground;
	/** Inside a string (OSC, DCS, ...): the ESC of a possible ST was seen. */
	private stringEscape = false;
	private sequence = '';
	private overflow = false;

	private line = '';
	/** A carriage return was seen: what comes next overwrites the line. */
	private rewrite = false;

	/** Parts of OSC 99 notifications that are not done yet, by identifier. */
	private readonly pendingNotifications = new Map<string, { title: string; body: string }>();

	private signals: Signal[] = [];

	/** The printable text of the line that is not complete yet. */
	get pendingLine(): string {
		return this.line;
	}

	push(chunk: string): Signal[] {
		this.signals = [];
		for (let i = 0; i < chunk.length; i++) {
			this.next(chunk.charCodeAt(i), chunk[i]);
		}
		const signals = this.signals;
		this.signals = [];
		return signals;
	}

	private next(code: number, char: string): void {
		switch (this.state) {
			case State.Ground: return this.ground(code, char);
			case State.Escape: return this.escape(code, char);
			case State.EscapeIntermediate: return this.escapeIntermediate(code, char);
			case State.Csi: return this.csi(code, char);
			case State.Osc:
			case State.String: return this.string(code, char);
		}
	}

	//#region States

	private ground(code: number, char: string): void {
		if (code === ESC) {
			this.state = State.Escape;
		} else if (code < 0x20 || code === DEL) {
			this.control(code);
		} else if (code >= 0x80 && code < 0xa0) {
			// C1 controls do not occur in UTF-8 streams as single code points, nothing to print either
		} else {
			this.print(char);
		}
	}

	private escape(code: number, char: string): void {
		this.sequence = '';
		this.overflow = false;
		this.stringEscape = false;
		if (code === 0x5b /* [ */) {
			this.state = State.Csi;
		} else if (code === 0x5d /* ] */) {
			this.state = State.Osc;
		} else if (code === 0x50 /* P */ || code === 0x58 /* X */ || code === 0x5e /* ^ */ || code === 0x5f /* _ */) {
			this.state = State.String;
		} else if (code >= 0x20 && code <= 0x2f) {
			this.state = State.EscapeIntermediate; // such as ESC ( B
		} else if (code === ESC) {
			// stays
		} else if (code === CAN || code === SUB) {
			this.state = State.Ground;
		} else if (code < 0x20) {
			this.control(code);
		} else {
			this.state = State.Ground;
			if (char === 'D' || char === 'E' || char === 'M' || char === '7' || char === '8' || char === 'c') {
				this.endLine(false); // index, next line, reverse index, save and restore cursor, reset: another row
			}
		}
	}

	private escapeIntermediate(code: number, _char: string): void {
		if (code === ESC) {
			this.state = State.Escape;
		} else if (code === CAN || code === SUB) {
			this.state = State.Ground;
		} else if (code < 0x20) {
			this.control(code);
		} else if (code >= 0x30) {
			this.state = State.Ground; // the final byte
		}
	}

	private csi(code: number, char: string): void {
		if (code === ESC) {
			this.state = State.Escape;
		} else if (code === CAN || code === SUB) {
			this.state = State.Ground;
		} else if (code < 0x20) {
			this.control(code); // C0 controls execute in the middle of a sequence
		} else if (code >= 0x40 && code <= 0x7e) {
			this.state = State.Ground;
			this.dispatchCsi(this.sequence, char);
		} else if (this.sequence.length < 64) {
			this.sequence += char;
		}
	}

	private string(code: number, char: string): void {
		if (this.stringEscape) {
			this.stringEscape = false;
			if (code === 0x5c /* \ */) {
				this.endString();
			} else {
				// A new sequence starts: the string was never terminated and is dropped
				this.state = State.Escape;
				this.escape(code, char);
			}
		} else if (code === ESC) {
			this.stringEscape = true;
		} else if (code === BEL && this.state === State.Osc) {
			this.endString();
		} else if (code === CAN || code === SUB) {
			this.state = State.Ground;
		} else if (this.state === State.Osc) {
			if (this.sequence.length < MAX_STRING) {
				this.sequence += char;
			} else {
				this.overflow = true;
			}
		}
	}

	private endString(): void {
		const isOsc = this.state === State.Osc;
		this.state = State.Ground;
		if (isOsc && !this.overflow) {
			this.dispatchOsc(this.sequence);
		}
	}

	//#endregion

	//#region Text

	private control(code: number): void {
		switch (code) {
			case BEL:
				this.signals.push({ kind: 'bell' });
				break;
			case BS:
				if (!this.rewrite) {
					this.line = this.line.slice(0, -1);
				}
				break;
			case HT:
				this.gap();
				break;
			case LF:
			case VT:
			case FF:
				this.endLine(false);
				break;
			case CR:
				this.rewrite = true;
				break;
		}
	}

	private print(char: string): void {
		if (this.rewrite) {
			this.endLine(true);
		}
		if (this.line.length < MAX_LINE) {
			this.line += char;
		}
	}

	/** Cursor forward and tabs: full screen programs skip what is on screen already. */
	private gap(): void {
		if (this.rewrite) {
			this.endLine(true);
		}
		if (this.line.length > 0 && this.line.length < MAX_LINE && !this.line.endsWith(' ')) {
			this.line += ' ';
		}
	}

	private endLine(transient: boolean): void {
		const line = this.line.trim();
		this.line = '';
		this.rewrite = false;
		if (line) {
			this.signals.push({ kind: 'text', line, transient });
		}
	}

	//#endregion

	//#region Sequences

	private dispatchCsi(sequence: string, final: string): void {
		const isPrivate = sequence.startsWith('?');
		if (isPrivate && (final === 'h' || final === 'l')) {
			for (const parameter of sequence.slice(1).split(';')) {
				const mode = Number.parseInt(parameter, 10);
				if (Number.isInteger(mode)) {
					this.signals.push({ kind: 'mode', mode, set: final === 'h' });
					if (mode === 1049 || mode === 1047 || mode === 47) {
						this.endLine(false);
					}
				}
			}
			return;
		}
		if (sequence !== '' && !/^[0-9;:]*$/.test(sequence)) {
			return; // other private sequences and intermediates: no cursor movement
		}

		switch (final) {
			case 'C': // cursor forward
				this.gap();
				break;
			case 'G': // cursor horizontal absolute
			case '`':
				if ((Number.parseInt(sequence, 10) || 1) === 1) {
					this.rewrite = true;
				} else {
					this.gap();
				}
				break;
			case 'K': // erase in line
				if (this.rewrite || sequence === '2' || sequence === '1') {
					this.endLine(true);
				}
				break;
			case 'A': case 'B': case 'E': case 'F': // cursor up, down, next line, previous line
			case 'H': case 'f': case 'd': // cursor position, line position
			case 'J': // erase in display
			case 'L': case 'M': case 'S': case 'T': // insert and delete lines, scroll
			case 'r': case 's': case 'u': // scroll region, save and restore cursor
				this.endLine(this.rewrite);
				break;
		}
	}

	private dispatchOsc(sequence: string): void {
		const separator = sequence.indexOf(';');
		const command = separator < 0 ? sequence : sequence.slice(0, separator);
		const payload = separator < 0 ? '' : sequence.slice(separator + 1);
		switch (command) {
			case '0':
			case '2':
				this.signals.push({ kind: 'title', text: clean(payload) });
				break;
			case '7':
				this.signals.push({ kind: 'cwd', path: pathOfFileUrl(payload) });
				break;
			case '1337':
				if (payload.startsWith('CurrentDir=')) {
					this.signals.push({ kind: 'cwd', path: payload.slice('CurrentDir='.length) });
				}
				break;
			case '9':
				this.dispatchOsc9(payload);
				break;
			case '777':
				this.dispatchOsc777(payload);
				break;
			case '99':
				this.dispatchOsc99(payload);
				break;
			case '633':
			case '133':
				this.dispatchMark(command, payload);
				break;
		}
	}

	/**
	 * iTerm2 made `OSC 9 ; text` a notification, ConEmu made `OSC 9 ; n ; ...` a family of commands, of which
	 * `9;4` (progress) is written by many tools today. A small number followed by `;` or nothing is a command.
	 */
	private dispatchOsc9(payload: string): void {
		const command = /^(?<number>\d{1,2})(?:;(?<rest>.*))?$/s.exec(payload);
		const number = command ? Number.parseInt(command.groups!.number, 10) : 0;
		if (command && number >= 1 && number <= 12) {
			if (number === 9 && command.groups!.rest) {
				this.signals.push({ kind: 'cwd', path: command.groups!.rest });
			} else if (number === 4) {
				const [state, value] = (command.groups!.rest ?? '').split(';').map(part => Number.parseInt(part, 10));
				if (Number.isInteger(state)) {
					this.signals.push(Number.isInteger(value) ? { kind: 'progress', state, value } : { kind: 'progress', state });
				}
			}
			return;
		}
		const body = clean(payload);
		if (body) {
			this.signals.push({ kind: 'notification', source: 'osc9', body });
		}
	}

	private dispatchOsc777(payload: string): void {
		const [command, title, ...rest] = payload.split(';');
		if (command !== 'notify') {
			return;
		}
		const body = clean(rest.join(';'));
		if (body) {
			this.signals.push({ kind: 'notification', source: 'osc777', title: clean(title ?? ''), body });
		} else if (clean(title ?? '')) {
			this.signals.push({ kind: 'notification', source: 'osc777', body: clean(title) });
		}
	}

	/**
	 * kitty: `OSC 99 ; key=value:key=value ; payload`. `p` says what the payload is (title by default), `d=0`
	 * that more is to come for the identifier `i`, `e=1` that the payload is base64.
	 */
	private dispatchOsc99(sequence: string): void {
		const separator = sequence.indexOf(';');
		const metadata = new Map((separator < 0 ? sequence : sequence.slice(0, separator)).split(':').map(pair => {
			const equals = pair.indexOf('=');
			return equals < 0 ? [pair, ''] as const : [pair.slice(0, equals), pair.slice(equals + 1)] as const;
		}));
		const type = metadata.get('p') || 'title';
		if (type !== 'title' && type !== 'body') {
			if (type === 'close') {
				this.pendingNotifications.delete(metadata.get('i') ?? '');
			}
			return; // queries, icons, buttons
		}

		let payload = separator < 0 ? '' : sequence.slice(separator + 1);
		if (metadata.get('e') === '1') {
			payload = decodeBase64(payload);
		}

		const id = metadata.get('i') ?? '';
		const pending = this.pendingNotifications.get(id) ?? { title: '', body: '' };
		pending[type] += payload;
		if (metadata.get('d') === '0') {
			if (this.pendingNotifications.size < 16 || this.pendingNotifications.has(id)) {
				this.pendingNotifications.set(id, pending);
			}
			return;
		}

		this.pendingNotifications.delete(id);
		const title = clean(pending.title);
		const body = clean(pending.body);
		if (title && body) {
			this.signals.push({ kind: 'notification', source: 'osc99', title, body });
		} else if (title || body) {
			this.signals.push({ kind: 'notification', source: 'osc99', body: title || body });
		}
	}

	private dispatchMark(source: '633' | '133', payload: string): void {
		const [mark, ...parameters] = payload.split(';');
		if (!/^[A-Z]$/.test(mark)) {
			return;
		}
		if (mark === 'D') {
			const exitCode = Number.parseInt(parameters[0] ?? '', 10);
			this.signals.push(Number.isInteger(exitCode) ? { kind: 'mark', source, mark, exitCode } : { kind: 'mark', source, mark });
		} else if (mark === 'E' && source === '633') {
			this.signals.push({ kind: 'mark', source, mark, commandLine: decodeShellIntegrationValue(parameters[0] ?? '') });
		} else {
			this.signals.push({ kind: 'mark', source, mark });
			const cwd = mark === 'P' ? parameters.find(parameter => parameter.startsWith('Cwd=')) : undefined;
			if (cwd !== undefined) {
				this.signals.push({ kind: 'cwd', path: decodeShellIntegrationValue(cwd.slice('Cwd='.length)) });
			}
		}
	}

	//#endregion
}

/** Text of a sequence as one line: control characters out, white space collapsed. */
function clean(text: string): string {
	return text.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The path of `file://host/path`, percent decoded. What is no such URL is taken as it is. */
function pathOfFileUrl(url: string): string {
	const match = /^file:\/\/[^/]*(?<path>\/.*)$/.exec(url);
	if (!match) {
		return url;
	}
	try {
		return decodeURIComponent(match.groups!.path);
	} catch {
		return match.groups!.path;
	}
}

/** Values of OSC 633 escape `\` as `\\` and everything a sequence cannot carry as `\xHH`. */
export function decodeShellIntegrationValue(value: string): string {
	return value.replace(/\\(?:\\|x(?<hex>[0-9a-fA-F]{2}))/g, (_match, hex: string | undefined) => hex === undefined ? '\\' : String.fromCharCode(Number.parseInt(hex, 16)));
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBase64(text: string): string {
	const bytes: number[] = [];
	let bits = 0;
	let value = 0;
	for (const char of text) {
		const index = BASE64.indexOf(char);
		if (index < 0) {
			continue; // padding and white space
		}
		value = (value << 6) | index;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((value >> bits) & 0xff);
		}
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Whether a line says something: at least three letters or digits. Frames of boxes, prompts
 * and the frames of a spinner are what full screen programs draw most, and say nothing.
 */
export function isMeaningfulLine(line: string): boolean {
	return (line.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3;
}
