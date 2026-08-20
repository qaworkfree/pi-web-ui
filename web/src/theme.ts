/**
 * Theme switching — the whole UI stylesheet is swapped for a complete
 * standalone CSS file served by the backend (/themes/<id>.css). Each theme is
 * a full copy of styles.css with a different palette (no variable extraction).
 *
 * The bundled default (dark) is always present; picking another theme injects
 * a <link rel="stylesheet"> whose file fully overrides it. Selecting the
 * default removes the link. Choice persists in localStorage per browser.
 */
import { useEffect, useState } from "react";

export interface ThemeInfo {
	id: string;
	name: string;
	builtin: boolean;
}

const STORAGE_KEY = "pi-web-ui:theme";
/** id of the bundled default theme (no extra link loaded). */
const DEFAULT_THEME_ID = "dark";
const LINK_ID = "theme-stylesheet";

export function loadTheme(): string | null {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved && saved !== DEFAULT_THEME_ID) return saved;
	} catch {
		// localStorage unavailable — fall through to the default.
	}
	return null;
}

export function saveTheme(id: string | null): void {
	try {
		if (id) localStorage.setItem(STORAGE_KEY, id);
		else localStorage.removeItem(STORAGE_KEY);
	} catch {
		// ignore storage errors
	}
}

/** Inject/replace the theme <link>. null = bundled default (dark). */
export function applyTheme(id: string | null): void {
	let link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
	if (!id) {
		link?.remove();
		return;
	}
	if (!link) {
		link = document.createElement("link");
		link.id = LINK_ID;
		link.rel = "stylesheet";
		document.head.appendChild(link);
	}
	link.href = `/themes/${encodeURIComponent(id)}.css`;
}

export async function fetchThemes(): Promise<ThemeInfo[]> {
	try {
		const res = await fetch("/api/themes");
		if (!res.ok) return [];
		const data = (await res.json()) as { themes?: ThemeInfo[] };
		return Array.isArray(data.themes) ? data.themes : [];
	} catch {
		return [];
	}
}

/** React hook: theme list + current selection + setter (persists + applies). */
export function useTheme() {
	const [themes, setThemes] = useState<ThemeInfo[]>([]);
	const [theme, setTheme] = useState<string | null>(() => loadTheme());

	useEffect(() => {
		let cancelled = false;
		fetchThemes().then((list) => {
			if (!cancelled) setThemes(list);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		applyTheme(theme);
		saveTheme(theme);
	}, [theme]);

	const switchTheme = (id: string | null) => setTheme(id === DEFAULT_THEME_ID ? null : id);

	return { themes, theme, switchTheme };
}