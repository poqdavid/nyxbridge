// Minimal hand-drawn icon set in the rounded Material Symbols style, kept
// as inline SVG strings so the WebUI has zero font/icon-library
// dependency and still renders correctly offline in the manager's WebView.
// Same set as NyxSUSFS / NyxProps, plus a log icon.
export const icons = {
	home: '<svg viewBox="0 0 24 24"><path d="M12 3 3 10v11h6v-6h6v6h6V10z"/></svg>',
	settings: '<svg viewBox="0 0 24 24"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm7.4-3.5c0 .4 0 .8-.1 1.2l2 1.6-2 3.4-2.4-1a7.7 7.7 0 0 1-2 1.2l-.4 2.6H9.5l-.4-2.6a7.7 7.7 0 0 1-2-1.2l-2.4 1-2-3.4 2-1.6a7 7 0 0 1 0-2.4l-2-1.6 2-3.4 2.4 1a7.7 7.7 0 0 1 2-1.2L9.5 2h5l.4 2.6a7.7 7.7 0 0 1 2 1.2l2.4-1 2 3.4-2 1.6c.1.4.1.8.1 1.2z"/></svg>',
	logs: '<svg viewBox="0 0 24 24"><path fill-rule="evenodd" d="M6 2h9l5 5v15H6zm2.5 8h9v1.6h-9zm0 3.5h9v1.6h-9zm0 3.5h6v1.6h-6z"/></svg>',
	info: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/></svg>',
	refresh: '<svg viewBox="0 0 24 24"><path d="M12 6V2L7 7l5 5V8a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>',
};
