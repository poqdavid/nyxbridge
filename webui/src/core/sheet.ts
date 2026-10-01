import { icons } from './icons';
import { $, escapeHtml } from './dom';

export interface SheetGroup {
	label: string;
	items: string[];
}

interface Sheet {
	scrim: HTMLElement;
	sheet: HTMLElement;
	title: HTMLElement;
	body: HTMLElement;
}

let mounted: Sheet | null = null;

function ensureMounted(): Sheet {
	if (mounted) return mounted;
	const scrim = document.createElement('div');
	scrim.className = 'sheet-scrim';
	const sheet = document.createElement('div');
	sheet.className = 'sheet';
	sheet.innerHTML = `
		<div class="sheet__handle"></div>
		<div class="sheet__header">
			<span data-role="title"></span>
			<button class="icon-btn" data-role="close" aria-label="Close">${icons.close}</button>
		</div>
		<div class="sheet__body" data-role="body"></div>
	`;
	document.body.append(scrim, sheet);
	mounted = { scrim, sheet, title: $(sheet, '[data-role="title"]'), body: $(sheet, '[data-role="body"]') };
	scrim.addEventListener('click', closeSheet);
	$(sheet, '[data-role="close"]').addEventListener('click', closeSheet);
	return mounted;
}

export function closeSheet(): void {
	if (!mounted) return;
	mounted.scrim.classList.remove('open');
	mounted.sheet.classList.remove('open');
}

function show(s: Sheet): void {
	requestAnimationFrame(() => {
		s.scrim.classList.add('open');
		s.sheet.classList.add('open');
	});
}

export function openSheetWithList(title: string, entries: string[], emptyMessage = 'Nothing recorded for this boot yet.'): void {
	const s = ensureMounted();
	s.title.textContent = title;
	if (!entries.length) {
		s.body.innerHTML = `<div class="sheet__empty">${emptyMessage}</div>`;
	} else {
		s.body.innerHTML = `<ul class="sheet__list">${entries.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
	}
	show(s);
}

export function openSheetWithGroups(title: string, groups: SheetGroup[], emptyMessage = 'Nothing recorded for this boot yet.'): void {
	const s = ensureMounted();
	s.title.textContent = title;
	const total = groups.reduce((n, g) => n + g.items.length, 0);
	if (!total) {
		s.body.innerHTML = `<div class="sheet__empty">${emptyMessage}</div>`;
	} else {
		const shown = groups.filter((g) => g.items.length);
		s.body.innerHTML = shown
			.map((g) => {
				const header = shown.length > 1 ? `<div class="sheet__group">${escapeHtml(g.label)} (${g.items.length})</div>` : '';
				return `${header}<ul class="sheet__list">${g.items.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
			})
			.join('');
	}
	show(s);
}

export function openSheetLoading(title: string, message = 'Loading…'): void {
	const s = ensureMounted();
	s.title.textContent = title;
	s.body.innerHTML = `<div class="sheet__empty">${escapeHtml(message)}</div>`;
	show(s);
}

export function openSheetWithHtml(title: string, html: string): void {
	const s = ensureMounted();
	s.title.textContent = title;
	s.body.innerHTML = html;
	show(s);
}
