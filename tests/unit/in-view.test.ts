// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { useInView } from "../../web/src/use-in-view.js";

let root: Root | null = null;

afterEach(() => {
	vi.unstubAllGlobals();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("useInView", () => {
	it("无 IntersectionObserver 环境直接回退可见（SSR / 旧浏览器不空白）", () => {
		vi.stubGlobal("IntersectionObserver", undefined);

		let result = false;

		function TestComponent() {
			const { ref, inView } = useInView();
			result = inView;
			return createElement("div", { ref });
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		expect(result).toBe(true);
	});

	it("进入视口后置 true；once 语义下自动 disconnect", () => {
		let observed: Element | null = null;
		let disconnectCalls = 0;
		let trigger: ((isIntersecting: boolean) => void) | null = null;

		class MockObserver {
			callback: IntersectionObserverCallback;
			constructor(cb: IntersectionObserverCallback) {
				this.callback = cb;
			}
			observe(el: Element) {
				observed = el;
				trigger = (isIntersecting: boolean) => {
					this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
				};
			}
			disconnect() {
				disconnectCalls++;
			}
			unobserve() {}
		}
		vi.stubGlobal("IntersectionObserver", MockObserver);

		let result = false;

		function TestComponent() {
			const { ref, inView } = useInView({ once: true });
			result = inView;
			return createElement("div", { ref });
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		expect(observed).not.toBeNull();
		expect(result).toBe(false);

		act(() => {
			trigger!(true);
		});

		expect(result).toBe(true);
		expect(disconnectCalls).toBeGreaterThanOrEqual(1);
	});

	it("once=false 时离开视口回落 false", () => {
		let trigger: ((isIntersecting: boolean) => void) | null = null;

		class MockObserver {
			callback: IntersectionObserverCallback;
			constructor(cb: IntersectionObserverCallback) {
				this.callback = cb;
			}
			observe() {
				trigger = (isIntersecting: boolean) => {
					this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
				};
			}
			disconnect() {}
			unobserve() {}
		}
		vi.stubGlobal("IntersectionObserver", MockObserver);

		let result = false;

		function TestComponent() {
			const { ref, inView } = useInView({ once: false });
			result = inView;
			return createElement("div", { ref });
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		act(() => {
			trigger!(true);
		});
		expect(result).toBe(true);

		act(() => {
			trigger!(false);
		});
		expect(result).toBe(false);
	});
});
