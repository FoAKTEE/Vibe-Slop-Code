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

/** Sets the text of a node only when it differs: nodes that do not change are not touched. */
export function setText(node: Element, text: string): void {
	if (node.textContent !== text) {
		node.textContent = text;
	}
}

export function setAttribute(node: Element, name: string, value: string | undefined): void {
	if (value === undefined) {
		node.removeAttribute(name);
	} else if (node.getAttribute(name) !== value) {
		node.setAttribute(name, value);
	}
}
