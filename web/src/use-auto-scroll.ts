import { useCallback, useEffect, useRef, useState } from "react";
import { classifyScroll } from "./components/scroll-classify";

export interface ScrollMetrics {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}

export interface UseAutoScrollOptions {
	/** 距底部多少 px 以内算“贴底”（默认 80，与 MessageList 同口径）。 */
	threshold?: number;
	/** 是否启用（默认 true）。 */
	enabled?: boolean;
	/** 程序化滚动后的宽限期（ms），宽限期内的 scroll 事件不解读为用户意图（默认 150）。 */
	graceMs?: number;
}

export interface UseAutoScrollResult {
	/** 绑定在滚动容器上的 ref。 */
	scrollRef: React.RefObject<HTMLDivElement | null>;
	/** 当前是否处于吸底状态（用户上滚逃逸后为 false）。 */
	isPinned: boolean;
	/** 程序化吸底（内容到达时调用；宽限期内不触发逃逸误判）。 */
	scrollToBottom: () => void;
	/** 直接绑定在滚动容器的 onScroll。 */
	onScroll: () => void;
}

/**
 * 纯函数：按指标判断是否贴近底部。
 */
export function isNearBottom(metrics: ScrollMetrics, threshold = 80): boolean {
	const { scrollTop, scrollHeight, clientHeight } = metrics;
	return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * 流式吸底与滚轮逃逸控制器。
 *
 * 解决痛点：
 * 1. 【逃逸判定】：复用 `scroll-classify.ts` 的 `classifyScroll`（宽限期 / 布局塌缩钳制 /
 *    真实用户上滚 三态区分），不上滚误判、不把布局抖动当用户意图；
 * 2. 【宽限期】：`scrollToBottom` 后的 `graceMs` 内到达的 scroll 事件一律视为程序化回声；
 * 3. 【状态外显】：`isPinned` 可直接驱动“回到底部”悬浮按钮的显隐。
 */
export function useAutoScroll(options: UseAutoScrollOptions = {}): UseAutoScrollResult {
	const { threshold = 80, enabled = true, graceMs = 150 } = options;

	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [isPinned, setIsPinned] = useState(true);

	const escapedRef = useRef(false);
	const prevStRef = useRef(0);
	const prevShRef = useRef(0);
	const graceUntilRef = useRef(0);

	const scrollToBottom = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		graceUntilRef.current = Date.now() + graceMs;
		try {
			el.scrollTop = el.scrollHeight;
		} catch {
			// 忽略极端环境异常
		}
		escapedRef.current = false;
		prevStRef.current = el.scrollTop;
		prevShRef.current = el.scrollHeight;
		setIsPinned(true);
	}, [graceMs]);

	const onScroll = useCallback(() => {
		if (!enabled) return;
		const el = scrollRef.current;
		if (!el) return;

		const dSt = el.scrollTop - prevStRef.current;
		const dSh = el.scrollHeight - prevShRef.current;
		prevStRef.current = el.scrollTop;
		prevShRef.current = el.scrollHeight;

		const graceActive = Date.now() < graceUntilRef.current;
		const { flipEscape } = classifyScroll({
			dSt,
			dSh,
			escaped: escapedRef.current,
			graceActive,
			stuck: isNearBottom(
				{ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
				threshold,
			),
		});

		if (flipEscape) {
			escapedRef.current = true;
			setIsPinned(false);
			return;
		}

		// 用户滚回底部附近 → 恢复吸底
		if (
			isNearBottom({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }, threshold)
		) {
			if (escapedRef.current) escapedRef.current = false;
			setIsPinned((prev) => (prev ? prev : true));
		} else if (!escapedRef.current) {
			// 非逃逸但离底较远（如内容增长把底部顶下去）：保持 pin=false 展示“回到底部”
			setIsPinned((prev) => (prev ? false : prev));
		}
	}, [enabled, threshold]);

	// 卸载时无副作用残留（全是 ref + state，无全局监听）
	useEffect(() => {
		return () => {
			escapedRef.current = false;
			graceUntilRef.current = 0;
		};
	}, []);

	return { scrollRef, isPinned, scrollToBottom, onScroll };
}
