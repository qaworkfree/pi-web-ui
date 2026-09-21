// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { readLocalStorage, useLocalStorage, writeLocalStorage } from "../../web/src/use-local-storage.js";

let root: Root | null = null;

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	localStorage.clear();
});

describe("useLocalStorage & helpers", () => {
	it("readLocalStorage: 正常读取、默认值回退、非法脏数据回退", () => {
		expect(readLocalStorage("non-existent", 42)).toBe(42);

		writeLocalStorage("valid-num", 100);
		expect(readLocalStorage("valid-num", 0)).toBe(100);

		// 存入脏数据
		localStorage.setItem("corrupted-obj", "not-a-json{");
		expect(readLocalStorage("corrupted-obj", { safe: true })).toBe("not-a-json{");

		// 带 validator 过滤
		const isNumber = (v: unknown): v is number => typeof v === "number";
		localStorage.setItem("type-mismatch", JSON.stringify("hello"));
		expect(readLocalStorage("type-mismatch", 999, isNumber)).toBe(999);
	});

	it("useLocalStorage: 状态读取与写入同步到 localStorage", () => {
		let hookState: [string, (v: string | ((p: string) => string)) => void, () => void] | null = null;

		function TestComponent() {
			hookState = useLocalStorage<string>("test-key", "default-val");
			return createElement("div", null, hookState[0]);
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement(TestComponent));
		});

		expect(hookState![0]).toBe("default-val");

		// 更新状态
		act(() => {
			hookState![1]("updated-val");
		});

		expect(hookState![0]).toBe("updated-val");
		expect(readLocalStorage("test-key", "")).toBe("updated-val");

		// 删除状态
		act(() => {
			hookState![2]();
		});

		expect(hookState![0]).toBe("default-val");
		expect(localStorage.getItem("test-key")).toBeNull();
	});

	it("同页面多实例广播同步：实例 A 更新，实例 B 自动同步", () => {
		let stateA: string | undefined;
		let setA: ((v: string) => void) | undefined;
		let stateB: string | undefined;

		function ComponentA() {
			const [val, setVal] = useLocalStorage("shared-key", "init");
			stateA = val;
			setA = setVal;
			return null;
		}

		function ComponentB() {
			const [val] = useLocalStorage("shared-key", "init");
			stateB = val;
			return null;
		}

		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		act(() => {
			root!.render(createElement("div", null, createElement(ComponentA), createElement(ComponentB)));
		});

		expect(stateA).toBe("init");
		expect(stateB).toBe("init");

		// 实例 A 触发更新
		act(() => {
			setA!("synced-value");
		});

		// 实例 A 和 实例 B 均同步到新值
		expect(stateA).toBe("synced-value");
		expect(stateB).toBe("synced-value");
	});
});
