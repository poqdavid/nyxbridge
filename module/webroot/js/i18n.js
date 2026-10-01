// Minimal i18n for the Nyx WebUI.
//
// Follows the original ksu_module_susfs pattern: every language, ENGLISH
// INCLUDED, is a file under webroot/languages/<code>.json, fetched at
// runtime. English is not special-cased in code - it's just the default
// language and the fallback source, exactly like the original uses en.xml.
//
// Design priorities, in order:
//   1. Never break rendering. t(key) ALWAYS returns a string - the active
//      language, else fetched English, else a tiny inline safety net, else
//      the key itself. Never undefined, never throws.
//   2. Consistency. English lives in languages/en.json alongside every other
//      language, same format. Translators copy en.json -> <code>.json and
//      translate the values; missing keys fall back to English.
//   3. Resilience. The KSU WebUI serves these files locally so fetch is
//      reliable, but if even en.json fails to load, a small inline set of
//      the most critical strings keeps the UI legible, and anything beyond
//      that renders its key rather than blanking.
//
// This is NOT the original's XML/data-i18n DOM-scan scheme. Nyx renders every
// page from JS template strings rebuilt on each refresh, so translation
// happens at render time by calling t(key) - no DOM-attribute pass to sync.

const STORAGE_KEY = 'nyx_language';

// Loaded English table (the fallback source), fetched once at init.
let english = null;
// Loaded table for the active non-English language, or null when English.
let active = null;
let activeCode = 'en';

// code -> display name, for the selector. Always contains at least English.
let available = { en: 'English' };

// Last-resort inline strings: only what's needed to keep the UI usable if
// even languages/en.json can't be loaded. Everything else falls back to its
// key. Kept deliberately tiny - en.json is the real source of truth.
const SAFETY = {
	app_title: 'NyxBridge',
	nav_main: 'Main',
	nav_settings: 'Settings',
	nav_logs: 'Logs',
	nav_about: 'About',
	set_group_language: 'Language',
	set_language_label: 'Interface language',
};

function hasText(table, key) {
	if (!table || !Object.prototype.hasOwnProperty.call(table, key)) return false;
	const v = table[key];
	return typeof v === 'string' && v.trim() !== '';
}

/**
 * Translate a key. Guaranteed to return a string.
 * @param {string} key
 * @param {string} [fallback] literal to use if the key is unknown even in
 *        English (lets callers inline a default during migration).
 */
export function t(key, fallback) {
	if (hasText(active, key)) return active[key];
	if (hasText(english, key)) return english[key];
	if (Object.prototype.hasOwnProperty.call(SAFETY, key)) return SAFETY[key];
	if (typeof fallback === 'string') return fallback;
	return key;
}

export function getCurrentLanguage() {
	return activeCode;
}

export function getAvailableLanguages() {
	return { ...available };
}

/** Fetch a language table by code, or null on any failure. */
async function fetchTable(code) {
	try {
		const res = await fetch(`languages/${code}.json`, { cache: 'no-store' });
		if (!res.ok) return null;
		const table = await res.json();
		return (table && typeof table === 'object') ? table : null;
	} catch (_e) {
		return null;
	}
}

/**
 * Load the manifest of available languages. Failure is non-fatal: English is
 * always present and listed first regardless of what the manifest says.
 */
async function loadManifest() {
	try {
		const res = await fetch('languages/languages.json', { cache: 'no-store' });
		if (res.ok) {
			const json = await res.json();
			if (json && typeof json === 'object') {
				available = { en: 'English', ...json };
			}
		}
	} catch (_e) {
		// offline / no file: English-only, which is fine.
	}
}

function persist(code) {
	try { localStorage.setItem(STORAGE_KEY, code); } catch (_e) { /* ignore */ }
}

/**
 * Load and activate a language by code. 'en' resets to English (active=null,
 * translation comes straight from the fetched English table). A fetch failure
 * leaves the previous language in place rather than blanking the UI.
 */
export async function setLanguage(code) {
	if (!code || code === 'en') {
		active = null;
		activeCode = 'en';
		persist('en');
		return;
	}
	const table = await fetchTable(code);
	if (table) {
		active = table;
		activeCode = code;
		persist(code);
		return;
	}
	console.error(`i18n: could not load language '${code}', staying on '${activeCode}'`);
}

/**
 * One-time init at boot. Loads English (the fallback source) and the manifest,
 * then the saved language if any. Always safe - worst case the UI renders from
 * the inline SAFETY set and keys.
 */
export async function initI18n() {
	// Both files are requested together: each one the manager serves can
	// cost a root shell of its own, so there's no point waiting in line.
	const [en] = await Promise.all([fetchTable('en'), loadManifest()]);
	english = en;
	if (!english) {
		console.error('i18n: languages/en.json failed to load; using inline safety strings');
	}
	let saved = 'en';
	try { saved = localStorage.getItem(STORAGE_KEY) || 'en'; } catch (_e) { /* ignore */ }
	if (saved !== 'en' && available[saved]) {
		await setLanguage(saved);
	} else {
		active = null;
		activeCode = 'en';
	}
}

/**
 * t() with {name} placeholders filled from `params`. Values are inserted as
 * given, so callers that put the result into innerHTML escape them first.
 * @param {string} key
 * @param {string} fallback
 * @param {Record<string, string|number>} [params]
 */
export function tf(key, fallback, params = {}) {
	return t(key, fallback).replace(/\{(\w+)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m));
}
