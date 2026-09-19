import { describe, expect, it } from "vitest";
import type { UiMessage } from "../../server/protocol.js";
import { stripTransientRetryErrors, serializeMessage } from "../../server/serialize.js";

function assistantError(id: string): UiMessage {
	return { id, role: "assistant", content: [], stopReason: "error", errorMessage: "500 overloaded" };
}

function assistantText(id: string): UiMessage {
	return { id, role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" };
}

function userText(id: string): UiMessage {
	return { id, role: "user", content: [{ type: "text", text: "q" }] };
}

describe("stripTransientRetryErrors", () => {
	it("未重试时原样返回（同一引用）", () => {
		const msgs = [userText("u"), assistantError("a")];
		expect(stripTransientRetryErrors(msgs, false)).toBe(msgs);
	});

	it("重试中去掉末尾连续的 error 气泡", () => {
		const msgs = [userText("u"), assistantText("a1"), assistantError("a2"), assistantError("a3")];
		const out = stripTransientRetryErrors(msgs, true);
		expect(out.map((m) => m.id)).toEqual(["u", "a1"]);
	});

	it("末尾不是 error 时不动", () => {
		const msgs = [assistantError("a1"), assistantText("a2")];
		const out = stripTransientRetryErrors(msgs, true);
		expect(out).toBe(msgs);
	});

	it("user/tool 消息截断剥离", () => {
		const tool: UiMessage = {
			id: "t-x",
			role: "toolResult",
			content: [{ type: "text", text: "boom" }],
			toolCallId: "x",
			isError: true,
		};
		const msgs = [assistantError("a1"), tool];
		expect(stripTransientRetryErrors(msgs, true)).toBe(msgs);
	});

	it("空数组安全", () => {
		expect(stripTransientRetryErrors([], true)).toEqual([]);
	});
});

describe("serializeMessage: toolResult 的 details", () => {
	const toolResult = (details?: unknown) =>
		({
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "present_files",
			content: [{ type: "text", text: "shown" }],
			details,
			isError: false,
			timestamp: 123,
		}) as unknown as Parameters<typeof serializeMessage>[0];

	it("details 原样下发（present_files 卡片的数据面）", () => {
		const details = { items: [{ path: "docs/a.png", abs: "E:/w/docs/a.png", kind: "image", size: 10 }] };
		expect(serializeMessage(toolResult(details), 0)?.details).toEqual(details);
	});

	it("没有 details 时不带该字段（老快照字节一致）", () => {
		expect(serializeMessage(toolResult(undefined), 0)).not.toHaveProperty("details");
	});

	it("超过体积闸门 → 整丢（不截断成不可解析的 JSON）", () => {
		const huge = { items: [{ excerpt: "x".repeat(70_000) }] };
		expect(serializeMessage(toolResult(huge), 0)?.details).toBeUndefined();
	});

	it("序列化不了的值（循环引用）也不炸", () => {
		const cyc: Record<string, unknown> = {};
		cyc.self = cyc;
		expect(serializeMessage(toolResult(cyc), 0)?.details).toBeUndefined();
	});
});
