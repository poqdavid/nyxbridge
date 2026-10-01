import { t } from '../i18n.js';
import { LOG_PATH } from '../bridge-data.js';

// The watcher's log. It only records changes (address added, rule
// restored, VirtualAP stopped...), so it stays short and readable.

export function buildLogs(root) {
	root.innerHTML = `
		<h2 class="section-title">${t('logs_title', 'Activity')}</h2>
		<div class="card">
			<pre class="log-view" data-role="log"></pre>
		</div>
		<p class="setting-row__desc page-footnote">${t('logs_hint', 'Newest at the bottom. Tap refresh in the top bar to reload.')} <code>${LOG_PATH}</code></p>
	`;
}

export function renderLogs(root, { log }) {
	const el = root.querySelector('[data-role="log"]');
	const text = (log || '').trim();
	el.textContent = text || t('logs_empty', 'No activity yet.');
	el.classList.toggle('is-empty', !text);
	// Newest lines are what you came for.
	requestAnimationFrame(() => {
		el.scrollTop = el.scrollHeight;
	});
}
