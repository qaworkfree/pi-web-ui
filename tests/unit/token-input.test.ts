import { describe, expect, it } from "vitest";
import { formatTokenDraft, parseTokenInput } from "../../web/src/token-input.js";

describe("parseTokenInput", () => {
	it("空/0/负数/非法 = 0", () => {
		expect(parseTokenInput("")).toBe(0);
		expect(parseTokenInput(null)).toBe(0);
		expect(parseTokenInput(undefined)).toBe(0);
		expect(parseTokenInput(0)).toBe(0);
		expect(parseTokenInput(-10)).toBe(0);
		expect(parseTokenInput("abc")).toBe(0);
	});

	it("支持 k/m 后缀与大小写", () => {
		expect(parseTokenInput("300k")).toBe(300000);
		expect(parseTokenInput("300K")).toBe(300000);
		expect(parseTokenInput("128k")).toBe(128000);
		expect(parseTokenInput("1.5m")).toBe(1500000);
		expect(parseTokenInput("1M")).toBe(1000000);
	});

	it("支持千分位逗号与下划线", () => {
		expect(parseTokenInput("300,000")).toBe(300000);
		expect(parseTokenInput("300_000")).toBe(300000);
		expect(parseTokenInput("1,000,000")).toBe(1000000);
	});

	it("纯数字输入：<= 1000 智能识别为 K tokens", () => {
		expect(parseTokenInput(300)).toBe(300000);
		expect(parseTokenInput("300")).toBe(300000);
		expect(parseTokenInput(128)).toBe(128000);
		expect(parseTokenInput("64")).toBe(64000);
		expect(parseTokenInput(1)).toBe(1000);
		expect(parseTokenInput(1000)).toBe(1000000);
	});

	it("完整数字 > 1000 保持原值并取整", () => {
		expect(parseTokenInput(300000)).toBe(300000);
		expect(parseTokenInput("300000")).toBe(300000);
		expect(parseTokenInput(190000.7)).toBe(190000);
	});

	it("上限钳制", () => {
		expect(parseTokenInput(99_000_000)).toBe(10_000_000);
		expect(parseTokenInput("20M")).toBe(10_000_000);
	});
});

describe("formatTokenDraft", () => {
	it("0 或非法返回空字符串", () => {
		expect(formatTokenDraft(0)).toBe("");
		expect(formatTokenDraft(null)).toBe("");
		expect(formatTokenDraft(undefined)).toBe("");
		expect(formatTokenDraft(-10)).toBe("");
	});

	it("整千格式化为 k", () => {
		expect(formatTokenDraft(300000)).toBe("300k");
		expect(formatTokenDraft(128000)).toBe("128k");
		expect(formatTokenDraft(2000)).toBe("2k");
	});

	it("整百万格式化为 M", () => {
		expect(formatTokenDraft(1000000)).toBe("1M");
		expect(formatTokenDraft(1500000)).toBe("1.5M");
		expect(formatTokenDraft(2000000)).toBe("2M");
	});

	it("非整千直接转字符串", () => {
		expect(formatTokenDraft(1234)).toBe("1234");
	});
});
