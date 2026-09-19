// SPDX-License-Identifier: MIT

// A stand-in for an interactive coding agent, for tests and demos: it costs nothing and needs no login.
// It behaves like the real ones as far as a terminal can tell: it turns on bracketed paste, hides the cursor
// while a spinner runs, sets the title, and when its turn is over it sends a desktop notification (OSC 9), rings
// the bell and waits for a line. Runs on old versions of Node.js on purpose (hosts reached over SSH).
//
//   node fake-agent.mjs [--name Fake] [--work 4] [--turns 2] [--exit 0] [--quiet]
//
//   --work   seconds of work per turn
//   --turns  turns before it exits; after every turn but the last one it waits for a line
//   --exit   the exit code
//   --quiet  no notification and no bell when a turn is over: only silence tells
import readline from 'readline';

const args = process.argv.slice(2);
function option(name, fallback) {
	const index = args.indexOf('--' + name);
	return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

const name = option('name', 'Fake Agent');
const workSeconds = Number(option('work', '4'));
const turns = Math.max(1, Number(option('turns', '2')));
const exitCode = Number(option('exit', '0'));
const quiet = args.indexOf('--quiet') >= 0;

const ESC = '\x1b';
const FRAMES = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];
const STEPS = ['Reading the repository', 'Planning the change', 'Editing files', 'Running the tests'];

function write(text) {
	process.stdout.write(text);
}

function leave(code) {
	write(ESC + '[?25h' + ESC + '[?2004l');
	process.exit(code);
}

process.on('SIGINT', function () {
	write('\r' + ESC + '[2K' + name + ': interrupted\r\n');
	leave(130);
});

function work(turn, done) {
	const started = Date.now();
	let frame = 0;
	let step = -1;
	write(ESC + '[?25l');
	const timer = setInterval(function () {
		const seconds = (Date.now() - started) / 1000;
		const nextStep = Math.min(STEPS.length - 1, Math.floor(seconds / Math.max(workSeconds, 0.1) * STEPS.length));
		if (nextStep !== step) {
			step = nextStep;
			write('\r' + ESC + '[2K  ' + ESC + '[2m\u2022 ' + STEPS[step] + ESC + '[0m\r\n');
		}
		write('\r' + ESC + '[2K' + ESC + '[36m' + FRAMES[frame++ % FRAMES.length] + ESC + '[0m Working\u2026 (' + Math.floor(seconds) + 's \u2022 esc to interrupt)');
		if (seconds >= workSeconds) {
			clearInterval(timer);
			write('\r' + ESC + '[2K' + ESC + '[32m\u2713' + ESC + '[0m Turn ' + turn + ' of ' + turns + ' complete: 3 files changed\r\n' + ESC + '[?25h');
			done();
		}
	}, 100);
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
let turn = 0;
let waiting = false;

function nextTurn() {
	turn++;
	waiting = false;
	work(turn, function () {
		if (turn >= turns) {
			write(name + ': done\r\n');
			input.close();
			leave(exitCode);
			return;
		}
		if (!quiet) {
			write(ESC + ']9;' + name + ': turn complete' + '\x07' + '\x07');
		}
		waiting = true;
		write('> ');
	});
}

input.on('line', function (line) {
	if (line.trim() === 'exit' || line.trim() === 'quit') {
		leave(exitCode);
	} else if (waiting) {
		nextTurn();
	}
});
input.on('close', function () {
	if (waiting) {
		leave(exitCode);
	}
});

write(ESC + ']0;' + name + '\x07' + ESC + '[?2004h');
write(ESC + '[1m' + name + ESC + '[0m  (a stand-in agent: ' + turns + ' turn' + (turns === 1 ? '' : 's') + ' of ' + workSeconds + 's, exit code ' + exitCode + ')\r\n');
nextTurn();
