import { runCheck, startWatcher, setSetting } from '../bridge-data.js';
import { toast, nextPaint } from '../ksu-bridge.js';
import { t, tf } from '../i18n.js';
import { busyButton } from '../util.js';

// The status box: what the bridge looks like right now, and the two
// actions that change it. Everything comes from `ctl.sh status`.

const REASONS = {
	module_disabled: ['reason_module_disabled', 'Module is disabled in the root manager'],
	turned_off: ['reason_turned_off', 'Turned off in settings'],
	va_stopped: ['reason_va_stopped', 'VirtualAP is not running'],
	va_routed: ['reason_va_routed', 'VirtualAP is in routed mode (the phone is already the gateway there)'],
	bad_gateway: ['reason_bad_gateway', "VirtualAP's gateway address is missing or invalid"],
	waiting_bridge: ['reason_waiting_bridge', 'Waiting for {arg}'],
	host_is_gateway: ['reason_host_is_gateway', "Phone address {arg} is the gateway's address; pick another"],
	addr_failed: ['reason_addr_failed', 'Could not add {arg} to the bridge'],
	rule_failed: ['reason_rule_failed', 'Could not add the IPv4 routing rule'],
	ipv6_unavailable: ['reason_ipv6_unavailable', 'IPv6 is not available on {arg}'],
};

/** Translated reason for a status, falling back to the shell's English. */
export function reasonText(status) {
	const entry = REASONS[status.reason_code];
	if (!entry) return status.reason || '';
	return tf(entry[0], entry[1], { arg: status.reason_arg || '' });
}

const ROWS = [
	['va', 'main_row_virtualap', 'VirtualAP'],
	['addr', 'main_row_address', 'Phone address'],
	['rule', 'main_row_rule', 'Routing rule'],
	['v6', 'main_row_ipv6', 'IPv6'],
	['checked', 'main_row_checked', 'Last check'],
];

export function buildMain(root, ctx) {
	root.innerHTML = `
		<section class="card bridge-card" aria-live="polite">
			<div class="bridge-card__head">
				<span class="state-dot" data-role="dot"></span>
				<div class="bridge-card__text">
					<div class="bridge-card__title" data-role="title"></div>
					<div class="bridge-card__reason" data-role="reason"></div>
				</div>
			</div>
			<div class="kv-list">
				${ROWS.map(([id, key, fallback]) => `
					<div class="kv-row">
						<span class="kv-row__label">${t(key, fallback)}</span>
						<span class="kv-row__value" data-row="${id}">—</span>
					</div>`).join('')}
				<div class="kv-row kv-row--switch">
					<div class="kv-row__text">
						<span class="kv-row__label">${t('main_row_monitor', 'Monitoring')}</span>
						<span class="kv-row__desc" data-role="monitor-desc"></span>
					</div>
					<label class="m3-switch">
						<input type="checkbox" data-role="monitor" aria-label="${t('main_row_monitor', 'Monitoring')}">
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
	`;

	root.querySelector('[data-role="check"]').addEventListener('click', async (e) => {
		const restore = busyButton(e.currentTarget, t('main_checking', 'Checking…'));
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

	// Stops or resumes the background watcher at once, no reboot. The
	// switch stays disabled until ctl.sh has done it and reported back.
	root.querySelector('[data-role="monitor"]').addEventListener('change', async (e) => {
		const sw = e.currentTarget;
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

	root.querySelector('[data-role="start"]').addEventListener('click', async (e) => {
		const restore = busyButton(e.currentTarget, t('main_starting', 'Starting…'));
		await nextPaint();
		try {
			const res = await startWatcher();
			if (res.ok && res.status) ctx.update({ status: res.status });
			toast(res.ok ? t('main_watcher_started', 'Watcher started') : res.error);
		} finally {
			restore();
		}
	});
}

// Interface names like vap-br0 should never break at their hyphen.
const nobreak = (name) => String(name || '').replace(/-/g, '\u2011');

function setRow(root, id, text, kind) {
	const el = root.querySelector(`[data-row="${id}"]`);
	el.textContent = text;
	el.className = `kv-row__value${kind ? ` is-${kind}` : ''}`;
}

export function renderMain(root, { status: s }) {
	const state = s.state || '';
	root.querySelector('[data-role="dot"]').className = `state-dot${state === 'active' ? ' is-active' : state === 'error' ? ' is-error' : ''}`;
	const titles = {
		active: t('main_state_active', 'Active'),
		error: t('main_state_problem', 'Problem'),
		inactive: t('main_state_idle', 'Idle'),
	};
	root.querySelector('[data-role="title"]').textContent = titles[state] || t('main_state_unknown', 'Not checked yet');
	root.querySelector('[data-role="reason"]').textContent = state === 'active'
		? tf('main_active_desc', 'Phone apps can reach devices on {bridge}.', { bridge: nobreak(s.bridge) })
		: reasonText(s);

	const modes = {
		bridged: t('va_bridged', 'Managed mode'),
		routed: t('va_routed', 'Routed mode'),
		stopped: t('va_stopped', 'Not running'),
	};
	const mode = modes[s.va_mode] || s.va_mode || '—';
	setRow(root, 'va', s.gateway && s.va_mode !== 'stopped' ? tf('va_with_gateway', '{mode} · gateway {gateway}', { mode, gateway: s.gateway }) : mode);

	if (s.addr4 === '1') setRow(root, 'addr', tf('main_addr_value', '{ip} on {bridge}', { ip: s.host_ip, bridge: nobreak(s.bridge) }), 'ok');
	else setRow(root, 'addr', t('main_not_set', 'Not set'), 'missing');

	if (s.rule4 === '1') setRow(root, 'rule', tf('main_rule_value', '{pref}: to {subnet} → main', { pref: s.rule_pref, subnet: s.subnet }), 'ok');
	else setRow(root, 'rule', t('main_not_installed', 'Not installed'), 'missing');

	if (s.ipv6 !== '1') {
		setRow(root, 'v6', t('main_ipv6_off', 'Off'), 'missing');
	} else {
		const addrs = (s.addrs6 || '').trim().split(/\s+/).filter(Boolean);
		const rules = Number(s.rules6 || 0);
		if (addrs.length) {
			const key = rules === 1 ? 'main_ipv6_value_one' : 'main_ipv6_value';
			const fallback = rules === 1 ? '{addrs} · 1 rule' : '{addrs} · {n} rules';
			setRow(root, 'v6', tf(key, fallback, { addrs: addrs.join(', '), n: rules }), 'ok');
		} else {
			setRow(root, 'v6', t('main_ipv6_waiting', 'On · no address yet'), 'missing');
		}
	}

	setRow(root, 'checked', s.checked || '—');

	const monitorOn = s.monitor !== '0';
	const running = s.daemon === 'running';
	const sw = root.querySelector('[data-role="monitor"]');
	if (!sw.disabled) sw.checked = monitorOn;
	const desc = root.querySelector('[data-role="monitor-desc"]');
	if (!monitorOn) {
		desc.textContent = t('main_monitor_off', 'Off. Nothing runs in the background; tap Check now after starting or stopping the hotspot.');
	} else if (running) {
		desc.textContent = t('main_monitor_on', 'Watching VirtualAP and applying changes automatically.');
	} else {
		desc.textContent = t('main_monitor_not_running', "On, but the watcher isn't running. Tap Start watcher.");
	}
	desc.classList.toggle('is-warn', monitorOn && !running);
	root.querySelector('[data-role="start"]').hidden = !monitorOn || running;
}
