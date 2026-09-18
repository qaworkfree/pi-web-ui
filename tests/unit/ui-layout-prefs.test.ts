/** normalizeUiLayout（server/client-state.ts）单测。
 *
 * 锁一条曾经真实发生的回归：归一化只保留 hidden/shown/order/groups/labels，
 * 把 `align` 整段丢掉 —— 布局页改对齐当时看着生效（本地 state），下一次快照
 * 回来就被洗掉（issue：所有 align 都无法修改）。align 是 UiLayoutPrefs 的一等
 * 字段（见 server/protocol.ts），归一化只做校验（start/center/end），不剪枝。
 */
import { describe, expect, it } from "vitest";
import { normalizeUiLayout } from "../../server/client-state.js";

describe("normalizeUiLayout", () => {
	it("保留合法的 align（start/center/end）", () => {
		expect(normalizeUiLayout({ align: { "host:cwd": "end", "host:cost": "center" } })).toEqual({
			align: { "host:cwd": "end", "host:cost": "center" },
		});
	});

	it("脏 align 值丢弃（不污染合并结果），全脏时不留空对象", () => {
		expect(normalizeUiLayout({ align: { a: "middle", b: 1, c: "" } })).toEqual({});
		expect(normalizeUiLayout({ hidden: ["host:chat"], align: { "host:cwd": "end", x: "nope" } })).toEqual({
			hidden: ["host:chat"],
			align: { "host:cwd": "end" },
		});
	});

	it("与其他字段共存（存盘→读回不丢对齐）", () => {
		const prefs = {
			hidden: ["host:sound"],
			shown: ["host:chat"],
			order: ["host:github", "host:chat"],
			groups: { "host:chat": "g" },
			align: { "host:cwd": "start" },
			labels: { "host:chat": "聊天" },
		};
		expect(normalizeUiLayout(prefs)).toEqual(prefs);
	});

	it("非对象/数组输入回落空对象（旧行为不变）", () => {
		expect(normalizeUiLayout(undefined)).toEqual({});
		expect(normalizeUiLayout([])).toEqual({});
		expect(normalizeUiLayout({ align: [] })).toEqual({});
	});
});
