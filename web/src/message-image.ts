/**
 * 整条消息卡片 → PNG → 系统剪贴板（issue #228「复制为图片」）。
 * 用 html-to-image 把渲染好的气泡（含语法高亮/表格）导出 2x 长图，
 * 直接写剪贴板：微信/飞书/钉钉里 Ctrl+V 即发。
 */

/** 导出留白：四周留白让长图成为一张「分享卡片」（issue #257）。 */
export const EXPORT_PAD_X = 20;
export const EXPORT_PAD_Y = 16;

/** 兜底背景：主题 token 全不可用、也沿不清 DOM 时的最后手段。 */
const LIGHT_FALLBACK = "#ffffff";
const DARK_FALLBACK = "#1e1e1e";

const UNUSABLE_TOKENS = new Set(["", "transparent", "none", "inherit", "initial", "unset", "revert", "currentcolor"]);

/**
 * 这个值能不能直接当导出图的**实底**背景。
 *
 * 为什么不能拿到什么就用什么：
 * - `--card-bg` / `--msgs-bg` 在大多数主题里是
 *   `color-mix(in srgb, var(--bg-elev) 62%, transparent)`。自定义属性是未注册属性，
 *   `getComputedStyle` 只把 `var()` 代进去、**不求值函数**，拿到的是表达式本身；
 *   就算浏览器能求值，它也只有 62% 不透明 —— 导出图会透光（paper 主题特意把
 *   `--wallpaper-panel-alpha` 设成 100%，注释就是「杜绝图片导出透光」）。
 * - `transparent` / 带 alpha 的颜色同理都不是实底。
 *
 * 所以只认「已求值、且完全不透明的颜色字面量」，其余一律交给下一个候选/回落到不透明的 `--bg`。
 */
export function isOpaqueColorLiteral(value: string): boolean {
	const v = (value || "").trim().toLowerCase();
	if (UNUSABLE_TOKENS.has(v)) return false;
	const hex = v.match(/^#([0-9a-f]{3,8})$/);
	if (hex) {
		const digits = hex[1];
		if (digits.length === 4) return digits[3] === "f";
		if (digits.length === 8) return digits.slice(6) === "ff";
		return digits.length === 3 || digits.length === 6;
	}
	const fn = v.match(/^(rgb|rgba|hsl|hsla)\(([^)]*)\)$/);
	if (!fn) return false; // var() / color-mix() / light-dark() / color() / 关键字：一律不求值、不认
	const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
	if (parts.length < 4) return parts.length >= 3;
	const alpha = parts[3].endsWith("%") ? Number.parseFloat(parts[3]) / 100 : Number.parseFloat(parts[3]);
	return Number.isFinite(alpha) ? alpha >= 1 : false;
}

/**
 * 从主题 token 里挑一个能当导出实底的背景色（纯函数，便于单测）。
 * 优先级沿用 `--card-bg` → `--msgs-bg` → `--bg`，只是跳过不可用的值。
 */
export function pickExportBg(tokens: { cardBg?: string; msgsBg?: string; bg?: string }, fallback = ""): string {
	for (const value of [tokens.cardBg, tokens.msgsBg, tokens.bg]) {
		if (value && isOpaqueColorLiteral(value)) return value.trim();
	}
	return fallback;
}

/**
 * `color-scheme` 计算值只在主题**显式声明**时才有内容：默认深色主题实测是 `"normal"`，
 * 浅色主题是 `"light"`。所以按「含 light 且不含 dark」判定浅色，其余一律走深色兜底。
 */
export function isLightScheme(colorScheme: string): boolean {
	const v = (colorScheme || "").toLowerCase();
	return v.includes("light") && !v.includes("dark");
}

/**
 * 导出画布的 CSS 尺寸 = 原内容尺寸 + 两侧留白。
 *
 * 必须显式算出来传给 html-to-image，不能只加 padding：`toSvg()` 先按元素
 * **加 padding 之前**的实测尺寸定画布（`getImageSize`），之后才 `applyStyle` 加 padding，
 * 而克隆出来的每个子节点带着各自的绝对 px 宽（`cloneCSSStyle` 逐条内联计算样式）。
 * 于是 `padding-left: 20px` 会把所有内容整体右移 20px，画布却没变宽 —— 右侧 20px
 * 直接落在画布外被裁掉（issue #257 的实测回归）。
 */
export function exportCanvasSize(m: {
	clientWidth: number;
	clientHeight: number;
	paddingTop: number;
	paddingBottom: number;
	paddingLeft: number;
	paddingRight: number;
}): { width: number; height: number } {
	const contentWidth = m.clientWidth - m.paddingLeft - m.paddingRight;
	const contentHeight = m.clientHeight - m.paddingTop - m.paddingBottom;
	return {
		width: Math.round(contentWidth + EXPORT_PAD_X * 2),
		height: Math.round(contentHeight + EXPORT_PAD_Y * 2),
	};
}

/**
 * 卡片真实的导出底色：主题 token 里的实色 → 沿 DOM 往上找第一个不透明背景 → 按 color-scheme 兜底。
 * 原实现只读 `getComputedStyle(el).backgroundColor`，而 `.msg` 自身没有背景色（由页面/中央列承载），
 * 拿到 `rgba(0, 0, 0, 0)` 后硬编码回落到暗色 `#1e1e1e` —— 浅色主题导出就是黑底黑字。
 */
export function resolveCardBg(el: HTMLElement): string {
	const root = getComputedStyle(document.documentElement);
	const token = pickExportBg({
		cardBg: root.getPropertyValue("--card-bg"),
		msgsBg: root.getPropertyValue("--msgs-bg"),
		bg: root.getPropertyValue("--bg"),
	});
	if (token) return token;
	let cur: HTMLElement | null = el;
	while (cur) {
		const bg = getComputedStyle(cur).backgroundColor;
		if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
		cur = cur.parentElement;
	}
	return isLightScheme(root.colorScheme) ? LIGHT_FALLBACK : DARK_FALLBACK;
}

export async function copyMessageCardAsImage(el: HTMLElement): Promise<void> {
	const { toBlob } = await import("html-to-image");
	const bg = resolveCardBg(el);
	const cs = getComputedStyle(el);
	const { width, height } = exportCanvasSize({
		clientWidth: el.clientWidth,
		clientHeight: el.clientHeight,
		paddingTop: Number.parseFloat(cs.paddingTop) || 0,
		paddingBottom: Number.parseFloat(cs.paddingBottom) || 0,
		paddingLeft: Number.parseFloat(cs.paddingLeft) || 0,
		paddingRight: Number.parseFloat(cs.paddingRight) || 0,
	});
	const blob = await toBlob(el, {
		pixelRatio: 2,
		// 画布尺寸要自己把留白补进去（见 exportCanvasSize 的注释），否则右侧被裁。
		width,
		height,
		backgroundColor: bg,
		style: {
			padding: `${EXPORT_PAD_Y}px ${EXPORT_PAD_X}px`,
			borderRadius: "10px",
			backgroundColor: bg,
		},
		// 工具条/块级复制键/流式光标是操作层，不进长图。
		filter: (node) => {
			if (!(node instanceof HTMLElement)) return true;
			return !node.closest(".msg-actions, .msg-text-copy, .chead-copy, .stream-cursor, .msg-editor");
		},
	});
	if (!blob) throw new Error("toBlob returned null");
	await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
