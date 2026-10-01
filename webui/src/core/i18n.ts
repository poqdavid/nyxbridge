type Table = Record<string, string>;

const STORAGE_KEY = 'nyx_language';

let english: Table | null = null;

let active: Table | null = null;
let activeCode = 'en';

let available: Table = { en: 'English' };

const SAFETY: Table = {
	app_title: 'NyxBridge',
	nav_main: 'Main',
	nav_settings: 'Settings',
	nav_logs: 'Logs',
	nav_about: 'About',
	set_group_language: 'Language',
	set_language_label: 'Interface language',
};

function pick(table: Table | null, key: string): string | undefined {
	if (!table) return undefined;
	const v = table[key];
	return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

export function t(key: string, fallback?: string): string {
	return pick(active, key) ?? pick(english, key) ?? SAFETY[key] ?? fallback ?? key;
}

export function tf(key: string, fallback: string, params: Record<string, string | number> = {}): string {
	return t(key, fallback).replace(/\{(\w+)\}/g, (m: string, name: string) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m));
}

export function getCurrentLanguage(): string {
	return activeCode;
}

export function getAvailableLanguages(): Table {
	return { ...available };
}

async function fetchTable(code: string): Promise<Table | null> {
	try {
		const res = await fetch(`languages/${code}.json`, { cache: 'no-store' });
		if (!res.ok) return null;
		const table: unknown = await res.json();
		return table && typeof table === 'object' ? (table as Table) : null;
	} catch {
		return null;
	}
}

async function loadManifest(): Promise<void> {
	try {
		const res = await fetch('languages/languages.json', { cache: 'no-store' });
		if (res.ok) {
			const json: unknown = await res.json();
			if (json && typeof json === 'object') {
				available = { en: 'English', ...(json as Table) };
			}
		}
	} catch {
		/* ignore */
	}
}

function persist(code: string): void {
	try {
		localStorage.setItem(STORAGE_KEY, code);
	} catch {
		/* ignore */
	}
}

export async function setLanguage(code: string): Promise<void> {
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

export async function initI18n(): Promise<void> {
	const [en] = await Promise.all([fetchTable('en'), loadManifest()]);
	english = en;
	if (!english) {
		console.error('i18n: languages/en.json failed to load; using inline safety strings');
	}
	let saved = 'en';
	try {
		saved = localStorage.getItem(STORAGE_KEY) || 'en';
	} catch {
		/* ignore */
	}
	if (saved !== 'en' && available[saved]) {
		await setLanguage(saved);
	} else {
		active = null;
		activeCode = 'en';
	}
}
