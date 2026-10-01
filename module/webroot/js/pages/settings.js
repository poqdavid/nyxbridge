import { setSetting, CONFIG_PATH } from '../bridge-data.js';
import { toast, nextPaint } from '../ksu-bridge.js';
import { t, tf, getAvailableLanguages, getCurrentLanguage, setLanguage } from '../i18n.js';
import { escapeHtml, busyButton } from '../util.js';

// Language first, as in NyxSUSFS / NyxProps, then the bridge settings.
// The switches show the value from `ctl.sh status`, which reads the same
// config.sh the watcher does.

function switchHtml(role) {
	return `
		<label class="m3-switch">
			<input type="checkbox" data-role="${role}">
			<span class="m3-switch__track"></span>
			<span class="m3-switch__thumb"></span>
		</label>`;
}

export function buildSettings(root, ctx) {
	const langs = getAvailableLanguages();
	const current = getCurrentLanguage();
	root.innerHTML = `
		<h2 class="section-title">${t('set_group_language', 'Language')}</h2>
		<div class="card">
			<div class="setting-row setting-row--stacked">
				<div class="setting-row__text">
					<div class="setting-row__title">${t('set_language_label', 'Interface language')}</div>
					<div class="setting-row__desc">${t('set_language_desc', 'English is the source language. Other languages are community translations and may be incomplete; missing text falls back to English.')}</div>
				</div>
				<select class="select-field select-field--block" data-role="language">
					${Object.entries(langs).map(([code, name]) => `<option value="${escapeHtml(code)}" ${code === current ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}
				</select>
			</div>
		</div>

		<h2 class="section-title">${t('set_group_bridge', 'Bridge')}</h2>
		<div class="card">
			<div class="setting-row">
				<div class="setting-row__text">
					<div class="setting-row__title">${t('set_enabled_label', 'Phone address on the bridge')}</div>
					<div class="setting-row__desc">${t('set_enabled_desc', 'Lets apps on the phone reach hotspot devices while VirtualAP runs in managed mode.')}</div>
				</div>
				${switchHtml('enabled')}
			</div>
			<div class="setting-row">
				<div class="setting-row__text">
					<div class="setting-row__title">${t('set_ipv6_label', 'IPv6')}</div>
					<div class="setting-row__desc">${t('set_ipv6_desc', "Also take an address from OpenWrt's announcements. Never uses OpenWrt as the phone's IPv6 gateway. Off by default.")}</div>
				</div>
				${switchHtml('ipv6')}
			</div>
			<div class="setting-row setting-row--stacked">
				<div class="setting-row__text">
					<div class="setting-row__title">${t('set_host_label', 'Phone address')}</div>
				</div>
				<div class="ip-edit">
					<span class="ip-edit__prefix" data-role="prefix"></span>
					<input class="select-field ip-edit__input" data-role="host" type="text" inputmode="numeric" maxlength="3" autocomplete="off" aria-label="${escapeHtml(t('set_host_aria', 'Last number of the phone address'))}">
					<button class="btn btn--tonal" data-role="save-host" disabled>${t('set_host_save', 'Save')}</button>
				</div>
				<div class="setting-row__desc" data-role="host-hint"></div>
			</div>
		</div>
		<p class="setting-row__desc page-footnote">${tf('set_footnote', 'The rule priority and the other settings are in {path}.', { path: `<code>${CONFIG_PATH}</code>` })}</p>
	`;

	root.querySelector('[data-role="language"]').addEventListener('change', async (e) => {
		await setLanguage(e.target.value);
		ctx.languageChanged();
	});

	const bridgeSwitch = (role, onMsg, offMsg) => {
		root.querySelector(`[data-role="${role}"]`).addEventListener('change', async (e) => {
			const on = e.target.checked;
			// Show the flipped switch first; the write holds the page.
			await nextPaint();
			const res = await setSetting(role, on ? 1 : 0);
			if (res.ok && res.status) {
				ctx.update({ status: res.status });
				toast(on ? onMsg() : offMsg());
			} else {
				e.target.checked = !on;
				toast(res.error || t('set_failed_toast', 'Could not save the setting'));
			}
		});
	};
	bridgeSwitch('enabled', () => t('set_enabled_on_toast', 'Turned on'), () => t('set_enabled_off_toast', 'Turned off; address and rule removed'));
	bridgeSwitch('ipv6', () => t('set_ipv6_on_toast', 'IPv6 on'), () => t('set_ipv6_off_toast', 'IPv6 off'));

	const input = root.querySelector('[data-role="host"]');
	const save = root.querySelector('[data-role="save-host"]');
	input.addEventListener('input', () => validateHost(root, ctx.state.status));
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !save.disabled) save.click();
	});
	save.addEventListener('click', async () => {
		const value = input.value.trim();
		if (!/^[1-9]\d{0,2}$/.test(value)) return;
		input.blur();
		const restore = busyButton(save, t('set_host_save', 'Save'));
		await nextPaint();
		try {
			const res = await setSetting('host_octet', value);
			if (res.ok && res.status) {
				ctx.update({ status: res.status });
				toast(tf('set_host_saved_toast', 'Phone address set to .{n}', { n: value }));
			} else {
				toast(res.error || t('set_failed_toast', 'Could not save the setting'));
			}
		} finally {
			restore();
			validateHost(root, ctx.state.status);
		}
	});
}

/** The /24 the phone address lives in, from the status. */
function prefixOf(s) {
	const fromSubnet = (s.subnet || '').match(/^(\d+\.\d+\.\d+)\.0\/24$/);
	if (fromSubnet) return fromSubnet[1];
	const fromGateway = (s.gateway || '').match(/^(\d+\.\d+\.\d+)\.\d+$/);
	return fromGateway ? fromGateway[1] : '';
}

function validateHost(root, s) {
	const input = root.querySelector('[data-role="host"]');
	const save = root.querySelector('[data-role="save-host"]');
	const hint = root.querySelector('[data-role="host-hint"]');
	const raw = input.value.trim();
	const n = Number(raw);
	const gw = (s.gateway || '').split('.')[3];
	const valid = /^[1-9]\d{0,2}$/.test(raw) && n >= 1 && n <= 254 && raw !== gw;
	input.classList.toggle('is-invalid', raw !== '' && !valid);
	save.disabled = save.classList.contains('is-busy') || !valid || raw === s.host_octet;
	if (raw !== '' && raw === gw) {
		hint.textContent = t('set_host_hint_gateway', "That is VirtualAP's gateway address.");
		hint.classList.add('is-warn');
	} else if (valid && n >= 100 && n <= 249) {
		hint.textContent = t('set_host_hint_pool', "Inside OpenWrt's DHCP range (.100–.249): a hotspot device could get the same address.");
		hint.classList.add('is-warn');
	} else {
		hint.textContent = t('set_host_hint', 'OpenWrt hands out .100–.249 by DHCP; keep the phone outside that range.');
		hint.classList.remove('is-warn');
	}
}

export function renderSettings(root, { status: s }) {
	root.querySelector('[data-role="enabled"]').checked = s.enabled === '1';
	const v6 = root.querySelector('[data-role="ipv6"]');
	v6.checked = s.ipv6 === '1';
	v6.disabled = s.enabled !== '1';
	const prefix = prefixOf(s);
	root.querySelector('[data-role="prefix"]').textContent = prefix ? `${prefix}.` : t('set_host_prefix_unknown', '<gateway /24>.');
	const input = root.querySelector('[data-role="host"]');
	if (document.activeElement !== input) input.value = s.host_octet || '';
	validateHost(root, s);
}
