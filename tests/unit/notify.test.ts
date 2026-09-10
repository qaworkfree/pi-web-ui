/**
 * 桌面通知纯函数单测（web/src/notify.ts）。
 *
 * 重点锁「抑制条件」：只有「窗口有焦点 且 页面可见」才吞掉通知。
 * 只判 hasFocus 的旧逻辑在 Windows 上会踩坑 —— 最小化时 Chromium 可能仍
 * 报 hasFocus()===true，于是通知在本该提醒的时候全部静默（见函数注释）。
 */
import { describe, expect, it } from "vitest";
import {
	isWindowsPlatform,
	notifyBlockReason,
	notificationsSupported,
	shouldSuppressNotify,
} from "../../web/src/notify.js";

describe("shouldSuppressNotify", () => {
	it("只看焦点会误杀：最小化（hidden）时即使 hasFocus 为 true 也要通知", () => {
		// Windows 上的关键回归：窗口最小化但仍报 hasFocus === true。
		expect(shouldSuppressNotify(true, "hidden")).toBe(false);
	});

	it("页面可见 + 有焦点 = 用户正在看，吞掉通知（改由提示音负责）", () => {
		expect(shouldSuppressNotify(true, "visible")).toBe(true);
	});

	it("失去焦点（切到别的应用）→ 通知", () => {
		expect(shouldSuppressNotify(false, "visible")).toBe(false);
	});

	it("后台标签页（不可见且无焦点）→ 通知", () => {
		expect(shouldSuppressNotify(false, "hidden")).toBe(false);
	});

	it("未知/缺失的可见性状态按「不可见」处理（宁可多提醒也不静默）", () => {
		expect(shouldSuppressNotify(true, "prerender")).toBe(false);
		expect(shouldSuppressNotify(true, "")).toBe(false);
	});
});

describe("notifyBlockReason", () => {
	it("非浏览器环境（无 window）→ 判为不支持，而不是安全上下文问题", () => {
		// node 单测环境没有 window / Notification。
		expect(notificationsSupported()).toBe(false);
		expect(notifyBlockReason()).toBe("unsupported");
	});
});

describe("isWindowsPlatform", () => {
	it("node 环境无 navigator → false（不误报平台提示）", () => {
		expect(isWindowsPlatform()).toBe(false);
	});
});
