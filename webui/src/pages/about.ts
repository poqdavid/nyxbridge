import { MOD_DIR, PERSISTENT_DIR, setSetting } from '../bridge-data';
import type { AppState } from '../context';
import { $ } from '../core/dom';
import { applyFullscreen, fullScreenAvailable } from '../core/fullscreen';
import { nextPaint } from '../core/ksu-bridge';
import { t, tf } from '../core/i18n';
import { applyMonet, applyTheme, monetAvailable } from '../core/theme';

function switchHtml(role: string): string {
	return `
		<label class="m3-switch">
			<input type="checkbox" data-role="${role}">
			<span class="m3-switch__track"></span>
			<span class="m3-switch__thumb"></span>
		</label>`;
}

export function buildAbout(root: HTMLElement): void {
	root.innerHTML = `
		<div class="card about-head">
			<div class="about-head__name" data-role="name">NyxBridge</div>
			<div class="about-head__version" data-role="version">—</div>
		</div>

		<h2 class="section-title">${t('about_what_title', 'What it does')}</h2>
		<div class="card prose">
			<p>${t('about_what_body', 'In managed mode VirtualAP hands the hotspot to an OpenWrt container and leaves its bridge, <code>vap-br0</code>, without an address, so the phone itself is not on the hotspot network. NyxBridge gives the phone an address there and adds the routing rule Android needs, so apps like LocalSend can reach hotspot devices.')}</p>
			<p>${t('about_what_cleanup', 'It only acts while VirtualAP runs in managed mode, and removes everything it added when the hotspot stops.')}</p>
		</div>

		<h2 class="section-title">${t('about_appearance_title', 'Appearance')}</h2>
		<div class="card">
			<div class="setting-row">
				<div class="setting-row__text">
					<div class="setting-row__title">${t('about_theme_label', 'Theme')}</div>
					<div class="setting-row__desc" data-role="theme-hint"></div>
				</div>
				<select class="select-field" data-role="theme">
					<option value="system">${t('about_theme_system', 'System')}</option>
					<option value="light">${t('about_theme_light', 'Light')}</option>
					<option value="dark">${t('about_theme_dark', 'Dark')}</option>
				</select>
			</div>
			<div class="setting-row">
				<div class="setting-row__text">
					<div class="setting-row__title">${t('about_monet_label', 'Material You')}</div>
					<div class="setting-row__desc" data-role="monet-hint"></div>
				</div>
				${switchHtml('monet')}
			</div>
			<div class="setting-row">
				<div class="setting-row__text">
					<div class="setting-row__title">${t('about_fullscreen_label', 'Fullscreen')}</div>
					<div class="setting-row__desc" data-role="fullscreen-hint"></div>
				</div>
				${switchHtml('fullscreen')}
			</div>
		</div>

		<h2 class="section-title">${t('about_credits_title', 'Credits')}</h2>
		<div class="card prose">
			<p>${t('about_credits_virtualap', '<strong>VirtualAP</strong> by <strong>ravindu644</strong> creates the hotspot and the managed-mode bridge NyxBridge attaches to.')}</p>
			<p>${t('about_credits_droidspaces', '<strong>Droidspaces</strong> by <strong>ravindu644</strong> runs the OpenWrt container that owns the hotspot network.')}</p>
			<p>${t('about_credits_lanip', 'The idea of a low-priority routing rule for the hotspot subnet comes from studying <strong>droidspaces-lan-ip</strong> by <strong>yashoswalyo</strong> and VirtualAP’s routed mode. NyxBridge’s code is its own.')}</p>
			<p>${t('about_credits_nyx', 'The WebUI shares its framework with NyxSUSFS and NyxProps. Issues and translations welcome.')}</p>
			<p class="muted">${t('about_credits_config', 'Config &amp; logs:')} <code>${PERSISTENT_DIR}</code></p>
		</div>

		<h2 class="section-title">${t('about_license_title', 'License')}</h2>
		<div class="card prose">
			<p>${t('about_license_copyright', 'Copyright © 2026 poqdavid')}</p>
			<p>${t('about_license_body', 'NyxBridge is free software under the GNU Affero General Public License v3.0 (AGPL-3.0-only). You may redistribute and modify it under that license. It comes with ABSOLUTELY NO WARRANTY.')}</p>
			<p class="muted">${t('about_license_where', 'License text and notices:')} <code>${MOD_DIR}/LICENSE</code>, <code>NOTICE.md</code><br>${t('about_license_source', 'Source code:')} <code>github.com/poqdavid/nyxbridge</code></p>
		</div>
	`;

	$(root, '[data-role="theme"]').addEventListener('change', async (e) => {
		const mode = (e.target as HTMLSelectElement).value;
		const effective = await applyTheme(mode);
		updateThemeHint(root, mode, effective);
		await nextPaint();
		await setSetting('webui_theme', mode);
	});

	$(root, '[data-role="monet"]').addEventListener('change', async (e) => {
		const sw = e.target as HTMLInputElement;
		const wanted = sw.checked;
		const { enabled, available } = await applyMonet(wanted);
		sw.checked = enabled;
		updateMonetHint(root, available);
		await nextPaint();
		await setSetting('webui_monet', wanted ? 1 : 0);
	});

	$(root, '[data-role="fullscreen"]').addEventListener('change', async (e) => {
		const sw = e.target as HTMLInputElement;
		const applied = applyFullscreen(sw.checked);
		sw.checked = applied;
		await nextPaint();
		await setSetting('webui_fullscreen', applied ? 1 : 0);
	});
}

export function renderAbout(root: HTMLElement, { prop, config, status }: AppState): void {
	$(root, '[data-role="name"]').textContent = prop.name || 'NyxBridge';
	const version = prop.version || status.version;
	$(root, '[data-role="version"]').textContent = [version, prop.author ? tf('about_by', 'by {author}', { author: prop.author }) : null].filter(Boolean).join(' · ') || '—';

	const mode = config.webui_theme || 'system';
	$<HTMLSelectElement>(root, '[data-role="theme"]').value = mode;
	updateThemeHint(root, mode, document.documentElement.dataset.theme);

	syncMonetSwitch(root);

	const fs = $<HTMLInputElement>(root, '[data-role="fullscreen"]');
	const fsAvailable = fullScreenAvailable();
	fs.checked = document.documentElement.dataset.fullscreen === 'on';
	fs.disabled = !fsAvailable;
	$(root, '[data-role="fullscreen-hint"]').textContent = fsAvailable
		? t('about_fullscreen_hint', 'Hide the status and navigation bars')
		: t('about_fullscreen_unavailable', "Your manager doesn't support fullscreen");
}

export function syncMonetSwitch(root: HTMLElement): void {
	const monet = root.querySelector<HTMLInputElement>('[data-role="monet"]');
	if (!monet) return;
	const available = monetAvailable();
	monet.checked = document.documentElement.dataset.monet === 'on';
	monet.disabled = !available;
	updateMonetHint(root, available);
}

function updateMonetHint(root: HTMLElement, available: boolean): void {
	$(root, '[data-role="monet-hint"]').textContent = available
		? t('about_monet_hint', 'Use the colours from your wallpaper')
		: t('about_monet_unavailable', "Your manager doesn't provide a Material You palette");
}

function updateThemeHint(root: HTMLElement, mode: string, effective: string | undefined): void {
	const scheme = effective === 'dark' ? t('about_scheme_dark', 'dark') : t('about_scheme_light', 'light');
	$(root, '[data-role="theme-hint"]').textContent = mode === 'system' ? tf('about_theme_hint', 'Following the device setting — currently {scheme}.', { scheme }) : '';
}
