export type Theme = 'mocha' | 'latte';

const STORAGE_KEY = 'clue-theme';

export function setTheme(t: Theme): void {
	document.documentElement.dataset.theme = t;
	localStorage.setItem(STORAGE_KEY, t);
}

export function initTheme(): Theme {
	const raw = localStorage.getItem(STORAGE_KEY);
	const saved: Theme | null = raw === 'mocha' || raw === 'latte' ? raw : null;
	const prefersLight =
		window.matchMedia('(prefers-color-scheme: light)').matches;
	const theme: Theme = saved ?? (prefersLight ? 'latte' : 'mocha');
	setTheme(theme);
	return theme;
}