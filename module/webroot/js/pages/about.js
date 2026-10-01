import { setSetting, PERSISTENT_DIR, MOD_DIR } from '../bridge-data.js';
import { applyTheme, applyMonet, monetAvailable } from '../theme.js';
import { applyFullscreen, fullScreenAvailable } from '../fullscreen.js';
import { nextPaint } from '../ksu-bridge.js';
import { t, tf } from '../i18n.js';

function switchHtml(role) {
	return `
		<label class="m3-switch">
			<input type="checkbox" data-role="${role}">
			<span class="m3-switch__track"></span>
			<span class="m3-switch__thumb"></span>
		</label>`;
}

export function buildAbout(root) {
	root.innerHTML = `
		<div class="card about-head">
			<div class="about-head__name" data-role="name">NyxBridge</div>
			<div class="about-head__version" data-role="version">—</div>
		</div>

		<h2 class="section-title">${t('about_what_title', 'What it does')}</h2>
		<div class="card prose">
			<p>${t('about_what_body', "In managed mode VirtualAP hands the hotspot to an OpenWrt container and leaves its bridge, <code>vap-br0</code>, without an address, so the phone itself is not on the hotspot network. NyxBridge gives the phone an address there and adds the routing rule Android needs, so apps like LocalSend can reach hotspot devices.")}</p>
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

	root.querySelector('[data-role="theme"]').addEventListener('change', async (e) => {
		const mode = e.target.value;
		const effective = await applyTheme(mode);
		updateThemeHint(root, mode, effective);
		await nextPaint();
		await setSetting('webui_theme', mode);
	});

	root.querySelector('[data-role="monet"]').addEventListener('change', async (e) => {
		const wanted = e.target.checked;
		const { enabled, available } = await applyMonet(wanted);
		// If the manager never supplied a palette, don't leave the switch on
		// while the colours plainly haven't changed.
		e.target.checked = enabled;
		updateMonetHint(root, available);
		await nextPaint();
		await setSetting('webui_monet', wanted ? 1 : 0);
	});

	root.querySelector('[data-role="fullscreen"]').addEventListener('change', async (e) => {
		// Applied first so the change is visible immediately; the config
		// write only decides what happens next time the WebUI opens.
		const applied = applyFullscreen(e.target.checked);
		e.target.checked = applied;
		await nextPaint();
		await setSetting('webui_fullscreen', applied ? 1 : 0);
	});
}

export function renderAbout(root, { prop, config }) {
	root.querySelector('[data-role="name"]').textContent = prop.name || 'NyxBridge';
	root.querySelector('[data-role="version"]').textContent = [prop.version, prop.author ? tf('about_by', 'by {author}', { author: prop.author }) : null].filter(Boolean).join(' · ') || '—';

	const mode = config.webui_theme || 'system';
	root.querySelector('[data-role="theme"]').value = mode;
	updateThemeHint(root, mode, document.documentElement.dataset.theme);

	syncMonetSwitch(root);

	// Read back off the document rather than the config, so the switch
	// shows what is actually in effect.
	const fs = root.querySelector('[data-role="fullscreen"]');
	const fsAvailable = fullScreenAvailable();
	fs.checked = document.documentElement.dataset.fullscreen === 'on';
	fs.disabled = !fsAvailable;
	root.querySelector('[data-role="fullscreen-hint"]').textContent = fsAvailable
		? t('about_fullscreen_hint', 'Hide the status and navigation bars')
		: t('about_fullscreen_unavailable', "Your manager doesn't support fullscreen");
}

/** Show the Material You switch as it is in effect right now. Also called
 * when a palette turns up after the page was rendered. */
export function syncMonetSwitch(root) {
	const monet = root.querySelector('[data-role="monet"]');
	if (!monet) return;
	const available = monetAvailable();
	monet.checked = document.documentElement.dataset.monet === 'on';
	monet.disabled = !available;
	updateMonetHint(root, available);
}

function updateMonetHint(root, available) {
	root.querySelector('[data-role="monet-hint"]').textContent = available
		? t('about_monet_hint', 'Use the colours from your wallpaper')
		: t('about_monet_unavailable', "Your manager doesn't provide a Material You palette");
}

function updateThemeHint(root, mode, effective) {
	const scheme = effective === 'dark' ? t('about_scheme_dark', 'dark') : t('about_scheme_light', 'light');
	root.querySelector('[data-role="theme-hint"]').textContent = mode === 'system'
		? tf('about_theme_hint', 'Following the device setting — currently {scheme}.', { scheme })
		: '';
}
