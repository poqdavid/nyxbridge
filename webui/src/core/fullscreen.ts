import { fullScreen, fullScreenAvailable, enableEdgeToEdge } from './ksu-bridge';

export function applyFullscreen(enabled: boolean): boolean {
	const on = Boolean(enabled) && fullScreenAvailable();
	if (fullScreen(on) && !on) enableEdgeToEdge();
	document.documentElement.dataset.fullscreen = on ? 'on' : 'off';
	return on;
}

export { fullScreenAvailable };
