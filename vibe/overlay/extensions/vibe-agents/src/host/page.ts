// SPDX-License-Identifier: MIT

export interface PageInput {
	/** `webview.cspSource`. */
	cspSource: string;
	nonce: string;
	styleUri: string;
	scriptUri: string;
	title: string;
}

/** For text content and double-quoted attribute values (a single quote needs no escape in either). */
function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
}

/**
 * The page of the Sessions view. Nothing inline: the style sheet and the script are files of the
 * extension, the script runs by nonce, and the view itself never writes a style attribute.
 */
export function renderPage(input: PageInput): string {
	const csp = [
		`default-src 'none'`,
		`style-src ${input.cspSource}`,
		`script-src 'nonce-${input.nonce}'`,
	].join('; ');
	return [
		'<!DOCTYPE html>',
		'<html lang="en">',
		'<head>',
		'<meta charset="UTF-8">',
		`<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">`,
		'<meta name="viewport" content="width=device-width, initial-scale=1.0">',
		`<title>${escapeHtml(input.title)}</title>`,
		`<link rel="stylesheet" href="${escapeHtml(input.styleUri)}">`,
		'</head>',
		'<body>',
		'<div id="vibe-agents"></div>',
		`<script type="module" nonce="${escapeHtml(input.nonce)}" src="${escapeHtml(input.scriptUri)}"></script>`,
		'</body>',
		'</html>',
	].join('\n');
}
