/**
 * voice-input 插件单测 —— 走真实源码路径，不 mock 被测逻辑。
 *
 * 覆盖：
 *   - manifest.json：view:false（无独立视图 tab）+ apiVersion 2 + permissions
 *     含 ui/http（严格模式下 composer 条目与 host.route 缺一不可）。
 *   - manifest "ui" 经服务端真实 `parseUiContributions` 解析：恰好一条，
 *     落在 composer.actions，kind=action，action=voice-input:toggle。
 *   - settings schema：lang 默认 zh-CN、serverFallback 默认开、转写三件套齐全、
 *     engine 默认 auto、localModel 默认 base。
 *   - 服务端纯函数：whisperLang（远端 ISO-639-1）、whisperFullLang（本地英文全名）、
 *     joinUrl、resolveLocalModel（白名单）、resampleLinear、decodeWav16k。
 *   - 客户端 encodeWavPCM（entry.mjs 纯函数导出）→ 服务端 decodeWav16k 往返 +
 *     srExplain 错误码映射。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUiContributions } from "../../server/plugins.js";
import {
	decodeWav16k,
	joinUrl,
	resampleLinear,
	resolveLocalModel,
	whisperFullLang,
	whisperLang,
} from "../../plugins/voice-input/index.mjs";
import { encodeWavPCM, srExplain } from "../../plugins/voice-input/client/entry.mjs";

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

	it("settings 有引擎/本地模型两档且默认值对", () => {
		const byKey = Object.fromEntries(manifest.settings.map((f: { key: string }) => [f.key, f]));
		expect(byKey.engine.type).toBe("select");
		expect(byKey.engine.default).toBe("auto");
		expect(byKey.engine.options).toEqual(expect.arrayContaining(["auto", "local", "remote"]));
		expect(byKey.localModel.type).toBe("select");
		expect(byKey.localModel.default).toBe("base");
		expect(byKey.localModel.options).toEqual(expect.arrayContaining(["base", "tiny"]));
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

describe("whisperFullLang", () => {
	it.each([
		["zh-CN", "chinese"],
		["zh-TW", "chinese"],
		["en-US", "english"],
		["ja-JP", "japanese"],
		["ko-KR", "korean"],
		["fr-FR", "french"],
		["de-DE", "german"],
		["es-ES", "spanish"],
		["ru-RU", "russian"],
		["it-IT", "italian"],
		["pt-BR", "portuguese"],
		["", ""],
		["xx-YY", ""],
	])("%s → %s", (input, expected) => {
		expect(whisperFullLang(input)).toBe(expected);
	});
});

describe("resolveLocalModel", () => {
	it("白名单内三档", () => {
		expect(resolveLocalModel("tiny")).toBe("Xenova/whisper-tiny");
		expect(resolveLocalModel("base")).toBe("Xenova/whisper-base");
		expect(resolveLocalModel("small")).toBe("Xenova/whisper-small");
		expect(resolveLocalModel(" Base ")).toBe("Xenova/whisper-base");
	});
	it("白名单外一律 null（防任意模型 id 注入下载）", () => {
		expect(resolveLocalModel("openai/whisper-large-v3")).toBeNull();
		expect(resolveLocalModel("https://evil.example/m.bin")).toBeNull();
		expect(resolveLocalModel("")).toBeNull();
		expect(resolveLocalModel(null)).toBeNull();
		expect(resolveLocalModel(undefined)).toBeNull();
	});
});

describe("resampleLinear", () => {
	it("同采样率原样返回", () => {
		const src = new Float32Array([0.1, 0.2, 0.3]);
		const out = resampleLinear(src, 16000, 16000);
		expect(out.length).toBe(3);
		for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(src[i]!, 6);
		expect(out).not.toBe(src);
	});
	it("48k→16k 长度约 1/3 且端点对齐", () => {
		const src = new Float32Array(480);
		for (let i = 0; i < src.length; i++) src[i] = i / 479;
		const out = resampleLinear(src, 48000, 16000);
		expect(out.length).toBe(160);
		expect(out[0]).toBeCloseTo(0, 5);
		expect(out[159]).toBeCloseTo(1, 2);
	});
	it("空输入回空", () => {
		expect(resampleLinear(new Float32Array(0), 48000, 16000).length).toBe(0);
	});
	it("非法采样率抛错", () => {
		expect(() => resampleLinear(new Float32Array([1]), 0, 16000)).toThrow();
	});
});

describe("decodeWav16k", () => {
	/** 手拼 16-bit PCM WAV（声道数/采样率可调，含一个 JUNK 块考验跳块）。 */
	function buildWav(frames: number[][], sampleRate: number) {
		const channels = frames.length;
		const n = frames[0]!.length;
		const dataLen = n * channels * 2;
		const junk = 8;
		const buf = new ArrayBuffer(12 + 8 + 16 + 8 + junk + 8 + dataLen);
		const v = new DataView(buf);
		const wstr = (o: number, s: string) => {
			for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
		};
		wstr(0, "RIFF");
		v.setUint32(4, buf.byteLength - 8, true);
		wstr(8, "WAVE");
		wstr(12, "JUNK");
		v.setUint32(16, junk, true);
		const fmtOff = 12 + 8 + junk;
		wstr(fmtOff, "fmt ");
		v.setUint32(fmtOff + 4, 16, true);
		v.setUint16(fmtOff + 8, 1, true);
		v.setUint16(fmtOff + 10, channels, true);
		v.setUint32(fmtOff + 12, sampleRate, true);
		v.setUint32(fmtOff + 16, sampleRate * channels * 2, true);
		v.setUint16(fmtOff + 20, channels * 2, true);
		v.setUint16(fmtOff + 22, 16, true);
		const dataOff = fmtOff + 8 + 16;
		wstr(dataOff, "data");
		v.setUint32(dataOff + 4, dataLen, true);
		let p = dataOff + 8;
		for (let i = 0; i < n; i++) {
			for (let c = 0; c < channels; c++) {
				const s = Math.max(-1, Math.min(1, frames[c]![i]!));
				v.setInt16(p, Math.round(s * 32767), true);
				p += 2;
			}
		}
		return Buffer.from(buf);
	}

	it("16k 单声道直解", () => {
		const out = decodeWav16k(buildWav([[0, 0.5, -0.5, 1]], 16000));
		expect(out.length).toBe(4);
		expect(out[1]).toBeCloseTo(0.5, 3);
		expect(out[2]).toBeCloseTo(-0.5, 3);
	});

	it("48k 立体声 → 16k 单声道（平均+重采样）", () => {
		const frames: number[][] = [[], []];
		for (let i = 0; i < 480; i++) {
			frames[0]!.push(i / 479);
			frames[1]!.push(i / 479);
		}
		const out = decodeWav16k(buildWav(frames, 48000));
		expect(out.length).toBe(160);
		expect(out[0]).toBeCloseTo(0, 3);
		expect(out[159]).toBeCloseTo(1, 2);
	});

	it("客户端 encodeWavPCM → 服务端 decodeWav16k 往返", () => {
		const src = new Float32Array(1600);
		for (let i = 0; i < src.length; i++) src[i] = Math.sin((i / 1600) * Math.PI * 4) * 0.5;
		const wav = Buffer.from(encodeWavPCM(src, 16000));
		const out = decodeWav16k(wav);
		expect(out.length).toBe(src.length);
		for (let i = 0; i < src.length; i += 100) expect(out[i]).toBeCloseTo(src[i]!, 2);
	});

	it("坏输入抛中文错", () => {
		expect(() => decodeWav16k(Buffer.alloc(10))).toThrow("WAV");
		const bad = Buffer.from(encodeWavPCM(new Float32Array([0.1]), 16000));
		bad.write("XXXX", 0);
		expect(() => decodeWav16k(bad)).toThrow("RIFF");
	});
});

describe("srExplain", () => {
	it("Edge 常见错误码都有中文解释", () => {
		expect(srExplain("not-allowed").kind).toBe("denied");
		expect(srExplain("service-not-allowed").kind).toBe("denied");
		expect(srExplain("network").kind).toBe("network");
		expect(srExplain("no-speech").kind).toBe("nospeech");
		expect(srExplain("audio-capture").kind).toBe("nospeech");
		for (const code of ["not-allowed", "network", "no-speech", "audio-capture", "oops"]) {
			const m = srExplain(code);
			expect(typeof m.msg).toBe("string");
			expect(m.msg.length).toBeGreaterThan(4);
		}
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
