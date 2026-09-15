/**
 * voice-input 插件单测 —— 走真实源码路径，不 mock 被测逻辑。
 *
 * 覆盖：
 *   - manifest.json：view:false（无独立视图 tab）+ apiVersion 2 + permissions
 *     含 ui/http（严格模式下 composer 条目与 host.route 缺一不可）。
 *   - manifest "ui" 经服务端真实 `parseUiContributions` 解析：恰好一条，
 *     落在 composer.actions，kind=action，action=voice-input:toggle。
 *   - settings schema：lang 默认 zh-CN、serverFallback 默认开、转写三件套齐全。
 *   - 服务端纯函数：whisperLang（插件语言 → Whisper language）与 joinUrl。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUiContributions } from "../../server/plugins.js";
import { joinUrl, whisperLang } from "../../plugins/voice-input/index.mjs";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "voice-input");
const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));

describe("voice-input manifest", () => {
	it("无独立视图 + 严格模式能力声明齐全", () => {
		expect(manifest.id).toBe("voice-input");
		expect(manifest.view).toBe(false);
		expect(manifest.apiVersion).toBe(2);
		expect(manifest.permissions).toContain("ui");
		expect(manifest.permissions).toContain("http");
	});

	it("ui 贡献解析出唯一的输入框麦克风按钮", () => {
		const parsed = parseUiContributions(manifest.ui);
		expect(parsed?.items).toHaveLength(1);
		const it0 = parsed!.items[0]!;
		expect(it0.slot).toBe("composer.actions");
		expect(it0.kind).toBe("action");
		expect(it0.action).toBe("voice-input:toggle");
		expect(it0.id).toBe("mic");
		expect(it0.label).toBeTruthy();
		expect(it0.labelEn).toBeTruthy();
	});

	it("settings 有语言/降级开关/转写三件套且默认值对", () => {
		const byKey = Object.fromEntries(manifest.settings.map((f: { key: string }) => [f.key, f]));
		expect(byKey.lang.default).toBe("zh-CN");
		expect(byKey.serverFallback.default).toBe(true);
		expect(byKey.transcribeUrl.default).toBe("");
		expect(byKey.transcribeKey.type).toBe("password");
		expect(byKey.transcribeModel.default).toBe("whisper-1");
	});
});

describe("whisperLang", () => {
	it.each([
		["zh-CN", "zh"],
		["zh-TW", "zh"],
		["en-US", "en"],
		["en-GB", "en"],
		["ja-JP", "ja"],
		["", ""],
		["xx-YY", ""],
	])("%s → %s", (input, expected) => {
		expect(whisperLang(input)).toBe(expected);
	});
});

describe("joinUrl", () => {
	it("容忍基址末尾斜杠", () => {
		expect(joinUrl("https://api.openai.com/v1/", "/audio/transcriptions")).toBe(
			"https://api.openai.com/v1/audio/transcriptions",
		);
		expect(joinUrl("https://api.openai.com/v1", "/audio/transcriptions")).toBe(
			"https://api.openai.com/v1/audio/transcriptions",
		);
	});
});
