// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { useLatestAsync } from "../../web/src/use-latest-async.js";

let root: Root | null = null;

afterEach(() => {
	vi.useRealTimers();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("useLatestAsync", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("慢请求被后发出的快请求淘汰，绝不覆盖最新结果（时序竞态消除）", async () => {
		let hook: ReturnType<typeof useLatestAsync<[string, number], string>> | null = null;

		// 模拟可变延迟的异步请求
		const asyncFn = vi.fn((query: string, delay: number) => {
			return new Promise<string>((resolve) => {
				setTimeout(() => {
					resolve(`result for ${query}`);
				}, delay);
			});
		});

		function TestComponent() {
			hook = useLatestAsync(asyncFn);
			return null;
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		// 第一次发出：查询 "first"，耗时 300ms
		act(() => {
			hook!.run("first", 300);
		});

		// 第二次紧接着发出：查询 "second"，耗时 100ms（更快的请求）
		act(() => {
			hook!.run("second", 100);
		});

		// 时间推移 100ms："second" 请求先完成
		await act(async () => {
			vi.advanceTimersByTime(100);
		});
		expect(hook!.data).toBe("result for second");

		// 时间继续推移 200ms（总计 300ms）："first" 慢请求完成
		await act(async () => {
			vi.advanceTimersByTime(200);
		});

		// 慢请求已被淘汰，数据依然保持为 "result for second"！
		expect(hook!.data).toBe("result for second");
	});

	it("支持 debounceMs 防抖，多次快速调用只触发最后一次", async () => {
		const asyncFn = vi.fn((query: string) => Promise.resolve(`data:${query}`));
		let hook: ReturnType<typeof useLatestAsync<[string], string>> | null = null;

		function TestComponent() {
			hook = useLatestAsync(asyncFn, { debounceMs: 200 });
			return null;
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		// 快速连续调用
		act(() => {
			hook!.run("a");
			hook!.run("ab");
			hook!.run("abc");
		});

		expect(asyncFn).not.toHaveBeenCalled();

		// 时间推移 200ms 防抖完成
		await act(async () => {
			vi.advanceTimersByTime(200);
		});

		expect(asyncFn).toHaveBeenCalledTimes(1);
		expect(asyncFn).toHaveBeenCalledWith("abc");
		expect(hook!.data).toBe("data:abc");
	});

	it("cancel() 能立即取消 pending 请求", async () => {
		const asyncFn = vi.fn((query: string) => new Promise((resolve) => setTimeout(() => resolve(query), 500)));
		let hook: ReturnType<typeof useLatestAsync<[string], unknown>> | null = null;

		function TestComponent() {
			hook = useLatestAsync(asyncFn);
			return null;
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		act(() => {
			hook!.run("never-lands");
		});
		expect(hook!.loading).toBe(true);

		act(() => {
			hook!.cancel();
		});
		expect(hook!.loading).toBe(false);

		// 时钟走完 500ms
		await act(async () => {
			vi.advanceTimersByTime(500);
		});

		// 状态不被写入
		expect(hook!.data).toBeUndefined();
	});
});
