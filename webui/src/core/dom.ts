export function $<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const el = root.querySelector<T>(selector);
	if (!el) throw new Error(`[nyx] element not found: ${selector}`);
	return el;
}

export function $$<T extends Element = HTMLElement>(root: ParentNode, selector: string): T[] {
	return Array.from(root.querySelectorAll<T>(selector));
}

export function closestTarget<T extends Element = HTMLElement>(event: Event, selector: string): T | null {
	const target = event.target;
	return target instanceof Element ? target.closest<T>(selector) : null;
}

export function escapeHtml(value: unknown): string {
	return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
