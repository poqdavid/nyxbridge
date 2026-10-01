export interface ExecResult {
	errno: number;
	stdout: string;
	stderr: string;
}

export interface ExecOptions {
	cwd?: string;
	env?: Record<string, string>;
}

interface KsuBridge {
	exec(command: string, options: string, callback: string): void;
	spawn?(command: string, args: string, options: string, callback: string): void;
	toast?(message: string): void;
	fullScreen?(enable: boolean): void;
	enableEdgeToEdge?(enable: boolean): void;
}

declare global {
	interface Window {
		ksu?: KsuBridge;
	}
}

const callbacks = window as unknown as Record<string, unknown>;

let seq = 0;
function uniqueName(prefix: string): string {
	seq += 1;
	return `nyx_${prefix}_${Date.now()}_${seq}`;
}

export function exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
	return new Promise((resolve) => {
		const ksu = window.ksu;
		if (ksu === undefined) {
			console.warn('[nyx] window.ksu not found, running in preview mode:', command);
			resolve({ errno: 1, stdout: '', stderr: 'ksu bridge unavailable (preview mode)' });
			return;
		}
		const cb = uniqueName('exec');
		callbacks[cb] = (errno: number, stdout?: string, stderr?: string) => {
			delete callbacks[cb];
			resolve({ errno, stdout: stdout ?? '', stderr: stderr ?? '' });
		};
		try {
			ksu.exec(command, JSON.stringify(options), cb);
		} catch (err) {
			delete callbacks[cb];
			resolve({ errno: 1, stdout: '', stderr: String(err) });
		}
	});
}

export async function execBatch<K extends string>(commands: Record<K, string>): Promise<Record<K, ExecResult>> {
	const keys = Object.keys(commands) as K[];
	const tag = `__NYX_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}__`;
	const script = keys.map((key, i) => [`printf '%s\\n' '${tag}B${i}'`, '(', commands[key], ') 2>/dev/null', `printf '\\n%s\\n' "${tag}E${i}:$?"`].join('\n')).join('\n');
	const { stdout } = await exec(script);
	const results = {} as Record<K, ExecResult>;
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

interface SpawnSink {
	stdout: { emit(event: string, data: unknown): void };
	stderr: { emit(event: string, data: unknown): void };
	emit(event: string, data: unknown): void;
}

export function execAsync(command: string): Promise<ExecResult> {
	const ksu = window.ksu;
	if (ksu === undefined || typeof ksu.spawn !== 'function') return exec(command);

	const bridge = ksu as Required<KsuBridge>;
	return new Promise((resolve) => {
		const cb = uniqueName('spawn');
		const out: string[] = [];
		const err: string[] = [];
		let done = false;
		const stream = (lines: string[]) => ({
			emit: (event: string, data: unknown) => {
				if (event === 'data') lines.push(String(data));
			},
		});
		const sink: SpawnSink = {
			stdout: stream(out),
			stderr: stream(err),
			emit: (event, data) => {
				if (event !== 'exit' || done) return;
				done = true;
				setTimeout(() => delete callbacks[cb], 10000);
				resolve({ errno: Number(data), stdout: out.join('\n'), stderr: err.join('\n') });
			},
		};
		callbacks[cb] = sink;
		try {
			bridge.spawn(command, '', '{}', cb);
		} catch {
			delete callbacks[cb];
			exec(command).then(resolve);
		}
	});
}

export function spawnLines(command: string, onLine: (line: string) => void, onExit: (code: number) => void): boolean {
	const ksu = window.ksu;
	if (ksu === undefined || typeof ksu.spawn !== 'function') return false;
	const bridge = ksu as Required<KsuBridge>;
	const cb = uniqueName('stream');
	let done = false;
	const ignore = { emit: () => {} };
	const sink: SpawnSink = {
		stdout: {
			emit: (event, data) => {
				if (event !== 'data') return;
				for (const line of String(data).split('\n')) onLine(line);
			},
		},
		stderr: ignore,
		emit: (event, data) => {
			if (event !== 'exit' || done) return;
			done = true;
			setTimeout(() => delete callbacks[cb], 10000);
			onExit(Number(data));
		},
	};
	callbacks[cb] = sink;
	try {
		bridge.spawn(command, '', '{}', cb);
	} catch {
		delete callbacks[cb];
		return false;
	}
	return true;
}

export function nextPaint(): Promise<void> {
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

export function toast(message: string): void {
	const ksu = window.ksu;
	if (ksu !== undefined && typeof ksu.toast === 'function') {
		ksu.toast(message);
	} else {
		console.log('[nyx toast]', message);
	}
}

export function fullScreen(enabled: boolean): boolean {
	const ksu = window.ksu;
	if (ksu === undefined || typeof ksu.fullScreen !== 'function') return false;
	try {
		ksu.fullScreen(enabled);
		return true;
	} catch (err) {
		console.warn('[nyx] fullScreen failed:', err);
		return false;
	}
}

export function fullScreenAvailable(): boolean {
	return window.ksu !== undefined && typeof window.ksu.fullScreen === 'function';
}

export function enableEdgeToEdge(): boolean {
	const ksu = window.ksu;
	if (ksu === undefined || typeof ksu.enableEdgeToEdge !== 'function') return false;
	try {
		ksu.enableEdgeToEdge(true);
		return true;
	} catch (err) {
		console.warn('[nyx] enableEdgeToEdge failed:', err);
		return false;
	}
}
