// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { computeTextareaHeight, useAutoResizeTextarea } from "../../web/src/use-auto-resize-textarea.js";

let root: Root | null = null;

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("useAutoResizeTextarea & computeTextareaHeight", () => {
	it("computeTextareaHeight: 正常范围自适应，低于保底钳制，超出上限内滚", () => {
		// 正常范围
		const r1 = computeTextareaHeight(120, { minHeight: 40, maxHeight: 300 });
		expect(r1.height).toBe(120);
		expect(r1.overflowY).toBe("hidden");

		// 低于保底高度
		const r2 = computeTextareaHeight(20, { minHeight: 40, maxHeight: 300 });
		expect(r2.height).toBe(40);
		expect(r2.overflowY).toBe("hidden");

		// 超过最大上限
		const r3 = computeTextareaHeight(500, { minHeight: 40, maxHeight: 300 });
		expect(r3.height).toBe(300);
		expect(r3.overflowY).toBe("auto");
	});

	it("useAutoResizeTextarea: 在 DOM 上正确应用计算出的高度与 overflowY", () => {
		function TestComponent({ text }: { text: string }) {
			const ref = useRef<HTMLTextAreaElement>(null);
			useAutoResizeTextarea(ref, text, { minHeight: 40, maxHeight: 200 });

			return createElement("textarea", { ref, defaultValue: text });
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent, { text: "hello" }));
		});

		const ta = container.querySelector("textarea")!;
		// jsdom 中 scrollHeight 默认为 0，触发 minHeight 保底
		expect(ta.style.height).toBe("40px");
		expect(ta.style.overflowY).toBe("hidden");
	});
});
