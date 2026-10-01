import { $, escapeHtml } from './dom';

interface Dialog {
	scrim: HTMLElement;
	dialog: HTMLElement;
}

let mounted: Dialog | null = null;
let resolveFn: ((value: unknown) => void) | null = null;

function ensureMounted(): Dialog {
	if (mounted) return mounted;
	const scrim = document.createElement('div');
	scrim.className = 'dialog-scrim';
	const dialog = document.createElement('div');
	dialog.className = 'dialog';
	scrim.appendChild(dialog);
	document.body.appendChild(scrim);
	scrim.addEventListener('click', (e) => {
		if (e.target === scrim) settle(null);
	});
	mounted = { scrim, dialog };
	return mounted;
}

function settle(value: unknown): void {
	if (!resolveFn || !mounted) return;
	const fn = resolveFn;
	resolveFn = null;
	mounted.scrim.classList.remove('open');
	fn(value);
}

function open(innerHtml: string, wire: (dialog: HTMLElement) => void): Promise<unknown> {
	const { scrim, dialog } = ensureMounted();
	dialog.innerHTML = innerHtml;
	return new Promise((resolve) => {
		resolveFn = resolve;
		wire(dialog);
		requestAnimationFrame(() => scrim.classList.add('open'));
	});
}

export function confirmDialog(title: string, message: string, confirmLabel = 'Confirm'): Promise<boolean> {
	return open(
		`
		<h3 class="dialog__title">${escapeHtml(title)}</h3>
		<p class="dialog__body">${escapeHtml(message)}</p>
		<div class="dialog__actions">
			<button class="btn btn--text" data-role="cancel">Cancel</button>
			<button class="btn btn--filled" data-role="ok">${escapeHtml(confirmLabel)}</button>
		</div>`,
		(dialog) => {
			$(dialog, '[data-role="cancel"]').onclick = () => settle(false);
			$(dialog, '[data-role="ok"]').onclick = () => settle(true);
		},
	).then((v) => v === true);
}

export function promptDialog(title: string, message: string, defaultValue = ''): Promise<string | null> {
	return open(
		`
		<h3 class="dialog__title">${escapeHtml(title)}</h3>
		<p class="dialog__body">${escapeHtml(message)}</p>
		<input class="dialog__input" data-role="input" value="${escapeHtml(defaultValue)}" spellcheck="false">
		<div class="dialog__actions">
			<button class="btn btn--text" data-role="cancel">Cancel</button>
			<button class="btn btn--filled" data-role="ok">OK</button>
		</div>`,
		(dialog) => {
			const input = $<HTMLInputElement>(dialog, '[data-role="input"]');
			$(dialog, '[data-role="cancel"]').onclick = () => settle(null);
			$(dialog, '[data-role="ok"]').onclick = () => settle(input.value);
			input.onkeydown = (e) => {
				if (e.key === 'Enter') settle(input.value);
			};
			setTimeout(() => input.focus(), 50);
		},
	).then((v) => (typeof v === 'string' ? v : null));
}
