import { useLayoutEffect, type RefObject } from "react";

export interface UseAutoResizeTextareaOptions {
	/** 最小保底高度（px），默认 0。 */
	minHeight?: number;
	/** 最大上限高度（px），超出后出现滚动条，默认 Infinity。 */
	maxHeight?: number;
	/** 是否启用自适应（默认 true）。 */
	enabled?: boolean;
}

/**
 * 纯函数：根据当前的 scrollHeight 和限制范围计算目标高度与 overflowY。
 */
export function computeTextareaHeight(
	scrollHeight: number,
	options: UseAutoResizeTextareaOptions = {},
): { height: number; overflowY: "auto" | "hidden" } {
	const { minHeight = 0, maxHeight = Infinity } = options;
	const h = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
	const overflowY = scrollHeight > h ? "auto" : "hidden";
	return { height: Math.round(h), overflowY };
}

/**
 * 多行输入框自适应撑高 Hook。
 *
 * 解决痛点：
 * 1. 【删减文字不缩小】：通过重置 `height = "auto"` 再量取 `scrollHeight`，彻底解决删字时高度不回缩的经典浏览器行为；
 * 2. 【平滑无闪烁】：在 `useLayoutEffect` 中微任务期计算并写入样式，避免首帧闪烁；
 * 3. 【滚动条智能切换】：未达上限时 `overflow-y: hidden` 隐藏右侧多余轨道，超过上限时自动切 `overflow-y: auto`。
 */
export function useAutoResizeTextarea(
	textareaRef: RefObject<HTMLTextAreaElement | null>,
	value: string,
	options: UseAutoResizeTextareaOptions = {},
): void {
	const { minHeight = 0, maxHeight = Infinity, enabled = true } = options;

	useLayoutEffect(() => {
		if (!enabled) return;
		const ta = textareaRef.current;
		if (!ta) return;

		// 必须先临时重置为 auto，才能测出由于删字导致的真实缩小后的 scrollHeight
		ta.style.height = "auto";
		const scrollHeight = ta.scrollHeight;

		const { height, overflowY } = computeTextareaHeight(scrollHeight, {
			minHeight,
			maxHeight,
		});

		ta.style.height = `${height}px`;
		ta.style.overflowY = overflowY;
	}, [textareaRef, value, minHeight, maxHeight, enabled]);
}
