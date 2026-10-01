// Soft-keyboard handling.
//
// The obvious approach - measure the keyboard via visualViewport and pad
// the page by that much - does NOT work in the manager's WebView. With an
// edge-to-edge activity the IME is drawn *over* the window: the WebView is
// neither resized nor panned, so visualViewport.height never changes and
// the measurement is always zero. There is no reliable way to detect the
// keyboard from inside the page in that configuration.
//
// So this doesn't try to detect it. On focus it scrolls the field to the
// TOP of the screen and temporarily adds enough scrollable space below for
// it to actually get there. A field at the top is visible whether or not
// the keyboard is up, and how much of the screen it covers stops mattering.
//
// visualViewport is still used when it does report something (a manager
// using adjustResize), purely to refine the padding - never as a
// precondition for the scrolling behaviour.

const EDIT_SELECTOR = 'textarea, input:not([type="checkbox"])';
const KEYBOARD_MIN_PX = 120;
const MAX_FRACTION = 0.65;

function computeCovered() {
	const vv = window.visualViewport;
	if (!vv) return 0;
	const covered = window.innerHeight - vv.height - vv.offsetTop;
	if (!Number.isFinite(covered) || covered <= 0) return 0;
	return Math.min(covered, window.innerHeight * MAX_FRACTION);
}

function applyViewportMetrics() {
	const root = document.documentElement;
	const covered = computeCovered();
	root.style.setProperty('--kb-height', `${Math.round(covered)}px`);
	if (covered > KEYBOARD_MIN_PX) {
		root.dataset.keyboard = 'open';
	} else {
		delete root.dataset.keyboard;
	}
}

/**
 * Scroll a focused field to the top of the viewport.
 *
 * Retried a few times because the keyboard animates in and the layout
 * settles after our first attempt - a single scroll lands in the wrong
 * place and stays there. scroll-margin-top in the CSS keeps the field
 * clear of the sticky top bar.
 */
function reveal(el) {
	const attempt = (behavior) => {
		if (!el.isConnected) return;
		try {
			el.scrollIntoView({ block: 'start', behavior });
		} catch {
			el.scrollIntoView(true); // older WebViews reject the options object
		}
	};
	attempt('auto');
	setTimeout(() => attempt('smooth'), 250);
	setTimeout(() => attempt('smooth'), 600);
}

function isEditable(el) {
	return Boolean(el) && typeof el.matches === 'function' && el.matches(EDIT_SELECTOR);
}

export function initKeyboardHandling() {
	const root = document.documentElement;
	const vv = window.visualViewport;
	if (vv && typeof vv.addEventListener === 'function') {
		vv.addEventListener('resize', applyViewportMetrics);
		vv.addEventListener('scroll', applyViewportMetrics);
	}
	applyViewportMetrics();

	document.addEventListener('focusin', (e) => {
		if (!isEditable(e.target)) return;
		// Drives the CSS: extra scroll room, nav bar out of the way, and a
		// shorter editor so more of it fits above the keyboard.
		root.dataset.editing = 'on';
		applyViewportMetrics();
		reveal(e.target);
	});

	document.addEventListener('focusout', () => {
		// Delay so moving between two fields doesn't flash the layout back.
		setTimeout(() => {
			if (isEditable(document.activeElement)) return;
			delete root.dataset.editing;
			applyViewportMetrics();
		}, 150);
	});
}
