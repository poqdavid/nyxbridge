// Small helpers shared by the pages.

export function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Put a button into its spinning "busy" state; returns a function that restores it. */
export function busyButton(btn, label) {
	const original = btn.innerHTML;
	btn.disabled = true;
	btn.classList.add('is-busy');
	btn.setAttribute('aria-busy', 'true');
	btn.innerHTML = `<span class="btn__spinner" aria-hidden="true"></span>${escapeHtml(label)}`;
	return () => {
		btn.disabled = false;
		btn.classList.remove('is-busy');
		btn.removeAttribute('aria-busy');
		btn.innerHTML = original;
	};
}
