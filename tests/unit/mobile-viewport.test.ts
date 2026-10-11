// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installMobileViewport } from "../../web/src/mobile-viewport.js";

const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
let cleanup = () => {};
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	if (original) Object.defineProperty(window, "visualViewport", original);
	else Reflect.deleteProperty(window, "visualViewport");
	document.documentElement.removeAttribute("style");
});

function fixture() {
	const viewport = Object.assign(new EventTarget(), { height: 500, offsetTop: 100, scale: 1 });
	Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
	const pending: FrameRequestCallback[] = [];
	vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
		pending.push(callback);
		return pending.length;
	});
	const flush = () => {
		for (const callback of pending.splice(0)) callback(0);
	};
	cleanup = installMobileViewport();
	return { viewport, flush, pending };
}

it("tracks keyboard height and Safari's visual viewport offset", () => {
	fixture();
	const style = document.documentElement.style;
	expect(style.getPropertyValue("--mobile-viewport-height")).toBe("500px");
	expect(document.documentElement.classList.contains("mobile-viewport-compact")).toBe(true);
	expect(style.getPropertyValue("--mobile-viewport-top")).toBe("100px");
	expect(style.getPropertyValue("--mobile-viewport-bottom")).toBe(`${Math.max(0, innerHeight - 600)}px`);
});

it("coalesces resize/scroll notifications and restores the height after dismissal", () => {
	const { viewport, flush, pending } = fixture();
	viewport.height = 700;
	viewport.offsetTop = 0;
	viewport.dispatchEvent(new Event("resize"));
	viewport.dispatchEvent(new Event("scroll"));
	expect(pending.length).toBe(1);
	flush();
	expect(document.documentElement.style.getPropertyValue("--mobile-viewport-height")).toBe("700px");
	expect(document.documentElement.style.getPropertyValue("--mobile-viewport-top")).toBe("0px");
	expect(document.documentElement.classList.contains("mobile-viewport-compact")).toBe(false);
});

it("leaves the layout stable when the user pinch-zooms", () => {
	const { viewport, flush } = fixture();
	viewport.scale = 2;
	viewport.height = 250;
	viewport.dispatchEvent(new Event("resize"));
	flush();
	expect(document.documentElement.style.getPropertyValue("--mobile-viewport-height")).toBe("500px");
});

it("falls back to window dimensions without VisualViewport", () => {
	Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
	cleanup = installMobileViewport();
	expect(document.documentElement.style.getPropertyValue("--mobile-viewport-height")).toBe(`${innerHeight}px`);
});

it("removes its event listeners on cleanup", () => {
	const { viewport, pending } = fixture();
	cleanup();
	expect(document.documentElement.classList.contains("mobile-viewport-compact")).toBe(false);
	viewport.dispatchEvent(new Event("resize"));
	window.dispatchEvent(new Event("resize"));
	expect(pending).toHaveLength(0);
});
