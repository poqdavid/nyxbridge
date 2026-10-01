// Thin wrapper around the native window.ksu bridge that KernelSU / KernelSU
// Next inject into the WebUI's WebView.
//
// The native side only speaks through global callback *names* (it can't
// hand back a JS function across the bridge), so exec() registers a
// one-shot function on `window`, passes its name across, and cleans up
// once it fires. This mirrors the documented behaviour of the official
// `kernelsu` npm package, written fresh here rather than vendored so the
// module has no build step or bundled third-party file.
//
// If window.ksu isn't present at all (e.g. you're previewing index.html in
// a normal desktop browser while designing the UI), everything resolves
// to an empty/failed result instead of throwing, so the page still loads.
//
// Cost model - this is what the WebUI's responsiveness hangs on. exec() is
// synchronous on the native side: the @JavascriptInterface call holds the
// page's main thread while the manager opens a NEW root shell for that one
// command (KernelSU, KernelSU-Next and ReSukiSU all use withNewRootShell)
// and runs it. Every exec() is therefore a visible freeze. So:
//   - reads go through execBatch(): many commands, one exec, one shell;
//   - long-running commands (network) go through execAsync(), which uses
//     the manager's spawn() so only the shell start-up blocks;
//   - UI feedback is painted first (nextPaint) before any of these runs.

let seq = 0;
function uniqueName(prefix) {
	seq += 1;
	return `nyx_${prefix}_${Date.now()}_${seq}`;
}

const hasBridge = () => typeof window.ksu !== 'undefined';

/**
 * Run a root shell command.
 * @param {string} command
 * @param {{cwd?: string, env?: Record<string,string>}} [options]
 * @returns {Promise<{errno:number, stdout:string, stderr:string}>}
 */
export function exec(command, options = {}) {
	return new Promise((resolve) => {
		if (!hasBridge()) {
			console.warn('[nyx] window.ksu not found, running in preview mode:', command);
			resolve({ errno: 1, stdout: '', stderr: 'ksu bridge unavailable (preview mode)' });
			return;
		}
		const cb = uniqueName('exec');
		window[cb] = (errno, stdout, stderr) => {
			delete window[cb];
			resolve({ errno, stdout: stdout ?? '', stderr: stderr ?? '' });
		};
		try {
			window.ksu.exec(command, JSON.stringify(options), cb);
		} catch (err) {
			delete window[cb];
			resolve({ errno: 1, stdout: '', stderr: String(err) });
		}
	});
}

/**
 * Run several commands through ONE exec - one root shell, one freeze - and
 * split the output back up per command.
 *
 * Each command runs in its own subshell with stderr discarded, between
 * begin/end marker lines carrying a random tag, so its stdout and exit code
 * come back exactly as a separate exec() would have given them: lines
 * joined with \n, trailing newline dropped (libsu's shape). A command whose
 * markers are missing - the batch died, or there's no bridge - reads as
 * errno 1 with empty output, the same as a failed exec().
 *
 * Only for read-only commands that don't depend on each other's side
 * effects. Writes keep their own exec() so a failure stays attributable.
 *
 * @param {Record<string,string>} commands key -> shell command
 * @returns {Promise<Record<string,{errno:number, stdout:string, stderr:string}>>}
 */
export async function execBatch(commands) {
	const keys = Object.keys(commands);
	const tag = `__NYX_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}__`;
	const script = keys
		.map((key, i) => [
			`printf '%s\\n' '${tag}B${i}'`,
			'(',
			commands[key],
			') 2>/dev/null',
			`printf '\\n%s\\n' "${tag}E${i}:$?"`,
		].join('\n'))
		.join('\n');
	const { stdout } = await exec(script);
	const results = {};
	let from = 0;
	keys.forEach((key, i) => {
		const begin = `${tag}B${i}\n`;
		const end = `\n${tag}E${i}:`;
		const b = stdout.indexOf(begin, from);
		const e = b < 0 ? -1 : stdout.indexOf(end, b + begin.length);
		if (b < 0 || e < 0) {
			results[key] = { errno: 1, stdout: '', stderr: '' };
			return;
		}
		let body = stdout.slice(b + begin.length, e);
		if (body.endsWith('\n')) body = body.slice(0, -1);
		const code = /^\d+/.exec(stdout.slice(e + end.length));
		results[key] = { errno: code ? Number(code[0]) : 1, stdout: body, stderr: '' };
		from = e + end.length;
	});
	return results;
}

/**
 * exec() for long-running commands, without freezing the page for their
 * whole runtime.
 *
 * Uses the manager's spawn() where it exists (KernelSU, KernelSU-Next and
 * ReSukiSU all have it): only opening the root shell happens inside the
 * call, the command itself runs on a background thread and its output is
 * posted back line by line, followed by 'exit' (and 'error' when the code
 * is non-zero). Resolves to the same {errno, stdout, stderr} shape as
 * exec(); falls back to exec() on a manager without spawn().
 *
 * @param {string} command
 * @returns {Promise<{errno:number, stdout:string, stderr:string}>}
 */
export function execAsync(command) {
	if (!hasBridge() || typeof window.ksu.spawn !== 'function') return exec(command);
	return new Promise((resolve) => {
		const cb = uniqueName('spawn');
		const out = [];
		const err = [];
		let done = false;
		const stream = (lines) => ({
			emit: (event, data) => {
				if (event === 'data') lines.push(String(data));
			},
		});
		window[cb] = {
			stdout: stream(out),
			stderr: stream(err),
			emit: (event, data) => {
				if (event !== 'exit' || done) return;
				done = true;
				// 'error' is emitted straight after 'exit' for a non-zero
				// code, so the handler has to outlive this - dropped later.
				setTimeout(() => delete window[cb], 10000);
				resolve({ errno: Number(data), stdout: out.join('\n'), stderr: err.join('\n') });
			},
		};
		try {
			window.ksu.spawn(command, '', '{}', cb);
		} catch (e) {
			delete window[cb];
			exec(command).then(resolve);
		}
	});
}

/**
 * Resolves after the browser has committed a frame, so whatever was just
 * changed - a switched tab, a toggled switch, a spinner - is actually on
 * screen, and CSS animations handed to the compositor, before an exec()
 * holds the main thread. The timer is only a backstop for a WebView that
 * isn't producing frames (backgrounded), so nothing waits on it forever.
 */
export function nextPaint() {
	return new Promise((resolve) => {
		let fired = false;
		const done = () => {
			if (fired) return;
			fired = true;
			resolve();
		};
		requestAnimationFrame(() => requestAnimationFrame(done));
		setTimeout(done, 250);
	});
}

export function toast(message) {
	if (hasBridge() && typeof window.ksu.toast === 'function') {
		window.ksu.toast(message);
	} else {
		console.log('[nyx toast]', message);
	}
}

export function fullScreen(enabled) {
	if (!fullScreenAvailable()) return false;
	try {
		window.ksu.fullScreen(enabled);
		return true;
	} catch (err) {
		console.warn('[nyx] fullScreen failed:', err);
		return false;
	}
}

/** Whether the host actually offers fullScreen. Older managers and the
 * desktop preview don't, and a toggle that silently does nothing is
 * worse than one that says it can't. */
export function fullScreenAvailable() {
	return hasBridge() && typeof window.ksu.fullScreen === 'function';
}

/** Switch the manager's edge-to-edge mode back on, where the host has the
 * call (KernelSU, SukiSU-Ultra, ReSukiSU; not KernelSU-Next). The argument
 * is passed explicitly: the Kotlin default of `true` doesn't cross the JS
 * bridge, which matches methods by arity. */
export function enableEdgeToEdge() {
	if (!hasBridge() || typeof window.ksu.enableEdgeToEdge !== 'function') return false;
	try {
		window.ksu.enableEdgeToEdge(true);
		return true;
	} catch (err) {
		console.warn('[nyx] enableEdgeToEdge failed:', err);
		return false;
	}
}

/** Returns module.prop as a parsed object, read directly off disk so it's
 * always current even before a reboot re-renders the manager's cache. */
export async function moduleInfo(modDir) {
	const { errno, stdout } = await exec(`cat '${modDir}/module.prop' 2>/dev/null`);
	const info = {};
	if (errno === 0) {
		for (const line of stdout.split('\n')) {
			const idx = line.indexOf('=');
			if (idx > 0) info[line.slice(0, idx)] = line.slice(idx + 1);
		}
	}
	return info;
}

export const bridgeAvailable = hasBridge;
