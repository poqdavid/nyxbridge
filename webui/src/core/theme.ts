import { exec, type ExecResult } from './ksu-bridge';

export type Scheme = 'dark' | 'light';

let mediaQuery: MediaQueryList | null = null;
let watching = false;

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

export function parseNightMode({ errno, stdout }: ExecResult): Scheme | null {
	if (errno !== 0) return null;
	const answer = stdout.trim();
	return answer === 'dark' || answer === 'light' ? answer : null;
}

async function querySystemNightMode(): Promise<Scheme | null> {
	try {
		return parseNightMode(await exec(NIGHT_MODE_COMMAND));
	} catch {
		return null;
	}
}

function mediaPrefersDark(): boolean {
	if (!mediaQuery && typeof window.matchMedia === 'function') {
		mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
	}
	return mediaQuery ? mediaQuery.matches : false;
}

export async function resolveSystemTheme(known?: Scheme | null): Promise<Scheme> {
	const fromAndroid = known === undefined ? await querySystemNightMode() : known;
	if (fromAndroid) return fromAndroid;
	return mediaPrefersDark() ? 'dark' : 'light';
}

export async function applyTheme(mode: string, { systemNight }: { systemNight?: Scheme | null } = {}): Promise<Scheme> {
	const root = document.documentElement;
	root.dataset.themeSource = mode;
	let effective: Scheme;
	if (mode === 'light' || mode === 'dark') {
		effective = mode;
	} else {
		effective = await resolveSystemTheme(systemNight);
		watchSystemChanges();
	}
	root.dataset.theme = effective;
	root.style.colorScheme = effective;
	return effective;
}

function watchSystemChanges(): void {
	if (watching) return;
	if (!mediaQuery && typeof window.matchMedia === 'function') {
		mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
	}
	if (!mediaQuery || typeof mediaQuery.addEventListener !== 'function') return;
	mediaQuery.addEventListener('change', async () => {
		const root = document.documentElement;
		if (root.dataset.themeSource !== 'system') return;
		const effective = await resolveSystemTheme();
		root.dataset.theme = effective;
		root.style.colorScheme = effective;
	});
	watching = true;
}

export function monetAvailable(): boolean {
	const probe = window.getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
	return probe.length > 0;
}

async function waitForMonet(timeoutMs = 1200): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (monetAvailable()) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return monetAvailable();
}

let monetRequest = 0;

export async function applyMonet(enabled: boolean, { wait = true }: { wait?: boolean } = {}): Promise<{ enabled: boolean; available: boolean }> {
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
