/**
 * 整条消息卡片 → PNG → 系统剪贴板（issue #228「复制为图片」）。
 * 用 html-to-image 把渲染好的气泡（含语法高亮/表格）导出 2x 长图，
 * 直接写剪贴板：微信/飞书/钉钉里 Ctrl+V 即发。
 */
/**
 * 寻找卡片真实的背景色：
 * 1. 优先读取当前主题的 CSS 变量（--card-bg / --msgs-bg / --bg）；
 * 2. 向上沿着 DOM 树查找第一个非透明的 background-color；
 * 3. 最终按当前 color-scheme 兜底（light → #ffffff，dark → #1e1e1e）。
 */
function resolveCardBg(el: HTMLElement): string {
	const rootStyle = getComputedStyle(document.documentElement);
	const cssVar =
		rootStyle.getPropertyValue("--card-bg").trim() ||
		rootStyle.getPropertyValue("--msgs-bg").trim() ||
		rootStyle.getPropertyValue("--bg").trim();
	if (cssVar && cssVar !== "transparent") return cssVar;

	let cur: HTMLElement | null = el;
	while (cur) {
		const bg = getComputedStyle(cur).backgroundColor;
		if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
			return bg;
		}
		cur = cur.parentElement;
	}

	const isLight = rootStyle.colorScheme === "light";
	return isLight ? "#ffffff" : "#1e1e1e";
}

export async function copyMessageCardAsImage(el: HTMLElement): Promise<void> {
	const { toBlob } = await import("html-to-image");
	const bg = resolveCardBg(el);
	const blob = await toBlob(el, {
		pixelRatio: 2,
		backgroundColor: bg,
		style: {
			padding: "16px 20px",
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
