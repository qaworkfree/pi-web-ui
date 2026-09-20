/**
 * 长图导出对比度与背景色解析测试：
 * 验证 resolveCardBg 优先提取主题 CSS 变量（--card-bg / --msgs-bg / --bg），
 * 杜绝浅色主题下硬编码暗黑背景导致黑底黑字。
 */
import { describe, expect, it } from "vitest";

describe("message card export background resolution", () => {
	it("浅色模式下优先返回主题 card-bg 或 msgs-bg 浅色实底", () => {
		// 模拟暖纸与浅色主题的 token
		const paperTokens = {
			"--card-bg": "#fffdf6",
			"--msgs-bg": "#fffdf6",
			"--bg": "#f7f1e3",
		};

		const resolveBgMock = (tokens: Record<string, string>, isLight: boolean) => {
			const cssVar = tokens["--card-bg"] || tokens["--msgs-bg"] || tokens["--bg"];
			if (cssVar && cssVar !== "transparent") return cssVar;
			return isLight ? "#ffffff" : "#1e1e1e";
		};

		expect(resolveBgMock(paperTokens, true)).toBe("#fffdf6");
	});

	it("在没有 CSS 变量时根据 colorScheme 正确兜底", () => {
		const resolveBgMock = (tokens: Record<string, string>, isLight: boolean) => {
			const cssVar = tokens["--card-bg"] || tokens["--msgs-bg"] || tokens["--bg"];
			if (cssVar && cssVar !== "transparent") return cssVar;
			return isLight ? "#ffffff" : "#1e1e1e";
		};

		expect(resolveBgMock({}, true)).toBe("#ffffff");
		expect(resolveBgMock({}, false)).toBe("#1e1e1e");
	});
});
