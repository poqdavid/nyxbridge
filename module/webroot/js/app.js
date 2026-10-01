import { icons } from './icons.js';
import { nextPaint } from './ksu-bridge.js';
import { loadEverything, getLog } from './bridge-data.js';
import { initI18n, t } from './i18n.js';
import { applyFullscreen } from './fullscreen.js';
import { applyTheme, applyMonet, NIGHT_MODE_COMMAND, parseNightMode } from './theme.js';
import { initKeyboardHandling } from './keyboard.js';
import { buildMain, renderMain } from './pages/main.js';
import { buildSettings, renderSettings } from './pages/settings.js';
import { buildLogs, renderLogs } from './pages/logs.js';
import { buildAbout, renderAbout, syncMonetSwitch } from './pages/about.js';

const PAGES = {
	main: { build: buildMain, render: renderMain, icon: icons.home, label: ['nav_main', 'Main'] },
	settings: { build: buildSettings, render: renderSettings, icon: icons.settings, label: ['nav_settings', 'Settings'] },
	logs: { build: buildLogs, render: renderLogs, icon: icons.logs, label: ['nav_logs', 'Logs'] },
	about: { build: buildAbout, render: renderAbout, icon: icons.info, label: ['nav_about', 'About'] },
};

const app = document.getElementById('app');
const navBar = document.getElementById('nav-bar');
const refreshBtn = document.getElementById('refresh-btn');
const titleEl = document.getElementById('app-title');

let currentPage = 'main';

// What every page renders from. Filled by one batched read at startup and
// on refresh; actions (Check now, a switch, Save) put the status they get
// back in here. Rendering only touches the DOM, never the shell, so a tab
// switch costs nothing (every exec() freezes the page - see ksu-bridge.js).
const state = { status: {}, config: {}, log: '', prop: {} };

// The log changes whenever the status does, but is only re-read when you
// actually look at it.
let logStale = false;

const ctx = {
	state,
	update(patch) {
		Object.assign(state, patch);
		if ('status' in patch && !('log' in patch)) logStale = true;
		renderAll();
		if (logStale && currentPage === 'logs') reloadLog();
	},
	// Every page's text comes from t() at build time, so a new language
	// means rebuilding them all - from the data already here, no shell.
	languageChanged() {
		buildAll();
		renderAll();
	},
};

const pageEl = (key) => document.getElementById(`page-${key}`);

function buildAll() {
	app.innerHTML = '';
	for (const [key, page] of Object.entries(PAGES)) {
		const section = document.createElement('section');
		section.className = `page${key === currentPage ? ' active' : ''}`;
		section.id = `page-${key}`;
		app.appendChild(section);
		page.build(section, ctx);
	}
	navBar.innerHTML = Object.entries(PAGES).map(([key, page]) => `
		<button class="nav-item" data-page="${key}"${key === currentPage ? ' aria-current="page"' : ''}>
			${page.icon}
			<span class="pill">${t(page.label[0], page.label[1])}</span>
		</button>
	`).join('');
	titleEl.textContent = t('app_title', 'NyxBridge');
	refreshBtn.setAttribute('aria-label', t('action_refresh', 'Refresh'));
	document.title = t('app_title', 'NyxBridge');
}

function renderAll() {
	for (const [key, page] of Object.entries(PAGES)) page.render(pageEl(key), state);
}

function goToPage(key) {
	if (!PAGES[key]) return;
	currentPage = key;
	document.querySelectorAll('.page').forEach((el) => el.classList.toggle('active', el.id === `page-${key}`));
	document.querySelectorAll('.nav-item').forEach((el) => {
		if (el.dataset.page === key) el.setAttribute('aria-current', 'page');
		else el.removeAttribute('aria-current');
	});
	window.scrollTo(0, 0);
	if (key === 'logs' && logStale) reloadLog();
}

async function reloadLog() {
	logStale = false;
	await nextPaint();
	state.log = await getLog();
	renderLogs(pageEl('logs'), state);
}

async function refreshAll() {
	if (refreshBtn.classList.contains('is-busy')) return;
	refreshBtn.classList.add('is-busy');
	try {
		await nextPaint();
		const { status, config, log, prop } = await loadEverything();
		Object.assign(state, { status, config, log, prop });
		logStale = false;
		renderAll();
	} finally {
		refreshBtn.classList.remove('is-busy');
	}
}

async function init() {
	// The language files load in the background while the shell read below
	// holds the page. Any failure falls back to the bundled English.
	const i18nReady = initI18n();
	// Everything the four pages show, plus Android's night mode for the
	// "System" theme, in ONE exec - one root shell.
	const data = await loadEverything({ night: NIGHT_MODE_COMMAND });
	Object.assign(state, { status: data.status, config: data.config, log: data.log, prop: data.prop });
	await i18nReady;
	const { config } = state;
	await applyTheme(config.webui_theme ?? 'system', { systemNight: parseNightMode(data.extra.night) });
	const monetWanted = (config.webui_monet ?? '1') === '1';
	const monet = await applyMonet(monetWanted, { wait: false });
	if (monetWanted && !monet.available) {
		applyMonet(true).then(() => syncMonetSwitch(pageEl('about')));
	}
	applyFullscreen((config.webui_fullscreen ?? '1') === '1');
	initKeyboardHandling();

	navBar.addEventListener('click', (e) => {
		const btn = e.target.closest('.nav-item');
		if (btn) goToPage(btn.dataset.page);
	});
	refreshBtn.addEventListener('click', () => refreshAll());

	buildAll();
	renderAll();
	goToPage('main');
}

init();
