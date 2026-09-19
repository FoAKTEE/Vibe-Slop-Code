// SPDX-License-Identifier: MIT

export interface PageInput {
	/** `webview.cspSource`. */
	cspSource: string;
	nonce: string;
	styleUris: readonly string[];
	scriptUri: string;
	/** The configured flow direction; the view uses it when it has no saved state. */
	direction: 'lr' | 'td';
	/** Where the page is shown: the side bar view sits on the side bar's background, the panel on the editor's. */
	surface: 'view' | 'panel';
	title: string;
}

/** For text content and double-quoted attribute values (a single quote needs no escape in either). */
function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
}

/**
 * The one page behind both the side bar view and the editor panel. Nothing inline: styles and the script are
 * files of the extension, the script runs by nonce, and the view itself never writes a style attribute.
 */
export function renderPage(input: PageInput): string {
	const csp = [
		`default-src 'none'`,
		`style-src ${input.cspSource}`,
		`script-src 'nonce-${input.nonce}'`,
		`font-src ${input.cspSource}`,
		`img-src ${input.cspSource} data:`,
	].join('; ');
	return [
		'<!DOCTYPE html>',
		'<html lang="en">',
		'<head>',
		'<meta charset="UTF-8">',
		`<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">`,
		'<meta name="viewport" content="width=device-width, initial-scale=1.0">',
		`<title>${escapeHtml(input.title)}</title>`,
		...input.styleUris.map(uri => `<link rel="stylesheet" href="${escapeHtml(uri)}">`),
		'</head>',
		`<body class="vc-surface-${input.surface}">`,
		`<div id="vibe-chandra-graph" data-direction="${input.direction}"></div>`,
		`<script type="module" nonce="${escapeHtml(input.nonce)}" src="${escapeHtml(input.scriptUri)}"></script>`,
		'</body>',
		'</html>',
	].join('\n');
}
