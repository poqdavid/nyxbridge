import { getDiagnostics, LOG_PATH } from '../bridge-data';
import type { AppState } from '../context';
import { $, escapeHtml } from '../core/dom';
import { icons } from '../core/icons';
import { nextPaint, toast } from '../core/ksu-bridge';
import { t } from '../core/i18n';
import { openSheetLoading, openSheetWithHtml } from '../core/sheet';
import { busyButton, copyText } from '../util';

export function buildLogs(root: HTMLElement): void {
	root.innerHTML = `
		<h2 class="section-title">${t('logs_title', 'Activity')}</h2>
		<div class="card">
			<pre class="log-view" data-role="log"></pre>
		</div>
		<p class="setting-row__desc page-footnote">${t('logs_hint', 'Newest at the bottom. Updates by itself while Main shows Live; the refresh button in the top bar re-reads it.')} <code>${LOG_PATH}</code></p>

		<h2 class="section-title">${t('logs_diag_title', 'Diagnostics')}</h2>
		<div class="card">
			<div class="setting-row setting-row--stacked">
				<div class="setting-row__text">
					<div class="setting-row__desc">${t('logs_diag_desc', "Everything useful for a bug report in one block of text: the status, VirtualAP's state, the settings, the routing rules, the bridge's addresses and the end of the log. It names your hotspot's addresses; nothing is sent anywhere.")}</div>
				</div>
				<div class="setting-row__actions">
					<button class="btn btn--text" data-role="diag-show">${t('logs_diag_show', 'Show')}</button>
					<button class="btn btn--tonal btn--icon" data-role="diag-copy">${icons.copy}<span>${t('logs_diag_copy', 'Copy diagnostics')}</span></button>
				</div>
			</div>
		</div>
	`;

	$(root, '[data-role="diag-copy"]').addEventListener('click', async (e) => {
		const restore = busyButton(e.currentTarget as HTMLButtonElement, t('logs_diag_collecting', 'Collecting…'));
		await nextPaint();
		try {
			const text = await getDiagnostics();
			if (text === null) {
				toast(t('logs_diag_failed', 'Could not collect the diagnostics'));
			} else if (await copyText(text)) {
				toast(t('logs_diag_copied', 'Diagnostics copied'));
			} else {
				showDiagnostics(text);
				toast(t('logs_diag_copy_failed', "Couldn't copy here; select the text and copy it"));
			}
		} finally {
			restore();
		}
	});

	$(root, '[data-role="diag-show"]').addEventListener('click', async () => {
		openSheetLoading(t('logs_diag_title', 'Diagnostics'), t('logs_diag_collecting', 'Collecting…'));
		const text = await getDiagnostics();
		showDiagnostics(text ?? t('logs_diag_failed', 'Could not collect the diagnostics'));
	});
}

function showDiagnostics(text: string): void {
	openSheetWithHtml(t('logs_diag_title', 'Diagnostics'), `<pre class="log-view log-view--select">${escapeHtml(text)}</pre>`);
}

export function renderLogs(root: HTMLElement, { log }: AppState): void {
	const el = $(root, '[data-role="log"]');
	const text = log.trim();
	const shown = text || t('logs_empty', 'No activity yet.');
	if (el.textContent === shown) return;
	const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24 || !el.textContent;
	el.textContent = shown;
	el.classList.toggle('is-empty', !text);
	if (atBottom) {
		requestAnimationFrame(() => {
			el.scrollTop = el.scrollHeight;
		});
	}
}
