export type Theme = 'mocha' | 'latte';

const STORAGE_KEY = 'clue-theme';

export function setTheme(t: Theme): void {
	document.documentElement.dataset.theme = t;
	localStorage.setItem(STORAGE_KEY, t);
}

export function initTheme(): Theme {
	const saved = localStorage.getItem(STORAGE_KEY) as Theme | null;
	const prefersLight =
		window.matchMedia('(prefers-color-scheme: light)').matches;
	const theme: Theme = saved ?? (prefersLight ? 'latte' : 'mocha');
	setTheme(theme);
	return theme;
}