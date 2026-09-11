import { describe, expect, it } from "vitest";
import { mergeRecalledDraft } from "../../web/src/composer-draft.js";

describe("mergeRecalledDraft", () => {
	it("输入框为空 → 直接填入", () => {
		expect(mergeRecalledDraft("", "撤回的内容")).toBe("撤回的内容");
	});

	it("输入框只有空白 → 视为空，直接填入（不留空行）", () => {
		expect(mergeRecalledDraft("   \n\t ", "撤回的内容")).toBe("撤回的内容");
	});

	it("输入框非空 → 追加到末尾，保留用户正在打的内容", () => {
		expect(mergeRecalledDraft("正在打的字", "撤回的内容")).toBe("正在打的字\n撤回的内容");
	});

	it("追加前清掉输入框末尾的换行/空格（不产生空行）", () => {
		expect(mergeRecalledDraft("第一行\n\n", "第二段")).toBe("第一行\n第二段");
		expect(mergeRecalledDraft("尾随空格  ", "x")).toBe("尾随空格\nx");
	});

	it("撤回内容为空 → 不动输入框", () => {
		expect(mergeRecalledDraft("keep", "")).toBe("keep");
		expect(mergeRecalledDraft("", "")).toBe("");
	});

	it("多行撤回内容原样保留（含内部换行与 markdown）", () => {
		const recalled = "第一行\n\n```js\nconst a = 1;\n```";
		expect(mergeRecalledDraft("", recalled)).toBe(recalled);
		expect(mergeRecalledDraft("abc", recalled)).toBe(`abc\n${recalled}`);
	});

	it("不修改入参（纯函数）", () => {
		const current = "abc";
		mergeRecalledDraft(current, "x");
		expect(current).toBe("abc");
	});
});
