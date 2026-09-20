/**
 * 「复制为图片」长图导出的背景色解析与画布尺寸测试（issue #257）。
 *
 * 覆盖两个真实回归点：
 *  1) 浅色主题下不能硬编码暗底（黑底黑字），也不能用带 alpha 的 `color-mix(...)`
 *     表达式当背景（自定义属性未求值 → 导出图透光）；
 *  2) 加留白时必须把留白补进画布尺寸，否则 padding-left 把内容整体右移、
 *     右侧 20px 落在画布外被裁掉。
 */
import { describe, expect, it } from "vitest";
import {
	EXPORT_PAD_X,
	EXPORT_PAD_Y,
	exportCanvasSize,
	isLightScheme,
	isOpaqueColorLiteral,
	pickExportBg,
} from "../../web/src/message-image.js";

describe("导出底色：pickExportBg", () => {
	it("优先用主题给的实色 --card-bg（paper / catppuccin-latte / nord 这类实底主题）", () => {
		expect(pickExportBg({ cardBg: "#fffdf6", msgsBg: "#fffdf6", bg: "#f7f1e3" })).toBe("#fffdf6");
	});

	it("--card-bg 是 color-mix(...) 表达式时跳过，回落到不透明的 --bg（否则导出图透光）", () => {
		// 默认深色主题与 white / mist / sakura / dazzle / cyberpunk / md-preview 的真实取值
		const mix = "color-mix(in srgb, #14161c 62%, transparent)";
		expect(pickExportBg({ cardBg: mix, msgsBg: mix, bg: "#0d0e12" })).toBe("#0d0e12");
		// 浅色主题同理：回落到该主题自己的 --bg，而不是写死的暗色
		expect(pickExportBg({ cardBg: mix, msgsBg: mix, bg: "#ffffff" })).toBe("#ffffff");
	});

	it("token 全不可用时返回调用方给的兜底值", () => {
		expect(pickExportBg({ cardBg: "transparent", msgsBg: "rgba(0, 0, 0, 0)", bg: "" }, "#123456")).toBe("#123456");
		expect(pickExportBg({}, "")).toBe("");
	});
});

describe("isOpaqueColorLiteral", () => {
	it("已求值且完全不透明的字面量为真", () => {
		expect(isOpaqueColorLiteral("#ffffff")).toBe(true);
		expect(isOpaqueColorLiteral("#FFF")).toBe(true);
		expect(isOpaqueColorLiteral("#ffff")).toBe(true);
		expect(isOpaqueColorLiteral("#0d0e12ff")).toBe(true);
		expect(isOpaqueColorLiteral("rgb(13, 14, 18)")).toBe(true);
		expect(isOpaqueColorLiteral("rgb(13 14 18)")).toBe(true);
		expect(isOpaqueColorLiteral("rgba(13, 14, 18, 1)")).toBe(true);
		expect(isOpaqueColorLiteral("hsl(210 10% 50%)")).toBe(true);
	});

	it("需要求值的表达式一律为假（getComputedStyle 对未注册的自定义属性不求值）", () => {
		expect(isOpaqueColorLiteral("color-mix(in srgb, #14161c 62%, transparent)")).toBe(false);
		expect(isOpaqueColorLiteral("var(--bg-elev)")).toBe(false);
		expect(isOpaqueColorLiteral("light-dark(#fff, #000)")).toBe(false);
		expect(isOpaqueColorLiteral("color(display-p3 1 0 0)")).toBe(false);
	});

	it("非实底（关键字 / 带 alpha）为假", () => {
		expect(isOpaqueColorLiteral("")).toBe(false);
		expect(isOpaqueColorLiteral("transparent")).toBe(false);
		expect(isOpaqueColorLiteral("currentColor")).toBe(false);
		expect(isOpaqueColorLiteral("inherit")).toBe(false);
		expect(isOpaqueColorLiteral("rgba(0, 0, 0, 0)")).toBe(false);
		expect(isOpaqueColorLiteral("rgba(13, 14, 18, 0.62)")).toBe(false);
		expect(isOpaqueColorLiteral("rgb(13 14 18 / 62%)")).toBe(false);
		expect(isOpaqueColorLiteral("#0d0e1299")).toBe(false);
		expect(isOpaqueColorLiteral("#fff0")).toBe(false);
	});
});

describe("exportCanvasSize：留白必须补进画布尺寸", () => {
	// `.msg` 的真实 padding 是 `6px 0px 14px`
	const msgMetrics = {
		clientWidth: 800,
		clientHeight: 600,
		paddingTop: 6,
		paddingBottom: 14,
		paddingLeft: 0,
		paddingRight: 0,
	};

	it("画布 = 原内容尺寸 + 两侧留白（换掉元素自身 padding，留白按 16/20 重新给）", () => {
		expect(exportCanvasSize(msgMetrics)).toEqual({
			width: 800 + EXPORT_PAD_X * 2,
			height: 600 - (6 + 14) + EXPORT_PAD_Y * 2,
		});
	});

	it("画布减去新留白后必须正好等于原内容区 —— 这是「右侧不被裁」的充要条件", () => {
		// html-to-image 给每个子节点内联的是绝对 px 宽（= 原内容宽），
		// 所以克隆体的内容盒必须与原内容盒等宽，多出来的只能是留白。
		const { width, height } = exportCanvasSize(msgMetrics);
		expect(width - EXPORT_PAD_X * 2).toBe(msgMetrics.clientWidth - msgMetrics.paddingLeft - msgMetrics.paddingRight);
		expect(height - EXPORT_PAD_Y * 2).toBe(msgMetrics.clientHeight - msgMetrics.paddingTop - msgMetrics.paddingBottom);
	});

	it("元素自带左右 padding 时也成立（不能重复计入）", () => {
		const { width } = exportCanvasSize({ ...msgMetrics, paddingLeft: 12, paddingRight: 12 });
		expect(width).toBe(800 - 24 + EXPORT_PAD_X * 2);
	});
});

describe("isLightScheme：兜底用的浅色判定", () => {
	it("只有显式 light 才算浅色（默认深色主题实测是 normal）", () => {
		expect(isLightScheme("light")).toBe(true);
		expect(isLightScheme("dark")).toBe(false);
		expect(isLightScheme("normal")).toBe(false);
		expect(isLightScheme("")).toBe(false);
		expect(isLightScheme("light dark")).toBe(false);
	});
});
