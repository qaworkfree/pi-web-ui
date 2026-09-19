/**
 * 整条消息卡片 → PNG → 系统剪贴板（issue #228「复制为图片」）。
 * 用 html-to-image 把渲染好的气泡（含语法高亮/表格）导出 2x 长图，
 * 直接写剪贴板：微信/飞书/钉钉里 Ctrl+V 即发。
 */
export async function copyMessageCardAsImage(el: HTMLElement): Promise<void> {
	const { toBlob } = await import("html-to-image");
	const bg = getComputedStyle(el).backgroundColor;
	const blob = await toBlob(el, {
		pixelRatio: 2,
		backgroundColor: bg && bg !== "rgba(0, 0, 0, 0)" ? bg : "#1e1e1e",
		// 工具条/块级复制键/流式光标是操作层，不进长图。
		filter: (node) => {
			if (!(node instanceof HTMLElement)) return true;
			return !node.closest(".msg-actions, .msg-text-copy, .chead-copy, .stream-cursor, .msg-editor");
		},
	});
	if (!blob) throw new Error("toBlob returned null");
	await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
