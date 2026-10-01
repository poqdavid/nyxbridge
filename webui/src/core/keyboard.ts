const EDIT_SELECTOR = 'textarea, input:not([type="checkbox"])';
const KEYBOARD_MIN_PX = 120;
const MAX_FRACTION = 0.65;

function computeCovered(): number {
	const vv = window.visualViewport;
	if (!vv) return 0;
	const covered = window.innerHeight - vv.height - vv.offsetTop;
	if (!Number.isFinite(covered) || covered <= 0) return 0;
	return Math.min(covered, window.innerHeight * MAX_FRACTION);
}

function applyViewportMetrics(): void {
	const root = document.documentElement;
	const covered = computeCovered();
	root.style.setProperty('--kb-height', `${Math.round(covered)}px`);
	if (covered > KEYBOARD_MIN_PX) {
		root.dataset.keyboard = 'open';
	} else {
		delete root.dataset.keyboard;
	}
}

function reveal(el: Element): void {
	const attempt = (behavior: ScrollBehavior) => {
		if (!el.isConnected) return;
		try {
			el.scrollIntoView({ block: 'start', behavior });
		} catch {
			el.scrollIntoView(true);
		}
	};
	attempt('auto');
	setTimeout(() => attempt('smooth'), 250);
	setTimeout(() => attempt('smooth'), 600);
}

function isEditable(el: EventTarget | null): el is Element {
	return el instanceof Element && el.matches(EDIT_SELECTOR);
}

export function initKeyboardHandling(): void {
	const root = document.documentElement;
	const vv = window.visualViewport;
	if (vv && typeof vv.addEventListener === 'function') {
		vv.addEventListener('resize', applyViewportMetrics);
		vv.addEventListener('scroll', applyViewportMetrics);
	}
	applyViewportMetrics();

	document.addEventListener('focusin', (e) => {
		if (!isEditable(e.target)) return;
		root.dataset.editing = 'on';
		applyViewportMetrics();
		reveal(e.target);
	});

	document.addEventListener('focusout', () => {
		setTimeout(() => {
			if (isEditable(document.activeElement)) return;
			delete root.dataset.editing;
			applyViewportMetrics();
		}, 150);
	});
}
