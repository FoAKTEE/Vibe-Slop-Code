// SPDX-License-Identifier: MIT

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Insets {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

const MIN_SCALE = 0.04;
const MAX_SCALE = 2.5;
const DRAG_THRESHOLD = 4;

/** Pan (drag), zoom (wheel, trackpad pinch, two-finger touch) and animated framing of an SVG viewport group. */
export class PanZoom {
	x = 0;
	y = 0;
	k = 1;

	private readonly surface: SVGSVGElement;
	private readonly viewport: SVGGElement;
	private readonly onChange: (scale: number) => void;
	private readonly pointers = new Map<number, { x: number; y: number }>();
	private dragOrigin: { x: number; y: number } | undefined;
	private moved = false;
	private frame = 0;
	private animation = 0;
	/** Where a running animation will end; gestures compose on this, not on the in-between state. */
	private target = { x: 0, y: 0, k: 1 };

	constructor(surface: SVGSVGElement, viewport: SVGGElement, onChange: (scale: number) => void) {
		this.surface = surface;
		this.viewport = viewport;
		this.onChange = onChange;
		surface.addEventListener('pointerdown', e => this.pointerDown(e));
		surface.addEventListener('pointermove', e => this.pointerMove(e));
		surface.addEventListener('pointerup', e => this.pointerUp(e));
		surface.addEventListener('pointercancel', e => this.pointerUp(e));
		surface.addEventListener('wheel', e => this.wheel(e), { passive: false });
	}

	/** The scale the view is at, or heading to. */
	get scale(): number {
		return this.target.k;
	}

	/** True when the pointer gesture that just ended was a drag, so the click that follows must be ignored. */
	get dragged(): boolean {
		return this.moved;
	}

	zoomBy(factor: number, cx = this.surface.clientWidth / 2, cy = this.surface.clientHeight / 2, animate = true): void {
		const from = this.target;
		const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, from.k * factor));
		const ratio = k / from.k;
		this.moveTo(cx - (cx - from.x) * ratio, cy - (cy - from.y) * ratio, k, animate);
	}

	/** Frames `box` (graph coordinates) inside the surface minus `insets`, never magnifying beyond `maxScale`. */
	fit(box: Box, insets: Insets, maxScale: number, animate: boolean): void {
		const availableW = Math.max(40, this.surface.clientWidth - insets.left - insets.right);
		const availableH = Math.max(40, this.surface.clientHeight - insets.top - insets.bottom);
		const k = Math.max(MIN_SCALE, Math.min(maxScale, availableW / Math.max(1, box.w), availableH / Math.max(1, box.h)));
		this.moveTo(insets.left + (availableW - box.w * k) / 2 - box.x * k, insets.top + (availableH - box.h * k) / 2 - box.y * k, k, animate);
	}

	/** Pans just enough to bring `box` into the area left free by `insets`; the scale is kept. */
	reveal(box: Box, insets: Insets, animate: boolean): void {
		const { x, y, k } = this.target;
		const left = box.x * k + x, top = box.y * k + y;
		const right = left + box.w * k, bottom = top + box.h * k;
		const viewRight = this.surface.clientWidth - insets.right, viewBottom = this.surface.clientHeight - insets.bottom;
		const margin = 24;
		let dx = 0, dy = 0;
		if (right - left > viewRight - insets.left - 2 * margin || left < insets.left + margin || right > viewRight - margin) {
			dx = (insets.left + viewRight) / 2 - (left + right) / 2;
		}
		if (bottom - top > viewBottom - insets.top - 2 * margin || top < insets.top + margin || bottom > viewBottom - margin) {
			dy = (insets.top + viewBottom) / 2 - (top + bottom) / 2;
		}
		if (dx !== 0 || dy !== 0) {
			this.moveTo(x + dx, y + dy, k, animate);
		}
	}

	moveTo(x: number, y: number, k: number, animate: boolean): void {
		cancelAnimationFrame(this.animation);
		this.target = { x, y, k };
		const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (!animate || reduced) {
			this.apply(x, y, k);
			return;
		}
		const from = { x: this.x, y: this.y, k: this.k };
		const start = performance.now();
		const step = (now: number): void => {
			const t = Math.min(1, (now - start) / 180);
			const e = 1 - Math.pow(1 - t, 3);
			this.apply(from.x + (x - from.x) * e, from.y + (y - from.y) * e, from.k + (k - from.k) * e);
			if (t < 1) {
				this.animation = requestAnimationFrame(step);
			}
		};
		this.animation = requestAnimationFrame(step);
	}

	private apply(x: number, y: number, k: number): void {
		this.x = x;
		this.y = y;
		this.k = k;
		if (!this.frame) {
			this.frame = requestAnimationFrame(() => {
				this.frame = 0;
				this.flush();
			});
		}
	}

	/** Writes the transform now; used by `apply` once per frame and by callers that need a synchronous state. */
	flush(): void {
		this.viewport.setAttribute('transform', `translate(${this.x.toFixed(2)} ${this.y.toFixed(2)}) scale(${this.k.toFixed(4)})`);
		this.onChange(this.k);
	}

	private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
		const rect = this.surface.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	private pointerDown(e: PointerEvent): void {
		if (e.button !== 0) {
			return;
		}
		cancelAnimationFrame(this.animation);
		this.target = { x: this.x, y: this.y, k: this.k };
		this.pointers.set(e.pointerId, this.local(e));
		this.dragOrigin = this.local(e);
		this.moved = false;
	}

	private pointerMove(e: PointerEvent): void {
		const previous = this.pointers.get(e.pointerId);
		if (!previous) {
			return;
		}
		const now = this.local(e);
		if (!this.moved && this.dragOrigin && Math.hypot(now.x - this.dragOrigin.x, now.y - this.dragOrigin.y) < DRAG_THRESHOLD) {
			return;
		}
		if (!this.moved) {
			this.moved = true;
			this.surface.setPointerCapture(e.pointerId);
			this.surface.classList.add('vc-dragging');
		}
		if (this.pointers.size === 2) {
			const other = [...this.pointers.entries()].find(([id]) => id !== e.pointerId)![1];
			const before = Math.hypot(previous.x - other.x, previous.y - other.y);
			const after = Math.hypot(now.x - other.x, now.y - other.y);
			if (before > 0) {
				this.zoomBy(after / before, (now.x + other.x) / 2, (now.y + other.y) / 2, false);
			}
		} else {
			this.moveTo(this.x + now.x - previous.x, this.y + now.y - previous.y, this.k, false);
		}
		this.pointers.set(e.pointerId, now);
	}

	private pointerUp(e: PointerEvent): void {
		this.pointers.delete(e.pointerId);
		if (this.pointers.size === 0) {
			this.surface.classList.remove('vc-dragging');
		}
	}

	private wheel(e: WheelEvent): void {
		e.preventDefault();
		const at = this.local(e);
		// A trackpad pinch arrives as ctrl+wheel with small deltas; a mouse wheel as lines or large pixel steps.
		const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
		const speed = e.ctrlKey ? 0.012 : 0.0022;
		this.zoomBy(Math.exp(-Math.max(-120, Math.min(120, delta)) * speed), at.x, at.y, false);
	}
}
