// WebUI tests: the built module/webroot in Chromium (Playwright) with a mock
// KernelSU manager, against the real bin/nyxbridge.
//
//   sudo node tests/webui/run.cjs [--binary PATH] [--update]
//
// Runs itself in new network and mount namespaces, where it builds what the
// WebUI looks at: VirtualAP's managed-mode bridge with OpenWrt and a hotspot
// client in namespaces of their own, a VPN-style catch-all rule, and a
// temporary device root (the module with the binary, its data folder,
// VirtualAP's run.state) that the commands' /data/adb paths are moved into.
// Nothing outside the namespaces and that root is read or written.
//
// The mock host behaves like the managers' WebView bridge:
//   exec   -> blocks the page (synchronous XHR) and calls back in a later task
//   spawn  -> streams stdout lines as they come, then 'exit', then 'error' on
//             a non-zero exit, each in its own task
// and runs every command for real with `sh -c` (NYX_SH=mksh for mksh).
//
// Checks:
//   functional  what each page shows and writes as VirtualAP starts, devices
//               talk, routes are checked and every setting is changed,
//               compared with tests/webui/expected/functional.json
//               (--update rewrites it)
//   behaviour   live updates, one stream at a time, typed values kept,
//               queued saves, managers without spawn, a missing program,
//               batching, late palette, About after a redraw (B1-B11)
//   insets      system-bar padding on KernelSU-style and KernelSU-Next-style
//               managers, with fullscreen on and off
//
// Needs root, iproute2, ping, a kernel with IPv6, bridges and veth,
// `npm ci && npm run build`, and a host build of the binary (default
// target/release/nyxbridge: cargo build --release). NYX_CHROMIUM=/path/to/chrome
// uses an existing Chromium; NYX_DEBUG=1 logs every command; VERBOSE=1 lists
// passing checks too.
'use strict';
const { execFile, execFileSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const MODULE = path.join(REPO, 'module');
const WEBROOT = path.join(MODULE, 'webroot');
const EXPECTED = path.join(__dirname, 'expected', 'functional.json');
const UPDATE = process.argv.includes('--update');
const argAt = process.argv.indexOf('--binary');
const BINARY = path.resolve(argAt > 0 ? process.argv[argAt + 1] : process.env.NYX_BINARY || path.join(REPO, 'target', 'release', 'nyxbridge'));
const SHELL = process.env.NYX_SH || 'sh';
const SHELL_COST = 80; // ms a manager spends opening a root shell
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(WEBROOT, 'js', 'app.js'))) {
	console.error('tests/webui: module/webroot/js/app.js not found - run `npm run build` first');
	process.exit(2);
}
if (!fs.existsSync(BINARY)) {
	console.error(`tests/webui: ${BINARY} not found - run \`cargo build --release\` or pass --binary`);
	process.exit(2);
}
if (!process.env.NYX_WEBUI_NETNS) {
	if (process.getuid() !== 0) {
		console.error('tests/webui: needs root (network namespaces) - run with sudo');
		process.exit(2);
	}
	const r = spawnSync('unshare', ['--net', '--mount', process.execPath, __filename, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, NYX_WEBUI_NETNS: '1' } });
	process.exit(r.status ?? 2);
}

const { chromium } = require('playwright');
const esbuild = require('esbuild');

// ---------------------------------------------------------------------------
// The network: VirtualAP's bridge, OpenWrt, a hotspot client, a VPN.
const ip = (...args) => execFileSync('ip', args, { encoding: 'utf8' });
const ipq = (...args) => spawnSync('ip', args, { encoding: 'utf8' });
const nsSysctl = (ns, key, value) => ip('netns', 'exec', ns, 'sysctl', '-qw', `${key}=${value}`);
const MAC = { bridge: '02:00:00:00:00:10', owrtPort: '02:00:00:00:00:11', cliPort: '02:00:00:00:00:12', owrt: '02:00:00:00:00:01', cli: '02:00:00:00:00:96' };

function setupNetwork() {
	ip('link', 'set', 'lo', 'up');
	fs.mkdirSync('/run/netns', { recursive: true });
	execFileSync('mount', ['-t', 'tmpfs', 'tmpfs', '/run/netns']);
	for (const ns of ['owrt', 'cli']) {
		ip('netns', 'add', ns);
		// Quiet devices: they send nothing until the test makes them talk.
		nsSysctl(ns, 'net.ipv6.conf.all.disable_ipv6', '1');
		nsSysctl(ns, 'net.ipv6.conf.default.disable_ipv6', '1');
	}
	// A VPN-style catch-all: tun0 in table 99 at 13000, like netd's.
	ip('link', 'add', 'tun0', 'address', '02:00:00:00:00:20', 'type', 'veth', 'peer', 'name', 'tun0-peer', 'address', '02:00:00:00:00:21');
	ip('link', 'set', 'tun0', 'up');
	ip('link', 'set', 'tun0-peer', 'up');
	ip('addr', 'add', '10.8.0.2/24', 'dev', 'tun0');
	ip('route', 'add', 'default', 'dev', 'tun0', 'table', '99');
	ip('rule', 'add', 'pref', '13000', 'lookup', '99');
}

function va(what) {
	if (what === 'up') {
		// Devices stay in the bridge's table however slow the run (ageing in 1/100 s).
		ip('link', 'add', 'vap-br0', 'address', MAC.bridge, 'type', 'bridge', 'ageing_time', '3000000');
		fs.writeFileSync('/proc/sys/net/ipv6/conf/vap-br0/disable_ipv6', '1\n'); // VirtualAP 2.0.5 and later
		ip('link', 'add', 'v-owrt', 'address', MAC.owrtPort, 'type', 'veth', 'peer', 'name', 'eth0', 'netns', 'owrt', 'address', MAC.owrt);
		ip('link', 'add', 'v-cli', 'address', MAC.cliPort, 'type', 'veth', 'peer', 'name', 'eth0', 'netns', 'cli', 'address', MAC.cli);
		for (const v of ['v-owrt', 'v-cli']) ip('link', 'set', v, 'master', 'vap-br0', 'up');
		ip('link', 'set', 'vap-br0', 'up');
		ip('-n', 'owrt', 'link', 'set', 'eth0', 'up');
		ip('-n', 'owrt', 'addr', 'add', '192.168.42.1/24', 'dev', 'eth0');
		ip('-n', 'cli', 'link', 'set', 'eth0', 'up');
		ip('-n', 'cli', 'addr', 'add', '192.168.42.150/24', 'dev', 'eth0');
		fs.writeFileSync(`${VA}/run.state.tmp`, 'mode=bridged\ncontainer=openwrt\nbridge=vap-br0\ngateway=192.168.42.1\n');
		fs.renameSync(`${VA}/run.state.tmp`, `${VA}/run.state`);
	} else if (what === 'down') {
		fs.rmSync(`${VA}/run.state`, { force: true });
		for (const l of ['v-owrt', 'v-cli', 'vap-br0']) ipq('link', 'del', l);
	} else if (what === 'talk') {
		// OpenWrt and the client talk to each other and to the phone.
		spawnSync('ip', ['netns', 'exec', 'cli', 'ping', '-c1', '-W1', '192.168.42.1']);
		spawnSync('ping', ['-c1', '-W1', '192.168.42.150']);
		spawnSync('ping', ['-c1', '-W1', '192.168.42.1']);
	} else if (what === 'ra') {
		// What OpenWrt's router advertisement leaves on the bridge.
		ip('-6', 'addr', 'add', 'fd00:42::2:aff:fe00:10/64', 'dev', 'vap-br0', 'valid_lft', '7200', 'preferred_lft', '3600');
		ip('-6', 'route', 'add', 'fd00:43::/48', 'via', 'fe80::1', 'dev', 'vap-br0', 'proto', 'ra', 'metric', '1024');
	}
}

const rules = () =>
	ipq('-4', 'rule', 'show')
		.stdout.split('\n')
		.filter((l) => /^\d+:/.test(l) && !/^(0|32766|32767|13000):/.test(l))
		.map((l) => l.replace(/\s+/g, ' ').trim());
const bridgeAddrs = () => (ipq('-4', '-o', 'addr', 'show', 'dev', 'vap-br0').stdout.match(/inet \S+/g) || []).join(' ');

// ---------------------------------------------------------------------------
// The device: a temporary root and the path mapping into it.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxbridge-webui-'));
const SYS = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxbridge-sys-'));
const host = (p) => path.join(ROOT, p);
const MODDIR = host('/data/adb/modules/nyxbridge');
const PDIR = host('/data/adb/nyxbridge');
const VA = host('/data/local/virtualap');
const TOOLS = host('/system/bin');
const CALLS = host('/calls.log');
const toHost = (cmd) => cmd.split('/data/adb/').join(`${ROOT}/data/adb/`);
const toDevice = (out) => out.split(ROOT).join('');
const ENV = {
	...process.env,
	PATH: `${TOOLS}:${process.env.PATH}`,
	NYXB_DATA_DIR: PDIR,
	NYXB_RUN_DIR: host('/dev/nyxbridge'),
	NYXB_VA_STATE: `${VA}/run.state`,
	NYXB_SYS_NET: `${SYS}/class/net`,
	NYXB_PACKAGES_LIST: host('/data/system/packages.list'),
	NYXB_CGROUP_ROOTS: '/nonexistent',
};
const TOOL_STUBS = {
	am: `#!/bin/sh\necho "am $*" >> ${CALLS}\n`,
	monkey: `#!/bin/sh\necho "monkey $*" >> ${CALLS}\n`,
	getprop: '#!/bin/sh\ncase "$1" in ro.build.version.release) echo 15;; ro.build.version.sdk) echo 35;; ro.product.model) echo SM-A155F;; *) echo;; esac\n',
	cmd: '#!/bin/sh\n[ "$1 $2" = "uimode night" ] && echo "Night mode: no"\n',
	settings: '#!/bin/sh\necho 0\n',
};
const PROP_VERSION = (fs.readFileSync(path.join(MODULE, 'module.prop'), 'utf8').match(/^version=(.*)$/m) || [])[1];

function killPrograms() {
	spawnSync('pkill', ['-9', '-f', `${MODDIR}/bin/nyxbridge`]);
}

function resetDevice() {
	killPrograms();
	va('down');
	for (const l of rules()) ipq('rule', 'del', 'pref', l.split(':')[0]);
	for (const l of ipq('-6', 'rule', 'show').stdout.split('\n').filter((x) => /^\d+:/.test(x) && !/^(0|32766):/.test(x))) ipq('-6', 'rule', 'del', 'pref', l.split(':')[0]);
	fs.rmSync(ROOT, { recursive: true, force: true });
	// The module as installed: customize.sh's permissions, and its data folder.
	fs.cpSync(MODULE, MODDIR, { recursive: true, filter: (src) => !/\.sha256$/.test(src) && !src.startsWith(WEBROOT) });
	fs.mkdirSync(`${MODDIR}/bin`, { recursive: true });
	fs.copyFileSync(BINARY, `${MODDIR}/bin/nyxbridge`);
	fs.chmodSync(`${MODDIR}/bin/nyxbridge`, 0o755);
	fs.mkdirSync(PDIR, { recursive: true, mode: 0o700 });
	fs.copyFileSync(path.join(MODULE, 'config.sh'), `${PDIR}/config.sh`);
	fs.chmodSync(`${PDIR}/config.sh`, 0o600);
	fs.mkdirSync(VA, { recursive: true });
	fs.mkdirSync(host('/data/system'), { recursive: true });
	fs.writeFileSync(host('/data/system/packages.list'), 'org.test.app 10123 0 /data/user/0/org.test.app default:targetSdkVersion=34 3003\n');
	fs.mkdirSync(TOOLS, { recursive: true });
	for (const [name, body] of Object.entries(TOOL_STUBS)) fs.writeFileSync(path.join(TOOLS, name), body, { mode: 0o755 });
	fs.writeFileSync(CALLS, '');
}
const readConfig = () => fs.readFileSync(`${PDIR}/config.sh`, 'utf8');
const cfgVal = (k) => (readConfig().match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
const settings = () =>
	readConfig()
		.split('\n')
		.filter((l) => l.trim() && !l.startsWith('#'))
		.join('\n');
const program = (...args) => execFileSync(`${MODDIR}/bin/nyxbridge`, args, { env: ENV, encoding: 'utf8' });
const watcherRunning = () => /^daemon=running$/m.test(program('status'));

// libsu-style result: output lines joined with \n (one trailing newline dropped).
function runSh(cmd) {
	return new Promise((resolve) => {
		execFile(SHELL, ['-c', `${toHost(cmd)}\nprintf '\\n__END__%s' $?`], { env: ENV, maxBuffer: 1 << 26 }, (_e, stdout, stderr) => {
			if (process.env.NYX_DEBUG) console.error('[sh]', JSON.stringify(cmd).slice(0, 160), '->', JSON.stringify(stdout).slice(-80), JSON.stringify(stderr).slice(0, 200));
			const i = stdout.lastIndexOf('\n__END__');
			const strip = (s) => toDevice(s.endsWith('\n') ? s.slice(0, -1) : s);
			if (i < 0) return resolve({ errno: 1, stdout: '', stderr: strip(stderr) });
			resolve({ errno: Number(stdout.slice(i + 8)), stdout: strip(stdout.slice(0, i)), stderr: strip(stderr) });
		});
	});
}

// Module functions for the behaviour checks, bundled from webui/src.
const TEST_BUNDLE = esbuild.buildSync({
	stdin: { contents: "export * as bridge from './core/ksu-bridge'; export * as data from './bridge-data';", resolveDir: path.join(REPO, 'webui', 'src'), loader: 'ts' },
	bundle: true,
	format: 'esm',
	target: 'es2020',
	write: false,
	logLevel: 'silent',
}).outputFiles[0].text;

// ---------------------------------------------------------------------------
// The mock manager.
let inflight = 0;
let lastNet = Date.now();

function hostInit() {
	const n = (window.__nyx = { execs: 0, spawns: 0, streams: 0, toasts: [], last: performance.now(), pending: 0 });
	const syncPost = (p, body) => {
		const x = new XMLHttpRequest();
		x.open('POST', p, false);
		x.send(JSON.stringify(body));
		return JSON.parse(x.responseText);
	};
	const post = (fn) => {
		n.pending++;
		setTimeout(() => {
			n.pending--;
			n.last = performance.now();
			fn();
		}, 0);
	};
	// Called from the test with each event of a spawned command, in order.
	window.__nyxEmit = (cb, ev, data, busy) =>
		post(() => {
			try {
				const sink = window[cb];
				if (ev === 'data') sink.stdout.emit('data', data);
				else if (ev === 'err') sink.stderr.emit('data', data);
				else if (ev === 'exit') {
					if (busy) n.pending--;
					sink.emit('exit', data);
				} else {
					const err = new Error();
					err.exitCode = data.errno;
					err.message = data.stderr;
					sink.emit('error', err);
				}
			} catch (e) {
				console.error(`emit ${ev}: ${e}`);
			}
		});
	window.ksu = {
		exec(cmd, opts, cb) {
			if (arguments.length !== 3) throw new Error(`Method not found: exec/${arguments.length}`);
			const r = syncPost('/__nyx_exec', { cmd });
			n.execs++;
			n.last = performance.now();
			post(() => {
				try {
					window[cb](r.errno, r.stdout, r.stderr);
				} catch (e) {
					console.error(e);
				}
			});
		},
		spawn(command, args, options, cb) {
			if (arguments.length !== 4) throw new Error(`Method not found: spawn/${arguments.length}`);
			syncPost('/__nyx_shell', {});
			n.spawns++;
			n.last = performance.now();
			// A short command keeps the page busy until it exits; the live stream doesn't.
			const busy = !/ watch \d+$/.test(command);
			if (busy) n.pending++;
			else n.streams++;
			window.__nyxSpawn(command, cb, busy);
		},
		toast(m) {
			n.toasts.push(String(m));
		},
		fullScreen(e) {
			if (arguments.length !== 1) throw new Error('arity');
		},
		enableEdgeToEdge(e) {
			if (arguments.length !== 1) throw new Error('arity');
		},
	};
}

async function serve(route, extra = {}) {
	const req = route.request();
	const p = new URL(req.url()).pathname;
	inflight++;
	try {
		if (extra[p]) return await extra[p](route);
		if (p === '/__nyx_exec') {
			const { cmd } = JSON.parse(req.postData());
			await sleep(SHELL_COST);
			return await route.fulfill({ contentType: 'application/json', body: JSON.stringify(await runSh(cmd)) });
		}
		if (p === '/__nyx_shell') {
			await sleep(SHELL_COST);
			return await route.fulfill({ contentType: 'application/json', body: '{}' });
		}
		if (p === '/__nyxtest.js') return await route.fulfill({ contentType: 'text/javascript', body: TEST_BUNDLE });
		if (p === '/internal/insets.css') {
			return await route.fulfill({ contentType: 'text/css', body: ':root{--safe-area-inset-top:0px;--safe-area-inset-bottom:0px;--window-inset-top:var(--safe-area-inset-top,0px);--window-inset-bottom:var(--safe-area-inset-bottom,0px);}' });
		}
		if (p === '/internal/colors.css') {
			return await route.fulfill({ contentType: 'text/css', body: ':root{--primary:#00696e;--onPrimary:#ffffff;--primaryContainer:#6ff6fe;--onPrimaryContainer:#002022;}' });
		}
		if (p.startsWith('/internal/')) return await route.fulfill({ contentType: 'text/css', body: '' });
		const f = path.join(WEBROOT, p === '/' ? 'index.html' : p);
		if (!f.startsWith(WEBROOT) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return await route.fulfill({ status: 404, body: '' });
		const ct = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html' }[path.extname(f)] || 'application/octet-stream';
		return await route.fulfill({ contentType: ct, body: fs.readFileSync(f) });
	} finally {
		inflight--;
		lastNet = Date.now();
	}
}

const children = new Set();
let busyChildren = 0;
const kill = (child) => {
	try {
		process.kill(-child.pid, 'SIGTERM');
	} catch {
		/* already gone */
	}
};

// spawn: run the command and stream its output into the page as it comes.
function exposeSpawn(page) {
	return page.exposeFunction('__nyxSpawn', (cmd, cb, busy) => {
		if (busy) busyChildren++;
		// Its own process group, so ending it ends what the shell started too.
		const child = spawn(SHELL, ['-c', toHost(cmd)], { env: ENV, detached: true });
		children.add(child);
		let chain = Promise.resolve();
		const emit = (ev, data) => {
			chain = chain.then(() => page.evaluate(([c, e, d, b]) => window.__nyxEmit(c, e, d, b), [cb, ev, data, busy]).catch(() => {}));
		};
		let err = '';
		const lines = (stream, ev, keep) => {
			let buf = '';
			stream.on('data', (d) => {
				buf += d;
				let i;
				while ((i = buf.indexOf('\n')) >= 0) {
					const line = toDevice(buf.slice(0, i));
					buf = buf.slice(i + 1);
					if (keep) err += (err ? '\n' : '') + line;
					emit(ev, line);
				}
			});
			stream.on('end', () => {
				if (buf) {
					if (keep) err += (err ? '\n' : '') + toDevice(buf);
					emit(ev, toDevice(buf));
				}
			});
		};
		lines(child.stdout, 'data', false);
		lines(child.stderr, 'err', true);
		child.on('close', (code) => {
			children.delete(child);
			emit('exit', code ?? 1);
			if (code) emit('error', { errno: code, stderr: err });
			chain.then(() => {
				if (busy) busyChildren--;
			});
		});
	});
}

async function newPage(browser, variant = '') {
	const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
	await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://mui.kernelsu.org' });
	const page = await ctx.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(`console: ${m.text()}`);
	});
	await exposeSpawn(page);
	await page.addInitScript(hostInit);
	if (variant === 'nospawn') await page.addInitScript(() => delete window.ksu.spawn);
	if (variant === 'nobridge') await page.addInitScript(() => delete window.ksu);
	await page.route('https://mui.kernelsu.org/**', (route) => serve(route));
	const close = async () => {
		await ctx.close();
		for (const c of children) kill(c);
	};
	return { ctx, page, errors, close };
}

async function settle(page, quiet = 400) {
	const start = Date.now();
	for (;;) {
		const s = await page.evaluate(() => ({ pending: window.__nyx.pending, idle: performance.now() - window.__nyx.last }));
		if (inflight === 0 && busyChildren === 0 && s.pending === 0 && s.idle > quiet && Date.now() - lastNet > quiet && Date.now() - start >= quiet) return;
		if (Date.now() - start > 60000) throw new Error('settle timeout');
		await sleep(50);
	}
}

async function until(fn, ms = 20000) {
	const end = Date.now() + ms;
	for (;;) {
		try {
			if (await fn()) return true;
		} catch {
			/* not there yet */
		}
		if (Date.now() > end) return false;
		await sleep(100);
	}
}

const counters = (page) => page.evaluate(() => ({ execs: window.__nyx.execs, spawns: window.__nyx.spawns, streams: window.__nyx.streams }));

// Whitespace in rendered text varies a little between Chromium releases; clock
// times, process ids, the build and the module version vary between runs.
function normalize(v) {
	if (typeof v === 'string') {
		let s = v
			.replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/g, '<time>')
			.replace(/\(pid \d+\)/g, '(pid <pid>)')
			.replace(/== Watcher pid \d+\n[^]*?(?=\n*== Log \(last)/g, '== Watcher pid <pid>\n<cgroups>\n')
			.replace(/^(A[46]_IDX)=\d+$/gm, '$1=<ifindex>')
			.replace(/^version=.*$/m, 'version=<build>')
			.replace(/^NyxBridge \S+$/m, 'NyxBridge <build>')
			.replace(/\(ifindex \d+\)/g, '(ifindex <n>)')
			.replace(/ accept_ra_rt_table=\S+/g, '');
		if (PROP_VERSION) s = s.split(PROP_VERSION).join('<version>');
		return s.replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();
	}
	if (Array.isArray(v)) return v.map(normalize);
	if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
	return v;
}

function diffValue(a, b) {
	const x = (typeof a === 'string' ? a : (JSON.stringify(a, null, 1) ?? 'undefined')).split('\n');
	const y = (typeof b === 'string' ? b : (JSON.stringify(b, null, 1) ?? 'undefined')).split('\n');
	const out = [];
	for (let i = 0; i < Math.max(x.length, y.length) && out.length < 16; i++) {
		if (x[i] !== y[i]) out.push(`      line ${i + 1}: expected ${JSON.stringify(x[i])}`, `              got      ${JSON.stringify(y[i])}`);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Functional snapshot: what the pages show and write, step by step.
async function functional(browser) {
	resetDevice();
	const { page, errors, close } = await newPage(browser);
	const snap = {};
	const text = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? null, sel);
	const go = async (t) => {
		// A focused field hides the navigation bar, as the keyboard does.
		await page.evaluate(() => document.activeElement?.blur());
		await page.click(`.nav-item[data-page="${t}"]`);
		await settle(page);
	};
	const toasts = () => page.evaluate(() => window.__nyx.toasts.slice());
	const lastToast = async () => (await toasts()).slice(-1)[0] ?? '';
	const mainText = () => text('#page-main');
	const row = (id) => text(`#page-main [data-row="${id}"]`);

	// A fresh install before its first reboot: no check yet, no watcher.
	await page.goto('https://mui.kernelsu.org/index.html');
	await until(() => page.isVisible('#page-main [data-role="live"]'));
	await settle(page);
	snap.html = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, fs: document.documentElement.dataset.fullscreen, monet: document.documentElement.dataset.monet ?? null, lang: document.documentElement.lang }));
	snap.nav = await text('#nav-bar');
	snap.main_fresh = await mainText();
	snap.markup = await page.evaluate(() => [...document.querySelectorAll('.page, #nav-bar')].map((el) => el.outerHTML.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim()));

	await page.click('#page-main [data-role="check"]');
	await settle(page);
	snap.main_checked = await mainText();

	// VirtualAP starts: the live stream shows it; nothing applies it yet.
	va('up');
	snap.live_va_row = (await until(async () => /Managed mode/.test(await row('va')))) ? await row('va') : `not updated: ${await row('va')}`;
	await settle(page);
	snap.main_va_up = await mainText();

	await page.click('#page-main [data-role="start"]');
	await until(async () => /Active/.test(await text('#page-main [data-role="title"]')));
	await settle(page);
	snap.main_active = await mainText();
	snap.net_active = { rules: rules(), addrs: bridgeAddrs() };

	// Devices appear once they talk.
	va('talk');
	await until(async () => (await text('[data-role="device-count"]')) === '2');
	await settle(page);
	snap.devices = await text('#page-main [data-role="devices"]');

	// Route checks.
	const result = () => text('#page-main [data-role="route-result"]');
	// The previous answer is cleared first, so a snapshot can only show this one.
	const clearResult = () => page.evaluate(() => document.querySelector('#page-main [data-role="route-result"]').replaceChildren());
	const answered = async () => {
		await until(async () => (await result()) !== '');
		await settle(page);
		return result();
	};
	const route = async (dest, app) => {
		await page.fill('#page-main [data-role="dest"]', dest);
		await page.fill('#page-main [data-role="app"]', app);
		await clearResult();
		await page.click('#page-main [data-role="route-go"]');
		return answered();
	};
	await clearResult();
	await page.click('#page-main .device[data-ip="192.168.42.150"]');
	snap.route_device = await answered();
	snap.route_vpn = await route('1.1.1.1', '');
	snap.route_as_app = await route('192.168.42.150', 'org.test.app');
	snap.route_unknown_app = await route('192.168.42.150', 'org.missing.app');
	await page.fill('#page-main [data-role="dest"]', 'not an address');
	snap.route_invalid = await page.evaluate(() => ({ disabled: document.querySelector('#page-main [data-role="route-go"]').disabled, invalid: document.querySelector('#page-main [data-role="dest"]').classList.contains('is-invalid') }));
	await page.fill('#page-main [data-role="dest"]', '');
	await page.fill('#page-main [data-role="app"]', '');

	// ---- Settings
	await go('settings');
	snap.page_settings = await text('#page-settings');
	const field = (role) => `#page-settings [data-role="${role}"]`;
	const fieldState = (role, save, hint) =>
		page.evaluate(([f, s, h]) => ({ value: document.querySelector(f).value, invalid: document.querySelector(f).classList.contains('is-invalid'), save: document.querySelector(s).disabled ? 'disabled' : 'enabled', hint: document.querySelector(h).textContent }), [field(role), field(save), field(hint)]);
	snap.host_typed = {};
	for (const v of ['1', '120', '255', '7']) {
		await page.fill(field('host'), v);
		snap.host_typed[v] = await fieldState('host', 'save-host', 'host-hint');
	}
	await page.click(field('save-host'));
	await settle(page);
	snap.host_saved = { toast: await lastToast(), addrs: bridgeAddrs(), cfg: cfgVal('host_octet') };
	snap.pref_typed = {};
	for (const v of ['12000', '40000', '7005']) {
		await page.fill(field('pref'), v);
		snap.pref_typed[v] = await fieldState('pref', 'save-pref', 'pref-hint');
	}
	await page.click(field('save-pref'));
	await settle(page);
	snap.pref_saved = { toast: await lastToast(), rules: rules(), cfg: cfgVal('rule_pref'), reset_shown: await page.isVisible(field('reset-pref')) };
	await page.click(field('reset-pref'));
	await settle(page);
	snap.pref_reset = { toast: await lastToast(), rules: rules(), cfg: cfgVal('rule_pref'), reset_shown: await page.isVisible(field('reset-pref')) };
	await page.fill(field('app'), 'not a package');
	snap.app_invalid = await fieldState('app', 'save-app', 'app-hint');
	await page.fill(field('app'), 'org.test.app');
	await page.click(field('save-app'));
	await settle(page);
	snap.app_saved = { toast: await lastToast(), cfg: cfgVal('restart_app'), restart_now: (await page.isDisabled(field('restart-now'))) ? 'disabled' : 'enabled' };
	fs.writeFileSync(CALLS, '');
	await page.click(field('restart-now'));
	await settle(page);
	snap.app_restart_now = { toast: await lastToast(), calls: fs.readFileSync(CALLS, 'utf8') };

	// IPv6 on: OpenWrt hasn't announced a prefix yet, then it does.
	await page.click('#page-settings label:has([data-role="ipv6"])');
	await settle(page);
	snap.ipv6_on = { toast: await lastToast(), cfg: cfgVal('ipv6'), details_shown: await page.isVisible(field('v6-details')) };
	await page.click(field('v6-details'));
	await settle(page);
	snap.ipv6_sheet_waiting = await text('.sheet');
	await page.click('.sheet [data-role="close"]');
	await settle(page);
	va('ra');
	await until(async () => /fd00:42::/.test(await row('v6')));
	await settle(page);
	snap.main_v6_row = await row('v6');
	await page.click(field('v6-details'));
	await settle(page);
	snap.ipv6_sheet = await text('.sheet');
	await page.click('.sheet [data-role="close"]');
	await settle(page);
	await page.click('#page-settings label:has([data-role="ipv6"])');
	await settle(page);
	snap.ipv6_off = { toast: await lastToast(), cfg: cfgVal('ipv6'), details_shown: await page.isVisible(field('v6-details')), v6_row: await row('v6') };

	await page.click('#page-settings label:has([data-role="enabled"])');
	await settle(page);
	const state = () => page.evaluate(() => ['title', 'reason'].map((r) => document.querySelector(`#page-main [data-role="${r}"]`).textContent).join(': '));
	snap.enabled_off = { toast: await lastToast(), cfg: cfgVal('enabled'), rules: rules(), addrs: bridgeAddrs(), ipv6_disabled: await page.isDisabled(field('ipv6')), main: await state() };
	await page.click('#page-settings label:has([data-role="enabled"])');
	await settle(page);
	snap.enabled_on = { toast: await lastToast(), cfg: cfgVal('enabled'), rules: rules(), addrs: bridgeAddrs() };
	snap.page_settings_after = await text('#page-settings');

	// ---- Main: monitoring off and on.
	await go('main');
	await page.click('#page-main label:has([data-role="monitor"])');
	await settle(page);
	snap.monitor_off = { toast: await lastToast(), cfg: cfgVal('monitor'), watcher: watcherRunning(), main: await mainText() };
	await page.click('#page-main label:has([data-role="monitor"])');
	await settle(page);
	snap.monitor_on = { toast: await lastToast(), cfg: cfgVal('monitor'), watcher: watcherRunning() };

	// ---- Logs and diagnostics.
	await go('logs');
	snap.page_logs = await text('#page-logs');
	await page.click('#page-logs [data-role="diag-show"]');
	await until(async () => /== Status/.test(await text('.sheet')));
	await settle(page);
	snap.diagnostics = await text('.sheet');
	await page.click('.sheet [data-role="close"]');
	await settle(page);

	// ---- About.
	await go('about');
	snap.page_about = await text('#page-about');
	await page.selectOption('#page-about [data-role="theme"]', 'dark');
	await settle(page);
	snap.theme_dark = { cfg: cfgVal('webui_theme'), theme: await page.evaluate(() => document.documentElement.dataset.theme), hint: await text('#page-about [data-role="theme-hint"]') };
	await page.selectOption('#page-about [data-role="theme"]', 'system');
	await settle(page);
	snap.theme_system = { cfg: cfgVal('webui_theme'), theme: await page.evaluate(() => document.documentElement.dataset.theme), hint: await text('#page-about [data-role="theme-hint"]') };
	await page.click('#page-about [data-role="monet"]');
	await settle(page, 1500);
	snap.monet = { cfg: cfgVal('webui_monet'), checked: await page.isChecked('#page-about [data-role="monet"]'), hint: await text('#page-about [data-role="monet-hint"]') };
	await page.click('#page-about [data-role="fullscreen"]');
	await settle(page);
	snap.fullscreen = { cfg: cfgVal('webui_fullscreen'), fs: await page.evaluate(() => document.documentElement.dataset.fullscreen) };

	for (const t of ['main', 'settings', 'logs', 'about']) {
		await go(t);
		await page.click('#refresh-btn');
		await settle(page);
		snap[`refreshed_${t}`] = await text(`#page-${t}`);
	}
	snap.toasts = (await toasts()).slice().sort();
	await go('settings');
	await page.selectOption('#page-settings [data-role="language"]', 'en');
	await settle(page);
	snap.settings_after_language = await text('#page-settings');
	snap.config = settings();
	await close();
	return { snap: normalize(snap), errors };
}

// ---------------------------------------------------------------------------
// Behaviour checks.
async function behaviour(browser, check) {
	const open = async (variant) => {
		const p = await newPage(browser, variant);
		await p.page.goto('https://mui.kernelsu.org/index.html');
		await settle(p.page);
		return p;
	};
	const title = (page) => page.evaluate(() => document.querySelector('#page-main [data-role="title"]').textContent);
	const row = (page, id) => page.evaluate((i) => document.querySelector(`#page-main [data-row="${i}"]`).textContent, id);

	// B1: execBatch gives each command exactly what a separate exec() would.
	{
		resetDevice();
		const { page, errors, close } = await open();
		const opened = await counters(page);
		check('B1 opening is one read and one stream', opened.execs === 1 && opened.spawns === 1 && opened.streams === 1, JSON.stringify(opened));
		const cmds = {
			empty: 'true',
			nonl: "printf 'abc'",
			nl: "printf 'abc\\n'",
			twonl: "printf 'abc\\n\\n'",
			multi: "printf 'a\\nb\\n\\nc\\n'",
			fail: 'echo out; exit 3',
			stderr: 'echo visible; echo hidden >&2',
			tagish: "echo '__NYX_fake_B0'; echo 'E0:9'",
			casey: 'n=yes\ncase "$n" in\n  *yes*) echo dark ;;\n  *) echo light ;;\nesac',
			spaces: "printf '  padded  \\n'",
			unicode: "printf 'ö — ✓\\n'",
			after: 'echo still-here',
		};
		const r = await page.evaluate(async (cmds) => {
			const { bridge } = await import('/__nyxtest.js');
			const batch = await bridge.execBatch(cmds);
			const single = {};
			for (const [k, c] of Object.entries(cmds)) {
				const x = await bridge.exec(`( ${c}\n) 2>/dev/null`);
				single[k] = { errno: x.errno, stdout: x.stdout };
			}
			return { batch, single };
		}, cmds);
		for (const k of Object.keys(cmds)) {
			const b = r.batch[k];
			const s = r.single[k];
			check(`B1 execBatch[${k}]`, b.errno === s.errno && b.stdout === s.stdout, `batch=${JSON.stringify(b)} single=${JSON.stringify(s)}`);
		}
		check('B1 no console errors', errors.length === 0, errors.join(' | '));
		await close();
	}

	// B2: spawn with a non-zero exit: result shape, and the trailing 'error' event is absorbed.
	{
		resetDevice();
		const { page, errors, close } = await open();
		const r = await page.evaluate(async () => (await import('/__nyxtest.js')).bridge.execAsync("sh -c 'echo one; echo two; echo bad >&2; exit 3'"));
		await settle(page);
		check('B2 execAsync non-zero exit', r.errno === 3 && r.stdout === 'one\ntwo' && r.stderr === 'bad', JSON.stringify(r));
		const r2 = await page.evaluate(async () => (await import('/__nyxtest.js')).bridge.execAsync('true'));
		check('B2 execAsync empty output', r2.errno === 0 && r2.stdout === '' && r2.stderr === '', JSON.stringify(r2));
		await settle(page, 600);
		check('B2 no console errors (error event after exit)', errors.length === 0, errors.join(' | '));
		await close();
	}

	// B3: live updates: one stream, VirtualAP and the watcher's repairs show without a refresh.
	{
		resetDevice();
		const { page, errors, close } = await open();
		check('B3 live chip once the stream reports in', await until(() => page.isVisible('#page-main [data-role="live"]')));
		await page.click('#page-main [data-role="start"]');
		await settle(page);
		va('up');
		check('B3 VirtualAP start applied and shown live', await until(async () => /Active/.test(await title(page))), await title(page));
		await settle(page);
		await sleep(1100); // the next check gets a later time
		const checked = await row(page, 'checked');
		ipq('rule', 'del', 'pref', '7001');
		const updated = await until(async () => (await row(page, 'checked')) !== checked);
		check('B3 rule restored by the watcher, shown live', updated && /^7001: to/.test(await row(page, 'rule')) && rules().length === 1, `${await row(page, 'rule')} checked=${await row(page, 'checked')}`);
		const before = await counters(page);
		await page.click('#refresh-btn');
		await page.click('#refresh-btn');
		await settle(page);
		check('B3 refreshes start no second stream', (await counters(page)).streams === 1 && before.streams === 1, JSON.stringify(await counters(page)));
		// The stream ends (the manager killed it, or its time ran out): a new one starts.
		for (const c of children) if (/ watch \d+$/.test(c.spawnargs.join(' '))) kill(c);
		check('B3 a new stream after the old one ends', await until(async () => (await counters(page)).streams === 2, 15000), JSON.stringify(await counters(page)));
		await page.click('.nav-item[data-page="logs"]');
		await settle(page);
		const logBefore = await page.evaluate(() => document.querySelector('#page-logs [data-role="log"]').textContent);
		va('down');
		check(
			'B3 the open log follows by itself',
			await until(async () => {
				const t = await page.evaluate(() => document.querySelector('#page-logs [data-role="log"]').textContent);
				return t !== logBefore && /VirtualAP is not running/.test(t);
			}),
		);
		check('B3 no console errors', errors.length === 0, errors.join(' | '));
		await close();
	}

	// B4: a typed, unsaved value survives a live update.
	{
		resetDevice();
		const { page, errors, close } = await open();
		await page.click('#page-main [data-role="start"]');
		va('up');
		await until(async () => /Active/.test(await title(page)));
		await page.click('.nav-item[data-page="settings"]');
		await settle(page);
		await page.fill('#page-settings [data-role="pref"]', '7005');
		await page.click('#page-settings .section-title >> nth=0');
		await settle(page);
		await sleep(1100); // the next check gets a later time
		const checked = await row(page, 'checked');
		ipq('rule', 'del', 'pref', '7001');
		const updated = await until(async () => (await row(page, 'checked')) !== checked);
		const value = await page.inputValue('#page-settings [data-role="pref"]');
		check('B4 typed priority kept across a live update', updated && value === '7005' && !(await page.isDisabled('#page-settings [data-role="save-pref"]')), `updated=${updated} value=${value}`);
		check('B4 no console errors', errors.length === 0, errors.join(' | '));
		await close();
	}

	// B5: quick switches queue: each one lands, in order.
	{
		resetDevice();
		va('up');
		const { page, errors, close } = await open();
		await page.click('.nav-item[data-page="settings"]');
		await settle(page);
		await page.evaluate(() => {
			document.querySelector('#page-settings [data-role="ipv6"]').click();
			document.querySelector('#page-settings [data-role="enabled"]').click();
		});
		await settle(page);
		check('B5 two quick switches both saved', cfgVal('ipv6') === '1' && cfgVal('enabled') === '0', `ipv6=${cfgVal('ipv6')} enabled=${cfgVal('enabled')}`);
		check('B5 the bridge follows the last one', rules().length === 0 && bridgeAddrs() === '', `${rules()} ${bridgeAddrs()}`);
		const r = await page.evaluate(async () => {
			const { data } = await import('/__nyxtest.js');
			const a = data.setSetting('host_octet', 9);
			const b = data.setSetting('host_octet', 11);
			const c = data.setSetting('host_octet', 'x');
			return [(await a).ok, (await b).ok, (await c).ok];
		});
		await settle(page);
		check('B5 queued saves: the last valid one wins, invalid ones are refused', JSON.stringify(r) === '[true,true,false]' && cfgVal('host_octet') === '11', `${JSON.stringify(r)} host_octet=${cfgVal('host_octet')}`);
		check('B5 no console errors', errors.length === 0, errors.join(' | '));
		await close();
	}

	// B6: a manager without spawn: no stream, everything through exec.
	{
		resetDevice();
		va('up');
		const { page, errors, close } = await open('nospawn');
		await sleep(1500);
		check('B6 no live chip without spawn()', !(await page.isVisible('#page-main [data-role="live"]')));
		const a = await counters(page);
		await page.click('#page-main [data-role="check"]');
		await settle(page);
		const b = await counters(page);
		check('B6 Check now through exec', b.execs - a.execs === 1 && b.spawns === 0, JSON.stringify(b));
		check('B6 Check now result shown', /Idle|Active/.test(await title(page)), await title(page));
		check('B6 no console errors', errors.length === 0, errors.join(' | '));
		await close();
	}

	// B7: the program doesn't answer (missing after an update without a reboot).
	{
		resetDevice();
		fs.rmSync(`${MODDIR}/bin/nyxbridge`);
		const { page, errors, close } = await open();
		await sleep(1500);
		check('B7 notice shown', await page.isVisible('#page-main [data-role="no-program"]'));
		check('B7 no Start watcher without a status', !(await page.isVisible('#page-main [data-role="start"]')));
		check('B7 no live chip', !(await page.isVisible('#page-main [data-role="live"]')));
		check('B7 no page errors', errors.filter((e) => e.startsWith('pageerror')).length === 0, errors.join(' | '));
		await close();
	}

	// B8: no bridge at all (desktop preview) still renders.
	{
		resetDevice();
		const { page, errors, close } = await open('nobridge');
		const tabs = await page.evaluate(() => document.querySelectorAll('.nav-item').length);
		check('B8 preview mode renders', tabs === 4 && (await title(page)) === 'Not checked yet', `tabs=${tabs} title=${await title(page)}`);
		check('B8 no page errors', errors.filter((e) => e.startsWith('pageerror')).length === 0, errors.join(' | '));
		await close();
	}

	// B9: Copy diagnostics puts exactly what Show shows on the clipboard.
	{
		resetDevice();
		va('up');
		const { page, errors, close } = await open();
		await page.click('.nav-item[data-page="logs"]');
		await page.click('#page-logs [data-role="diag-copy"]');
		await settle(page);
		const toast = await page.evaluate(() => window.__nyx.toasts.slice(-1)[0]);
		const clip = await page.evaluate(() => navigator.clipboard.readText());
		check('B9 diagnostics copied', toast === 'Diagnostics copied' && /^NyxBridge /.test(clip) && /\n== Status\n/.test(clip) && /\n== Log \(last 50 lines\)(\n|$)/.test(clip), `${toast}: ${clip.slice(0, 80)}`);
		check('B9 no console errors', errors.length === 0, errors.join(' | '));
		await close();
	}

	// B11: the appearance choices on About stay as chosen when the pages redraw
	// (a live update, Check now) before the next refresh.
	{
		resetDevice();
		const { page, errors, close } = await open();
		await page.click('.nav-item[data-page="about"]');
		await page.selectOption('#page-about [data-role="theme"]', 'dark');
		await settle(page);
		await page.click('.nav-item[data-page="main"]');
		await page.click('#page-main [data-role="check"]');
		await settle(page);
		await page.click('.nav-item[data-page="about"]');
		const st = await page.evaluate(() => ({ select: document.querySelector('#page-about [data-role="theme"]').value, theme: document.documentElement.dataset.theme, hint: document.querySelector('#page-about [data-role="theme-hint"]').textContent }));
		check('B11 theme choice kept across a redraw', st.select === 'dark' && st.theme === 'dark' && st.hint === '' && cfgVal('webui_theme') === 'dark', `${JSON.stringify(st)} cfg=${cfgVal('webui_theme')}`);
		check('B11 no console errors', errors.length === 0, errors.join(' | '));
		await close();
	}

	// B10: a palette that turns up late is picked up without holding the first render.
	{
		resetDevice();
		const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
		const page = await ctx.newPage();
		const errors = [];
		page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
		page.on('console', (m) => {
			if (m.type() === 'error') errors.push(`console: ${m.text()}`);
		});
		await exposeSpawn(page);
		await page.addInitScript(hostInit);
		await page.route('https://mui.kernelsu.org/**', (route) =>
			serve(route, {
				'/internal/colors.css': async (r) => {
					await sleep(600);
					await r.fulfill({ contentType: 'text/css', body: ':root{--primary:#00696e;}' });
				},
			}),
		);
		await page.goto('https://mui.kernelsu.org/index.html');
		await settle(page, 1800);
		const st = await page.evaluate(() => ({ monet: document.documentElement.dataset.monet ?? null, sw: document.querySelector('#page-about [data-role="monet"]').checked }));
		check('B10 late palette applied', st.monet === 'on' && st.sw === true, JSON.stringify(st));
		check('B10 no console errors', errors.length === 0, errors.join(' | '));
		await ctx.close();
		for (const c of children) kill(c);
	}
}

// ---------------------------------------------------------------------------
// Insets. Two manager models:
//   ksu  - KernelSU / SukiSU-Ultra / ReSukiSU: insets.css turns edge-to-edge
//          on; fullScreen(e) hides/shows the bars and sets edge-to-edge = e;
//          while edge-to-edge is on the manager pushes the system-bar insets
//          into documentElement.style, and the host pads while it's off.
//   ksun - KernelSU-Next: insets.css turns edge-to-edge on and serves the real
//          values; fullScreen only hides/shows the bars.
// Host padding + page padding must equal the visible system bars.
const BARS = { top: 24, bottom: 48 };

function insetsHostInit([model, real, effectDelay]) {
	const h = (window.__host = { model, insetsEnabled: false, barsHidden: false, current: { top: 0, bottom: 0 }, calls: [] });
	const push = (v) => {
		const s = document.documentElement.style;
		s.setProperty('--safe-area-inset-top', `${v.top}px`);
		s.setProperty('--safe-area-inset-right', '0px');
		s.setProperty('--safe-area-inset-bottom', `${v.bottom}px`);
		s.setProperty('--safe-area-inset-left', '0px');
	};
	const effect = () => {
		if (model !== 'ksu' || !h.insetsEnabled) return;
		const v = h.barsHidden ? { top: 0, bottom: 0 } : real;
		if (v.top !== h.current.top || v.bottom !== h.current.bottom) {
			h.current = { ...v };
			push(v);
		}
	};
	const schedule = () => setTimeout(effect, 16);
	h.insetsEnabled = true; // insets.css requested from <head>
	setTimeout(effect, effectDelay);
	h.hostPad = () => (h.insetsEnabled || h.barsHidden ? { top: 0, bottom: 0 } : { ...real });
	const arity = (name, n, args) => {
		if (args.length !== n) throw new Error(`Method not found: ${name}/${args.length}`);
	};
	window.ksu = {
		exec(cmd, opts, cb) {
			window.__nyxExec(cmd).then((r) => window[cb](r.errno, r.stdout, r.stderr));
		},
		toast() {},
		fullScreen(e) {
			arity('fullScreen', 1, arguments);
			h.calls.push(`fullScreen:${e}`);
			setTimeout(() => {
				h.barsHidden = e;
				schedule();
			}, 0);
			if (model === 'ksu') {
				h.insetsEnabled = e;
				schedule();
			}
		},
	};
	if (model === 'ksu') {
		window.ksu.enableEdgeToEdge = function (e) {
			arity('enableEdgeToEdge', 1, arguments);
			h.calls.push(`enableEdgeToEdge:${e}`);
			h.insetsEnabled = e;
			schedule();
		};
		window.ksu.enableInsets = window.ksu.enableEdgeToEdge;
	} else {
		window.ksu.enableInsets = function (e) {
			arity('enableInsets', 1, arguments);
			h.calls.push(`enableInsets:${e}`);
			h.insetsEnabled = e;
		};
	}
}

function insetsMeasure() {
	const cs = getComputedStyle;
	const top = parseFloat(cs(document.querySelector('.top-bar')).paddingTop);
	const bottom = parseFloat(cs(document.querySelector('main')).paddingBottom) - 96;
	const hostPad = window.__host.hostPad();
	return { fs: document.documentElement.dataset.fullscreen, barsHidden: window.__host.barsHidden, total: { top: top + hostPad.top, bottom: bottom + hostPad.bottom } };
}

async function insets(browser, check) {
	const insetsCss = (t, b) =>
		`:root{--safe-area-inset-top:${t}px;--safe-area-inset-right:0px;--safe-area-inset-bottom:${b}px;--safe-area-inset-left:0px;--window-inset-top:var(--safe-area-inset-top,0px);--window-inset-bottom:var(--safe-area-inset-bottom,0px);--window-inset-left:var(--safe-area-inset-left,0px);--window-inset-right:var(--safe-area-inset-right,0px);}`;
	for (const model of ['ksu', 'ksun']) {
		for (const effectDelay of [16, 1500]) {
			for (const start of ['0', '1']) {
				resetDevice();
				fs.writeFileSync(`${PDIR}/config.sh`, readConfig().replace(/^webui_fullscreen=.*$/m, `webui_fullscreen=${start}`));
				const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
				const page = await ctx.newPage();
				const errors = [];
				page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
				page.on('console', (m) => {
					if (m.type() === 'error') errors.push(`console: ${m.text()}`);
				});
				await page.exposeFunction('__nyxExec', runSh);
				await page.addInitScript(insetsHostInit, [model, BARS, effectDelay]);
				await page.route('https://mui.kernelsu.org/**', (route) =>
					serve(route, {
						'/internal/insets.css': (r) => {
							const v = model === 'ksun' ? BARS : { top: 0, bottom: 0 };
							return r.fulfill({ contentType: 'text/css', body: insetsCss(v.top, v.bottom) });
						},
					}),
				);
				await page.goto('https://mui.kernelsu.org/index.html');
				await page.waitForSelector('.nav-item');
				await page.waitForTimeout(effectDelay + 800);
				const steps = [['load', await page.evaluate(insetsMeasure)]];
				await page.click('.nav-item[data-page="about"]');
				const sw = page.locator('[data-role="fullscreen"]');
				for (let i = 0; i < 2; i++) {
					const was = cfgVal('webui_fullscreen');
					await sw.evaluate((el) => el.click());
					await until(() => cfgVal('webui_fullscreen') !== was, 10000);
					await page.waitForTimeout(400);
					const m = await page.evaluate(insetsMeasure);
					m.cfg = cfgVal('webui_fullscreen');
					steps.push([`toggle${i + 1}`, m]);
				}
				for (const [name, m] of steps) {
					const want = m.barsHidden ? { top: 0, bottom: 0 } : BARS;
					const ok = m.total.top === want.top && m.total.bottom === want.bottom && m.fs === (m.barsHidden ? 'on' : 'off') && (m.cfg === undefined || m.cfg === (m.fs === 'on' ? '1' : '0'));
					check(`insets ${model} delay=${effectDelay} fullscreen=${start} ${name}`, ok, `fs=${m.fs} padding=${m.total.top}/${m.total.bottom} want=${want.top}/${want.bottom}${m.cfg ? ` cfg=${m.cfg}` : ''}`);
				}
				check(`insets ${model} delay=${effectDelay} fullscreen=${start} no console errors`, errors.length === 0, errors.join(' | '));
				await ctx.close();
			}
		}
	}
}

// ---------------------------------------------------------------------------
async function main() {
	setupNetwork();
	execFileSync('mount', ['-t', 'sysfs', 'sysfs', SYS]);
	const browser = await chromium.launch(process.env.NYX_CHROMIUM ? { executablePath: process.env.NYX_CHROMIUM } : {});
	const results = [];
	const check = (name, ok, detail = '') => results.push({ name, ok, detail });
	try {
		const { snap, errors } = await functional(browser);
		check('functional: no console errors', errors.length === 0, errors.join(' | '));
		if (UPDATE) {
			fs.mkdirSync(path.dirname(EXPECTED), { recursive: true });
			fs.writeFileSync(EXPECTED, JSON.stringify(snap, null, 1) + '\n');
			console.log(`wrote ${path.relative(REPO, EXPECTED)} (${Object.keys(snap).length} keys)`);
		} else if (!fs.existsSync(EXPECTED)) {
			check('functional: expected file', false, `${path.relative(REPO, EXPECTED)} missing (run with --update)`);
		} else {
			const want = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
			for (const k of [...new Set([...Object.keys(want), ...Object.keys(snap)])]) {
				const same = JSON.stringify(want[k]) === JSON.stringify(snap[k]);
				check(`functional: ${k}`, same, same ? '' : `\n${diffValue(want[k], snap[k]).join('\n')}`);
			}
		}
		await behaviour(browser, check);
		await insets(browser, check);
	} finally {
		await browser.close();
		killPrograms();
		execFileSync('umount', [SYS]);
		fs.rmSync(ROOT, { recursive: true, force: true });
		fs.rmSync(SYS, { recursive: true, force: true });
	}
	const failed = results.filter((r) => !r.ok);
	for (const r of results) if (!r.ok || process.env.VERBOSE) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok || !r.detail ? '' : ` - ${r.detail}`}`);
	console.log(`== WebUI (sh=${SHELL}): ${results.length - failed.length}/${results.length} checks passed`);
	process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	killPrograms();
	fs.rmSync(ROOT, { recursive: true, force: true });
	process.exit(2);
});
