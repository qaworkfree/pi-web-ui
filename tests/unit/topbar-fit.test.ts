import { describe, expect, it } from "vitest";
import { fitTopbar } from "../../web/src/topbar-fit.js";

/** 造一批等宽条目（宽度可变）——只关心「谁被丢」，不关心具体几何。 */
const items = (list: [string, number][]) => list.map(([id, width]) => ({ id, width }));

describe("fitTopbar", () => {
	const gap = 8;
	// 60 + 8 = 68 一个；可用 300、⋯ 占 40+8=48 → 预算 252 → 3 个（204）、第 4 个超。
	const five = items([
		["a", 60],
		["b", 60],
		["c", 60],
		["d", 60],
		["e", 60],
	]);

	it("全都放得下时不丢任何条目", () => {
		expect(fitTopbar(five, 1000, gap, 48).size).toBe(0);
		// 恰好放下（边界不算超）：5 个 = 5*68 = 340，预算 = 340 → 全保留
		expect(fitTopbar(five, 388, gap, 48).size).toBe(0);
	});

	it("放不下时从尾部丢，剩下的保持原相对顺序", () => {
		const drop = fitTopbar(five, 300, gap, 48);
		expect([...drop]).toEqual(["d", "e"]);
	});

	it("一旦开始丢，后续条目一律跟着丢（不抽空隙回填）", () => {
		// c 是宽条目放不下，但 d 很窄「塞得下」——仍然跟着丢（位置单调，不跳）。
		const rows = items([
			["a", 40],
			["b", 40],
			["c", 200],
			["d", 10],
		]);
		// 可用 200、⋯ 48 → 预算 152：a(48) + b(48) = 96 之后 c 需要 208 超预算
		expect([...fitTopbar(rows, 200, gap, 48)]).toEqual(["c", "d"]);
	});

	it("宽度为 0 的条目（CSS 藏起来的抽屉开关）既不占位也不进溢出", () => {
		// ☰/📁 在桌面端 offsetWidth = 0：5 个普通条目仍要全放得下，0 宽的也永远不丢。
		const rows = items([
			["host:history", 0],
			["a", 60],
			["b", 60],
			["host:files", 0],
			["c", 60],
		]);
		expect(fitTopbar(rows, 388, gap, 48).size).toBe(0);
		expect([...fitTopbar(rows, 208, gap, 48)]).toEqual(["c"]);
	});

	it("未测量（available ≤ 0 / NaN）时全保留，不清空顶栏", () => {
		expect(fitTopbar(five, 0, gap, 48).size).toBe(0);
		expect(fitTopbar(five, Number.NaN, gap, 48).size).toBe(0);
		// 预留比可用宽度还大（窄到连 ⋯ 都放不下）→ 预算 0，除 0 宽条目外全丢。
		expect([...fitTopbar(five, 20, gap, 48)]).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("⋯ 预留宽度影响结果（预留越大，越早开始丢）", () => {
		expect([...fitTopbar(five, 300, gap, 0)]).toEqual(["e"]);
		// 预算 100：只放得下 a（68），b 起全部退进溢出。
		expect([...fitTopbar(five, 300, gap, 200)]).toEqual(["b", "c", "d", "e"]);
	});
});
