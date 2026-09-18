// SPDX-License-Identifier: MIT

const SVG_NS = 'http://www.w3.org/2000/svg';

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, ...children: Child[]): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	append(node, children);
	return node;
}

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}, ...children: Child[]): SVGElementTagNameMap[K] {
	const node = document.createElementNS(SVG_NS, tag);
	for (const key in attributes) {
		node.setAttribute(key, String(attributes[key]));
	}
	append(node, children);
	return node;
}

function append(parent: Element, children: Child[]): void {
	for (const child of children) {
		if (child !== null && child !== undefined && child !== false) {
			parent.append(child);
		}
	}
}

export function clear(node: Element): void {
	node.replaceChildren();
}

/** A toolbar icon from stroke paths on a 16x16 grid. */
export function icon(...paths: string[]): SVGSVGElement {
	return svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, ...paths.map(d => svg('path', { d })));
}
