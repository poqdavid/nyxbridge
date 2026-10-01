import { execAsync, execBatch, spawnLines, type ExecResult } from './core/ksu-bridge';

export const MOD_DIR = '/data/adb/modules/nyxbridge';
export const PERSISTENT_DIR = '/data/adb/nyxbridge';
export const CONFIG_PATH = `${PERSISTENT_DIR}/config.sh`;
export const LOG_PATH = `${PERSISTENT_DIR}/nyxbridge.log`;
const BIN = `${MOD_DIR}/bin/nyxbridge`;

export interface Status {
	version: string;
	daemon: boolean;
	daemon_pid: number | null;
	monitor: boolean;
	module_disabled: boolean;
	enabled: boolean;
	ipv6: boolean;
	host_octet: number;
	rule_pref: number;
	restart_app: string;
	va_mode: string;
	bridge: string;
	gateway: string;
	bridge_present: boolean;
	subnet: string | null;
	host_ip: string | null;
	addr4: boolean;
	rule4: boolean;
	addrs6: string[];
	rules6: number;
	v6_targets: string[];
	rules: string[];
	state: string;
	reason: string;
	reason_code: string;
	reason_arg: string;
	checked: string;
}

export const NO_STATUS: Status = {
	version: '',
	daemon: false,
	daemon_pid: null,
	monitor: true,
	module_disabled: false,
	enabled: true,
	ipv6: false,
	host_octet: 2,
	rule_pref: 7001,
	restart_app: '',
	va_mode: '',
	bridge: 'vap-br0',
	gateway: '',
	bridge_present: false,
	subnet: null,
	host_ip: null,
	addr4: false,
	rule4: false,
	addrs6: [],
	rules6: 0,
	v6_targets: [],
	rules: [],
	state: '',
	reason: '',
	reason_code: '',
	reason_arg: '',
	checked: '',
};

export interface Device {
	mac: string;
	ipv4: string[];
	ipv6: string[];
	gateway: boolean;
}

export interface Devices {
	bridge: string;
	bridge_present: boolean;
	devices: Device[];
}

export const NO_DEVICES: Devices = { bridge: 'vap-br0', bridge_present: false, devices: [] };

export interface Route {
	dest: string;
	app?: string;
	uid: number | null;
	dev?: string;
	table: string;
	via?: string;
	src?: string;
	via_bridge: boolean;
	bridge: string;
}

export type Config = Record<string, string>;

function parseJson<T>({ errno, stdout }: ExecResult, isValid: (v: Record<string, unknown>) => boolean): T | null {
	if (errno !== 0) return null;
	try {
		const v: unknown = JSON.parse(stdout.trim());
		return v && typeof v === 'object' && isValid(v as Record<string, unknown>) ? (v as T) : null;
	} catch {
		return null;
	}
}

const isStatus = (v: Record<string, unknown>) => typeof v.state === 'string' && typeof v.enabled === 'boolean';
const isDevices = (v: Record<string, unknown>) => Array.isArray(v.devices);
const isRoute = (v: Record<string, unknown>) => typeof v.via_bridge === 'boolean';

export const parseStatus = (r: ExecResult): Status | null => parseJson<Status>(r, isStatus);
const parseDevices = (r: ExecResult): Devices | null => parseJson<Devices>(r, isDevices);

function parseKv({ errno, stdout }: ExecResult): Record<string, string> {
	const out: Record<string, string> = {};
	if (errno !== 0) return out;
	for (const line of stdout.split('\n')) {
		const idx = line.indexOf('=');
		if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1).trim();
	}
	return out;
}

function parseConfig({ errno, stdout }: ExecResult): Config {
	const config: Config = {};
	if (errno !== 0) return config;
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const idx = trimmed.indexOf('=');
		if (idx < 0) continue;
		let value = trimmed.slice(idx + 1);
		const quoted = value.match(/^'([\s\S]*)'$/) ?? value.match(/^"([\s\S]*)"$/);
		if (quoted) value = quoted[1] ?? '';
		config[trimmed.slice(0, idx)] = value;
	}
	return config;
}

const READS = {
	status: `${BIN} status --json`,
	devices: `${BIN} devices`,
	config: `cat '${CONFIG_PATH}' 2>/dev/null`,
	log: `${BIN} log`,
	prop: `cat '${MOD_DIR}/module.prop' 2>/dev/null`,
} as const;

export interface Everything {
	status: Status | null;
	devices: Devices;
	config: Config;
	log: string;
	prop: Record<string, string>;
	extra: Record<string, ExecResult>;
}

export async function loadEverything(extra: Record<string, string> = {}): Promise<Everything> {
	const commands: Record<string, string> = { ...READS };
	for (const [key, cmd] of Object.entries(extra)) commands[`extra.${key}`] = cmd;
	const r = await execBatch(commands);
	const get = (key: string): ExecResult => r[key] ?? { errno: 1, stdout: '', stderr: '' };
	const extras: Record<string, ExecResult> = {};
	for (const key of Object.keys(extra)) extras[key] = get(`extra.${key}`);
	const log = get('log');
	return {
		status: parseStatus(get('status')),
		devices: parseDevices(get('devices')) ?? NO_DEVICES,
		config: parseConfig(get('config')),
		log: log.errno === 0 ? log.stdout : '',
		prop: parseKv(get('prop')),
		extra: extras,
	};
}

export async function getLog(): Promise<string> {
	const r = await execAsync(`${BIN} log`);
	return r.errno === 0 ? r.stdout : '';
}

export async function getDevices(): Promise<Devices | null> {
	return parseDevices(await execAsync(`${BIN} devices`));
}

export async function getStatus(): Promise<Status | null> {
	return parseStatus(await execAsync(`${BIN} status --json`));
}

export async function getDiagnostics(): Promise<string | null> {
	const r = await execAsync(`${BIN} diag`);
	return r.errno === 0 && r.stdout.trim() ? r.stdout : null;
}

export interface CommandResult {
	ok: boolean;
	status: Status | null;
	error: string;
}

async function run(args: string): Promise<CommandResult> {
	const r = await execAsync(`${BIN} ${args}`);
	const ok = r.errno === 0;
	return { ok, status: ok ? parseStatus(r) : null, error: (r.stderr || (ok ? '' : r.stdout)).trim() };
}

export const runCheck = (): Promise<CommandResult> => run('apply --json');

export const startWatcher = (): Promise<CommandResult> => run('start --json');

export const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

export const ADDRESS_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*)$/;

const SETTING_VALUES: Record<string, RegExp> = {
	enabled: /^[01]$/,
	monitor: /^[01]$/,
	ipv6: /^[01]$/,
	host_octet: /^[1-9]\d{0,2}$/,
	rule_pref: /^[1-9]\d{0,4}$/,
	restart_app: new RegExp(`^$|${PACKAGE_RE.source}`),
	webui_theme: /^(system|light|dark)$/,
	webui_monet: /^[01]$/,
	webui_fullscreen: /^[01]$/,
};

let writes: Promise<unknown> = Promise.resolve();

export function setSetting(key: string, value: string | number): Promise<CommandResult> {
	const v = String(value);
	const re = SETTING_VALUES[key];
	if (!re || !re.test(v)) return Promise.resolve({ ok: false, status: null, error: `invalid ${key}` });
	const cmd = writes.then(() => run(`set ${key} '${v}' --json`));
	writes = cmd.catch(() => {});
	return cmd;
}

export async function checkRoute(dest: string, app = ''): Promise<{ route: Route | null; error: string }> {
	if (!ADDRESS_RE.test(dest)) return { route: null, error: 'invalid address' };
	if (app && !PACKAGE_RE.test(app)) return { route: null, error: 'invalid package' };
	const r = await execAsync(`${BIN} route '${dest}'${app ? ` '${app}'` : ''}`);
	return { route: parseJson<Route>(r, isRoute), error: r.errno === 0 ? '' : (r.stderr || r.stdout).trim() };
}

export async function restartApp(): Promise<{ ok: boolean; error: string }> {
	const r = await execAsync(`${BIN} restart-app`);
	return { ok: r.errno === 0, error: (r.stderr || r.stdout).trim() };
}

export interface LiveUpdate {
	status?: Status;
	devices?: Devices;
}

export function parseLiveLine(line: string): LiveUpdate | null {
	const text = line.trim();
	if (!text.startsWith('{')) return null;
	try {
		const v = JSON.parse(text) as Record<string, unknown>;
		const out: LiveUpdate = {};
		const s = v.status;
		const d = v.devices;
		if (s && typeof s === 'object' && isStatus(s as Record<string, unknown>)) out.status = s as Status;
		if (d && typeof d === 'object' && isDevices(d as Record<string, unknown>)) out.devices = d as Devices;
		return out.status || out.devices ? out : null;
	} catch {
		return null;
	}
}

export function watchLive(seconds: number, onUpdate: (u: LiveUpdate) => void, onExit: (code: number) => void): boolean {
	return spawnLines(
		`${BIN} watch ${Math.max(10, Math.min(3600, Math.round(seconds)))}`,
		(line) => {
			const u = parseLiveLine(line);
			if (u) onUpdate(u);
		},
		onExit,
	);
}
