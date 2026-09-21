import { useEffect, useRef, useState } from "react";

export interface UseInViewOptions {
	/** 透传给 IntersectionObserver 的 rootMargin（默认 "0px"）。 */
	rootMargin?: string;
	/** 透传给 IntersectionObserver 的 threshold（默认 0）。 */
	threshold?: number | number[];
	/** 进入视口后是否保持 true 不再回落（默认 true，惰性渲染场景）。 */
	once?: boolean;
	/** 是否启用（默认 true）。 */
	enabled?: boolean;
}

export interface UseInViewResult<T extends Element = HTMLDivElement> {
	/** 绑定在待观察元素上的 ref。 */
	ref: React.RefObject<T | null>;
	/** 是否（曾经）进入视口。 */
	inView: boolean;
}

/**
 * 视口惰性渲染 Hook。
 *
 * 解决痛点：
 * 1. 【SSR / jsdom 安全】：无 `IntersectionObserver` 环境直接回退 `inView = true`
 *   （服务端渲染不空白，旧浏览器不崩）；
 * 2. 【once 语义】：默认进入一次即锁定，避免昂贵内容（代码高亮、图片）反复挂载/卸载；
 * 3. 【自动清理】：卸载时自动 `disconnect`，无观察器泄漏。
 */
export function useInView<T extends Element = HTMLDivElement>(options: UseInViewOptions = {}): UseInViewResult<T> {
	const { rootMargin = "0px", threshold = 0, once = true, enabled = true } = options;

	const ref = useRef<T | null>(null);
	const [inView, setInView] = useState(false);

	useEffect(() => {
		if (!enabled) return;
		const el = ref.current;
		if (!el) return;

		// 无 IntersectionObserver 环境（SSR / 旧浏览器 / jsdom）：直接视为可见
		if (typeof IntersectionObserver === "undefined") {
			setInView(true);
			return;
		}

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						setInView(true);
						if (once) observer.disconnect();
					} else if (!once) {
						setInView(false);
					}
				}
			},
			{ rootMargin, threshold },
		);

		observer.observe(el);
		return () => {
			observer.disconnect();
		};
	}, [enabled, rootMargin, threshold, once]);

	return { ref, inView };
}
