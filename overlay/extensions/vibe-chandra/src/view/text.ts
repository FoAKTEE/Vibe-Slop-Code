// SPDX-License-Identifier: MIT

const NARROW = new Set('iljtfrI.,:;|!\'`()[]{} '.split(''));
const WIDE = new Set('mwMW@%'.split(''));

/**
 * Approximate advance width of UI text. SVG has no text overflow, so labels are fitted before they are
 * drawn; an estimate (slightly on the generous side) keeps layout independent of font loading and DOM.
 */
export function estimateWidth(text: string, fontSize: number): number {
	let em = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0)!;
		em += code > 0x2e7f ? 1 : NARROW.has(ch) ? 0.33 : WIDE.has(ch) ? 0.88 : ch === '-' || ch === '_' ? 0.46 : ch >= 'A' && ch <= 'Z' ? 0.69 : ch >= '0' && ch <= '9' ? 0.62 : 0.57;
	}
	return em * fontSize * 1.03;
}

/** Shortens text to fit `maxWidth`, keeping the head and the tail (ids differ mostly at their ends). */
export function fit(text: string, maxWidth: number, fontSize: number): string {
	if (estimateWidth(text, fontSize) <= maxWidth) {
		return text;
	}
	const chars = [...text];
	let keep = chars.length - 1;
	const build = (count: number): string => {
		const tail = Math.min(6, Math.floor(count / 3));
		return chars.slice(0, count - tail).join('') + '…' + (tail ? chars.slice(chars.length - tail).join('') : '');
	};
	while (keep > 1 && estimateWidth(build(keep), fontSize) > maxWidth) {
		keep--;
	}
	return build(keep);
}

/**
 * Splits a label over at most two lines, breaking after a separator (`-`, `_`, `.`, `/`, `:` or a space) as
 * late as the first line allows; whatever still does not fit on the second line is shortened.
 */
export function wrapTwo(text: string, maxWidth: number, fontSize: number): string[] {
	if (estimateWidth(text, fontSize) <= maxWidth) {
		return [text];
	}
	let cut = -1;
	for (let i = 1; i < text.length - 1; i++) {
		if ('-_./: '.includes(text[i]) && estimateWidth(text.slice(0, i + 1), fontSize) <= maxWidth) {
			cut = i + 1;
		}
	}
	return cut === -1 ? [fit(text, maxWidth, fontSize)] : [text.slice(0, cut).trimEnd(), fit(text.slice(cut), maxWidth, fontSize)];
}
