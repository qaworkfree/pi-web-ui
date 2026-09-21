// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { isNearBottom, useAutoScroll } from "../../web/src/use-auto-scroll.js";

let root: Root | null = null;

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

/** jsdom 的 scrollHeight/clientHeight 只读，用 defineProperty 注入指标。 */
function mockMetrics(el: HTMLElement, metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
	Object.defineProperty(el, "scrollTop", { value: metrics.scrollTop, writable: true, configurable: true });
	Object.defineProperty(el, "scrollHeight", { value: metrics.scrollHeight, configurable: true });
	Object.defineProperty(el, "clientHeight", { value: metrics.clientHeight, configurable: true });
}

describe("useAutoScroll & isNearBottom", () => {
	it("isNearBottom: 阈值边界判定", () => {
		// scrollHeight(1000) - scrollTop(900) - clientHeight(100) = 0 → 贴底
		expect(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }, 80)).toBe(true);
		// 差值 80 → 等于阈值算贴底
		expect(isNearBottom({ scrollTop: 820, scrollHeight: 1000, clientHeight: 100 }, 80)).toBe(true);
		// 差值 81 → 超出阈值
		expect(isNearBottom({ scrollTop: 819, scrollHeight: 1000, clientHeight: 100 }, 80)).toBe(false);
	});

	it("初始状态为吸底；scrollToBottom 重置到底部", () => {
		let hook: ReturnType<typeof useAutoScroll> | null = null;

		function TestComponent() {
			hook = useAutoScroll();
			return createElement("div", { ref: hook.scrollRef, className: "scroller" });
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		expect(hook!.isPinned).toBe(true);

		const el = container.querySelector(".scroller") as HTMLElement;
		mockMetrics(el, { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });

		act(() => {
			hook!.scrollToBottom();
		});

		expect(el.scrollTop).toBe(1000);
		expect(hook!.isPinned).toBe(true);
	});

	it("用户上滚（scrollHeight 不变）→ 逃逸，isPinned 变 false", () => {
		let hook: ReturnType<typeof useAutoScroll> | null = null;

		function TestComponent() {
			hook = useAutoScroll({ graceMs: 0 });
			return createElement("div", { ref: hook.scrollRef, className: "scroller" });
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		const el = container.querySelector(".scroller") as HTMLElement;
		// 初始贴底：scrollTop=800, height=1000, view=200
		mockMetrics(el, { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 });
		act(() => {
			hook!.onScroll();
		});
		expect(hook!.isPinned).toBe(true);

		// 用户上滚 100px：scrollTop 800→700，内容高度不变
		mockMetrics(el, { scrollTop: 700, scrollHeight: 1000, clientHeight: 200 });
		act(() => {
			hook!.onScroll();
		});
		expect(hook!.isPinned).toBe(false);

		// 用户滚回底部附近 → 恢复吸底
		mockMetrics(el, { scrollTop: 790, scrollHeight: 1000, clientHeight: 200 });
		act(() => {
			hook!.onScroll();
		});
		expect(hook!.isPinned).toBe(true);
	});
});
