import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalActivity } from "../../web/src/components/ApprovalActivity.js";
import { LanguageProvider } from "../../web/src/i18n.js";

describe("approval activity rendering", () => {
	it("uses native disclosure and timestamps, and hides empty conversation histories", () => {
		const render = (entries: Parameters<typeof ApprovalActivity>[0]["entries"]) =>
			renderToStaticMarkup(createElement(LanguageProvider, null, createElement(ApprovalActivity, { entries })));
		expect(render([])).toBe("");
		const html = render([{ id: "one", toolName: "<unsafe>", status: "pending", createdAt: 1, updatedAt: 2 }]);
		expect(html).toContain("<details");
		expect(html).toContain("<summary");
		expect(html).toContain("<time");
		expect(html).toContain("&lt;unsafe&gt;");
		expect(html).not.toContain("<unsafe>");
	});
});
