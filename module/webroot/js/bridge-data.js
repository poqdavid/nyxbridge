import { exec, execBatch } from './ksu-bridge.js';

// NyxBridge's directories. Every read and write goes through ctl.sh, the
// same script the watcher and the Action button use, so the WebUI never
// has its own idea of how the bridge is set up.
export const MOD_DIR = '/data/adb/modules/nyxbridge';
export const PERSISTENT_DIR = '/data/adb/nyxbridge';
export const CONFIG_PATH = `${PERSISTENT_DIR}/config.sh`;
export const LOG_PATH = `${PERSISTENT_DIR}/nyxbridge.log`;
const CTL = `/system/bin/sh ${MOD_DIR}/ctl.sh`;

// Everything the four pages show, read through ONE exec at startup and on
// refresh (see ksu-bridge.js for why the number of exec() calls matters).
const READS = {
	status: `${CTL} status`,
	config: `cat '${CONFIG_PATH}' 2>/dev/null`,
	log: `${CTL} log`,
	prop: `cat '${MOD_DIR}/module.prop' 2>/dev/null`,
};

/** key=value lines -> object. */
export function parseKv({ errno, stdout }) {
	const out = {};
	if (errno !== 0) return out;
	for (const line of stdout.split('\n')) {
		const idx = line.indexOf('=');
		if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1).trim();
	}
	return out;
}

/** config.sh -> object, ignoring comments; accepts bare or quoted values. */
export function parseConfig({ errno, stdout }) {
	const config = {};
	if (errno !== 0) return config;
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const idx = trimmed.indexOf('=');
		if (idx < 0) continue;
		let value = trimmed.slice(idx + 1);
		const quoted = value.match(/^'([\s\S]*)'$/) || value.match(/^"([\s\S]*)"$/);
		if (quoted) value = quoted[1];
		config[trimmed.slice(0, idx)] = value;
	}
	return config;
}

function withPrefix(prefix, commands) {
	const out = {};
	for (const [key, cmd] of Object.entries(commands)) out[`${prefix}${key}`] = cmd;
	return out;
}

/**
 * One batched read of everything, plus any extra read-only commands the
 * caller wants in the same shell (the night-mode check for "System").
 */
export async function loadEverything(extra = {}) {
	const r = await execBatch({ ...READS, ...withPrefix('extra.', extra) });
	const extras = {};
	for (const key of Object.keys(extra)) extras[key] = r[`extra.${key}`];
	return {
		status: parseKv(r.status),
		config: parseConfig(r.config),
		log: r.log.errno === 0 ? r.log.stdout : '',
		prop: parseKv(r.prop),
		extra: extras,
	};
}

export async function getLog() {
	const { errno, stdout } = await exec(`${CTL} log`);
	return errno === 0 ? stdout : '';
}

async function ctlCommand(args) {
	const { errno, stdout, stderr } = await exec(`${CTL} ${args}`);
	const status = errno === 0 ? parseKv({ errno, stdout }) : {};
	return { ok: errno === 0, status: Object.keys(status).length ? status : null, error: (stderr || stdout || '').trim() };
}

/** Re-check now (same as the watcher's 30 s check). Resolves to the new status. */
export const runCheck = () => ctlCommand('apply');

/** Start the watcher if it isn't running. */
export const startWatcher = () => ctlCommand('start');

// Settings ctl.sh accepts, with the values it accepts. Checked here too so
// nothing unexpected ever reaches the shell.
const SETTING_VALUES = {
	enabled: /^[01]$/,
	monitor: /^[01]$/,
	ipv6: /^[01]$/,
	host_octet: /^[1-9]\d{0,2}$/,
	webui_theme: /^(system|light|dark)$/,
	webui_monet: /^[01]$/,
	webui_fullscreen: /^[01]$/,
};

// Writes run one after another, so two quick toggles can't interleave.
let writes = Promise.resolve();

/**
 * Save one setting. Bridge settings (enabled, monitor, ipv6, host_octet)
 * are applied straight away and resolve with the new status; WebUI
 * settings resolve with status null.
 */
export function setSetting(key, value) {
	const v = String(value);
	if (!SETTING_VALUES[key] || !SETTING_VALUES[key].test(v)) {
		return Promise.resolve({ ok: false, status: null, error: `invalid ${key}` });
	}
	const run = writes.then(() => ctlCommand(`set ${key} ${v}`));
	writes = run.catch(() => {});
	return run;
}
