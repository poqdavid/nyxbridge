import { CONFIG_PATH, PACKAGE_RE, restartApp, setSetting, type Status } from '../bridge-data';
import type { AppState, PageContext } from '../context';
import { $, escapeHtml } from '../core/dom';
import { nextPaint, toast } from '../core/ksu-bridge';
import { getAvailableLanguages, getCurrentLanguage, setLanguage, t, tf } from '../core/i18n';
import { openSheetWithGroups } from '../core/sheet';
import { reasonText } from '../reasons';
import { busyButton } from '../util';

const DEFAULT_PREF = 7001;
const NETD_FIRST_PREF = 10000;

function switchHtml(role: string, label: string): string {
	return `
		<label class="m3-switch">
			<input type="checkbox" data-role="${role}" aria-label="${escapeHtml(label)}">
			<span class="m3-switch__track"></span>
			<span class="m3-switch__thumb"></span>
		</label>`;
}

export function buildSettings(root: HTMLElement, ctx: PageContext): void {
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
					${Object.entries(langs)
						.map(([code, name]) => `<option value="${escapeHtml(code)}" ${code === current ? 'selected' : ''}>${escapeHtml(name)}</option>`)
						.join('')}
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
				${switchHtml('enabled', t('set_enabled_label', 'Phone address on the bridge'))}
			</div>
			<div class="setting-row">
				<div class="setting-row__text">
					<div class="setting-row__title">${t('set_ipv6_label', 'IPv6')}</div>
					<div class="setting-row__desc">${t('set_ipv6_desc', "Also take an address from OpenWrt's announcements. Never uses OpenWrt as the phone's IPv6 gateway. Off by default.")}</div>
					<button class="btn btn--text btn--inline" data-role="v6-details" hidden>${t('set_ipv6_details', 'IPv6 details')}</button>
				</div>
				${switchHtml('ipv6', t('set_ipv6_label', 'IPv6'))}
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

		<h2 class="section-title">${t('set_group_routing', 'Routing')}</h2>
		<div class="card">
			<div class="setting-row setting-row--stacked">
				<div class="setting-row__text">
					<div class="setting-row__title">${t('set_pref_label', 'Rule priority')}</div>
					<div class="setting-row__desc">${tf('set_pref_desc', "Where the routing rule sits among Android's rules; lower numbers are looked at first. Changing it moves the rules over. Default {n}.", { n: DEFAULT_PREF })}</div>
				</div>
				<div class="ip-edit">
					<input class="select-field ip-edit__input ip-edit__input--wide" data-role="pref" type="text" inputmode="numeric" maxlength="5" autocomplete="off" aria-label="${escapeHtml(t('set_pref_label', 'Rule priority'))}">
					<button class="btn btn--tonal" data-role="save-pref" disabled>${t('set_host_save', 'Save')}</button>
					<button class="btn btn--text" data-role="reset-pref" hidden>${t('set_pref_reset', 'Default')}</button>
				</div>
				<div class="setting-row__desc" data-role="pref-hint"></div>
			</div>
		</div>

		<h2 class="section-title">${t('set_group_app', 'App restart')}</h2>
		<div class="card">
			<div class="setting-row setting-row--stacked">
				<div class="setting-row__text">
					<div class="setting-row__title">${t('set_app_label', 'Restart an app when the bridge comes up')}</div>
					<div class="setting-row__desc">${t('set_app_desc', 'Apps like LocalSend look for networks only when they start. When the phone gets its hotspot address, NyxBridge closes this app and opens it again - only if it was running. Leave empty for none.')}</div>
				</div>
				<div class="ip-edit">
					<input class="select-field ip-edit__input ip-edit__input--grow" data-role="app" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="org.localsend.localsend_app" aria-label="${escapeHtml(t('set_app_aria', 'Package name'))}">
					<button class="btn btn--tonal" data-role="save-app" disabled>${t('set_host_save', 'Save')}</button>
				</div>
				<div class="setting-row__desc" data-role="app-hint"></div>
				<div class="setting-row__actions">
					<button class="btn btn--text" data-role="restart-now" disabled>${t('set_app_restart_now', 'Restart it now')}</button>
				</div>
			</div>
		</div>
		<p class="setting-row__desc page-footnote">${tf('set_footnote', 'All settings are saved in {path}.', { path: `<code>${CONFIG_PATH}</code>` })}</p>
	`;

	$(root, '[data-role="language"]').addEventListener('change', async (e) => {
		await setLanguage((e.target as HTMLSelectElement).value);
		ctx.languageChanged();
	});

	const bridgeSwitch = (role: string, onMsg: () => string, offMsg: () => string) => {
		$(root, `[data-role="${role}"]`).addEventListener('change', async (e) => {
			const sw = e.target as HTMLInputElement;
			const on = sw.checked;
			sw.disabled = true;
			sw.dataset.busy = '1';
			await nextPaint();
			try {
				const res = await setSetting(role, on ? 1 : 0);
				if (res.ok && res.status) {
					ctx.update({ status: res.status });
					toast(res.status.state === 'error' ? reasonText(res.status) : on ? onMsg() : offMsg());
				} else {
					sw.checked = !on;
					toast(res.error || t('set_failed_toast', 'Could not save the setting'));
				}
			} finally {
				delete sw.dataset.busy;
				sw.disabled = false;
				renderSettings(root, ctx.state);
			}
		});
	};
	bridgeSwitch(
		'enabled',
		() => t('set_enabled_on_toast', 'Turned on'),
		() => t('set_enabled_off_toast', 'Turned off; address and rule removed'),
	);
	bridgeSwitch(
		'ipv6',
		() => t('set_ipv6_on_toast', 'IPv6 on'),
		() => t('set_ipv6_off_toast', 'IPv6 off'),
	);

	$(root, '[data-role="v6-details"]').addEventListener('click', () => openV6Details(ctx.state.status));

	const field = (role: string, saveRole: string, validate: () => void, save: (value: string) => Promise<boolean>) => {
		const input = $<HTMLInputElement>(root, `[data-role="${role}"]`);
		const btn = $<HTMLButtonElement>(root, `[data-role="${saveRole}"]`);
		input.addEventListener('input', () => {
			input.dataset.edited = '1';
			validate();
		});
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !btn.disabled) btn.click();
		});
		btn.addEventListener('click', async () => {
			const value = input.value.trim();
			input.blur();
			const restore = busyButton(btn, t('set_host_save', 'Save'));
			await nextPaint();
			try {
				if (await save(value)) {
					delete input.dataset.edited;
					renderSettings(root, ctx.state);
				}
			} finally {
				restore();
				validate();
			}
		});
	};

	field(
		'host',
		'save-host',
		() => validateHost(root, ctx.state.status),
		async (value) => {
			const res = await setSetting('host_octet', value);
			if (res.ok && res.status) {
				ctx.update({ status: res.status });
				toast(tf('set_host_saved_toast', 'Phone address set to .{n}', { n: value }));
				return true;
			}
			toast(res.error || t('set_failed_toast', 'Could not save the setting'));
			return false;
		},
	);

	const savePref = async (value: string): Promise<boolean> => {
		const res = await setSetting('rule_pref', value);
		if (res.ok && res.status) {
			ctx.update({ status: res.status });
			toast(tf('set_pref_saved_toast', 'Rule priority set to {n}', { n: value }));
			return true;
		}
		toast(res.error || t('set_failed_toast', 'Could not save the setting'));
		return false;
	};
	field('pref', 'save-pref', () => validatePref(root, ctx.state.status), savePref);
	$(root, '[data-role="reset-pref"]').addEventListener('click', async (e) => {
		const restore = busyButton(e.currentTarget as HTMLButtonElement, t('set_pref_reset', 'Default'));
		await nextPaint();
		try {
			if (await savePref(String(DEFAULT_PREF))) delete $<HTMLInputElement>(root, '[data-role="pref"]').dataset.edited;
		} finally {
			restore();
			renderSettings(root, ctx.state);
		}
	});

	field(
		'app',
		'save-app',
		() => validateApp(root, ctx.state.status),
		async (value) => {
			const res = await setSetting('restart_app', value);
			if (res.ok) {
				ctx.update({ status: { ...ctx.state.status, restart_app: value } });
				toast(
					value ? tf('set_app_saved_toast', '{app} will be restarted when the bridge comes up', { app: value }) : t('set_app_cleared_toast', 'No app will be restarted'),
				);
				return true;
			}
			toast(res.error || t('set_failed_toast', 'Could not save the setting'));
			return false;
		},
	);
	$(root, '[data-role="restart-now"]').addEventListener('click', async (e) => {
		const restore = busyButton(e.currentTarget as HTMLButtonElement, t('set_app_restarting', 'Restarting…'));
		await nextPaint();
		try {
			const res = await restartApp();
			toast(
				res.ok
					? tf('set_app_restarted_toast', 'Restarted {app}', { app: ctx.state.status.restart_app })
					: res.error || t('set_app_restart_failed', 'Could not restart the app'),
			);
		} finally {
			restore();
			renderSettings(root, ctx.state);
		}
	});
}

function openV6Details(s: Status): void {
	if (s.reason_code === 'ipv6_unavailable') {
		openSheetWithGroups(t('set_ipv6_details', 'IPv6 details'), [], reasonText(s));
		return;
	}
	const rules6 = s.rules.slice(s.rules.length - s.rules6);
	openSheetWithGroups(
		t('set_ipv6_details', 'IPv6 details'),
		[
			{ label: t('set_v6_addresses', 'Addresses on the bridge'), items: s.addrs6 },
			{ label: t('set_v6_rules', 'Rules installed'), items: rules6 },
			{ label: t('set_v6_targets', 'Rules wanted (from the routes on the bridge)'), items: s.v6_targets.map((x) => `${s.rule_pref}: from all ${x}`) },
		],
		t('set_v6_empty', 'Nothing yet: OpenWrt has not announced a prefix on the bridge.'),
	);
}

function prefixOf(s: Status): string {
	const fromSubnet = /^(\d+\.\d+\.\d+)\.0\/24$/.exec(s.subnet ?? '');
	if (fromSubnet?.[1]) return fromSubnet[1];
	const fromGateway = /^(\d+\.\d+\.\d+)\.\d+$/.exec(s.gateway);
	return fromGateway?.[1] ?? '';
}

function setHint(el: HTMLElement, text: string, warn: boolean): void {
	el.textContent = text;
	el.classList.toggle('is-warn', warn);
}

function validateHost(root: HTMLElement, s: Status): void {
	const input = $<HTMLInputElement>(root, '[data-role="host"]');
	const save = $<HTMLButtonElement>(root, '[data-role="save-host"]');
	const hint = $(root, '[data-role="host-hint"]');
	const raw = input.value.trim();
	const n = Number(raw);
	const gw = s.gateway.split('.')[3];
	const valid = /^[1-9]\d{0,2}$/.test(raw) && n >= 1 && n <= 254 && raw !== gw;
	input.classList.toggle('is-invalid', raw !== '' && !valid);
	save.disabled = save.classList.contains('is-busy') || !valid || n === s.host_octet;
	if (raw !== '' && raw === gw) {
		setHint(hint, t('set_host_hint_gateway', "That is VirtualAP's gateway address."), true);
	} else if (valid && n >= 100 && n <= 249) {
		setHint(hint, t('set_host_hint_pool', "Inside OpenWrt's DHCP range (.100–.249): a hotspot device could get the same address."), true);
	} else {
		setHint(hint, t('set_host_hint', 'OpenWrt hands out .100–.249 by DHCP; keep the phone outside that range.'), false);
	}
}

function validatePref(root: HTMLElement, s: Status): void {
	const input = $<HTMLInputElement>(root, '[data-role="pref"]');
	const save = $<HTMLButtonElement>(root, '[data-role="save-pref"]');
	const hint = $(root, '[data-role="pref-hint"]');
	const raw = input.value.trim();
	const n = Number(raw);
	const valid = /^[1-9]\d{0,4}$/.test(raw) && n >= 1 && n <= 32765;
	input.classList.toggle('is-invalid', raw !== '' && !valid);
	save.disabled = save.classList.contains('is-busy') || !valid || n === s.rule_pref;
	$(root, '[data-role="reset-pref"]').hidden = s.rule_pref === DEFAULT_PREF;
	if (raw !== '' && !valid) {
		setHint(hint, t('set_pref_hint_range', 'Between 1 and 32765.'), true);
	} else if (valid && n >= NETD_FIRST_PREF) {
		setHint(
			hint,
			tf('set_pref_hint_netd', "{n} or above comes after Android's own rules (VPN, per-network), which can then send hotspot traffic elsewhere.", { n: NETD_FIRST_PREF }),
			true,
		);
	} else {
		setHint(hint, tf('set_pref_hint', "Keep it below {n}, where Android's own rules start.", { n: NETD_FIRST_PREF }), false);
	}
}

function validateApp(root: HTMLElement, s: Status): void {
	const input = $<HTMLInputElement>(root, '[data-role="app"]');
	const save = $<HTMLButtonElement>(root, '[data-role="save-app"]');
	const hint = $(root, '[data-role="app-hint"]');
	const raw = input.value.trim();
	const valid = raw === '' || PACKAGE_RE.test(raw);
	input.classList.toggle('is-invalid', !valid);
	save.disabled = save.classList.contains('is-busy') || !valid || raw === s.restart_app;
	setHint(hint, valid ? '' : t('set_app_hint_invalid', 'Not a package name (like org.example.app).'), !valid);
	const restart = $<HTMLButtonElement>(root, '[data-role="restart-now"]');
	if (!restart.classList.contains('is-busy')) restart.disabled = !s.restart_app;
}

export function renderSettings(root: HTMLElement, { status: s }: AppState): void {
	const enabled = $<HTMLInputElement>(root, '[data-role="enabled"]');
	const v6 = $<HTMLInputElement>(root, '[data-role="ipv6"]');
	// A switch that is saving keeps what was pressed until the answer is in.
	if (!enabled.dataset.busy) enabled.checked = s.enabled;
	if (!v6.dataset.busy) {
		v6.checked = s.ipv6;
		v6.disabled = !s.enabled;
	}
	$(root, '[data-role="v6-details"]').hidden = !s.ipv6 || !s.enabled;
	const prefix = prefixOf(s);
	$(root, '[data-role="prefix"]').textContent = prefix ? `${prefix}.` : t('set_host_prefix_unknown', '<gateway /24>.');
	const fill = (role: string, value: string) => {
		const input = $<HTMLInputElement>(root, `[data-role="${role}"]`);
		if (document.activeElement !== input && !input.dataset.edited) input.value = value;
	};
	fill('host', String(s.host_octet));
	fill('pref', String(s.rule_pref));
	fill('app', s.restart_app);
	validateHost(root, s);
	validatePref(root, s);
	validateApp(root, s);
}
