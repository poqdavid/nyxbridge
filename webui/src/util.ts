import { escapeHtml } from './core/dom';

export function busyButton(btn: HTMLButtonElement, label: string): () => void {
	const original = btn.innerHTML;
	const wasDisabled = btn.disabled;
	btn.disabled = true;
	btn.classList.add('is-busy');
	btn.setAttribute('aria-busy', 'true');
	btn.innerHTML = `<span class="btn__spinner" aria-hidden="true"></span>${escapeHtml(label)}`;
	return () => {
		btn.disabled = wasDisabled;
		btn.classList.remove('is-busy');
		btn.removeAttribute('aria-busy');
		btn.innerHTML = original;
	};
}

export function nobreak(name: string): string {
	return name.replace(/-/g, '‑');
}

export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {}

	const area = document.createElement('textarea');
	area.value = text;
	area.setAttribute('readonly', '');
	area.style.position = 'fixed';
	area.style.opacity = '0';
	document.body.appendChild(area);
	area.select();
	let ok = false;
	try {
		ok = document.execCommand('copy');
	} catch {
		ok = false;
	}
	area.remove();
	return ok;
}
