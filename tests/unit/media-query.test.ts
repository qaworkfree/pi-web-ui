// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { useMediaQuery } from "../../web/src/use-media-query.js";

let root: Root | null = null;

afterEach(() => {
	vi.unstubAllGlobals();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("useMediaQuery", () => {
	it("matchMedia 命中时返回 true，未命中返回 false", () => {
		let currentMatches = false;
		const listeners = new Set<(e: { matches: boolean }) => void>();

		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: currentMatches,
			media: query,
			addEventListener: (_type: string, cb: (e: { matches: boolean }) => void) => {
				listeners.add(cb);
			},
			removeEventListener: (_type: string, cb: (e: { matches: boolean }) => void) => {
				listeners.delete(cb);
			},
		}));

		let result = false;

		function TestComponent() {
			result = useMediaQuery("(max-width: 768px)");
			return createElement("div", null, result ? "mobile" : "desktop");
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		expect(result).toBe(false);

		// 模拟屏幕尺寸变化，触发 change 事件
		act(() => {
			currentMatches = true;
			for (const cb of listeners) {
				cb({ matches: true });
			}
		});

		expect(result).toBe(true);
	});
});
