import { checkRoute, runCheck, setSetting, startWatcher, ADDRESS_RE, PACKAGE_RE, type Device, type Route, type Status } from '../bridge-data';
import type { AppState, PageContext } from '../context';
import { $, closestTarget, escapeHtml } from '../core/dom';
import { icons } from '../core/icons';
import { nextPaint, toast } from '../core/ksu-bridge';
import { t, tf } from '../core/i18n';
import { reasonText } from '../reasons';
import { busyButton, nobreak } from '../util';

const ROWS: [string, string, string][] = [
	['va', 'main_row_virtualap', 'VirtualAP'],
	['addr', 'main_row_address', 'Phone address'],
	['rule', 'main_row_rule', 'Routing rule'],
	['v6', 'main_row_ipv6', 'IPv6'],
	['checked', 'main_row_checked', 'Last check'],
];

export function buildMain(root: HTMLElement, ctx: PageContext): void {
	root.innerHTML = `
		<section class="card bridge-card" aria-live="polite">
			<div class="bridge-card__head">
				<span class="state-dot" data-role="dot"></span>
				<div class="bridge-card__text">
					<div class="bridge-card__title" data-role="title"></div>
					<div class="bridge-card__reason" data-role="reason"></div>
				</div>
				<span class="live-chip" data-role="live" hidden title="${escapeHtml(t('main_live_hint', 'Updates by itself while this page is open'))}">
					<span class="live-chip__dot"></span>${t('main_live', 'Live')}
				</span>
			</div>
			<div class="notice notice--error" data-role="no-program" hidden>${t('main_no_program', "NyxBridge's program didn't answer. Reboot once after installing or updating the module; if it stays like this, reinstall it.")}</div>
			<div class="kv-list">
				${ROWS.map(
					([id, key, fallback]) => `
					<div class="kv-row">
						<span class="kv-row__label">${t(key, fallback)}</span>
						<span class="kv-row__value" data-row="${id}">—</span>
					</div>`,
				).join('')}
				<div class="kv-row kv-row--switch">
					<div class="kv-row__text">
						<span class="kv-row__label">${t('main_row_monitor', 'Monitoring')}</span>
						<span class="kv-row__desc" data-role="monitor-desc"></span>
					</div>
					<label class="m3-switch">
						<input type="checkbox" data-role="monitor" aria-label="${escapeHtml(t('main_row_monitor', 'Monitoring'))}">
						<span class="m3-switch__track"></span>
						<span class="m3-switch__thumb"></span>
					</label>
				</div>
			</div>
			<div class="bridge-card__actions">
				<button class="btn btn--tonal" data-role="start" hidden>${t('main_start_watcher', 'Start watcher')}</button>
				<button class="btn btn--filled" data-role="check">${t('main_check_now', 'Check now')}</button>
			</div>
		</section>

		<h2 class="section-title section-title--row">
			<span>${t('main_devices_title', 'Devices on the hotspot')}</span>
			<span class="count-badge" data-role="device-count" hidden></span>
		</h2>
		<div class="card device-card">
			<div class="device-list" data-role="devices"></div>
			<p class="card-note">${t('main_devices_note', 'What has sent anything over the hotspot in the last few minutes. Addresses show once the phone has talked to a device. Tap one to check the route to it.')}</p>
		</div>

		<h2 class="section-title">${t('main_route_title', 'Route check')}</h2>
		<div class="card" data-role="route-card">
			<p class="card-note card-note--top">${t('main_route_desc', 'Shows which way the phone sends traffic to an address - over the hotspot, or somewhere else such as a VPN. Name an app to check as that app (VPNs often pick apps).')}</p>
			<div class="route-form">
				<input class="select-field route-form__dest" data-role="dest" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="192.168.42.150" aria-label="${escapeHtml(t('main_route_dest', 'Address'))}">
				<input class="select-field route-form__app" data-role="app" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${escapeHtml(t('main_route_app_placeholder', 'App package (optional)'))}" aria-label="${escapeHtml(t('main_route_app', 'App'))}">
				<button class="btn btn--filled" data-role="route-go" disabled>${t('main_route_check', 'Check')}</button>
			</div>
			<div class="route-result" data-role="route-result" hidden></div>
		</div>
	`;

	$(root, '[data-role="check"]').addEventListener('click', async (e) => {
		const restore = busyButton(e.currentTarget as HTMLButtonElement, t('main_checking', 'Checking…'));
		await nextPaint();
		try {
			const res = await runCheck();
			if (res.ok && res.status) {
				ctx.update({ status: res.status });
				toast(t('main_checked_toast', 'Checked'));
			} else {
				toast(res.error || t('main_check_failed', 'Check failed'));
			}
		} finally {
			restore();
		}
	});

	$(root, '[data-role="monitor"]').addEventListener('change', async (e) => {
		const sw = e.currentTarget as HTMLInputElement;
		const on = sw.checked;
		sw.disabled = true;
		await nextPaint();
		try {
			const res = await setSetting('monitor', on ? 1 : 0);
			if (res.ok && res.status) {
				ctx.update({ status: res.status });
				toast(on ? t('main_monitor_on_toast', 'Monitoring on') : t('main_monitor_off_toast', 'Monitoring off'));
			} else {
				sw.checked = !on;
				toast(res.error || t('set_failed_toast', 'Could not save the setting'));
			}
		} finally {
			sw.disabled = false;
		}
	});

	$(root, '[data-role="start"]').addEventListener('click', async (e) => {
		const restore = busyButton(e.currentTarget as HTMLButtonElement, t('main_starting', 'Starting…'));
		await nextPaint();
		try {
			const res = await startWatcher();
			if (res.ok && res.status) ctx.update({ status: res.status });
			toast(res.ok ? t('main_watcher_started', 'Watcher started') : res.error);
		} finally {
			restore();
		}
	});

	const dest = $<HTMLInputElement>(root, '[data-role="dest"]');
	const app = $<HTMLInputElement>(root, '[data-role="app"]');
	const go = $<HTMLButtonElement>(root, '[data-role="route-go"]');
	app.addEventListener('input', () => {
		app.dataset.edited = '1';
	});
	const validate = () => {
		const d = dest.value.trim();
		const a = app.value.trim();
		const destOk = ADDRESS_RE.test(d);
		const appOk = a === '' || PACKAGE_RE.test(a);
		dest.classList.toggle('is-invalid', d !== '' && !destOk);
		app.classList.toggle('is-invalid', !appOk);
		go.disabled = go.classList.contains('is-busy') || !destOk || !appOk;
	};
	dest.addEventListener('input', validate);
	app.addEventListener('input', validate);
	for (const input of [dest, app]) {
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !go.disabled) go.click();
		});
	}
	go.addEventListener('click', async () => {
		dest.blur();
		app.blur();
		const restore = busyButton(go, t('main_route_check', 'Check'));
		try {
			await runRouteCheck(root, ctx.state, dest.value.trim(), app.value.trim());
		} finally {
			restore();
			validate();
		}
	});
	$(root, '[data-role="devices"]').addEventListener('click', (e) => {
		const ip = closestTarget(e, '.device[data-ip]')?.dataset.ip;
		if (!ip) return;
		dest.value = ip;
		validate();
		$(root, '[data-role="route-card"]').scrollIntoView({ behavior: 'smooth', block: 'start' });
		if (!go.disabled) go.click();
	});
}

async function runRouteCheck(root: HTMLElement, state: AppState, dest: string, app: string): Promise<void> {
	const box = $(root, '[data-role="route-result"]');
	await nextPaint();
	const { route, error } = await checkRoute(dest, app);
	box.hidden = false;
	box.innerHTML = route
		? routeHtml(route, state.status)
		: `<div class="route-result__line is-bad">${icons.error}<span>${escapeHtml(error || t('main_route_failed', 'Could not check the route'))}</span></div>`;
}

function inSubnet(ip: string, subnet: string | null): boolean {
	const m = /^(\d+\.\d+\.\d+)\.0\/24$/.exec(subnet ?? '');
	return !!m && ip.startsWith(`${m[1]}.`);
}

function routeHtml(r: Route, s: Status): string {
	const who = r.app ? tf('main_route_as_app', 'As {app} (uid {uid})', { app: r.app, uid: r.uid ?? '?' }) : t('main_route_as_phone', 'From the phone');
	const details = [
		r.table ? tf('main_route_table', 'table {table}', { table: r.table }) : '',
		r.via ? tf('main_route_via', 'via {via}', { via: r.via }) : '',
		r.src ? tf('main_route_src', 'from {src}', { src: r.src }) : '',
	]
		.filter(Boolean)
		.join(' · ');
	let line: string;
	let hint = '';
	if (r.via_bridge) {
		line = `<div class="route-result__line is-good">${icons.check}<span>${escapeHtml(tf('main_route_good', 'Goes over the hotspot ({bridge})', { bridge: nobreak(r.bridge) }))}</span></div>`;
	} else {
		line = `<div class="route-result__line is-bad">${icons.error}<span>${escapeHtml(
			r.dev
				? tf('main_route_bad', 'Does not use the hotspot: goes out through {dev}', { dev: nobreak(r.dev) })
				: t('main_route_none', 'Does not use the hotspot: there is no route'),
		)}</span></div>`;
		if (inSubnet(r.dest, s.subnet)) {
			hint = s.rule4
				? t('main_route_hint_rule', "NyxBridge's rule is in place, so another rule with a lower priority number comes first. Try a lower rule priority in Settings.")
				: t('main_route_hint_norule', "NyxBridge's rule isn't in place right now - see the status above.");
		} else if (s.subnet) {
			hint = tf('main_route_hint_subnet', 'This address is not on the hotspot network ({subnet}).', { subnet: s.subnet });
		}
	}
	return `
		<div class="route-result__who">${escapeHtml(who)} → <code>${escapeHtml(r.dest)}</code></div>
		${line}
		${details ? `<div class="route-result__details">${escapeHtml(details)}</div>` : ''}
		${hint ? `<div class="route-result__hint">${escapeHtml(hint)}</div>` : ''}`;
}

function setRow(root: HTMLElement, id: string, text: string, kind?: 'ok' | 'missing'): void {
	const el = $(root, `[data-row="${id}"]`);
	el.textContent = text;
	el.className = `kv-row__value${kind ? ` is-${kind}` : ''}`;
}

function routableV6(d: Device): string | undefined {
	return d.ipv6.find((a) => !/^fe[89ab]/i.test(a));
}

function deviceHtml(d: Device): string {
	const ip = d.ipv4[0] ?? routableV6(d);
	const v6 = d.ipv6.length;
	const sub = [d.mac, v6 ? (v6 === 1 ? t('main_device_one_v6', '1 IPv6 address') : tf('main_device_v6', '{n} IPv6 addresses', { n: v6 })) : ''].filter(Boolean).join(' · ');
	const extraV4 = d.ipv4.length > 1 ? ` <span class="device__more">+${d.ipv4.length - 1}</span>` : '';
	const badge = d.gateway ? `<span class="badge">${t('main_device_gateway', 'OpenWrt gateway')}</span>` : '';
	const title = ip ? `${escapeHtml(ip)}${extraV4}` : `<span class="device__noaddr">${t('main_device_no_address', 'No address seen yet')}</span>`;
	const inner = `
		<span class="device__icon">${d.gateway ? icons.router : icons.devices}</span>
		<span class="device__text">
			<span class="device__title">${title}${badge}</span>
			<span class="device__sub">${escapeHtml(sub)}</span>
		</span>`;
	return ip
		? `<button class="device" data-ip="${escapeHtml(ip)}">${inner}<span class="device__chev">${icons.chevron}</span></button>`
		: `<div class="device device--static">${inner}</div>`;
}

export function renderMain(root: HTMLElement, { status: s, statusOk, devices, live }: AppState): void {
	const state = s.state;
	$(root, '[data-role="dot"]').className = `state-dot${state === 'active' ? ' is-active' : state === 'error' ? ' is-error' : ''}${live ? ' is-live' : ''}`;
	const titles: Record<string, string> = {
		active: t('main_state_active', 'Active'),
		error: t('main_state_problem', 'Problem'),
		inactive: t('main_state_idle', 'Idle'),
	};
	$(root, '[data-role="title"]').textContent = titles[state] ?? t('main_state_unknown', 'Not checked yet');
	$(root, '[data-role="reason"]').textContent =
		state === 'active' ? tf('main_active_desc', 'Phone apps can reach devices on {bridge}.', { bridge: nobreak(s.bridge) }) : reasonText(s);
	$(root, '[data-role="live"]').hidden = !live;
	$(root, '[data-role="no-program"]').hidden = statusOk;

	const modes: Record<string, string> = {
		bridged: t('va_bridged', 'Managed mode'),
		routed: t('va_routed', 'Routed mode'),
		stopped: t('va_stopped', 'Not running'),
	};
	const mode = modes[s.va_mode] ?? (s.va_mode || '—');
	setRow(root, 'va', s.gateway && s.va_mode !== 'stopped' ? tf('va_with_gateway', '{mode} · gateway {gateway}', { mode, gateway: s.gateway }) : mode);

	if (s.addr4 && s.host_ip) setRow(root, 'addr', tf('main_addr_value', '{ip} on {bridge}', { ip: s.host_ip, bridge: nobreak(s.bridge) }), 'ok');
	else setRow(root, 'addr', t('main_not_set', 'Not set'), 'missing');

	if (s.rule4 && s.subnet) setRow(root, 'rule', tf('main_rule_value', '{pref}: to {subnet} → main', { pref: s.rule_pref, subnet: s.subnet }), 'ok');
	else setRow(root, 'rule', t('main_not_installed', 'Not installed'), 'missing');

	if (!s.ipv6) {
		setRow(root, 'v6', t('main_ipv6_off', 'Off'), 'missing');
	} else if (s.addrs6.length) {
		const addrs = s.addrs6.join(', ');
		const text = s.rules6 === 1 ? tf('main_ipv6_value_one', '{addrs} · 1 rule', { addrs }) : tf('main_ipv6_value', '{addrs} · {n} rules', { addrs, n: s.rules6 });
		setRow(root, 'v6', text, 'ok');
	} else {
		setRow(root, 'v6', t('main_ipv6_waiting', 'On · no address yet'), 'missing');
	}

	setRow(root, 'checked', s.checked || '—');

	const running = s.daemon;
	const sw = $<HTMLInputElement>(root, '[data-role="monitor"]');
	if (!sw.disabled) sw.checked = s.monitor;
	const desc = $(root, '[data-role="monitor-desc"]');
	if (!s.monitor) {
		desc.textContent = t('main_monitor_off', 'Off. Nothing runs in the background; tap Check now after starting or stopping the hotspot.');
	} else if (running) {
		desc.textContent = t('main_monitor_on', 'Watching VirtualAP and applying changes automatically.');
	} else {
		desc.textContent = t('main_monitor_not_running', "On, but the watcher isn't running. Tap Start watcher.");
	}
	desc.classList.toggle('is-warn', s.monitor && !running && statusOk);
	$(root, '[data-role="start"]').hidden = !s.monitor || running || !statusOk;

	const list = $(root, '[data-role="devices"]');
	const count = $(root, '[data-role="device-count"]');
	const others = devices.devices.length;
	count.hidden = !devices.bridge_present || others === 0;
	count.textContent = String(others);
	let html: string;
	if (!devices.bridge_present) {
		html = `<div class="empty-hint">${escapeHtml(tf('main_devices_no_bridge', '{bridge} is not up - start the hotspot in VirtualAP.', { bridge: nobreak(devices.bridge) }))}</div>`;
	} else if (!others) {
		html = `<div class="empty-hint">${t('main_devices_none', 'No devices seen yet.')}</div>`;
	} else {
		html = devices.devices.map(deviceHtml).join('');
	}

	if (shown.get(list) !== html) {
		list.innerHTML = html;
		shown.set(list, html);
	}

	const app = $<HTMLInputElement>(root, '[data-role="app"]');
	if (!app.dataset.edited && document.activeElement !== app) app.value = s.restart_app;
}

const shown = new WeakMap<HTMLElement, string>();
