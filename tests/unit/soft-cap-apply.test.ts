import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { DEFAULT_COMPACTION_RESERVE_TOKENS } from "../../server/soft-cap.js";

/** 不起 server：伪造 settingsSvc + convs，直接调原型方法验覆盖逻辑。 */
function serviceWith(settings: { softCapTokens: number; softCapByModel: Record<string, number> }, sessions: unknown[]) {
	const convs = new Map(sessions.map((s, i) => [`c${i}`, { session: s }]));
	return { settingsSvc: { current: settings }, convs };
}

function fakeSession(model: { provider: string; id: string } | null, window: number) {
	const applyOverrides = vi.fn();
	return {
		model,
		getSessionStats: () => ({ contextUsage: { tokens: 1000, contextWindow: window, percent: 1 } }),
		settingsManager: { applyOverrides },
		_captured: applyOverrides,
	};
}

describe("applyCompactionOverrides", () => {
	it("全局软上限 → reserve = window - cap", () => {
		const s = fakeSession({ provider: "xai", id: "grok-4" }, 500000);
		const svc = serviceWith({ softCapTokens: 190000, softCapByModel: {} }, [s]);
		ClientSession.prototype.applyCompactionOverrides.call(svc);
		expect(s._captured).toHaveBeenCalledWith({ compaction: { reserveTokens: 310000 } });
	});
	it("按模型覆盖优先于全局", () => {
		const s = fakeSession({ provider: "xai", id: "grok-4" }, 500000);
		const svc = serviceWith({ softCapTokens: 400000, softCapByModel: { "xai/grok-4": 190000 } }, [s]);
		ClientSession.prototype.applyCompactionOverrides.call(svc);
		expect(s._captured).toHaveBeenCalledWith({ compaction: { reserveTokens: 310000 } });
	});
	it("关闭时回填 SDK 默认（旧覆盖不泄漏）", () => {
		const s = fakeSession({ provider: "a", id: "b" }, 200000);
		const svc = serviceWith({ softCapTokens: 0, softCapByModel: {} }, [s]);
		ClientSession.prototype.applyCompactionOverrides.call(svc);
		expect(s._captured).toHaveBeenCalledWith({ compaction: { reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS } });
	});
	it("cap 非法（太接近上限）→ 回填默认", () => {
		const s = fakeSession({ provider: "a", id: "b" }, 200000);
		const svc = serviceWith({ softCapTokens: 199500, softCapByModel: {} }, [s]);
		ClientSession.prototype.applyCompactionOverrides.call(svc);
		expect(s._captured).toHaveBeenCalledWith({ compaction: { reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS } });
	});
	it("未就绪会话抛错不连累其他会话", () => {
		const bad = {
			model: { provider: "a", id: "b" },
			getSessionStats: () => {
				throw new Error("not ready");
			},
			settingsManager: {
				applyOverrides: () => {
					throw new Error("gone");
				},
			},
		};
		const good = fakeSession({ provider: "a", id: "b" }, 200000);
		const svc = serviceWith({ softCapTokens: 100000, softCapByModel: {} }, [bad, good]);
		expect(() => ClientSession.prototype.applyCompactionOverrides.call(svc)).not.toThrow();
		expect(good._captured).toHaveBeenCalledWith({ compaction: { reserveTokens: 100000 } });
	});
});

describe("activeSoftCap", () => {
	it("合法返回 cap，非法/关闭返回 null", () => {
		const cap = (
			settings: { softCapTokens: number; softCapByModel: Record<string, number> },
			model: unknown,
			window: number,
		) =>
			ClientSession.prototype.activeSoftCap.call(
				{
					settingsSvc: { current: settings },
					session: { model },
				},
				window,
			);
		expect(cap({ softCapTokens: 190000, softCapByModel: {} }, { provider: "xai", id: "grok-4" }, 500000)).toBe(190000);
		expect(cap({ softCapTokens: 0, softCapByModel: {} }, { provider: "xai", id: "grok-4" }, 500000)).toBeNull();
		expect(cap({ softCapTokens: 199500, softCapByModel: {} }, { provider: "a", id: "b" }, 200000)).toBeNull();
	});
});
