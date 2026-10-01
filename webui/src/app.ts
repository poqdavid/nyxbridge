import { icons } from './core/icons';
import { $, closestTarget } from './core/dom';
import { nextPaint } from './core/ksu-bridge';
import { initI18n, t } from './core/i18n';
import { applyFullscreen } from './core/fullscreen';
import { applyMonet, applyTheme, NIGHT_MODE_COMMAND, parseNightMode } from './core/theme';
import { initKeyboardHandling } from './core/keyboard';
import { getLog, loadEverything, NO_DEVICES, NO_STATUS, watchLive, type LiveUpdate } from './bridge-data';
import type { AppState, PageContext } from './context';
import { buildMain, renderMain } from './pages/main';
import { buildSettings, renderSettings } from './pages/settings';
import { buildLogs, renderLogs } from './pages/logs';
import { buildAbout, renderAbout, syncMonetSwitch } from './pages/about';

interface Page {
	build(root: HTMLElement, ctx: PageContext): void;
	render(root: HTMLElement, state: AppState): void;
	icon: string;
	label: [string, string];
}

const PAGES = {
	main: { build: buildMain, render: renderMain, icon: icons.home, label: ['nav_main', 'Main'] },
	settings: { build: buildSettings, render: renderSettings, icon: icons.settings, label: ['nav_settings', 'Settings'] },
	logs: { build: buildLogs, render: renderLogs, icon: icons.logs, label: ['nav_logs', 'Logs'] },
	about: { build: buildAbout, render: renderAbout, icon: icons.info, label: ['nav_about', 'About'] },
} satisfies Record<string, Page>;

type PageKey = keyof typeof PAGES;
const PAGE_KEYS = Object.keys(PAGES) as PageKey[];

function isPageKey(key: string | undefined): key is PageKey {
	return key !== undefined && Object.prototype.hasOwnProperty.call(PAGES, key);
}

const app = $(document, '#app');
const navBar = $(document, '#nav-bar');
const refreshBtn = $(document, '#refresh-btn');
const titleEl = $(document, '#app-title');

let currentPage: PageKey = 'main';

const state: AppState = {
	status: NO_STATUS,
	statusOk: false,
	devices: NO_DEVICES,
	config: {},
	log: '',
	prop: {},
	live: false,
};

let logStale = false;
let logReading: Promise<void> | null = null;

const pageEl = (key: PageKey): HTMLElement => $(document, `#page-${key}`);

const ctx: PageContext = {
	state,
	update(patch) {
		Object.assign(state, patch);
		if (patch.status) state.statusOk = true;
		if (patch.status && patch.log === undefined) logStale = true;
		renderAll();
		if (logStale && currentPage === 'logs') reloadLog();
	},
	languageChanged() {
		buildAll();
		renderAll();
	},
};

function buildAll(): void {
	app.replaceChildren();
	for (const key of PAGE_KEYS) {
		const section = document.createElement('section');
		section.className = `page${key === currentPage ? ' active' : ''}`;
		section.id = `page-${key}`;
		app.appendChild(section);
		PAGES[key].build(section, ctx);
	}
	navBar.innerHTML = PAGE_KEYS.map((key) => {
		const page = PAGES[key];
		return `
		<button class="nav-item" data-page="${key}"${key === currentPage ? ' aria-current="page"' : ''}>
			${page.icon}
			<span class="pill">${t(page.label[0], page.label[1])}</span>
		</button>`;
	}).join('');
	titleEl.textContent = t('app_title', 'NyxBridge');
	refreshBtn.setAttribute('aria-label', t('action_refresh', 'Refresh'));
	document.title = t('app_title', 'NyxBridge');
}

function renderAll(): void {
	for (const key of PAGE_KEYS) PAGES[key].render(pageEl(key), state);
}

function goToPage(key: PageKey): void {
	currentPage = key;
	document.querySelectorAll('.page').forEach((el) => el.classList.toggle('active', el.id === `page-${key}`));
	document.querySelectorAll<HTMLElement>('.nav-item').forEach((el) => {
		if (el.dataset.page === key) el.setAttribute('aria-current', 'page');
		else el.removeAttribute('aria-current');
	});
	window.scrollTo(0, 0);
	if (key === 'logs' && logStale) reloadLog();
}

function reloadLog(): Promise<void> {
	if (logReading) return logReading;
	logStale = false;
	logReading = (async () => {
		state.log = await getLog();
		renderLogs(pageEl('logs'), state);
	})().finally(() => {
		logReading = null;
		if (logStale && currentPage === 'logs') reloadLog();
	});
	return logReading;
}

async function refreshAll(): Promise<void> {
	if (refreshBtn.classList.contains('is-busy')) return;
	refreshBtn.classList.add('is-busy');
	try {
		await nextPaint();
		const data = await loadEverything();
		Object.assign(state, {
			status: data.status ?? state.status,
			statusOk: data.status !== null,
			devices: data.devices,
			config: data.config,
			log: data.log,
			prop: data.prop,
		});
		logStale = false;
		renderAll();
		startLive();
	} finally {
		refreshBtn.classList.remove('is-busy');
	}
}

const LIVE_SECONDS = 300;
let liveRunning = false;
let liveStartedAt = 0;
let quickExits = 0;
let liveUnsupported = false;

function setLive(on: boolean): void {
	if (state.live === on) return;
	state.live = on;
	renderAll();
}

function onLive(u: LiveUpdate): void {
	const patch: Partial<AppState> = {};
	if (u.status) patch.status = u.status;
	if (u.devices) patch.devices = u.devices;
	state.live = true;
	ctx.update(patch);
}

function startLive(): void {
	if (liveRunning || liveUnsupported || document.visibilityState === 'hidden') return;
	liveStartedAt = Date.now();
	const started = watchLive(LIVE_SECONDS, onLive, () => {
		liveRunning = false;
		setLive(false);
		const quick = Date.now() - liveStartedAt < 5000;
		quickExits = quick ? quickExits + 1 : 0;
		if (quickExits >= 3) return;
		setTimeout(startLive, quick ? 5000 : 250);
	});
	if (!started) {
		liveUnsupported = true;
		return;
	}
	liveRunning = true;
}

document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'visible') {
		quickExits = 0;
		startLive();
	}
});

async function init(): Promise<void> {
	const i18nReady = initI18n();
	const data = await loadEverything({ night: NIGHT_MODE_COMMAND });
	Object.assign(state, {
		status: data.status ?? NO_STATUS,
		statusOk: data.status !== null,
		devices: data.devices,
		config: data.config,
		log: data.log,
		prop: data.prop,
	});
	await i18nReady;
	const { config } = state;
	const night = data.extra.night;
	await applyTheme(config.webui_theme ?? 'system', night ? { systemNight: parseNightMode(night) } : {});
	const monetWanted = (config.webui_monet ?? '1') === '1';
	const monet = await applyMonet(monetWanted, { wait: false });
	if (monetWanted && !monet.available) {
		applyMonet(true).then(() => syncMonetSwitch(pageEl('about')));
	}
	applyFullscreen((config.webui_fullscreen ?? '1') === '1');
	initKeyboardHandling();

	navBar.addEventListener('click', (e) => {
		const page = closestTarget(e, '.nav-item')?.dataset.page;
		if (isPageKey(page)) goToPage(page);
	});
	refreshBtn.addEventListener('click', () => refreshAll());

	buildAll();
	renderAll();
	goToPage('main');
	startLive();
}

init();
