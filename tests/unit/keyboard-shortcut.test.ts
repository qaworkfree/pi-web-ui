// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { matchShortcut, parseShortcut, useKeyboardShortcut } from "../../web/src/use-keyboard-shortcut.js";

let root: Root | null = null;

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("useKeyboardShortcut & pure helpers", () => {
	it("parseShortcut: 正确解析包含 mod、ctrl、shift、alt 及主键的组合", () => {
		const s1 = parseShortcut("mod+k");
		expect(s1.mod).toBe(true);
		expect(s1.key).toBe("k");
		expect(s1.shift).toBe(false);

		const s2 = parseShortcut("ctrl+shift+p");
		expect(s2.ctrl).toBe(true);
		expect(s2.shift).toBe(true);
		expect(s2.key).toBe("p");
		expect(s2.mod).toBe(false);

		const s3 = parseShortcut("Escape");
		expect(s3.key).toBe("escape");
		expect(s3.mod).toBe(false);
	});

	it("matchShortcut: 跨平台 mod 适配", () => {
		const def = parseShortcut("mod+k");

		// Mac 环境：metaKey 应匹配
		const macEvent = new KeyboardEvent("keydown", { key: "k", metaKey: true });
		expect(matchShortcut(macEvent, def, true)).toBe(true);
		expect(matchShortcut(macEvent, def, false)).toBe(false);

		// Win/Linux 环境：ctrlKey 应匹配
		const winEvent = new KeyboardEvent("keydown", { key: "k", ctrlKey: true });
		expect(matchShortcut(winEvent, def, false)).toBe(true);
		expect(matchShortcut(winEvent, def, true)).toBe(false);
	});

	it("useKeyboardShortcut: 默认在普通元素上触发，在 input/textarea 打字时自动过滤", () => {
		const callback = vi.fn();

		function TestComponent() {
			useKeyboardShortcut("mod+k", callback);
			return createElement(
				"div",
				null,
				createElement("input", { type: "text", className: "test-input" }),
				createElement("div", { className: "test-div" }),
			);
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		const inputEl = container.querySelector(".test-input")!;
		const divEl = container.querySelector(".test-div")!;

		// 在普通元素上按快捷键 -> 触发
		act(() => {
			divEl.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
		});
		expect(callback).toHaveBeenCalledTimes(1);

		// 在输入框中打字按快捷键 -> 默认过滤，不触发
		act(() => {
			inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
		});
		expect(callback).toHaveBeenCalledTimes(1);
	});
});
