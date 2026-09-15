/**
 * 桌面壳检测单测（`web/src/desktop.ts` 的 isDesktopShell）。
 *
 * 传参即判定，不碰全局 window —— 单测里不需要 jsdom。
 */
import { describe, expect, it } from "vitest";
import { isDesktopShell } from "../../web/src/desktop.js";

describe("isDesktopShell", () => {
	it("preload 标记在就认（主判定）", () => {
		expect(isDesktopShell({ piDesktop: { isDesktop: true } })).toBe(true);
	});

	it("标记不是 true 不认", () => {
		expect(isDesktopShell({ piDesktop: { isDesktop: false } })).toBe(false);
		expect(isDesktopShell({ piDesktop: {} })).toBe(false);
		expect(isDesktopShell({})).toBe(false);
	});

	it("没 preload 时 UA 带 Electron/ 兜底", () => {
		expect(isDesktopShell({ navigator: { userAgent: "Mozilla/5.0 Electron/44.0.0 Chrome/153 Safari/537.36" } })).toBe(
			true,
		);
		expect(
			isDesktopShell({
				navigator: { userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/153 Safari/537.36" },
			}),
		).toBe(false);
	});

	it("空输入不抛错", () => {
		expect(isDesktopShell(undefined)).toBe(false);
		expect(isDesktopShell(null)).toBe(false);
	});
});
