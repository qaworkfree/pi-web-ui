// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { useDebouncedCallback, useDebouncedValue } from "../../web/src/use-debounce.js";

let root: Root | null = null;

afterEach(() => {
	vi.useRealTimers();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("useDebouncedValue & useDebouncedCallback", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("useDebouncedValue: 延迟到期后更新，快速连续输入只生效最后一次", () => {
		let currentDebounced = "";
		let updateInput: ((val: string) => void) | null = null;

		function TestComponent() {
			const [input, setInput] = useState("initial");
			updateInput = setInput;
			const debounced = useDebouncedValue(input, 300);
			currentDebounced = debounced;
			return null;
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		expect(currentDebounced).toBe("initial");

		// 触发输入变更
		act(() => {
			updateInput!("search-1");
		});
		// 尚未到期
		expect(currentDebounced).toBe("initial");

		// 紧接着再次变更
		act(() => {
			vi.advanceTimersByTime(100);
			updateInput!("search-2");
		});
		expect(currentDebounced).toBe("initial");

		// 推进 300ms 完成防抖
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(currentDebounced).toBe("search-2");
	});

	it("useDebouncedCallback: 延迟到期后执行最新回调", () => {
		const targetFn = vi.fn();
		let trigger: ((val: string) => void) | null = null;

		function TestComponent() {
			trigger = useDebouncedCallback(targetFn, 200);
			return null;
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		act(() => {
			trigger!("a");
			trigger!("b");
			trigger!("c");
		});

		expect(targetFn).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(200);
		});

		expect(targetFn).toHaveBeenCalledTimes(1);
		expect(targetFn).toHaveBeenCalledWith("c");
	});
});
