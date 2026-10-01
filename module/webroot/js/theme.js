import { exec } from './ksu-bridge.js';

// Resolving "System" is harder than it should be inside the manager's
// WebView:
//
//  - Without a declared color-scheme, an Android WebView commonly reports
//    prefers-color-scheme: light no matter what the system is set to.
//  - It may also apply algorithmic darkening ("force dark") to a light
//    page, producing washed-out grey surfaces rather than the real dark
//    palette.
//
// So rather than trusting the media query, ask Android itself - we have a
// root shell, so we can just read the night-mode setting. The media query
// stays as a fallback for when the shell answer is inconclusive.

let mediaQuery = null;
let watching = false;

// `cmd uimode night` answers yes/no/auto. When it says auto (or isn't
// available) fall through to the raw secure setting, where
// 2 = always dark, 1 = always light, 0 = auto. Exported so the startup read
// can run it in the same shell as everything else (see ksu-bridge.js).
export const NIGHT_MODE_COMMAND = [
	'n=$(cmd uimode night 2>/dev/null)',
	'case "$n" in',
	'  *yes*) echo dark ;;',
	'  *no*) echo light ;;',
	'  *)',
	'    v=$(settings get secure ui_night_mode 2>/dev/null)',
	'    case "$v" in',
	'      2) echo dark ;;',
	'      1) echo light ;;',
	'      *) echo unknown ;;',
	'    esac',
	'    ;;',
	'esac',
].join('\n');

/** @returns {'dark'|'light'|null} null when Android can't say */
export function parseNightMode({ errno, stdout }) {
	if (errno !== 0) return null;
	const answer = stdout.trim();
	return answer === 'dark' || answer === 'light' ? answer : null;
}

/** @returns {Promise<'dark'|'light'|null>} null when Android can't say */
async function querySystemNightMode() {
	try {
		return parseNightMode(await exec(NIGHT_MODE_COMMAND));
	} catch {
		return null;
	}
}

function mediaPrefersDark() {
	if (!mediaQuery && typeof window.matchMedia === 'function') {
		mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
	}
	return mediaQuery ? mediaQuery.matches : false;
}

/**
 * The concrete scheme that "system" currently resolves to.
 * @param {'dark'|'light'|null} [known] Android's answer when the caller
 *   already has it (null = Android couldn't say); omitted = ask now.
 */
export async function resolveSystemTheme(known) {
	const fromAndroid = known === undefined ? await querySystemNightMode() : known;
	if (fromAndroid) return fromAndroid;
	return mediaPrefersDark() ? 'dark' : 'light';
}

/**
 * Applies a theme preference. Unlike before, "system" is resolved to a
 * concrete light/dark value and written to data-theme, so the rendered
 * theme never depends on the WebView answering the media query correctly.
 *
 * @param {'system'|'light'|'dark'} mode
 * @param {{systemNight?: 'dark'|'light'|null}} [opts] Android's night-mode
 *   answer if already read (startup batches it), so "system" costs no exec.
 * @returns {Promise<'light'|'dark'>} the scheme actually applied
 */
export async function applyTheme(mode, { systemNight } = {}) {
	const root = document.documentElement;
	root.dataset.themeSource = mode;
	let effective = mode;
	if (mode !== 'light' && mode !== 'dark') {
		effective = await resolveSystemTheme(systemNight);
		watchSystemChanges();
	}
	root.dataset.theme = effective;
	// Tells the WebView the page handles this scheme itself, which stops
	// force-dark from re-darkening it and makes native controls (the theme
	// <select>, text inputs) match.
	root.style.colorScheme = effective;
	return effective;
}

/** Re-resolve if the system flips while the UI is open. Only attached
 * when the user is actually on "system". */
function watchSystemChanges() {
	if (watching) return;
	if (!mediaQuery && typeof window.matchMedia === 'function') {
		mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
	}
	if (!mediaQuery || typeof mediaQuery.addEventListener !== 'function') return;
	mediaQuery.addEventListener('change', async () => {
		const root = document.documentElement;
		// Only follow along if the user hasn't since picked an explicit theme.
		if (root.dataset.themeSource !== 'system') return;
		const effective = await resolveSystemTheme();
		root.dataset.theme = effective;
		root.style.colorScheme = effective;
	});
	watching = true;
}

// ---------------------------------------------------------------------
// Material You
//
// The manager injects the device palette via the colors.css import in
// tokens.css. That import resolves asynchronously, so detection retries
// briefly before giving up rather than checking once and concluding the
// palette isn't there.
// ---------------------------------------------------------------------

/** True when the manager actually supplied a Monet palette. */
export function monetAvailable() {
	const probe = window.getComputedStyle(document.documentElement)
		.getPropertyValue('--primary')
		.trim();
	return probe.length > 0;
}

async function waitForMonet(timeoutMs = 1200) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (monetAvailable()) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return monetAvailable();
}

let monetRequest = 0;

/**
 * Turns the Material You token overrides on or off.
 *
 * `wait: false` checks once instead of polling, for startup: the palette
 * import is part of a render-blocking stylesheet, so it is normally there
 * by the time any script runs, and holding the first render for up to
 * 1.2s on a manager that never serves one isn't worth it. A later call
 * wins: if the user flips the switch while an earlier call is still
 * waiting, the earlier one leaves the page alone.
 *
 * @param {boolean} enabled the user's preference
 * @param {{wait?: boolean}} [opts]
 * @returns {Promise<{enabled:boolean, available:boolean}>}
 */
export async function applyMonet(enabled, { wait = true } = {}) {
	const request = ++monetRequest;
	const available = enabled && wait ? await waitForMonet() : monetAvailable();
	const on = Boolean(enabled) && available;
	if (request !== monetRequest) return { enabled: on, available };
	if (on) {
		document.documentElement.dataset.monet = 'on';
	} else {
		delete document.documentElement.dataset.monet;
	}
	return { enabled: on, available };
}
