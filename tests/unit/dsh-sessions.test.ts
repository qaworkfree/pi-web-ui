/** sessionLogPreset 单测：回放定预设（selected 事件 > header > null）。纯函数。 */
import { describe, expect, it } from "vitest";
import { sessionLogPreset } from "../../server/dsh/dsh-sessions";
import type { SessionLog } from "../../server/dsh/dsh-sessions";

const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, seq: 1, time: 1, data });

describe("sessionLogPreset", () => {
	it("无记录 → null", () => {
		expect(sessionLogPreset({ header: null, events: [] })).toBeNull();
		expect(sessionLogPreset({ header: {}, events: [ev("user/message")] })).toBeNull();
	});
	it("header 记录", () => {
		const log: SessionLog = { header: { agentPreset: "standard" }, events: [] };
		expect(sessionLogPreset(log)).toBe("standard");
	});
	it("selected 事件优先于 header，取最后一条", () => {
		const log: SessionLog = {
			header: { agentPreset: "standard" },
			events: [
				ev("agent-preset/selected", { agentPreset: "minimal" }),
				ev("agent-preset/selected", { agentPreset: "ptc" }),
			],
		};
		expect(sessionLogPreset(log)).toBe("ptc");
	});
	it("脏数据宽容（空串/非字符串忽略）", () => {
		const log: SessionLog = {
			header: { agentPreset: "" },
			events: [ev("agent-preset/selected", { agentPreset: 42 }), ev("user/message")],
		};
		expect(sessionLogPreset(log)).toBeNull();
	});
});
