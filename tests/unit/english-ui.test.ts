import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
	en,
	LanguageProvider,
	registerLocale,
	translateEnglish,
	UI_LOCALE,
	UI_PACKS,
	unregisterLocale,
	useI18n,
} from "../../web/src/i18n";

describe("English-only local interface", () => {
	it("renders English immediately and exposes only English even when another pack is registered", () => {
		registerLocale({ code: "ja", nativeName: "日本語", strings: { modelStudioModelManagement: "モデル管理" } });
		function Probe() {
			const { locale, packs, t } = useI18n();
			return createElement(
				"p",
				null,
				`${locale}|${packs.map((p) => p.nativeName).join(",")}|${t("modelStudioModelManagement")}`,
			);
		}
		try {
			expect(renderToStaticMarkup(createElement(LanguageProvider, null, createElement(Probe)))).toBe(
				"<p>en|English|Model management</p>",
			);
		} finally {
			unregisterLocale("ja");
		}
		expect(UI_LOCALE).toBe("en");
		expect(UI_PACKS).toEqual([{ code: "en", nativeName: "English" }]);
	});

	it("keeps all English labels free of Chinese, Japanese, and Korean text", () => {
		for (const [key, text] of Object.entries(en)) {
			expect(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text), key).toBe(false);
		}
		expect(translateEnglish("quickPhrasesTip", { text: "Continue" })).toContain("Continue");
	});
});
