/**
 * 桌面壳（Electron）检测。
 *
 * `desktop/preload.ts` 经 contextBridge 在主世界挂了 `window.piDesktop = { isDesktop: true, … }`，
 * 这是主判定；UA 里带 `Electron/` 当兜底（preload 未来改名也不至于全瞎）。
 *
 * 参数注水（`win?`）是为了单测：浏览器里直接调 `isDesktopShell()` 读全局 window 即可。
 */
export interface DesktopShellWindow {
	piDesktop?: { isDesktop?: unknown; updater?: unknown };
	navigator?: { userAgent?: unknown };
}

export function isDesktopShell(win?: unknown): boolean {
	const w =
		(win as DesktopShellWindow | undefined) ??
		(typeof window === "undefined" ? undefined : (window as unknown as DesktopShellWindow));
	if (!w) return false;
	if (w.piDesktop?.isDesktop === true) return true;
	const ua = w.navigator?.userAgent;
	return typeof ua === "string" && ua.includes("Electron/");
}
