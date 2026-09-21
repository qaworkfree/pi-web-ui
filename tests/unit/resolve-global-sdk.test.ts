/**
 * resolve-global-sdk 单测（issue #260）：
 * 「优先用全局/祖先那份 pi SDK」的选择逻辑 —— 只在 PI_WEB_SDK=global 时启用，
 * 且绝不降级（祖先那份必须 >= 自带那份），否则保持默认解析。
 */
import { describe, expect, it } from "vitest";
import { pickGlobalSdk } from "../../server/resolve-global-sdk.js";
import type { SdkCopy } from "../../server/sdk-origin.js";

const bundled: SdkCopy = { path: "/app/node_modules/pi-coding-agent/package.json", version: "0.85.1" };
const globalNewer: SdkCopy = { path: "/global/node_modules/pi-coding-agent/package.json", version: "0.86.1" };
const globalOlder: SdkCopy = { path: "/global/node_modules/pi-coding-agent/package.json", version: "0.84.0" };
const globalSame: SdkCopy = { path: "/global/node_modules/pi-coding-agent/package.json", version: "0.85.1" };

describe("pickGlobalSdk：默认不启用", () => {
	it("缺省 / bundled / 其它值 → 保持默认解析（自带副本）", () => {
		expect(pickGlobalSdk([bundled, globalNewer], undefined)).toBeNull();
		expect(pickGlobalSdk([bundled, globalNewer], "bundled")).toBeNull();
		expect(pickGlobalSdk([bundled, globalNewer], "")).toBeNull();
		expect(pickGlobalSdk([bundled, globalNewer], "auto")).toBeNull();
	});

	it("大小写与空白不敏感", () => {
		expect(pickGlobalSdk([bundled, globalNewer], " GLOBAL ")).toBe(globalNewer);
	});
});

describe("pickGlobalSdk：PI_WEB_SDK=global", () => {
	it("祖先那份更新 → 用它（这就是报告人想要的「升了全局就生效」）", () => {
		expect(pickGlobalSdk([bundled, globalNewer], "global")).toBe(globalNewer);
	});

	it("祖先那份更旧或同版本 → 不用（绝不降级）", () => {
		expect(pickGlobalSdk([bundled, globalOlder], "global")).toBeNull();
		expect(pickGlobalSdk([bundled, globalSame], "global")).toBeNull();
	});

	it("没有祖先副本（独立安装 / 桌面版 / 没装全局 pi CLI）→ 回落自带", () => {
		expect(pickGlobalSdk([bundled], "global")).toBeNull();
		expect(pickGlobalSdk([], "global")).toBeNull();
	});

	it("多份祖先副本 → 取解析顺序上最近的那份合格者", () => {
		const near: SdkCopy = { path: "/near/package.json", version: "0.86.0" };
		const far: SdkCopy = { path: "/far/package.json", version: "0.86.1" };
		expect(pickGlobalSdk([bundled, near, far], "global")).toBe(near);
	});

	it("最近的那份不合格时继续往外找", () => {
		const nearOlder: SdkCopy = { path: "/near/package.json", version: "0.80.0" };
		expect(pickGlobalSdk([bundled, nearOlder, globalNewer], "global")).toBe(globalNewer);
	});

	it("一份副本都没有（copies 为空）时不抛错", () => {
		expect(pickGlobalSdk([], "global")).toBeNull();
	});
});
