import { describe, expect, it } from "vitest";
import { QUICK_PHRASE_DEFAULTS, addSeeded, parseSeeded } from "../../web/src/quick-phrases.js";

describe("QUICK_PHRASE_DEFAULTS", () => {
	it("中英各有一套非空默认值，且符合服务端归一化约束", () => {
		for (const locale of ["zh", "en"] as const) {
			const list = QUICK_PHRASE_DEFAULTS[locale];
			expect(list.length).toBeGreaterThan(0);
			expect(list.length).toBeLessThanOrEqual(30);
			for (const p of list) {
				expect(p.trim()).toBe(p);
				expect(p.length).toBeGreaterThan(0);
				expect(p.length).toBeLessThanOrEqual(200);
			}
			expect(new Set(list).size).toBe(list.length);
		}
	});
});

describe("parseSeeded", () => {
	it("空/坏数据 → []", () => {
		expect(parseSeeded(null)).toEqual([]);
		expect(parseSeeded("")).toEqual([]);
		expect(parseSeeded("not-json")).toEqual([]);
		expect(parseSeeded("{}")).toEqual([]);
		expect(parseSeeded("[1,2]")).toEqual([]);
	});

	it("正常数组透传（只留字符串）", () => {
		expect(parseSeeded('["a","b"]')).toEqual(["a", "b"]);
		expect(parseSeeded('["a",1,null]')).toEqual(["a"]);
	});
});

describe("addSeeded", () => {
	it("追加去重 + 截尾封顶", () => {
		expect(addSeeded([], "c1")).toEqual(["c1"]);
		expect(addSeeded(["c1", "c2"], "c1")).toEqual(["c2", "c1"]);
		const many = Array.from({ length: 25 }, (_, i) => `c${i}`);
		const next = addSeeded(many, "new");
		expect(next.length).toBe(20);
		expect(next.at(-1)).toBe("new");
		expect(next[0]).toBe("c6");
	});
});
